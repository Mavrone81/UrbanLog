// Server-side Claude proxy for the Urban Werkz Delivery chatbot.
// The browser talks to THIS service; this service holds the API key and talks to Claude.
// The key is never sent to the browser and never committed to git.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CHAT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS || 1024);
const WHATSAPP_NUMBER = "6589968390";

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

WHEN YOU CANNOT HELP: If a question is outside what you can answer — live tracking, exact prices, account/order \
details, complaints, or anything needing a human — DO NOT guess. Apologise briefly and suggest the user reach \
our team on WhatsApp at +65 8996 8390 (https://wa.me/6589968390), or by phone (+65 8996 8390) or email \
(Urbanfleet@gmail.com). Never invent specific prices or delivery guarantees; give ranges and point to a quote.

BOOKINGS: When a user wants to book a delivery or get a real quote, gather the key details conversationally: \
service type, pickup location, drop-off location, what's being sent, and preferred time (and their name if they \
offer it). Once the user CONFIRMS they want to proceed, call the create_whatsapp_booking tool with the details \
you have collected — this prepares a WhatsApp message they can send to our team to finalise scheduling. After \
the tool runs, tell the user their booking summary is ready and to tap the WhatsApp button to send it. Do not \
fabricate details the user did not give; pass through only what you collected.`;

const TOOLS = [
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
    // Short agentic loop so the model can call the booking tool, then reply.
    for (let i = 0; i < 3; i++) {
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
          if (block.type === "tool_use" && block.name === "create_whatsapp_booking") {
            whatsappUrl = buildBookingLink(block.input || {});
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
