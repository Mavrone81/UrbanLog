// Server-side Claude proxy for the Urban Werkz Delivery chatbot.
// The browser talks to THIS service; this service holds the API key and talks to Claude.
// The key is never sent to the browser and never committed to git.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import PDFDocument from "pdfkit";

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CHAT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS || 1024);
const WHATSAPP_NUMBER = "6589968390";
const LEAD_URL = process.env.LEAD_URL || ""; // CMS endpoint to record confirmed bookings (CRM)

// Forward a confirmed booking to the CMS CRM. Fire-and-forget — never blocks the reply.
async function recordLead(details) {
  if (!LEAD_URL) return;
  try {
    await fetch(LEAD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "chatbot", ...details }),
    });
  } catch (e) {
    console.error("lead forward failed:", e?.message);
  }
}

const PRICING_URL = process.env.PRICING_URL || ""; // CMS rate card (local-compute fallback)
// CDMS encrypted rate card is the source of truth: the bot calls its public quote API,
// which decrypts the rate model, computes the customer price, saves the quote, and serves the PDF.
const RATE_CARD_API = process.env.RATE_CARD_URL || "https://app.urbanfleetsg.com/api/rate-card";

// CDMS rate card defaults (fallback if the CMS is unreachable). The CMS is the source of truth.
const DEFAULT_PRICING = {
  currency: "SGD", gst: 9, fuel: 6, refCost: 7.75,
  zones: [
    { k: 1, name: "Zone 1", maxKm: 5, m: 1.0 }, { k: 2, name: "Zone 2", maxKm: 12, m: 1.25 },
    { k: 3, name: "Zone 3", maxKm: 20, m: 1.55 }, { k: 4, name: "Zone 4", maxKm: 9999, m: 1.9 },
  ],
  weights: [
    { max: 3, s: 0 }, { max: 5, s: 1.2 }, { max: 10, s: 2.8 },
    { max: 20, s: 5.5 }, { max: 30, s: 9 }, { max: 99999, s: 9, perKg: 0.4 },
  ],
  tiers: [
    { k: "eco", name: "Economy", sla: "3–5 business days", cm: 0.8, mg: 0.25 },
    { k: "std", name: "Standard", sla: "Next business day", cm: 1.0, mg: 0.35 },
    { k: "exp", name: "Express", sla: "Same day · 4–6 h", cm: 1.45, mg: 0.45 },
    { k: "sameday", name: "Same-Day Priority", sla: "Dedicated · ≤3 h", cm: 1.85, mg: 0.55 },
    { k: "night", name: "Overnight", sla: "Eve → before 9 am", cm: 1.3, mg: 0.4 },
    { k: "b2b", name: "B2B Contract", sla: "Volume contract", cm: 0.95, mg: 0.22 },
  ],
  surcharges: [
    { k: "afterhours", label: "After-hours / weekend", type: "pctNet", v: 25 },
    { k: "fragile", label: "Fragile / special handling", type: "flat", v: 6 },
    { k: "cod", label: "Cash-on-delivery", type: "flat", v: 3.5 },
    { k: "multistop", label: "Extra stop (multi-drop)", type: "flat", v: 4.5 },
    { k: "pod", label: "Proof-of-delivery + photo", type: "flat", v: 1.5 },
    { k: "redelivery", label: "Failed re-delivery", type: "flat", v: 8 },
  ],
};
let pricingCache = { at: 0, data: DEFAULT_PRICING };
async function getPricing() {
  if (!PRICING_URL) return DEFAULT_PRICING;
  if (Date.now() - pricingCache.at < 60000) return pricingCache.data;
  try {
    const r = await fetch(PRICING_URL);
    if (r.ok) { const d = await r.json(); if (d && d.tiers) pricingCache = { at: Date.now(), data: d }; }
  } catch (e) { /* keep last good / default */ }
  return pricingCache.data;
}
const round2 = (n) => Math.round(n * 100) / 100;
function zoneForKm(p, km) {
  const zs = [...p.zones].sort((a, b) => a.maxKm - b.maxKm);
  return zs.find((z) => km <= z.maxKm) || zs[zs.length - 1];
}
function weightSurcharge(p, kg) {
  const w = p.weights.find((x) => kg <= x.max) || p.weights[p.weights.length - 1];
  let s = Number(w.s);
  if (w.perKg && kg > 30) s += (kg - 30) * w.perKg;
  return s;
}
// Exact CDMS formula: ((refCost × zone × tier) + weightSurcharge) × (1+margin) × (1+fuel) + add-ons, then GST.
function computeQuote(p, tierKey, distanceKm, kg, surchargeKeys = []) {
  const tier = p.tiers.find((t) => t.k === tierKey) || p.tiers.find((t) => t.k === "std") || p.tiers[0];
  const km = Math.max(0, Number(distanceKm) || 0);
  const zone = zoneForKm(p, km);
  const weight = Math.max(0.1, Number(kg) || 0.1);
  const operational = Number(p.refCost) * zone.m * tier.cm;
  const costToServe = operational + weightSurcharge(p, weight);
  const deliveryCharge = costToServe * (1 + tier.mg); // net before fuel = base service price incl. margin
  const fuel = deliveryCharge * (Number(p.fuel) / 100);
  const net = deliveryCharge + fuel;
  let addOn = 0;
  const addOns = [];
  for (const k of surchargeKeys || []) {
    const sc = (p.surcharges || []).find((s) => s.k === k);
    if (!sc) continue;
    const amt = sc.type === "pctNet" ? net * (Number(sc.v) / 100) : Number(sc.v);
    if (amt > 0) { addOn += amt; addOns.push({ label: sc.label, amt: round2(amt) }); }
  }
  const subtotal = net + addOn;
  const gst = subtotal * (Number(p.gst) / 100);
  const total = subtotal + gst;
  return {
    currency: p.currency || "SGD", gstRate: Number(p.gst),
    service: tier.name, sla: tier.sla, zone: zone.name, zoneDesc: zone.desc || "", km, kg: weight,
    deliveryCharge: round2(deliveryCharge), fuel: round2(fuel), addOns,
    subtotal: round2(subtotal), gst: round2(gst), total: round2(total),
  };
}

