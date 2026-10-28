import pg from "pg";
import crypto from "node:crypto";
import { computeStintFuel, lapSeconds } from "./_lib/fuel.js";
import { computeBlocks, recomputeReminders, distributeFreeStints, hasOverlap } from "./_lib/stints.js";

// Feste Admin-IDs, direkt im Code statt als Env Var
const ADMIN_DISCORD_IDS = [
  "755740275627786270", // Benni
  "489500699676377088", // Legends
];

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
)`).then(() => q(`alter table users add column if not exists car_number integer`))
  .then(() => q(`create table if not exists stint_plans (
  id serial primary key,
  name text,
  track text not null default 'Spa-Francorchamps',
  h int not null default 3,
  m int not null default 0,
  stint int not null default 40,
  start text not null default '',
  lap text not null default '',
  drivers jsonb not null default '["Fahrer 1","Fahrer 2","Fahrer 3"]',
  assign jsonb not null default '[]',
  is_current boolean not null default false,
  updated_at timestamptz not null default now()
)`))
  .then(() => q(`insert into stint_plans(is_current) select true where not exists (select 1 from stint_plans where is_current)`))
  .then(() => q(`create table if not exists events (
  id serial primary key,
  name text not null,
  track text not null default 'Spa-Francorchamps',
  car_class text not null default '',
  start_at timestamptz not null,
  duration_minutes int not null check (duration_minutes > 0 and duration_minutes % 60 = 0),
  signup_opens_at timestamptz not null,
  signup_closes_at timestamptz not null,
  signup_opens_offset_minutes int,
  signup_closes_offset_minutes int,
  status text not null default 'draft' check (status in ('draft','signup','assigning','locked','done','cancelled')),
  reminder_lead_times int[] not null default '{1440,120,20}',
  guild_id text,
  voice_channel_id text,
  lap_seconds numeric,
  fuel_cons_per_lap numeric,
  tank_liters numeric,
  fuel_reserve_laps int not null default 1,
  created_by int references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)`))
  .then(() => q(`create table if not exists stints (
  id serial primary key,
  event_id int not null references events(id) on delete cascade,
  number int not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  duration_minutes int not null default 60,
  fuel_liters numeric,
  pit_stops int not null default 0,
  assigned_user_id int references users(id),
  assignment_source text check (assignment_source in ('self','admin','auto')),
  assigned_at timestamptz,
  unique(event_id, number)
)`))
  .then(() => q(`create index if not exists stints_user_idx on stints(assigned_user_id)`))
  .then(() => q(`create table if not exists reminders (
  id serial primary key,
  event_id int not null references events(id) on delete cascade,
  user_id int not null references users(id),
  first_stint_number int not null,
  last_stint_number int not null,
  lead_time_minutes int not null,
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  sent_at timestamptz,
  discord_message_id text,
  error_text text,
  created_at timestamptz not null default now()
)`))
  .then(() => q(`create index if not exists reminders_due_idx on reminders(status, due_at)`))
  .then(() => q(`create unique index if not exists reminders_pending_uidx on reminders(event_id, user_id, lead_time_minutes, first_stint_number) where status = 'pending'`))
  .then(() => q(`create table if not exists settings (
  id int primary key default 1 check (id = 1),
  guild_id text,
  default_voice_channel_id text,
  bot_token_hash text,
  bot_token_created_at timestamptz
)`))
  .then(() => q(`insert into settings(id) values (1) on conflict do nothing`))
  .then(() => q(`create table if not exists audit_log (
  id serial primary key,
  user_id int references users(id),
  action text not null,
  target text not null,
  detail jsonb,
  created_at timestamptz not null default now()
)`))
  .catch(e => { ready = null; throw e; }));

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
const requireAdmin = user => {
  if (!user) throw new HttpErr(401, "Nicht angemeldet.");
  if (user.role !== "admin") throw new HttpErr(403, "Nur für Admins.");
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
const pub = u => ({ id: u.id, display_name: u.display_name, role: u.role, discord_id: u.discord_id, steam_id: u.steam_id, car_number: u.car_number });

// Dual-Auth für Routen, die sowohl vom Discord-Bot (Bot-Token) als auch per Session genutzt werden
async function authEither(req) {
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/);
  if (m) {
    const hash = crypto.createHash("sha256").update(m[1]).digest("hex");
    const row = (await q("select bot_token_hash from settings where id=1")).rows[0];
    const a = Buffer.from(hash), b = Buffer.from(row?.bot_token_hash || "", "utf8");
    if (!row?.bot_token_hash || a.length !== b.length || !crypto.timingSafeEqual(a, b))
      throw new HttpErr(401, "Ungültiger Bot-Token.");
    return { bot: true, user: null };
  }
  const user = await currentUser(req);
  if (!user) throw new HttpErr(401, "Nicht angemeldet.");
  return { bot: false, user };
}

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
const normNumber = v => {
  v = String(v ?? "").trim(); if (!v) return null;
  if (!/^\d{1,3}$/.test(v)) throw new HttpErr(400, "Startnummer: 1 bis 3 Ziffern (0–999).");
  return +v;
};
function clean(o) {
  const name = String(o.display_name ?? "").trim();
  if (!name || name.length > 60) throw new HttpErr(400, "Anzeigename fehlt oder ist zu lang (max. 60 Zeichen).");
  const role = o.role ?? "driver";
  if (!["admin", "driver"].includes(role)) throw new HttpErr(400, "Ungültige Rolle.");
  return { display_name: name, discord_id: normDiscord(o.discord_id), steam_id: normSteam(o.steam_id), car_number: normNumber(o.car_number), role, active: o.active !== false };
}
async function ensureFree(field, val, exceptId) {
  if (!val) return;
  const r = await q(`select display_name from users where ${field}=$1 and ($2::int is null or id<>$2) limit 1`, [val, exceptId ?? null]);
  if (r.rows[0]) throw new HttpErr(409, `${field === "discord_id" ? "Diese Discord-ID" : field === "steam_id" ? "Diese Steam-ID" : "Diese Startnummer"} ist schon mit „${r.rows[0].display_name}“ vergeben.`);
}

// Stintplan: genau ein Plan ist is_current=true (der live-Plan, den Fahrer lesen), benannte Pläne sind die Bibliothek
const planPub = p => ({ track: p.track, h: p.h, m: p.m, stint: p.stint, start: p.start, lap: p.lap, drivers: p.drivers, assign: p.assign });
const currentPlan = async () => (await q("select * from stint_plans where is_current limit 1")).rows[0];
function normPlan(o) {
  const drivers = Array.isArray(o.drivers) ? o.drivers.map(String).slice(0, 50) : [];
  const assign = Array.isArray(o.assign) ? o.assign.map(x => Number.isInteger(x) ? x : -1).slice(0, 500) : [];
  return {
    track: String(o.track ?? "").trim().slice(0, 80) || "Spa-Francorchamps",
    h: Math.max(0, Math.min(48, +o.h || 0)),
    m: Math.max(0, Math.min(59, +o.m || 0)),
    stint: Math.max(1, Math.min(600, +o.stint || 40)),
    start: String(o.start ?? "").trim().slice(0, 5),
    lap: String(o.lap ?? "").trim().slice(0, 20),
    drivers, assign,
  };
}
async function saveCurrentPlan(v) {
  const r = await q(`update stint_plans set track=$1,h=$2,m=$3,stint=$4,start=$5,lap=$6,drivers=$7,assign=$8,updated_at=now() where is_current=true returning *`,
    [v.track, v.h, v.m, v.stint, v.start, v.lap, JSON.stringify(v.drivers), JSON.stringify(v.assign)]);
  return r.rows[0];
}
async function adminPlans(req, res, url, id, action) {
  const m = req.method, b = req.body || {};
  if (m === "GET" && id === undefined) {
    const r = await q("select id,name,track,updated_at from stint_plans where is_current=false order by updated_at desc");
    return json(res, 200, r.rows);
  }
  if (m === "POST" && id === undefined) {
    const name = String(b.name ?? "").trim().slice(0, 60);
    if (!name) throw new HttpErr(400, "Name fehlt.");
    const cur = await currentPlan();
    const r = await q(`insert into stint_plans(name,track,h,m,stint,start,lap,drivers,assign,is_current) values($1,$2,$3,$4,$5,$6,$7,$8,$9,false) returning id,name,track,updated_at`,
      [name, cur.track, cur.h, cur.m, cur.stint, cur.start, cur.lap, JSON.stringify(cur.drivers), JSON.stringify(cur.assign)]);
    return json(res, 201, r.rows[0]);
  }
  if (m === "POST" && id !== undefined && action === "load") {
    const snap = (await q("select * from stint_plans where id=$1 and is_current=false", [id])).rows[0];
    if (!snap) throw new HttpErr(404, "Plan nicht gefunden.");
    return json(res, 200, planPub(await saveCurrentPlan(snap)));
  }
  if (m === "DELETE" && id !== undefined) {
    await q("delete from stint_plans where id=$1 and is_current=false", [id]);
    return json(res, 200, { ok: true });
  }
  throw new HttpErr(404, "Nicht gefunden.");
}

// Discord-Login (OAuth2): jedes Mitglied des Discord-Servers DISCORD_GUILD_ID darf sich anmelden,
// Admin-Rechte gibt es nur für die festen IDs in ADMIN_DISCORD_IDS.
const redirectUri = req => (process.env.BASE_URL || "https://" + req.headers.host).replace(/\/$/, "") + "/api/auth/callback";
function login(req, res) {
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(res, "crtg_state", state, 600);
  const p = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(req), scope: "identify guilds", state });
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
  const { access_token } = await tr.json();
  const auth = { headers: { Authorization: "Bearer " + access_token } };
  const ur = await fetch("https://discord.com/api/users/@me", auth);
  if (!ur.ok) return redirect(res, "/login.html?error=discord");
  const d = await ur.json();           // Die Discord-ID kommt nur von Discord, nie aus einem Formular
  const gr = await fetch("https://discord.com/api/users/@me/guilds", auth);
  if (!gr.ok) return redirect(res, "/login.html?error=discord");
  const guilds = await gr.json();
  if (!guilds.some(g => g.id === process.env.DISCORD_GUILD_ID)) return redirect(res, "/login.html?error=guild");
  const role = ADMIN_DISCORD_IDS.includes(d.id) ? "admin" : "driver";
  let u = (await q("select * from users where discord_id=$1", [d.id])).rows[0];
  if (!u) u = (await q("insert into users(display_name,discord_id,role) values($1,$2,$3) returning *", [d.global_name || d.username, d.id, role])).rows[0];
  else if (u.role !== role) u = (await q("update users set role=$1 where id=$2 returning *", [role, u.id])).rows[0];
  if (!u.active) return redirect(res, "/login.html?error=inactive");
  setCookie(res, "crtg_session", makeSession(u.id), 7 * 86400);
  redirect(res, "/");
}

// Steam-Verknüpfung (OpenID 2.0, kein API-Key nötig): hängt die SteamID64 an den eingeloggten Nutzer
function steamLogin(req, res, user) {
  if (!user) return redirect(res, "/login.html");
  const base = (process.env.BASE_URL || "https://" + req.headers.host).replace(/\/$/, "");
  const p = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": base + "/api/auth/steam/callback",
    "openid.realm": base,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  redirect(res, "https://steamcommunity.com/openid/login?" + p);
}
async function steamCallback(req, res, url, user) {
  if (!user) return redirect(res, "/login.html");
  const p = new URLSearchParams(url.search);
  p.set("openid.mode", "check_authentication");
  const vr = await fetch("https://steamcommunity.com/openid/login", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: p,
  });
  const claimed = url.searchParams.get("openid.claimed_id") || "";
  const m = claimed.match(/\/id\/(\d{17})$/);
  if (!vr.ok || !/is_valid\s*:\s*true/.test(await vr.text()) || !m) return redirect(res, "/?error=steam");
  const steamId = normSteam(m[1]);
  await ensureFree("steam_id", steamId, user.id);
  await q("update users set steam_id=$1 where id=$2", [steamId, user.id]);
  redirect(res, "/");
}

// Admin: Fahrer verwalten
async function adminUsers(req, res, url, id) {
  const m = req.method, b = req.body || {};
  if (m === "GET" && id === undefined) {
    const s = (url.searchParams.get("q") || "").trim();
    const users = (await q(`select id,display_name,discord_id,steam_id,car_number,role,active,created_at from users
      where $1='' or display_name ilike '%'||$1||'%' or discord_id like '%'||$1||'%' or steam_id ilike '%'||$1||'%'
      order by active desc, lower(display_name)`, [s])).rows;
    const w = (await q("select count(*) filter (where discord_id is null) nd, count(*) filter (where steam_id is null) ns from users where active")).rows[0];
    return json(res, 200, { users, warnings: { noDiscord: +w.nd, noSteam: +w.ns } });
  }
  if (m === "POST" && id === undefined) {
    const v = clean(b);
    await ensureFree("discord_id", v.discord_id); await ensureFree("steam_id", v.steam_id); await ensureFree("car_number", v.car_number);
    const r = await q("insert into users(display_name,discord_id,steam_id,car_number,role,active) values($1,$2,$3,$4,$5,$6) returning *", [v.display_name, v.discord_id, v.steam_id, v.car_number, v.role, v.active]);
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
    await ensureFree("discord_id", v.discord_id, id); await ensureFree("steam_id", v.steam_id, id); await ensureFree("car_number", v.car_number, id);
    const r = await q("update users set display_name=$1,discord_id=$2,steam_id=$3,car_number=$4,role=$5,active=$6 where id=$7 returning *", [v.display_name, v.discord_id, v.steam_id, v.car_number, v.role, v.active, id]);
    return json(res, 200, r.rows[0]);
  }
  throw new HttpErr(404, "Nicht gefunden.");
}

// Events: Fuel-/Zeit-Berechnung für Stints
function fuelInputs(o) {
  const num = v => (v == null || v === "" ? null : +v);
  return {
    lap_seconds: o.lap_seconds == null || o.lap_seconds === "" ? null : lapSeconds(o.lap_seconds),
    fuel_cons_per_lap: num(o.fuel_cons_per_lap),
    tank_liters: num(o.tank_liters),
    fuel_reserve_laps: o.fuel_reserve_laps == null || o.fuel_reserve_laps === "" ? 1 : +o.fuel_reserve_laps,
  };
}
// (Neu-)Berechnet alle Stints eines Events aus event.start_at/duration_minutes/Fuel-Parametern.
// Bestehende Zuweisungen bleiben per ON CONFLICT erhalten, überschüssige Stints werden gelöscht.
async function syncStints(event) {
  const n = event.duration_minutes / 60;
  const fuelReady = event.lap_seconds != null && event.fuel_cons_per_lap != null && event.tank_liters != null;
  for (let number = 1; number <= n; number++) {
    const start_at = new Date(event.start_at.getTime() + (number - 1) * 3600000);
    const end_at = new Date(start_at.getTime() + 3600000);
    let fuel_liters = null, pit_stops = 0;
    if (fuelReady) ({ fuel_liters, pit_stops } = computeStintFuel({
      raceStartAt: event.start_at, stintStartAt: start_at, stintEndAt: end_at,
      lapSec: event.lap_seconds, consPerLap: event.fuel_cons_per_lap, tankLiters: event.tank_liters, reserveLaps: event.fuel_reserve_laps,
    }));
    await q(`insert into stints(event_id,number,start_at,end_at,fuel_liters,pit_stops) values($1,$2,$3,$4,$5,$6)
      on conflict (event_id,number) do update set start_at=excluded.start_at, end_at=excluded.end_at, fuel_liters=excluded.fuel_liters, pit_stops=excluded.pit_stops`,
      [event.id, number, start_at, end_at, fuel_liters, pit_stops]);
  }
  await q(`delete from stints where event_id=$1 and number>$2`, [event.id, n]);
}

async function adminListEvents(res) {
  const r = await q(`select e.*, coalesce(s.total,0)::int total, coalesce(s.assigned,0)::int assigned
    from events e
    left join (select event_id, count(*) total, count(*) filter (where assigned_user_id is not null) assigned from stints group by event_id) s on s.event_id=e.id
    order by e.start_at desc`);
  return json(res, 200, r.rows);
}

async function adminCreateEvent(req, res, user) {
  const b = req.body || {};
  const name = String(b.name ?? "").trim();
  if (!name) throw new HttpErr(400, "Name fehlt.");
  const track = String(b.track ?? "").trim() || "Spa-Francorchamps";
  const car_class = String(b.car_class ?? "").trim();
  const start_at = new Date(b.start_at);
  if (!b.start_at || isNaN(start_at)) throw new HttpErr(400, "start_at: gültiges Datum erwartet.");
  const duration_minutes = +b.duration_minutes;
  if (!Number.isInteger(duration_minutes) || duration_minutes <= 0 || duration_minutes % 60 !== 0)
    throw new HttpErr(400, "duration_minutes muss ein positives Vielfaches von 60 sein.");
  const fuel = fuelInputs(b);
  const opensOff = b.signup_opens_offset_minutes != null ? +b.signup_opens_offset_minutes : null;
  const closesOff = b.signup_closes_offset_minutes != null ? +b.signup_closes_offset_minutes : null;
  const signup_opens_at = b.signup_opens_at ? new Date(b.signup_opens_at) : (opensOff != null ? new Date(start_at.getTime() - opensOff * 60000) : null);
  const signup_closes_at = b.signup_closes_at ? new Date(b.signup_closes_at) : (closesOff != null ? new Date(start_at.getTime() - closesOff * 60000) : null);
  if (!signup_opens_at || isNaN(signup_opens_at) || !signup_closes_at || isNaN(signup_closes_at))
    throw new HttpErr(400, "Anmeldefenster fehlt: signup_opens_at/signup_closes_at oder die passenden Offset-Minuten angeben.");

  const r = await q(`insert into events(name,track,car_class,start_at,duration_minutes,signup_opens_at,signup_closes_at,
      signup_opens_offset_minutes,signup_closes_offset_minutes,lap_seconds,fuel_cons_per_lap,tank_liters,fuel_reserve_laps,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [name, track, car_class, start_at, duration_minutes, signup_opens_at, signup_closes_at, opensOff, closesOff,
      fuel.lap_seconds, fuel.fuel_cons_per_lap, fuel.tank_liters, fuel.fuel_reserve_laps, user.id]);
  const event = r.rows[0];
  await syncStints(event);
  return json(res, 201, event);
}

