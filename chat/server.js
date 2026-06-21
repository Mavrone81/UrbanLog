// Server-side Claude proxy for the Urban Werkz Delivery chatbot.
// The browser talks to THIS service; this service holds the API key and talks to Claude.
// The key is never sent to the browser and never committed to git.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

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

const PRICING_URL = process.env.PRICING_URL || ""; // CMS rate card the bot quotes from

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
  let net = costToServe * (1 + tier.mg);
  net += net * (Number(p.fuel) / 100); // fuel surcharge
  let addOn = 0;
  const addLines = [];
  for (const k of surchargeKeys || []) {
    const sc = (p.surcharges || []).find((s) => s.k === k);
    if (!sc) continue;
    const amt = sc.type === "pctNet" ? net * (Number(sc.v) / 100) : Number(sc.v);
    if (amt > 0) { addOn += amt; addLines.push(`${sc.label} ${p.currency} ${round2(amt)}`); }
  }
  const subtotal = net + addOn;
  const gst = subtotal * (Number(p.gst) / 100);
  const total = subtotal + gst;
  return { currency: p.currency || "SGD", tier, zone, km, kg: weight, addLines, subtotal: round2(subtotal), gst: round2(gst), total: round2(total) };
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
"SGD 18.50, incl. GST"), with the service SLA. Add that re-weighing or zone changes at pickup may adjust the \
final charge. Never invent a price without calling the tool.

BOOKINGS: After quoting (or whenever the user wants to proceed), gather pickup, drop-off, item, and preferred \
time (and their name if offered). When the user CONFIRMS, call create_whatsapp_booking with the details — this \
prepares a WhatsApp message to send to our team to finalise scheduling. Tell the user to tap the WhatsApp button. \
Pass through only details the user actually gave.

WHEN YOU CANNOT HELP: For things you genuinely cannot do — live tracking, account/order details, complaints, or \
anything needing a human — apologise briefly and point the user to WhatsApp +65 8996 8390 \
(https://wa.me/6589968390), phone (+65 8996 8390), or email (Urbanfleet@gmail.com).`;

const TOOLS = [
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
    let whatsappUrl = null;
    // Short agentic loop so the model can call quote/booking tools, then reply.
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
            const p = await getPricing();
            const inp = block.input || {};
            const q = computeQuote(p, inp.service, inp.distance_km, inp.weight_kg, inp.surcharges || []);
            const adds = q.addLines.length ? ` Add-ons: ${q.addLines.join(", ")}.` : "";
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content:
                `Quote: ${q.currency} ${q.total} total (incl. ${p.gst}% GST). ${q.tier.name} (${q.tier.sla}), ` +
                `${q.zone.name} (~${q.km} km), ${q.kg} kg.${adds} Subtotal ${q.currency} ${q.subtotal} + GST ` +
                `${q.currency} ${q.gst}. Quote this exact total to the customer; note re-weighing or zone changes ` +
                `at pickup may alter the final charge.`,
            });
          } else if (block.name === "create_whatsapp_booking") {
            whatsappUrl = buildBookingLink(block.input || {});
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
        reply: reply || "Your booking summary is ready — tap the WhatsApp button to send it to our team.",
        whatsappUrl,
      });
    }
    // Loop exhausted (shouldn't happen) — still hand off if we built a link.
    return res.json({
      reply: "Your booking summary is ready — tap the WhatsApp button to send it to our team.",
      whatsappUrl,
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(503).json({ error: "We're a bit busy right now — please try again shortly." });
    }
    console.error("chat error:", err?.status, err?.message);
    res.status(500).json({ error: "Something went wrong. Please WhatsApp us at +65 8996 8390." });
  }
});

app.listen(PORT, () => console.log(`urbanlog-chat listening on :${PORT} (model: ${MODEL})`));
