// Lightweight CMS for the Urban Werkz Delivery site.
// Modules: SEO, Content, CRM (leads), Logo/Favicon. Data persists in DATA_DIR (a Docker volume).
// Auth: single admin user; password is bcrypt-hashed at startup from ADMIN_PASSWORD (never stored plaintext).
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
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10); // hashed in-memory; plaintext never persisted
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-please";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DEFAULTS = {
  seo: {
    title: "Urban Werkz Delivery | Fast, Tracked Deliveries Across the City",
    description: "Tech-Powered Last-Mile Logistics. Real-Time Tracking. Same-Day Service.",
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
  // Rate card the chatbot uses to quote. Editable in the CMS.
  pricing: {
    currency: "SGD",
    baseFare: 8,
    perKm: 0.8,
    minFare: 10,
    sizeSurcharge: { small: 0, medium: 3, large: 8 },
    serviceMultiplier: { sameday: 1.0, express: 1.4, scheduled: 0.85, regional: 1.2 },
  },
  leads: [],
};

function loadDB() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      ...DEFAULTS, ...parsed,
      seo: { ...DEFAULTS.seo, ...parsed.seo },
      content: { ...DEFAULTS.content, ...parsed.content },
      logo: { ...DEFAULTS.logo, ...parsed.logo },
      pricing: {
        ...DEFAULTS.pricing, ...(parsed.pricing || {}),
        sizeSurcharge: { ...DEFAULTS.pricing.sizeSurcharge, ...(parsed.pricing?.sizeSurcharge || {}) },
        serviceMultiplier: { ...DEFAULTS.pricing.serviceMultiplier, ...(parsed.pricing?.serviceMultiplier || {}) },
      },
      leads: parsed.leads || [],
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

const app = express();
app.set("trust proxy", 1); // behind nginx
app.use(express.json({ limit: "1mb" }));
app.use(cookieSession({
  name: "uwsess",
  keys: [SESSION_SECRET],
  maxAge: 8 * 60 * 60 * 1000, // 8h
  httpOnly: true,
  sameSite: "lax",
}));

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

// ---- Public: content for the live site + lead capture ----
app.get("/cms/site", (_req, res) => {
  res.json({
    seo: db.seo,
    content: db.content,
    logoUrl: db.logo.faviconFile ? `/cms/logo-file?v=${encodeURIComponent(db.logo.faviconFile)}` : null,
  });
});
app.get("/cms/logo-file", (_req, res) => {
  if (!db.logo.faviconFile) return res.status(404).end();
  const p = path.join(UPLOAD_DIR, db.logo.faviconFile);
  if (!p.startsWith(UPLOAD_DIR) || !fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});
app.get("/cms/pricing", (_req, res) => res.json(db.pricing));
app.post("/cms/lead", (req, res) => {
  const b = req.body || {};
  const lead = {
    id: `lead_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    createdAt: new Date().toISOString(),
    source: String(b.source || "website").slice(0, 40),
    name: String(b.name || "").slice(0, 200),
    contact: String(b.contact || "").slice(0, 200),
    service: String(b.service || "").slice(0, 200),
    pickup: String(b.pickup || "").slice(0, 300),
    dropoff: String(b.dropoff || "").slice(0, 300),
    item: String(b.item || "").slice(0, 300),
    when: String(b.when || "").slice(0, 200),
    notes: String(b.notes || "").slice(0, 1000),
  };
  db.leads.unshift(lead);
  if (db.leads.length > 1000) db.leads.length = 1000;
  saveDB();
  res.json({ ok: true, id: lead.id });
});

// ---- Admin (auth required) ----
app.get("/cms/content", requireAuth, (_req, res) => res.json({ seo: db.seo, content: db.content, pricing: db.pricing, logoUrl: db.logo.faviconFile ? `/cms/logo-file?v=${encodeURIComponent(db.logo.faviconFile)}` : null }));
app.put("/cms/content", requireAuth, (req, res) => {
  const { seo, content, pricing } = req.body || {};
  if (seo && typeof seo === "object") db.seo = { ...db.seo, ...pick(seo, ["title", "description"]) };
  if (content && typeof content === "object") {
    db.content = { ...db.content, ...pick(content, ["heroTitleTop", "heroTitleBottom", "heroSubtitle", "phone", "whatsapp", "email", "availability"]) };
  }
  if (pricing && typeof pricing === "object") db.pricing = sanitizePricing(pricing);
  saveDB();
  res.json({ ok: true, seo: db.seo, content: db.content, pricing: db.pricing });
});

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function sanitizePricing(p) {
  const cur = db.pricing;
  return {
    currency: (typeof p.currency === "string" && p.currency.trim()) ? p.currency.trim().slice(0, 8) : cur.currency,
    baseFare: num(p.baseFare, cur.baseFare),
    perKm: num(p.perKm, cur.perKm),
    minFare: num(p.minFare, cur.minFare),
    sizeSurcharge: {
      small: num(p.sizeSurcharge?.small, cur.sizeSurcharge.small),
      medium: num(p.sizeSurcharge?.medium, cur.sizeSurcharge.medium),
      large: num(p.sizeSurcharge?.large, cur.sizeSurcharge.large),
    },
    serviceMultiplier: {
      sameday: num(p.serviceMultiplier?.sameday, cur.serviceMultiplier.sameday),
      express: num(p.serviceMultiplier?.express, cur.serviceMultiplier.express),
      scheduled: num(p.serviceMultiplier?.scheduled, cur.serviceMultiplier.scheduled),
      regional: num(p.serviceMultiplier?.regional, cur.serviceMultiplier.regional),
    },
  };
}

app.get("/cms/leads", requireAuth, (_req, res) => res.json({ leads: db.leads }));
app.delete("/cms/leads/:id", requireAuth, (req, res) => {
  const before = db.leads.length;
  db.leads = db.leads.filter((l) => l.id !== req.params.id);
  saveDB();
  res.json({ ok: true, removed: before - db.leads.length });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `logo_${Date.now()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".png"}`),
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

app.listen(PORT, () => console.log(`urbanlog-admin (CMS) listening on :${PORT}`));
