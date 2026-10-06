#!/usr/bin/env node
// JARVIS Home-Base Server – zero dependencies (Node >= 20)
// Hält: Claude-API-Schlüssel, deine App-Daten (AES-256-GCM verschlüsselt auf der Platte), Geräte-Zugänge.
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DATA = process.env.JARVIS_DATA || "/var/lib/jarvis";
const KEYDIR = process.env.JARVIS_KEYS || "/etc/jarvis";
const PORT = +process.env.JARVIS_PORT || 8787;
const ORIGINS = (process.env.JARVIS_ORIGINS || "https://elmenchho.github.io").split(",");
const MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-opus-5-5"];
const MAX_TOKENS = 1500;
const MAX_BODY = 2 * 1024 * 1024;

const rd = f => fs.readFileSync(path.join(KEYDIR, f), "utf8").trim();
const MASTER = Buffer.from(rd("master.key"), "base64"); // 32 bytes
if (MASTER.length !== 32) { console.error("master.key ungültig"); process.exit(1); }

// ---------- verschlüsselte Ablage ----------
function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", MASTER, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function unseal(s) {
  const b = Buffer.from(s, "base64"), d = crypto.createDecipheriv("aes-256-gcm", MASTER, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
}
function load(name, def) { try { return unseal(fs.readFileSync(path.join(DATA, name + ".enc"), "utf8")); } catch { return def; } }
function save(name, obj) {
  const f = path.join(DATA, name + ".enc"), t = f + ".tmp";
  fs.writeFileSync(t, seal(obj), { mode: 0o600 }); fs.renameSync(t, f);
}
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

// ---------- Geräte & Kopplung ----------
// Kopplungscode erzeugen:  sudo -u jarvis node /opt/jarvis/jarvis-server.js pair
if (process.argv[2] === "pair") {
  const code = Array.from(crypto.randomBytes(5)).map(b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("") + "-" +
               Array.from(crypto.randomBytes(5)).map(b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  const p = load("pair", []); p.push({ h: sha(code), exp: Date.now() + 15 * 60e3 }); save("pair", p.filter(x => x.exp > Date.now()));
  console.log("\n  Kopplungscode (15 Min gültig, nur 1x):  " + code + "\n");
  process.exit(0);
}
if (process.argv[2] === "devices") { const d = load("devices", []); d.forEach(x => console.log(x.id, x.name, new Date(x.at).toLocaleString("de-DE"), x.last ? "zuletzt " + new Date(x.last).toLocaleString("de-DE") : "")); process.exit(0); }
if (process.argv[2] === "revoke") { const d = load("devices", []).filter(x => x.id !== process.argv[3]); save("devices", d); console.log("Entfernt. Verbleibend:", d.length); process.exit(0); }

const APIKEY = rd("anthropic.key");

// ---------- Rate-Limits ----------
const hits = new Map();
function limited(key, max, winMs) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < winMs); a.push(now); hits.set(key, a);
  return a.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// ---------- HTTP ----------
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok, bad) => {
    let n = 0; const c = [];
    req.on("data", d => { n += d.length; if (n > MAX_BODY) { bad(new Error("zu groß")); req.destroy(); } else c.push(d); });
    req.on("end", () => { try { ok(c.length ? JSON.parse(Buffer.concat(c).toString("utf8")) : {}); } catch { bad(new Error("kein JSON")); } });
    req.on("error", bad);
  });
}
function auth(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.authorization || ""); if (!m) return null;
  const h = sha(m[1]), devs = load("devices", []), d = devs.find(x => crypto.timingSafeEqual(Buffer.from(x.h), Buffer.from(h)));
  if (d && (!d.last || Date.now() - d.last > 600e3)) { d.last = Date.now(); save("devices", devs); }
  return d || null;
}

const server = http.createServer(async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/health") return send(res, 200, { ok: true, name: "JARVIS" });

    if (url.pathname === "/api/pair" && req.method === "POST") {
      if (limited("pair:" + ip, 5, 3600e3)) return send(res, 429, { error: "Zu viele Versuche. Später nochmal." });
      const b = await body(req), code = String(b.code || "").toUpperCase().trim();
      const p = load("pair", []), i = p.findIndex(x => x.exp > Date.now() && x.h === sha(code));
      if (i < 0) return send(res, 403, { error: "Code falsch oder abgelaufen." });
      p.splice(i, 1); save("pair", p);
      const token = crypto.randomBytes(32).toString("base64url"), id = crypto.randomBytes(4).toString("hex");
      const devs = load("devices", []); devs.push({ id, name: String(b.name || "Gerät").slice(0, 40), h: sha(token), at: Date.now() }); save("devices", devs);
      return send(res, 200, { token, id });
    }

    const dev = auth(req);
    if (!dev) { limited("bad:" + ip, 30, 600e3); return send(res, 401, { error: "Nicht gekoppelt." }); }
    if (limited("dev:" + dev.id, 240, 600e3)) return send(res, 429, { error: "Zu viele Anfragen." });

    if (url.pathname === "/api/state" && req.method === "GET") {
      const s = load("state", null); return send(res, 200, s || { ts: 0, data: null });
    }
    if (url.pathname === "/api/state" && req.method === "PUT") {
      const b = await body(req), cur = load("state", { ts: 0 });
      if (!b || typeof b.ts !== "number" || typeof b.data !== "object") return send(res, 400, { error: "ungültig" });
      if (b.ts < (cur.ts || 0)) return send(res, 409, cur);           // anderes Gerät war neuer
      save("state", { ts: b.ts, data: b.data, by: dev.id }); return send(res, 200, { ok: true, ts: b.ts });
    }
    if (url.pathname === "/api/claude" && req.method === "POST") {
      if (limited("claude:" + dev.id, 60, 600e3)) return send(res, 429, { error: "Kurz Pause, Boss." });
      const b = await body(req);
      const payload = {
        model: MODELS.includes(b.model) ? b.model : MODELS[0],
        max_tokens: Math.min(+b.max_tokens || 700, MAX_TOKENS),
        system: typeof b.system === "string" ? b.system.slice(0, 200000) : undefined,
        messages: Array.isArray(b.messages) ? b.messages.slice(-40) : [],
        tools: Array.isArray(b.tools) ? b.tools.slice(0, 16) : undefined
      };
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": APIKEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(payload)
      });
      const t = await r.text();
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(t);
    }
    return send(res, 404, { error: "unbekannt" });
  } catch (e) { return send(res, 400, { error: String(e && e.message || e).slice(0, 200) }); }
});
server.listen(PORT, "127.0.0.1", () => console.log("JARVIS läuft auf 127.0.0.1:" + PORT));