// Generated quotations kept briefly so the customer can download the PDF.
const quotes = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1h TTL
  for (const [id, q] of quotes) if (q._at < cutoff) quotes.delete(id);
}, 10 * 60 * 1000).unref();
function storeQuote(q) {
  const id = `q_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  quotes.set(id, { ...q, _at: Date.now(), number: "UF-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Math.floor(1000 + Math.random() * 9000) });
  if (quotes.size > 2000) quotes.delete(quotes.keys().next().value);
  return id;
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY is not set. Refusing to start.");
  process.exit(1);
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const SYSTEM_PROMPT = `You are the friendly virtual assistant for Urban Werkz Delivery, a tech-powered \
last-mile courier service in Singapore (website: urbanfleetsg.com). You help visitors with questions about \
our delivery services: same-day/express delivery, scheduled deliveries, dedicated fleet for businesses, and \
regional delivery (up to ~200km). We offer real-time GPS tracking, ETA updates, delivery photos, and digital \
proof of delivery, available 24/7.

Be concise, warm, and helpful. Answer in 1-3 short sentences or a tight bullet list. Only discuss Urban Werkz \
Delivery and its services; if asked something unrelated, politely steer back.

QUOTING A PRICE: You CAN give a price using the calculate_quote tool — do not refuse or defer price questions. \
Quotes are GST-inclusive and computed from our rate card (distance zones, weight, service tier, add-ons). To \
quote you need: (1) the service tier — Economy (3–5 days), Standard (next day), Express (same day 4–6h), \
Same-Day Priority (dedicated ≤3h), Overnight, or B2B; if the customer just says "same day" pick Express, or \
Same-Day Priority if they want a dedicated ≤3h trip; (2) pickup and drop-off — YOU estimate the driving \
distance in km (you know Singapore: e.g. Toa Payoh to Ang Mo Kio ≈ 6 km), which sets the zone; (3) parcel \
weight in kg (ask, or estimate — a small box ≈ 2 kg, docs ≈ 0.5 kg). Ask only for what's missing, 1–2 questions \
at a time. Mention relevant add-ons if the customer raises them (after-hours/weekend, fragile, cash-on-delivery, \
extra stop, proof-of-delivery photo). Then call calculate_quote and quote the EXACT total it returns (e.g. \
"SGD 18.50, incl. GST"), with the service SLA. A PDF quotation is generated automatically — tell the customer \
they can download it using the button below your message. Add that re-weighing or zone changes at pickup may \
adjust the final charge. Never invent a price without calling the tool.

BOOKINGS: After quoting (or whenever the user wants to proceed), gather pickup, drop-off, item, and preferred \
time (and their name if offered). When the user CONFIRMS, call create_whatsapp_booking with the details — this \
prepares a WhatsApp message to send to our team to finalise scheduling. Tell the user to tap the WhatsApp button. \
Pass through only details the user actually gave.

WHEN YOU CANNOT HELP: For things you genuinely cannot do — live tracking, account/order details, complaints, or \
anything needing a human — apologise briefly and call the whatsapp_handoff tool. ALWAYS pass a summary that \
captures the whole conversation: the customer's issue and every detail they gave (name, order/tracking number, \
pickup & drop-off, item, timing, what they want) — written in their voice — so our team has full context and the \
customer never has to repeat themselves. The button's WhatsApp message is pre-filled with that summary; tell the \
customer to tap it. You can also mention phone (+65 8996 8390) or email (Urbanfleet@gmail.com).`;

const TOOLS = [
  {
    name: "whatsapp_handoff",
    description:
      "Hand the customer off to a human on WhatsApp. Call this whenever you cannot fully help — live tracking, " +
      "account/order issues, complaints, special requests, or anything needing a person. It shows the customer a " +
      "WhatsApp button whose message is PRE-FILLED with your summary, so they don't have to re-explain.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "A concise summary of the WHOLE conversation so far — the customer's issue/request and every relevant " +
            "detail they gave (name, order/tracking number, pickup & drop-off, item, timing, what they want). " +
            "Write it in the customer's voice (e.g. 'My parcel UW-123 is late and I'd like a refund'). This is " +
            "pre-filled into the WhatsApp message to our team.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "calculate_quote",
    description:
      "Calculate a GST-inclusive delivery price from the CDMS rate card. Call this once you know: the service " +
      "tier; an estimated driving distance in km (you estimate it from the pickup/drop-off addresses — it maps " +
      "to a delivery zone); the parcel weight in kg (ask, or estimate from the description); and any add-on " +
      "surcharges the customer needs. Returns the exact price.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", enum: ["eco", "std", "exp", "sameday", "night", "b2b"], description: "Service tier: eco=Economy 3-5d, std=Standard next-day, exp=Express same-day 4-6h, sameday=Same-Day Priority ≤3h, night=Overnight, b2b=B2B contract" },
        distance_km: { type: "number", description: "Estimated driving distance in km between pickup and drop-off" },
        weight_kg: { type: "number", description: "Parcel weight in kg (estimate if unknown, e.g. small box ≈ 2)" },
        surcharges: { type: "array", items: { type: "string", enum: ["afterhours", "fragile", "cod", "multistop", "pod", "redelivery"] }, description: "Optional add-ons that apply" },
      },
      required: ["service", "distance_km", "weight_kg"],
    },
  },
  {
    name: "create_whatsapp_booking",
    description:
      "Generate a WhatsApp hand-off link containing a booking summary. Call this ONLY after the user has " +
      "confirmed they want to proceed with a delivery booking/quote and you have collected their details. " +
      "It lets the user send the booking to the Urban Werkz team to finalise scheduling.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service type, e.g. Same-day, Scheduled, Business fleet, Regional" },
        pickup: { type: "string", description: "Pickup location/address" },
        dropoff: { type: "string", description: "Drop-off location/address" },
        item: { type: "string", description: "What is being delivered" },
        when: { type: "string", description: "Preferred pickup or delivery time" },
        name: { type: "string", description: "Customer name, if provided" },
        notes: { type: "string", description: "Any additional notes" },
      },
      required: ["service"],
    },
  },
];

function buildHandoffLink(summary) {
  const text = summary && String(summary).trim()
    ? `Hi Urban Werkz, I'd like some help: ${String(summary).trim()}`
    : "Hi Urban Werkz, I'd like to speak to someone about a delivery.";
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

function buildBookingLink(details) {
  const lines = ["Hi Urban Werkz, I'd like to book a delivery:"];
  const add = (label, val) => { if (val && String(val).trim()) lines.push(`• ${label}: ${String(val).trim()}`); };
  add("Service", details.service);
  add("Pickup", details.pickup);
  add("Drop-off", details.dropoff);
  add("Item", details.item);
  add("When", details.when);
  add("Name", details.name);
  add("Notes", details.notes);
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join("\n"))}`;
}

// --- Tiny in-memory rate limiter (per client IP) ---
const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 30;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_REQUESTS;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now > e.resetAt) hits.delete(ip);
}, WINDOW_MS).unref();

function textOf(message) {
  return message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

const app = express();
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => res.json({ ok: true, model: MODEL }));

app.post("/chat", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Too many messages. Please try again in a few minutes." });
  }

  const raw = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!raw || raw.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }
  const messages = raw
    .slice(-20)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "the last message must be from the user" });
  }

  try {
    let whatsappUrl = null, whatsappLabel = null, quoteInfo = null;
    // Short agentic loop so the model can call quote/handoff/booking tools, then reply.
    for (let i = 0; i < 4; i++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });
        const results = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          if (block.name === "calculate_quote") {
            const inp = block.input || {};
            const km = Math.max(0, Number(inp.distance_km) || 0);
            // Map driving distance to a CDMS zone: 1 ≤5km, 2 ≤12km, 3 ≤20km, 4 >20km.
            const zone = km <= 5 ? 1 : km <= 12 ? 2 : km <= 20 ? 3 : 4;
            const kg = Math.max(0.1, Number(inp.weight_kg) || 0.1);
            let reference, total, currency = "SGD", service = inp.service, sla = "", pdfUrl, ok = false;
            try {
              const r = await fetch(`${RATE_CARD_API}/quote`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tier: inp.service, zone, weightKg: kg }),
              });
              if (!r.ok) throw new Error(`rate-card ${r.status}`);
              const cq = await r.json();
              reference = cq.reference; total = cq.total; currency = cq.currency || "SGD";
              service = cq.serviceTier?.name || service; sla = cq.serviceTier?.sla || "";
              pdfUrl = `${RATE_CARD_API}/quote/${reference}/pdf`;
              quoteInfo = { reference, total, currency, pdfUrl };
              ok = true;
            } catch (e) {
              // Fallback to local compute if the CDMS rate-card API is unreachable.
              const q = computeQuote(await getPricing(), inp.service, inp.distance_km, kg, inp.surcharges || []);
              const id = storeQuote(q);
              reference = q.number; total = q.total; currency = q.currency; service = q.service; sla = q.sla;
              pdfUrl = `/api/quote/${id}.pdf`;
              quoteInfo = { id, reference, total, currency, pdfUrl };
            }
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content:
                `Quote ${reference}: ${currency} ${total} total, GST-inclusive (9%). ${service}` +
                (sla ? ` (${sla})` : "") + `, ~${km} km (zone ${zone}), ${kg} kg. ` +
                (ok ? "Priced from the live CDMS rate card. " : "") +
                `A downloadable PDF quotation is ready — tell the customer they can download it below. Quote ` +
                `this EXACT total; note re-weighing or zone changes at pickup may alter the final charge.`,
            });
          } else if (block.name === "whatsapp_handoff") {
            whatsappUrl = buildHandoffLink((block.input || {}).summary);
            whatsappLabel = "Chat with our team on WhatsApp";
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "A WhatsApp button to reach our team has been shown to the customer. Briefly let them know they can tap it to chat with a person.",
            });
          } else if (block.name === "create_whatsapp_booking") {
            whatsappUrl = buildBookingLink(block.input || {});
            whatsappLabel = "Send booking to WhatsApp";
            recordLead({ ...(block.input || {}), ip }); // record in the CRM (non-blocking)
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content:
                "WhatsApp hand-off link is ready. Tell the user their booking summary is prepared and to tap " +
                "the WhatsApp button to send it to the team to confirm scheduling.",
            });
          }
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      const reply = textOf(response);
      return res.json({
        reply: reply || "Tap the button below to continue. 😊",
        whatsappUrl, whatsappLabel, quote: quoteInfo,
      });
    }
    return res.json({
      reply: "Tap the button below to continue. 😊",
      whatsappUrl, whatsappLabel, quote: quoteInfo,
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(503).json({ error: "We're a bit busy right now — please try again shortly." });
    }
    console.error("chat error:", err?.status, err?.message);
    res.status(500).json({ error: "Something went wrong. Please WhatsApp us at +65 8996 8390." });
  }
});

// Downloadable PDF quotation for a previously calculated quote.
app.get("/quote/:file", (req, res) => {
  const id = String(req.params.file || "").replace(/\.pdf$/i, "");
  const q = quotes.get(id);
  if (!q) return res.status(404).send("Quotation not found or expired.");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${q.number}.pdf"`);

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(res);
  const cur = q.currency;
  const money = (n) => `${cur} ${Number(n).toFixed(2)}`;
  const NAVY = "#0f2530", TEAL = "#0ea5b7", GREY = "#6b7c85", LINE = "#e6ebee";

  // Header
  doc.fontSize(22).fillColor(NAVY).font("Helvetica-Bold").text("UrbanFleet SG", 50, 50);
  doc.fontSize(9).fillColor(GREY).font("Helvetica").text("URBAN WERKZ · COURIER & SAME-DAY DELIVERY", 50, 76);
  doc.fontSize(13).fillColor(NAVY).font("Helvetica-Bold").text(q.number, 0, 50, { align: "right" });
  doc.fontSize(10).fillColor(GREY).font("Helvetica").text(new Date(q._at).toLocaleDateString("en-SG", { day: "2-digit", month: "short", year: "numeric" }), 0, 68, { align: "right" });
  doc.text("Singapore · GST Reg.", 0, 82, { align: "right" });
  doc.moveTo(50, 100).lineTo(545, 100).lineWidth(2).strokeColor(TEAL).stroke();

  doc.fontSize(16).fillColor(NAVY).font("Helvetica-Bold").text("Delivery Service Quotation", 50, 116);

  // Info grid
  let y = 146;
  const info = [
    ["Service", q.service], ["Delivery window", q.sla],
    ["Zone", q.zone], ["Coverage", q.zoneDesc || "—"],
    ["Estimated distance", `~${q.km} km`], ["Parcel weight", `${q.kg} kg`],
  ];
  doc.fontSize(10.5).font("Helvetica");
  for (let i = 0; i < info.length; i += 2) {
    doc.fillColor(GREY).text(info[i][0] + ":", 50, y, { continued: true }).fillColor(NAVY).font("Helvetica-Bold").text(" " + info[i][1]);
    doc.font("Helvetica").fillColor(GREY).text(info[i + 1][0] + ":", 310, y, { continued: true }).fillColor(NAVY).font("Helvetica-Bold").text(" " + info[i + 1][1]);
    doc.font("Helvetica");
    y += 22;
  }

  // Line items
  y += 10;
  doc.rect(50, y, 495, 22).fill(NAVY);
  doc.fillColor("#fff").font("Helvetica-Bold").fontSize(10).text("DESCRIPTION", 60, y + 6).text("AMOUNT (SGD)", 0, y + 6, { align: "right", width: 535 });
  y += 22;
  const row = (label, amt, opts = {}) => {
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.big ? 12 : 10.5).fillColor(opts.bold ? NAVY : "#333");
    doc.text(label, 60, y + 6, { width: 380 });
    doc.text(money(amt), 0, y + 6, { align: "right", width: 535 });
    doc.moveTo(50, y + 24).lineTo(545, y + 24).lineWidth(0.5).strokeColor(LINE).stroke();
    y += 24;
  };
  row(`${q.service} delivery service charge`, q.deliveryCharge);
  row("Fuel surcharge", q.fuel);
  for (const a of q.addOns) row(a.label, a.amt);
  row("Subtotal (before GST)", q.subtotal, { bold: true });
  row(`GST (${q.gstRate}%)`, q.gst);
  doc.rect(50, y, 495, 28).fill("#f4f8f9");
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text("Total payable", 60, y + 8).text(money(q.total), 0, y + 8, { align: "right", width: 535 });
  y += 44;

  // Terms
  doc.fontSize(8.5).fillColor(GREY).font("Helvetica");
  doc.text("Validity: This quotation is valid for 14 days from the date of issue.", 50, y);
  doc.text("Terms: Prices are inclusive of GST. Rates are based on the details provided; re-weighing or zone changes at pickup may alter the final charge.", 50, y + 14, { width: 495 });
  doc.text("UrbanFleet SG · urbanfleetsg.com · WhatsApp +65 8996 8390 · Urbanfleet@gmail.com · Thank you for your business.", 50, y + 40, { width: 495 });

  doc.end();
});

