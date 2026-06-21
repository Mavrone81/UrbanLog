// Lightweight CMS for the Urban Werkz / UrbanFleet SG site.
// Modules: SEO, Content, Pricing (CDMS rate card), CRM (leads), Logo, Visitors (IP tracking).
// Data persists in DATA_DIR (a Docker volume). Auth: single admin user, bcrypt-hashed at startup.
import express from "express";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "/data";
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "cms.json");

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "P@55w0rd888";
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-please";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// CDMS rate card (digested from the CDMS Rate Card Dashboard). Reference direct cost is the
// sum of the dashboard's cost components ($7.75). Editable in the CMS.
const DEFAULT_PRICING = {
  currency: "SGD",
  gst: 9,
  fuel: 6,
  refCost: 7.75,
  zones: [
    { k: 1, name: "Zone 1", desc: "Same district · ≤5 km", maxKm: 5, m: 1.0 },
    { k: 2, name: "Zone 2", desc: "Adjacent regions · 5–12 km", maxKm: 12, m: 1.25 },
    { k: 3, name: "Zone 3", desc: "Cross-island · 12–20 km", maxKm: 20, m: 1.55 },
    { k: 4, name: "Zone 4", desc: "Outlying · Tuas/Changi/Sentosa · 20 km+", maxKm: 9999, m: 1.9 },
  ],
  weights: [
    { name: "0–3 kg", max: 3, s: 0.0 },
    { name: "3–5 kg", max: 5, s: 1.2 },
    { name: "5–10 kg", max: 10, s: 2.8 },
    { name: "10–20 kg", max: 20, s: 5.5 },
    { name: "20–30 kg", max: 30, s: 9.0 },
    { name: "30 kg+", max: 99999, s: 9.0, perKg: 0.4 },
  ],
  tiers: [
    { k: "eco", name: "Economy", sla: "3–5 business days · batched", cm: 0.8, mg: 0.25 },
    { k: "std", name: "Standard", sla: "Next business day", cm: 1.0, mg: 0.35 },
    { k: "exp", name: "Express", sla: "Same day · 4–6 h", cm: 1.45, mg: 0.45 },
    { k: "sameday", name: "Same-Day Priority", sla: "Dedicated · ≤3 h", cm: 1.85, mg: 0.55 },
    { k: "night", name: "Overnight", sla: "Eve pickup → before 9 am", cm: 1.3, mg: 0.4 },
    { k: "b2b", name: "B2B Contract", sla: "Volume · route density", cm: 0.95, mg: 0.22 },
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

const DEFAULTS = {
  seo: {
    title: "Urban Werkz Delivery | Same-Day Courier & Tracked Delivery in Singapore",
    description: "Urban Werkz Delivery (UrbanFleet SG) — tech-powered last-mile courier in Singapore. Same-day & express delivery, real-time GPS tracking, instant quotes. Get a quote on WhatsApp.",
  },
  content: {
    heroTitleTop: "Fast, Tracked Deliveries",
    heroTitleBottom: "Across the City",
    heroSubtitle: "Tech-Powered Last-Mile Logistics • Real-Time Tracking • Same-Day Service",
    phone: "+65 8996 8390",
    whatsapp: "6589968390",
    email: "Urbanfleet@gmail.com",
    availability: "Available 24/7 for urgent deliveries",
  },
  logo: { faviconFile: null },
  pricing: DEFAULT_PRICING,
  leads: [],
  visitors: {}, // keyed by IP: { ip, first, last, count, ua }
};

function loadDB() {
  try {
    const p = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      ...DEFAULTS, ...p,
      seo: { ...DEFAULTS.seo, ...p.seo },
      content: { ...DEFAULTS.content, ...p.content },
      logo: { ...DEFAULTS.logo, ...p.logo },
      pricing: p.pricing && p.pricing.tiers ? p.pricing : DEFAULT_PRICING,
      leads: p.leads || [],
      visitors: p.visitors || {},
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}
let db = loadDB();
function saveDB() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
// Visitor writes are frequent — persist them on a throttle instead of every hit.
let visitorsDirty = false;
setInterval(() => { if (visitorsDirty) { visitorsDirty = false; saveDB(); } }, 15000).unref();

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";
}
function recordVisit(req) {
  const ip = clientIp(req);
  const now = new Date().toISOString();
  const v = db.visitors[ip] || { ip, first: now, count: 0, ua: "" };
  v.count += 1;
  v.last = now;
  v.ua = String(req.headers["user-agent"] || "").slice(0, 250);
  db.visitors[ip] = v;
  // Cap unique IPs — drop the least-recently-seen.
  const keys = Object.keys(db.visitors);
  if (keys.length > 5000) {
    keys.sort((a, b) => (db.visitors[a].last < db.visitors[b].last ? -1 : 1));
    for (let i = 0; i < keys.length - 5000; i++) delete db.visitors[keys[i]];
  }
  visitorsDirty = true;
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieSession({ name: "uwsess", keys: [SESSION_SECRET], maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax" }));

function requireAuth(req, res, next) {
  if (req.session?.user === ADMIN_USER) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

// ---- Auth ----
app.post("/cms/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && typeof password === "string" && bcrypt.compareSync(password, ADMIN_HASH)) {
    req.session.user = ADMIN_USER;
    return res.json({ ok: true, user: ADMIN_USER });
  }
  return res.status(401).json({ error: "Invalid username or password" });
});
app.post("/cms/logout", (req, res) => { req.session = null; res.json({ ok: true }); });
app.get("/cms/me", (req, res) => res.json({ user: req.session?.user || null }));

// ---- Public ----
app.get("/cms/site", (req, res) => {
  recordVisit(req); // every page load pings this — track the visitor IP
  res.json({
    seo: db.seo,
    content: db.content,
    logoUrl: db.logo.faviconFile ? `/cms/logo-file?v=${encodeURIComponent(db.logo.faviconFile)}` : null,
  });
});
app.get("/cms/pricing", (_req, res) => res.json(db.pricing));
app.get("/cms/logo-file", (_req, res) => {
  if (!db.logo.faviconFile) return res.status(404).end();
  const p = path.join(UPLOAD_DIR, db.logo.faviconFile);
  if (!p.startsWith(UPLOAD_DIR) || !fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});
app.post("/cms/lead", (req, res) => {
  const b = req.body || {};
  const lead = {
    id: `lead_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    createdAt: new Date().toISOString(),
    ip: String(b.ip || clientIp(req)).slice(0, 60),
    source: String(b.source || "website").slice(0, 40),
    name: String(b.name || "").slice(0, 200),
    contact: String(b.contact || "").slice(0, 200),
    service: String(b.service || "").slice(0, 200),
    pickup: String(b.pickup || "").slice(0, 300),
    dropoff: String(b.dropoff || "").slice(0, 300),
    item: String(b.item || "").slice(0, 300),
    when: String(b.when || "").slice(0, 200),
    quote: String(b.quote || "").slice(0, 120),
    notes: String(b.notes || "").slice(0, 1000),
  };
  db.leads.unshift(lead);
  if (db.leads.length > 1000) db.leads.length = 1000;
  saveDB();
  res.json({ ok: true, id: lead.id });
});

// ---- Admin (auth) ----
app.get("/cms/content", requireAuth, (_req, res) => res.json({ seo: db.seo, content: db.content, pricing: db.pricing, logoUrl: db.logo.faviconFile ? `/cms/logo-file?v=${encodeURIComponent(db.logo.faviconFile)}` : null }));
app.put("/cms/content", requireAuth, (req, res) => {
  const { seo, content, pricing } = req.body || {};
  if (seo && typeof seo === "object") db.seo = { ...db.seo, ...pick(seo, ["title", "description"]) };
  if (content && typeof content === "object") db.content = { ...db.content, ...pick(content, ["heroTitleTop", "heroTitleBottom", "heroSubtitle", "phone", "whatsapp", "email", "availability"]) };
  if (pricing && typeof pricing === "object") db.pricing = normalizePricing(pricing);
  saveDB();
  res.json({ ok: true, seo: db.seo, content: db.content, pricing: db.pricing });
});

app.get("/cms/leads", requireAuth, (_req, res) => res.json({ leads: db.leads }));
app.delete("/cms/leads/:id", requireAuth, (req, res) => {
  const before = db.leads.length;
  db.leads = db.leads.filter((l) => l.id !== req.params.id);
  saveDB();
  res.json({ ok: true, removed: before - db.leads.length });
});

app.get("/cms/visitors", requireAuth, (_req, res) => {
  const list = Object.values(db.visitors).sort((a, b) => (a.last < b.last ? 1 : -1));
  res.json({ total: list.length, visitors: list.slice(0, 1000) });
});
app.delete("/cms/visitors", requireAuth, (_req, res) => { db.visitors = {}; saveDB(); res.json({ ok: true }); });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `logo_${Date.now()}${(path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "")) || ".png"}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
app.post("/cms/logo", requireAuth, upload.single("logo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "An image file is required" });
  db.logo.faviconFile = req.file.filename;
  saveDB();
  res.json({ ok: true, logoUrl: `/cms/logo-file?v=${encodeURIComponent(req.file.filename)}` });
});

// ---- Admin UI ----
app.use("/admin", express.static(path.join(__dirname, "public")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/cms/health", (_req, res) => res.json({ ok: true }));

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (typeof obj[k] === "string") out[k] = obj[k].slice(0, 2000);
  return out;
}
function num(v, fb) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function normalizePricing(p) {
  const cur = db.pricing;
  const zones = Array.isArray(p.zones) && p.zones.length ? p.zones : cur.zones;
  const tiers = Array.isArray(p.tiers) && p.tiers.length ? p.tiers : cur.tiers;
  const weights = Array.isArray(p.weights) && p.weights.length ? p.weights : cur.weights;
  const surcharges = Array.isArray(p.surcharges) && p.surcharges.length ? p.surcharges : cur.surcharges;
  return {
    currency: (typeof p.currency === "string" && p.currency.trim()) ? p.currency.trim().slice(0, 8) : cur.currency,
    gst: num(p.gst, cur.gst),
    fuel: num(p.fuel, cur.fuel),
    refCost: num(p.refCost, cur.refCost),
    zones: zones.map((z, i) => ({ k: num(z.k, i + 1), name: String(z.name || cur.zones[i]?.name || `Zone ${i + 1}`).slice(0, 40), desc: String(z.desc || "").slice(0, 80), maxKm: num(z.maxKm, cur.zones[i]?.maxKm ?? 9999), m: num(z.m, 1) })),
    weights: weights.map((w, i) => ({ name: String(w.name || cur.weights[i]?.name || "").slice(0, 40), max: num(w.max, cur.weights[i]?.max ?? 99999), s: num(w.s, 0), ...(w.perKg != null ? { perKg: num(w.perKg, 0) } : (cur.weights[i]?.perKg != null ? { perKg: cur.weights[i].perKg } : {})) })),
    tiers: tiers.map((t, i) => ({ k: String(t.k || cur.tiers[i]?.k || `t${i}`).slice(0, 20), name: String(t.name || "").slice(0, 40), sla: String(t.sla || "").slice(0, 80), cm: num(t.cm, 1), mg: num(t.mg, 0.3) })),
    surcharges: surcharges.map((s, i) => ({ k: String(s.k || cur.surcharges[i]?.k || `s${i}`).slice(0, 20), label: String(s.label || "").slice(0, 60), type: s.type === "pctNet" ? "pctNet" : "flat", v: num(s.v, 0) })),
  };
}

app.listen(PORT, () => console.log(`urbanlog-admin (CMS) listening on :${PORT}`));