async function adminPatchEvent(req, res, id, user) {
  const b = req.body || {};
  const cur = (await q("select * from events where id=$1", [id])).rows[0];
  if (!cur) throw new HttpErr(404, "Event nicht gefunden.");

  const fields = {};
  if (b.name !== undefined) { const v = String(b.name).trim(); if (!v) throw new HttpErr(400, "Name fehlt."); fields.name = v; }
  if (b.track !== undefined) fields.track = String(b.track).trim() || cur.track;
  if (b.car_class !== undefined) fields.car_class = String(b.car_class).trim();
  if (b.status !== undefined) fields.status = String(b.status);
  if (b.start_at !== undefined) { const d = new Date(b.start_at); if (isNaN(d)) throw new HttpErr(400, "start_at ungültig."); fields.start_at = d; }
  if (b.duration_minutes !== undefined) {
    const d = +b.duration_minutes;
    if (!Number.isInteger(d) || d <= 0 || d % 60 !== 0) throw new HttpErr(400, "duration_minutes muss ein positives Vielfaches von 60 sein.");
    fields.duration_minutes = d;
  }
  if (b.lap_seconds !== undefined) fields.lap_seconds = b.lap_seconds == null || b.lap_seconds === "" ? null : lapSeconds(b.lap_seconds);
  if (b.fuel_cons_per_lap !== undefined) fields.fuel_cons_per_lap = b.fuel_cons_per_lap == null || b.fuel_cons_per_lap === "" ? null : +b.fuel_cons_per_lap;
  if (b.tank_liters !== undefined) fields.tank_liters = b.tank_liters == null || b.tank_liters === "" ? null : +b.tank_liters;
  if (b.fuel_reserve_laps !== undefined) fields.fuel_reserve_laps = +b.fuel_reserve_laps;
  if (b.signup_opens_offset_minutes !== undefined) fields.signup_opens_offset_minutes = b.signup_opens_offset_minutes == null ? null : +b.signup_opens_offset_minutes;
  if (b.signup_closes_offset_minutes !== undefined) fields.signup_closes_offset_minutes = b.signup_closes_offset_minutes == null ? null : +b.signup_closes_offset_minutes;
  if (b.signup_opens_at !== undefined) fields.signup_opens_at = new Date(b.signup_opens_at);
  else if (fields.signup_opens_offset_minutes != null)
    fields.signup_opens_at = new Date((fields.start_at || cur.start_at).getTime() - fields.signup_opens_offset_minutes * 60000);
  if (b.signup_closes_at !== undefined) fields.signup_closes_at = new Date(b.signup_closes_at);
  else if (fields.signup_closes_offset_minutes != null)
    fields.signup_closes_at = new Date((fields.start_at || cur.start_at).getTime() - fields.signup_closes_offset_minutes * 60000);

  if (!Object.keys(fields).length) throw new HttpErr(400, "Keine Felder zum Ändern.");

  const cols = Object.keys(fields);
  const vals = cols.map(c => fields[c]);
  const r = await q(`update events set ${cols.map((c, i) => `${c}=$${i + 1}`).join(",")}, updated_at=now() where id=$${cols.length + 1} returning *`, [...vals, id]);
  const event = r.rows[0];

  const touchesStints = ["start_at", "duration_minutes", "lap_seconds", "fuel_cons_per_lap", "tank_liters", "fuel_reserve_laps"].some(k => k in fields);
  if (touchesStints) await syncStints(event);

  if (cur.status === "locked") {
    await q(`insert into audit_log(user_id,action,target,detail) values($1,'event_patch',$2,$3)`, [user.id, "event:" + id, JSON.stringify(fields)]);
    await recomputeReminders(q, id);
  }
  return json(res, 200, event);
}