// Daily AI SEO refresh: generate optimized SEO + FAQ from current context, push to the CMS.
const SEO_REFRESH_KEY = process.env.SEO_REFRESH_KEY || "";
const ADMIN_SEO_URL = process.env.ADMIN_SEO_URL || "http://admin:3000/cms/seo-refresh";
const SEO_TOOL = [{
  name: "publish_seo",
  description: "Publish the optimized SEO metadata and FAQ for the homepage.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "SEO <title>, <=60 chars ideally, includes 'Singapore' and the primary keyword. Must start with 'Urban Werkz Delivery'." },
      description: { type: "string", description: "Meta description, 140-160 chars, compelling, includes primary keywords and a call to action." },
      keywords: { type: "string", description: "8-12 comma-separated Singapore courier/delivery keywords and long-tail phrases." },
      faq: {
        type: "array",
        description: "5-6 FAQ entries targeting real Singapore search queries about courier/delivery.",
        items: { type: "object", properties: { q: { type: "string" }, a: { type: "string", description: "2-3 sentence answer, keyword-rich, accurate to the business." } }, required: ["q", "a"] },
      },
    },
    required: ["title", "description", "keywords", "faq"],
  },
}];

app.post("/seo-refresh", async (req, res) => {
  if (!SEO_REFRESH_KEY || req.headers["x-seo-key"] !== SEO_REFRESH_KEY) return res.status(401).json({ error: "unauthorized" });
  try {
    const p = await getPricing().catch(() => null);
    const tiers = p?.tiers ? p.tiers.map((t) => t.name).join(", ") : "Economy, Standard, Express, Same-Day Priority, Overnight, B2B";
    const context =
      `Business: Urban Werkz Delivery (also "UrbanFleet SG"), a tech-powered same-day & express last-mile courier in ` +
      `Singapore — website urbanfleetsg.com. Services: same-day/express delivery, scheduled & recurring delivery, ` +
      `dedicated business fleet, regional delivery up to ~200km. Features: real-time GPS tracking, ETA updates, ` +
      `delivery photos, digital proof of delivery, 24/7 availability, instant quotes + PDF. Service tiers: ${tiers}. ` +
      `Contact: WhatsApp/phone +65 8996 8390, email Urbanfleet@gmail.com.`;
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system:
        "You are an SEO specialist optimizing a Singapore courier/delivery homepage for Google. Produce accurate, " +
        "non-spammy, stable SEO that targets high-intent local queries (same-day delivery Singapore, courier Singapore, " +
        "parcel/express delivery, etc.). Keep the brand name. Never invent services, prices, or guarantees not in the context.",
      tools: SEO_TOOL,
      tool_choice: { type: "tool", name: "publish_seo" },
      messages: [{ role: "user", content: `Generate optimized homepage SEO + FAQ from this context:\n\n${context}` }],
    });
    const block = r.content.find((b) => b.type === "tool_use" && b.name === "publish_seo");
    if (!block) return res.status(502).json({ error: "no SEO generated" });
    const seo = block.input;
    const push = await fetch(ADMIN_SEO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-seo-key": SEO_REFRESH_KEY },
      body: JSON.stringify(seo),
    });
    const pushed = await push.json().catch(() => ({}));
    console.log(`[${new Date().toISOString()}] seo-refresh: "${seo.title}" faq=${seo.faq?.length} -> admin ${push.status}`);
    res.json({ ok: push.ok, title: seo.title, keywords: seo.keywords, faqCount: seo.faq?.length, admin: pushed });
  } catch (e) {
    console.error("seo-refresh failed:", e?.message);
    res.status(500).json({ error: e?.message || "seo-refresh failed" });
  }
});

app.listen(PORT, () => console.log(`urbanlog-chat listening on :${PORT} (model: ${MODEL})`));
