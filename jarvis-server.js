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
function newPairCode() {
  const code = Array.from(crypto.randomBytes(5)).map(b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("") + "-" +
               Array.from(crypto.randomBytes(5)).map(b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  const p = load("pair", []); p.push({ h: sha(code), exp: Date.now() + 15 * 60e3 }); save("pair", p.filter(x => x.exp > Date.now()));
  return code;
}
if (process.argv[2] === "pair") {
  const code = newPairCode();
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
function voiceId() {
  try { const v = load("voice", null); if (v && v.id) return v.id; } catch {}
  try { const v = rd("voice.id"); if (v) return v; } catch {}
  return "onwK4e9ZLuTAKqWW03F9";
}
async function ttsBuffer(text) {
  let key = ""; try { key = rd("elevenlabs.key"); } catch {}
  if (!key) return null;
  const voice = voiceId();
  const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voice) + "?output_format=mp3_44100_128", {
    method: "POST", headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", apply_text_normalization: "on", voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0, use_speaker_boost: true } })
  });
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}
async function greetText() {
  const b = berlin(), h = +b.hm.slice(0, 2);
  const fallback = (h < 11 ? "Guten Morgen" : h < 18 ? "Willkommen zurück" : "Guten Abend") + ", Sir. Alle Systeme sind online.";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": APIKEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODELS[0], max_tokens: 160, system: "Du bist JARVIS, der KI-Assistent von Luis. Er meldet sich gerade an seinem PC an. Begrüße ihn mit 'Sir': höflich, elegant, leicht trockener Humor. Maximal 3 kurze gesprochene Sätze: Begrüßung passend zur Tageszeit, dann das Wichtigste aus dem Lagebild (was heute noch offen ist). Uhrzeiten und Zahlen so, wie ein Mensch sie spricht. Kein Markdown, keine Emojis. Nur der gesprochene Text.",
        messages: [{ role: "user", content: "Lagebild: " + lagebild() }] })
    });
    if (r.ok) { const j = await r.json(); const t = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim(); if (t) return t.slice(0, 500); }
  } catch {}
  return fallback;
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

// ---------- App ausliefern (holt sich Updates selbst von GitHub) ----------
const APPSRC = process.env.JARVIS_APPSRC || "https://elmenchho.github.io/winterarc";
const WWW = path.join(DATA, "www");
const APPFILES = { "index.html": "text/html; charset=utf-8", "sw.js": "text/javascript; charset=utf-8", "manifest.webmanifest": "application/manifest+json",
  "icon-192.png": "image/png", "icon-512.png": "image/png", "apple-touch-icon.png": "image/png" };