async function adminPublish(res, id) {
  const cur = (await q("select * from events where id=$1", [id])).rows[0];
  if (!cur) throw new HttpErr(404, "Event nicht gefunden.");
  if (cur.status !== "draft") throw new HttpErr(409, "Nur Events im Status 'draft' können veröffentlicht werden.");
  if (!cur.start_at || !cur.signup_opens_at || !cur.signup_closes_at) throw new HttpErr(400, "Event hat kein vollständiges Anmeldefenster.");
  const r = await q(`update events set status='signup', updated_at=now() where id=$1 returning *`, [id]);
  return json(res, 200, r.rows[0]);
}

async function adminDistribute(res, id) {
  const cur = (await q("select * from events where id=$1", [id])).rows[0];
  if (!cur) throw new HttpErr(404, "Event nicht gefunden.");
  if (cur.status !== "signup" || !(new Date() >= cur.signup_closes_at))
    throw new HttpErr(409, "Verteilung ist erst möglich, wenn die Anmeldung geschlossen ist.");
  const result = await distributeFreeStints(q, id);
  await q(`update events set status='assigning', updated_at=now() where id=$1`, [id]);
  return json(res, 200, result);
}

async function adminLock(res, id, user) {
  const cur = (await q("select * from events where id=$1", [id])).rows[0];
  if (!cur) throw new HttpErr(404, "Event nicht gefunden.");
  if (cur.status === "locked") throw new HttpErr(409, "Event ist schon gesperrt.");
  await q(`update events set status='locked', updated_at=now() where id=$1`, [id]);
  await recomputeReminders(q, id);
  await q(`insert into audit_log(user_id,action,target) values($1,'lock',$2)`, [user.id, "event:" + id]);
  return json(res, 200, { ok: true });
}

