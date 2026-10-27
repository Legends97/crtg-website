import pg from "pg";
import crypto from "node:crypto";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL, max: 1 });
const q = (t, p) => pool.query(t, p);

let ready;
const init = () => (ready ||= q(`create table if not exists users (
  id serial primary key,
  display_name text not null,
  discord_id text unique,
  steam_id text unique,
  role text not null default 'driver' check (role in ('admin','driver')),
  timezone text not null default 'Europe/Berlin',
  active boolean not null default true,
  created_at timestamptz not null default now()
)`).catch(e => { ready = null; throw e; }));

class HttpErr extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};
const redirect = (res, to) => { res.statusCode = 302; res.setHeader("Location", to); res.end(); };
const cookies = req => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map(c => {
  const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
}));
const setCookie = (res, name, value, maxAge) => {
  const c = `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  res.setHeader("Set-Cookie", [].concat(res.getHeader("Set-Cookie") || [], c));
};

// Sitzung: signiertes Cookie (HMAC), 7 Tage gültig
const sign = v => crypto.createHmac("sha256", process.env.SESSION_SECRET).update(v).digest("base64url");
const makeSession = uid => {
  const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 7 * 864e5 })).toString("base64url");
  return p + "." + sign(p);
};
function readSession(req) {
  const [p, s] = (cookies(req).crtg_session || "").split(".");
  if (!p || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString()); return d.exp > Date.now() ? d : null; } catch { return null; }
}
async function currentUser(req) {
  const s = readSession(req);
  return s ? (await q("select * from users where id=$1 and active", [s.uid])).rows[0] || null : null;
}
const pub = u => ({ id: u.id, display_name: u.display_name, role: u.role, discord_id: u.discord_id, steam_id: u.steam_id });

// Eingaben prüfen und vereinheitlichen
const normDiscord = v => {
  v = String(v ?? "").trim(); if (!v) return null;
  if (!/^\d{17,19}$/.test(v)) throw new HttpErr(400, "Discord-ID: 17 bis 19 Ziffern erwartet.");
  return v;
};
const normSteam = v => {
  v = String(v ?? "").trim(); if (!v) return null;
  const m = v.match(/^S?(7656119\d{10})$/i);
  if (!m) throw new HttpErr(400, "Steam-ID: 17 Ziffern, beginnt mit 7656119 (mit oder ohne S).");
  return "S" + m[1];
};
function clean(o) {
  const name = String(o.display_name ?? "").trim();
  if (!name || name.length > 60) throw new HttpErr(400, "Anzeigename fehlt oder ist zu lang (max. 60 Zeichen).");
  const role = o.role ?? "driver";
  if (!["admin", "driver"].includes(role)) throw new HttpErr(400, "Ungültige Rolle.");
  return { display_name: name, discord_id: normDiscord(o.discord_id), steam_id: normSteam(o.steam_id), role, active: o.active !== false };
}
async function ensureFree(field, val, exceptId) {
  if (!val) return;
  const r = await q(`select display_name from users where ${field}=$1 and ($2::int is null or id<>$2) limit 1`, [val, exceptId ?? null]);
  if (r.rows[0]) throw new HttpErr(409, `${field === "discord_id" ? "Diese Discord-ID" : "Diese Steam-ID"} ist schon mit „${r.rows[0].display_name}“ verknüpft.`);
}

// Discord-Login (OAuth2, nur Scope "identify")
const redirectUri = req => (process.env.BASE_URL || "https://" + req.headers.host).replace(/\/$/, "") + "/api/auth/callback";
function login(req, res) {
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(res, "crtg_state", state, 600);
  const p = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(req), scope: "identify", state });
  redirect(res, "https://discord.com/oauth2/authorize?" + p);
}
async function callback(req, res, url) {
  const st = cookies(req).crtg_state, code = url.searchParams.get("code");
  setCookie(res, "crtg_state", "", 0);
  if (!code || !st || st !== url.searchParams.get("state")) return redirect(res, "/login.html?error=state");
  const tr = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: redirectUri(req) }),
  });
  if (!tr.ok) return redirect(res, "/login.html?error=discord");
  const ur = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + (await tr.json()).access_token } });
  if (!ur.ok) return redirect(res, "/login.html?error=discord");
  const d = await ur.json();           // Die Discord-ID kommt nur von Discord, nie aus einem Formular
  let u = (await q("select * from users where discord_id=$1", [d.id])).rows[0];
  const admins = (process.env.ADMIN_DISCORD_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!u && admins.includes(d.id)) u = (await q("insert into users(display_name,discord_id,role) values($1,$2,'admin') returning *", [d.global_name || d.username, d.id])).rows[0];
  if (!u) return redirect(res, "/login.html?error=unknown");
  if (!u.active) return redirect(res, "/login.html?error=inactive");
  setCookie(res, "crtg_session", makeSession(u.id), 7 * 86400);
  redirect(res, "/");
}

// Admin: Fahrer verwalten
async function adminUsers(req, res, url, id) {
  const m = req.method, b = req.body || {};
  if (m === "GET" && id === undefined) {
    const s = (url.searchParams.get("q") || "").trim();
    const users = (await q(`select id,display_name,discord_id,steam_id,role,active,created_at from users
      where $1='' or display_name ilike '%'||$1||'%' or discord_id like '%'||$1||'%' or steam_id ilike '%'||$1||'%'
      order by active desc, lower(display_name)`, [s])).rows;
    const w = (await q("select count(*) filter (where discord_id is null) nd, count(*) filter (where steam_id is null) ns from users where active")).rows[0];
    return json(res, 200, { users, warnings: { noDiscord: +w.nd, noSteam: +w.ns } });
  }
  if (m === "POST" && id === undefined) {
    const v = clean(b);
    await ensureFree("discord_id", v.discord_id); await ensureFree("steam_id", v.steam_id);
    const r = await q("insert into users(display_name,discord_id,steam_id,role,active) values($1,$2,$3,$4,$5) returning *", [v.display_name, v.discord_id, v.steam_id, v.role, v.active]);
    return json(res, 201, r.rows[0]);
  }
  if (m === "PATCH" && id !== undefined) {
    const cur = (await q("select * from users where id=$1", [id])).rows[0];
    if (!cur) throw new HttpErr(404, "Fahrer nicht gefunden.");
    const v = clean({ ...cur, ...b });
    if (cur.role === "admin" && cur.active && (v.role !== "admin" || !v.active)) {
      const n = (await q("select count(*) from users where role='admin' and active and id<>$1", [id])).rows[0].count;
      if (+n === 0) throw new HttpErr(409, "Es muss mindestens ein aktiver Admin bleiben.");
    }
    await ensureFree("discord_id", v.discord_id, id); await ensureFree("steam_id", v.steam_id, id);
    const r = await q("update users set display_name=$1,discord_id=$2,steam_id=$3,role=$4,active=$5 where id=$6 returning *", [v.display_name, v.discord_id, v.steam_id, v.role, v.active, id]);
    return json(res, 200, r.rows[0]);
  }
  throw new HttpErr(404, "Nicht gefunden.");
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x"), path = url.pathname.replace(/\/+$/, "");
    if (path === "/api/v1/health") {
      let db = "ok";
      try { await init(); } catch (e) { db = "nicht erreichbar"; console.error(e); }
      const has = k => !!process.env[k];
      return json(res, 200, { status: "ok", db, env: {
        DATABASE_URL: has("DATABASE_URL") || has("POSTGRES_URL"),
        SESSION_SECRET: (process.env.SESSION_SECRET || "").length >= 32,
        DISCORD_CLIENT_ID: has("DISCORD_CLIENT_ID"),
        DISCORD_CLIENT_SECRET: has("DISCORD_CLIENT_SECRET"),
        ADMIN_DISCORD_IDS: has("ADMIN_DISCORD_IDS"),
      } });
    }
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new HttpErr(500, "SESSION_SECRET fehlt oder ist kürzer als 32 Zeichen.");
    await init();
    if (path === "/api/auth/login") return login(req, res);
    if (path === "/api/auth/callback") return await callback(req, res, url);
    const mutating = req.method !== "GET";
    if (mutating && !/application\/json/.test(req.headers["content-type"] || "")) throw new HttpErr(415, "JSON erwartet.");
    if (path === "/api/auth/logout" && req.method === "POST") { setCookie(res, "crtg_session", "", 0); return json(res, 200, { ok: true }); }
    const user = await currentUser(req);
    if (path === "/api/me") return user ? json(res, 200, pub(user)) : json(res, 401, { error: "Nicht angemeldet." });
    const am = path.match(/^\/api\/admin\/users(?:\/(\d+))?$/);
    if (am) {
      if (!user) throw new HttpErr(401, "Nicht angemeldet.");
      if (user.role !== "admin") throw new HttpErr(403, "Nur für Admins.");
      return await adminUsers(req, res, url, am[1] === undefined ? undefined : +am[1]);
    }
    throw new HttpErr(404, "Nicht gefunden.");
  } catch (e) {
    if (e instanceof HttpErr) return json(res, e.status, { error: e.message });
    if (e.code === "23505") return json(res, 409, { error: "Diese ID ist bereits vergeben." });
    console.error(e);
    json(res, 500, { error: "Serverfehler." });
  }
}
