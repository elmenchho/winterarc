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

// ---------- Web-Push ----------
let webpush = null;
try { webpush = require("/opt/jarvis/node_modules/web-push"); } catch { try { webpush = require("web-push"); } catch {} }
let VAPID = load("vapid", null);
if (webpush && !VAPID) { VAPID = webpush.generateVAPIDKeys(); save("vapid", VAPID); }
if (webpush && VAPID) webpush.setVapidDetails("mailto:jarvis@localhost", VAPID.publicKey, VAPID.privateKey);
async function pushAll(msg) {
  if (!webpush) return 0;
  const subs = load("subs", []); let ok = 0, keep = [];
  for (const s of subs) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(msg), { TTL: 3600, urgency: "high" }); ok++; keep.push(s); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(s); }
  }
  if (keep.length !== subs.length) save("subs", keep);
  return ok;
}

// ---------- Jarvis meldet sich selbst ----------
const SCHEDULE = [
  ["11:57", "Vormittag-Check: Was ist erledigt, was fehlt bis Mittag?"],
  ["12:57", "Nachmittag startet: Gym (vor 16 Uhr) und 2 Std Business."],
  ["14:57", "Gym-Check: Warst du schon trainieren?"],
  ["16:57", "Nachmittag-Check: Business und Essen."],
  ["19:27", "Abend: Abendessen, Lesen/Englisch, nichts Dummes."],
  ["21:25", "Abend-Check: Alles abhaken, Tagebuch."],
  ["21:57", "Handy weg. Schlafen."]
];
function berlin() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: p.year + "-" + p.month + "-" + p.day, hm: p.hour + ":" + p.minute, y: +p.year, m: +p.month, d: +p.day };
}
function lagebild() {
  const st = load("state", null), S = st && st.data; if (!S) return "Keine Daten.";
  const b = berlin(), day = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(2026, 9, 1)) / 864e5) + 1;
  const dd = (S.days || {})[day] || {}, h = dd.h || {};
  const done = Object.keys(h).filter(k => h[k]);
  const todos = (S.todos || []).filter(t => !t.done).slice(0, 5).map(t => t.t);
  const food = (dd.food || []).reduce((a, x) => a + (+x.k || 0), 0), prot = (dd.food || []).reduce((a, x) => a + (+x.p || 0), 0);
  const sd = dd.sd || {}, slots = S.slots || {}, open = [];
  for (const k of ["mo", "vm", "nm", "ab"]) for (const x of (slots[k] || [])) if (!sd[x.id]) open.push(x.n);
  return `Tag ${day}/90, ${b.hm} Uhr. Erledigte Habits: ${done.join(", ") || "keine"}. Offene Tagesplan-Punkte: ${open.slice(0, 8).join("; ") || "keine"}. Offene To-dos: ${todos.join("; ") || "keine"}. Essen: ${food} kcal, ${prot} g Eiweiß.`;
}
async function proactive(topic) {
  let body = topic;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": APIKEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODELS[0], max_tokens: 120, system: "Du bist JARVIS, persönlicher Assistent von Luis. Sprich ihn mit 'Boss' an, nie 'Kommandant'. Drill-Ton, motivierend, nie beleidigend. Schreib EINE Push-Nachricht: max. 2 kurze Sätze, max. 160 Zeichen, keine Emojis-Flut, konkret anhand der Daten (was noch offen ist). Nur der Nachrichtentext.",
        messages: [{ role: "user", content: "Anlass: " + topic + "\nLagebild: " + lagebild() }] })
    });
    if (r.ok) { const j = await r.json(); const t = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim(); if (t) body = t.slice(0, 240); }
  } catch {}
  return pushAll({ title: "JARVIS", body, tag: "jarvis-" + Date.now() });
}
setInterval(() => {
  const b = berlin(), sent = load("sent", {});
  for (const [hm, topic] of SCHEDULE) {
    const key = b.date + " " + hm;
    if (b.hm === hm && !sent[key]) { sent[key] = 1; save("sent", Object.fromEntries(Object.entries(sent).slice(-50))); proactive(topic).catch(() => {}); }
  }
}, 20e3).unref();

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
    if (url.pathname === "/api/tts/status" && req.method === "GET") {
      let ok = false; try { ok = !!rd("elevenlabs.key"); } catch {} return send(res, 200, { ok });
    }
    if (url.pathname === "/api/tts" && req.method === "POST") {
      if (limited("tts:" + dev.id, 40, 600e3)) return send(res, 429, { error: "Kurz Pause." });
      let key = ""; try { key = rd("elevenlabs.key"); } catch {}
      if (!key) return send(res, 503, { error: "Keine Stimme eingerichtet." });
      let voice = "onwK4e9ZLuTAKqWW03F9"; try { voice = rd("voice.id") || voice; } catch {}
      const b = await body(req), text = String(b.text || "").replace(/\[[^\]]*\]/g, "").slice(0, 600).trim();
      if (!text) return send(res, 400, { error: "leer" });
      const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voice) + "?output_format=mp3_44100_64", {
        method: "POST", headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } })
      });
      if (!r.ok) { const t = await r.text(); return send(res, r.status === 401 ? 502 : r.status, { error: "Stimme: " + t.slice(0, 160) }); }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": buf.length, "cache-control": "no-store" }); return res.end(buf);
    }
    if (url.pathname === "/api/push/key" && req.method === "GET") {
      return send(res, 200, { key: VAPID && webpush ? VAPID.publicKey : null });
    }
    if (url.pathname === "/api/push/sub" && req.method === "POST") {
      const b = await body(req); if (!b || !b.sub || !b.sub.endpoint) return send(res, 400, { error: "ungültig" });
      const subs = load("subs", []).filter(x => x.sub.endpoint !== b.sub.endpoint && x.dev !== dev.id);
      subs.push({ dev: dev.id, sub: b.sub, at: Date.now() }); save("subs", subs);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/push/test" && req.method === "POST") {
      const n = await proactive("Test: Begrüße den Boss kurz und sag, dass Push jetzt läuft."); return send(res, 200, { sent: n });
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