async function adminDeleteEvent(res, id) {
  const cur = (await q("select * from events where id=$1", [id])).rows[0];
  if (!cur) throw new HttpErr(404, "Event nicht gefunden.");
  if (cur.status !== "draft") throw new HttpErr(409, "Nur Entwürfe können gelöscht werden. Stattdessen Event auf 'cancelled' setzen (via PATCH status).");
  await q("delete from events where id=$1", [id]);
  return json(res, 200, { ok: true });
}

async function adminPatchStint(req, res, eventId, number, user) {
  const b = req.body || {};
  if (b.assigned_user_id === undefined) throw new HttpErr(400, "assigned_user_id fehlt.");
  let assignedUserId = b.assigned_user_id;
  if (assignedUserId != null) {
    assignedUserId = +assignedUserId;
    if (!Number.isInteger(assignedUserId)) throw new HttpErr(400, "assigned_user_id ungültig.");
  } else assignedUserId = null;

  const event = (await q("select * from events where id=$1", [eventId])).rows[0];
  if (!event) throw new HttpErr(404, "Event nicht gefunden.");
  const stint = (await q("select * from stints where event_id=$1 and number=$2", [eventId, number])).rows[0];
  if (!stint) throw new HttpErr(404, "Stint nicht gefunden.");

  if (assignedUserId != null) {
    const u = (await q("select id from users where id=$1 and active", [assignedUserId])).rows[0];
    if (!u) throw new HttpErr(404, "Fahrer nicht gefunden.");
    if (assignedUserId !== stint.assigned_user_id && await hasOverlap(q, assignedUserId, stint.start_at, stint.end_at))
      throw new HttpErr(409, "Überlappt mit einem anderen Stint dieses Fahrers.");
  }

  const r = await q(`update stints set assigned_user_id=$1, assignment_source=$2, assigned_at=$3 where event_id=$4 and number=$5 returning *`,
    [assignedUserId, assignedUserId != null ? "admin" : null, assignedUserId != null ? new Date() : null, eventId, number]);

  if (event.status === "locked") {
    await q(`insert into audit_log(user_id,action,target,detail) values($1,'event_patch',$2,$3)`,
      [user.id, "event:" + eventId + ":stint:" + number, JSON.stringify({ assigned_user_id: assignedUserId })]);
    await recomputeReminders(q, eventId);
  }
  return json(res, 200, r.rows[0]);
}