async function appSync() {
  try { fs.mkdirSync(WWW, { recursive: true, mode: 0o755 }); } catch {}
  for (const f of Object.keys(APPFILES)) {
    try {
      const r = await fetch(APPSRC + "/" + f + "?t=" + Date.now(), { cache: "no-store" }); if (!r.ok) continue;
      const b = Buffer.from(await r.arrayBuffer()); if (!b.length || b.length > 8 * 1024 * 1024) continue;
      if (f === "index.html" && !/<html/i.test(b.toString("utf8", 0, 4000))) continue;
      const t = path.join(WWW, f + ".tmp"); fs.writeFileSync(t, b); fs.renameSync(t, path.join(WWW, f));
    } catch {}
  }
}
appSync(); setInterval(appSync, 10 * 60e3).unref();
function serveApp(req, res, p) {
  const f = p === "/" ? "index.html" : p.slice(1);
  if (!APPFILES[f]) return false;
  let b; try { b = fs.readFileSync(path.join(WWW, f)); } catch { if (f !== "index.html") return false; b = Buffer.from("<!doctype html><meta charset=utf-8><title>JARVIS</title><p style='font-family:system-ui;padding:40px'>JARVIS startet … in 1 Minute neu laden.</p>"); }
  res.writeHead(200, { "content-type": APPFILES[f], "cache-control": "no-cache", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    "referrer-policy": "no-referrer", "permissions-policy": "microphone=(self), camera=(), geolocation=()" });
  res.end(req.method === "HEAD" ? undefined : b); return true;
}

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
    if (!url.pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD")) { if (serveApp(req, res, url.pathname)) return; return send(res, 404, { error: "unbekannt" }); }

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
      if (cur && cur.data) { const h = new Date().toISOString().slice(0, 13); const bk = load("backups", []); if (!bk.length || bk[bk.length - 1].h !== h) { bk.push({ h, ts: cur.ts, data: cur.data }); save("backups", bk.slice(-48)); } }
      save("state", { ts: b.ts, data: b.data, by: dev.id }); return send(res, 200, { ok: true, ts: b.ts });
    }
    if (url.pathname === "/api/tts/status" && req.method === "GET") {
      let ok = false; try { ok = !!rd("elevenlabs.key"); } catch {} return send(res, 200, { ok });
    }
    if (url.pathname === "/api/pair/new" && req.method === "POST") {
      if (limited("pairnew:" + dev.id, 6, 3600e3)) return send(res, 429, { error: "Zu viele Codes. Später nochmal." });
      return send(res, 200, { code: newPairCode(), exp: 15 });
    }
    if (url.pathname === "/api/voices" && req.method === "GET") {
      let key = ""; try { key = rd("elevenlabs.key"); } catch {}
      if (!key) return send(res, 503, { error: "Keine Stimme eingerichtet." });
      const cur = voiceId();
      const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
      if (!r.ok) return send(res, 200, { current: cur, voices: [], note: "Liste nicht erlaubt (" + r.status + ")" });
      const j = await r.json();
      const voices = (j.voices || []).map(v => ({ id: v.voice_id, name: v.name, cat: v.category, lang: (v.labels && (v.labels.language || v.labels.accent)) || "" })).slice(0, 80);
      return send(res, 200, { current: cur, voices });
    }
    if (url.pathname === "/api/voice" && req.method === "PUT") {
      const b = await body(req), id = String((b && b.id) || "").trim();
      if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return send(res, 400, { error: "Voice-ID ungültig." });
      save("voice", { id, by: dev.id, at: Date.now() }); return send(res, 200, { ok: true, id });
    }
    if (url.pathname === "/api/stt" && req.method === "POST") {
      if (limited("stt:" + dev.id, 60, 600e3)) return send(res, 429, { error: "Kurz Pause." });
      let key = ""; try { key = rd("elevenlabs.key"); } catch {}
      if (!key) return send(res, 503, { error: "Keine Stimme eingerichtet." });
      const audio = await new Promise((ok, bad) => { let n = 0; const c = []; req.on("data", d => { n += d.length; if (n > 8 * 1024 * 1024) { bad(new Error("zu groß")); req.destroy(); } else c.push(d); }); req.on("end", () => ok(Buffer.concat(c))); req.on("error", bad); });
      if (audio.length < 1000) return send(res, 200, { text: "" });
      const ct = String(req.headers["content-type"] || "audio/webm").split(";")[0];
      const fd = new FormData();
      fd.append("model_id", "scribe_v1"); fd.append("language_code", "deu"); fd.append("tag_audio_events", "false");
      fd.append("file", new Blob([audio], { type: ct }), "rec." + (ct.includes("mp4") ? "mp4" : ct.includes("ogg") ? "ogg" : "webm"));
      const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: fd });
      const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
      if (!r.ok) return send(res, 502, { error: "Hören: " + t.slice(0, 160) });
      return send(res, 200, { text: String(j.text || "").trim() });
    }
    if (url.pathname === "/api/greet" && req.method === "POST") {
      if (limited("greet:" + dev.id, 10, 600e3)) return send(res, 429, { error: "Kurz Pause." });
      const text = await greetText(), buf = await ttsBuffer(text);
      if (!buf) return send(res, 200, { text });
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": buf.length, "cache-control": "no-store", "x-jarvis-text": encodeURIComponent(text).slice(0, 2000) }); return res.end(buf);
    }
    if (url.pathname === "/api/tts" && req.method === "POST") {
      if (limited("tts:" + dev.id, 40, 600e3)) return send(res, 429, { error: "Kurz Pause." });
      let key = ""; try { key = rd("elevenlabs.key"); } catch {}
      if (!key) return send(res, 503, { error: "Keine Stimme eingerichtet." });
      const voice = voiceId();
      const b = await body(req), text = String(b.text || "").replace(/\[[^\]]*\]/g, "").slice(0, 600).trim();
      if (!text) return send(res, 400, { error: "leer" });
      const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voice) + "?output_format=mp3_44100_128", {
        method: "POST", headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", apply_text_normalization: "on", voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0, use_speaker_boost: true } })
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