async function adminGetSettings(res) {
  const r = (await q("select guild_id, default_voice_channel_id, bot_token_hash from settings where id=1")).rows[0];
  return json(res, 200, { guild_id: r.guild_id, default_voice_channel_id: r.default_voice_channel_id, has_bot_token: !!r.bot_token_hash });
}
async function adminPatchSettings(req, res) {
  const b = req.body || {};
  const cur = (await q("select guild_id, default_voice_channel_id from settings where id=1")).rows[0];
  const guild_id = b.guild_id !== undefined ? (String(b.guild_id).trim() || null) : cur.guild_id;
  const default_voice_channel_id = b.default_voice_channel_id !== undefined ? (String(b.default_voice_channel_id).trim() || null) : cur.default_voice_channel_id;
  const r = await q(`update settings set guild_id=$1, default_voice_channel_id=$2 where id=1 returning guild_id, default_voice_channel_id, bot_token_hash`,
    [guild_id, default_voice_channel_id]);
  const row = r.rows[0];
  return json(res, 200, { guild_id: row.guild_id, default_voice_channel_id: row.default_voice_channel_id, has_bot_token: !!row.bot_token_hash });
}
async function adminGenBotToken(res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await q("update settings set bot_token_hash=$1, bot_token_created_at=now() where id=1", [hash]);
  return json(res, 200, { token });
}

// Fahrer-Ansicht: Events (ohne draft) + berechnete Phase fürs Frontend
function eventPhase(e, now) {
  if (e.status === "locked") return "locked";
  if (e.status === "done") return "done";
  if (e.status === "cancelled") return "cancelled";
  if (e.status === "assigning") return "after_signup";
  if (now < e.signup_opens_at) return "before_signup";
  if (now <= e.signup_closes_at) return "signup_open";
  return "after_signup";
}
async function listEvents(res, user) {
  if (!user) throw new HttpErr(401, "Nicht angemeldet.");
  const r = await q(`select * from events where status<>'draft' order by start_at`);
  const now = new Date();
  return json(res, 200, r.rows.map(e => ({ ...e, phase: eventPhase(e, now) })));
}

async function claimStint(res, eventId, number, user) {
  if (!user) throw new HttpErr(401, "Nicht angemeldet.");
  const event = (await q("select * from events where id=$1", [eventId])).rows[0];
  if (!event) throw new HttpErr(404, "Event nicht gefunden.");
  const now = new Date();
  if (event.status !== "signup" || now < event.signup_opens_at || now > event.signup_closes_at)
    throw new HttpErr(403, "Anmeldung ist aktuell nicht möglich.");
  const stint = (await q("select * from stints where event_id=$1 and number=$2", [eventId, number])).rows[0];
  if (!stint) throw new HttpErr(404, "Stint nicht gefunden.");
  // Claim zielt per WHERE-Klausel unten ohnehin nur auf unbelegte Stints; dieser Guard ist defensiv und billig.
  if (stint.assigned_user_id !== user.id && await hasOverlap(q, user.id, stint.start_at, stint.end_at))
    throw new HttpErr(409, "Überlappt mit einem anderen deiner Stints.");
  const r = await q(`update stints set assigned_user_id=$1, assignment_source='self', assigned_at=now()
    where event_id=$2 and number=$3 and assigned_user_id is null returning *`, [user.id, eventId, number]);
  if (!r.rows.length) throw new HttpErr(409, "Stint schon vergeben.");
  return json(res, 200, r.rows[0]);
}

async function unclaimStint(res, eventId, number, user) {
  if (!user) throw new HttpErr(401, "Nicht angemeldet.");
  const event = (await q("select * from events where id=$1", [eventId])).rows[0];
  if (!event) throw new HttpErr(404, "Event nicht gefunden.");
  if (event.status === "locked") throw new HttpErr(409, "Event ist gesperrt, Stint kann nicht mehr freigegeben werden.");
  const r = await q(`update stints set assigned_user_id=null, assignment_source=null, assigned_at=null
    where event_id=$1 and number=$2 and assigned_user_id=$3 returning *`, [eventId, number, user.id]);
  if (!r.rows.length) throw new HttpErr(403, "Du hast diesen Stint nicht belegt.");
  return json(res, 200, r.rows[0]);
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
    if (path === "/api/me" && req.method === "PATCH") {
      if (!user) throw new HttpErr(401, "Nicht angemeldet.");
      const n = normNumber((req.body || {}).car_number);
      await ensureFree("car_number", n, user.id);
      const r = await q("update users set car_number=$1 where id=$2 returning *", [n, user.id]);
      return json(res, 200, pub(r.rows[0]));
    }
    if (path === "/api/me") return user ? json(res, 200, pub(user)) : json(res, 401, { error: "Nicht angemeldet." });
    if (path === "/api/auth/steam") return steamLogin(req, res, user);
    if (path === "/api/auth/steam/callback") return await steamCallback(req, res, url, user);
    if (path === "/api/drivers") {
      if (!user) throw new HttpErr(401, "Nicht angemeldet.");
      const r = await q("select display_name,car_number from users where active order by car_number nulls last, lower(display_name)");
      return json(res, 200, r.rows);
    }
    const am = path.match(/^\/api\/admin\/users(?:\/(\d+))?$/);
    if (am) {
      requireAdmin(user);
      return await adminUsers(req, res, url, am[1] === undefined ? undefined : +am[1]);
    }
    if (path === "/api/plan") {
      if (!user) throw new HttpErr(401, "Nicht angemeldet.");
      return json(res, 200, planPub(await currentPlan()));
    }
    if (path === "/api/admin/plan" && req.method === "PATCH") {
      requireAdmin(user);
      const v = normPlan({ ...(await currentPlan()), ...(req.body || {}) });
      return json(res, 200, planPub(await saveCurrentPlan(v)));
    }
    const pm = path.match(/^\/api\/admin\/plans(?:\/(\d+)(?:\/(load))?)?$/);
    if (pm) {
      requireAdmin(user);
      return await adminPlans(req, res, url, pm[1] === undefined ? undefined : +pm[1], pm[2]);
    }

    if (path === "/api/admin/events") {
      requireAdmin(user);
      if (req.method === "GET") return await adminListEvents(res);
      if (req.method === "POST") return await adminCreateEvent(req, res, user);
      throw new HttpErr(404, "Nicht gefunden.");
    }
    const evAction = path.match(/^\/api\/admin\/events\/(\d+)\/(publish|distribute|lock)$/);
    if (evAction && req.method === "POST") {
      requireAdmin(user);
      const id = +evAction[1];
      if (evAction[2] === "publish") return await adminPublish(res, id);
      if (evAction[2] === "distribute") return await adminDistribute(res, id);
      return await adminLock(res, id, user);
    }
    const evStint = path.match(/^\/api\/admin\/events\/(\d+)\/stints\/(\d+)$/);
    if (evStint && req.method === "PATCH") {
      requireAdmin(user);
      return await adminPatchStint(req, res, +evStint[1], +evStint[2], user);
    }
    const evOne = path.match(/^\/api\/admin\/events\/(\d+)$/);
    if (evOne) {
      requireAdmin(user);
      const id = +evOne[1];
      if (req.method === "PATCH") return await adminPatchEvent(req, res, id, user);
      if (req.method === "DELETE") return await adminDeleteEvent(res, id);
      throw new HttpErr(404, "Nicht gefunden.");
    }
    if (path === "/api/admin/settings") {
      requireAdmin(user);
      if (req.method === "GET") return await adminGetSettings(res);
      if (req.method === "PATCH") return await adminPatchSettings(req, res);
      throw new HttpErr(404, "Nicht gefunden.");
    }
    if (path === "/api/admin/settings/bot-token" && req.method === "POST") {
      requireAdmin(user);
      return await adminGenBotToken(res);
    }
    if (path === "/api/events" && req.method === "GET") return await listEvents(res, user);
    const claimM = path.match(/^\/api\/events\/(\d+)\/stints\/(\d+)\/claim$/);
    if (claimM) {
      const eventId = +claimM[1], number = +claimM[2];
      if (req.method === "POST") return await claimStint(res, eventId, number, user);
      if (req.method === "DELETE") return await unclaimStint(res, eventId, number, user);
      throw new HttpErr(404, "Nicht gefunden.");
    }

    throw new HttpErr(404, "Nicht gefunden.");
  } catch (e) {
    if (e instanceof HttpErr) return json(res, e.status, { error: e.message });
    if (e.code === "23505") return json(res, 409, { error: "Diese ID ist bereits vergeben." });
    console.error(e);
    json(res, 500, { error: "Serverfehler." });
  }
}
