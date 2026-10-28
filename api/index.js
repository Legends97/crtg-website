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
  .then(() => q(`create table if not exists notifications (
  id serial primary key,
  type text not null check (type in ('event_published','stint_confirmed','stint_removed')),
  user_id int not null references users(id),
  event_id int references events(id) on delete cascade,
  payload jsonb not null default '{}',
  due_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  sent_at timestamptz,
  discord_message_id text,
  error_text text,
  created_at timestamptz not null default now()
)`))
  .then(() => q(`create index if not exists notifications_due_idx on notifications(status, due_at)`))
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

// Discord-Login (OAuth2): jedes Mitglied des Discord-Servers DISCORD_GUILD_ID darf sich anmelden,
// Admin-Rechte gibt es nur für die festen IDs in ADMIN_DISCORD_IDS.
const baseUrl = req => (process.env.BASE_URL || "https://" + req.headers.host).replace(/\/$/, "");
const redirectUri = req => baseUrl(req) + "/api/auth/callback";
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
  // > 0 statt nur != null: ein lap_seconds/fuel_cons_per_lap von "0" (String aus pg
  // numeric oder Eingabe) würde sonst als "bereit" gelten und computeStintFuel()
  // durch Division durch 0 NaN liefern lassen, was die DB klaglos als numeric annimmt.
  const fuelReady = event.lap_seconds > 0 && event.fuel_cons_per_lap > 0 && event.tank_liters > 0;
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

// Muss exakt zum CHECK-Constraint der events.status-Spalte oben passen.
const EVENT_STATUSES = ["draft", "signup", "assigning", "locked", "done", "cancelled"];

// reminder_lead_times: Array positiver Ganzzahlen (Minuten) oder undefined/null (unverändert/Default).
function parseReminderLeadTimes(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.length || !v.every(n => Number.isInteger(n) && n > 0))
    throw new HttpErr(400, "reminder_lead_times muss ein Array positiver Ganzzahlen (Minuten) sein.");
  return v;
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
  const reminder_lead_times = parseReminderLeadTimes(b.reminder_lead_times);
  const guild_id = b.guild_id == null || b.guild_id === "" ? null : String(b.guild_id).trim();
  const voice_channel_id = b.voice_channel_id == null || b.voice_channel_id === "" ? null : String(b.voice_channel_id).trim();

  const cols = ["name", "track", "car_class", "start_at", "duration_minutes", "signup_opens_at", "signup_closes_at",
    "signup_opens_offset_minutes", "signup_closes_offset_minutes", "lap_seconds", "fuel_cons_per_lap", "tank_liters", "fuel_reserve_laps", "created_by", "guild_id", "voice_channel_id"];
  const vals = [name, track, car_class, start_at, duration_minutes, signup_opens_at, signup_closes_at, opensOff, closesOff,
    fuel.lap_seconds, fuel.fuel_cons_per_lap, fuel.tank_liters, fuel.fuel_reserve_laps, user.id, guild_id, voice_channel_id];
  if (reminder_lead_times) { cols.push("reminder_lead_times"); vals.push(reminder_lead_times); }
  const r = await q(`insert into events(${cols.join(",")}) values(${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning *`, vals);
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
  if (b.status !== undefined) {
    const v = String(b.status);
    if (!EVENT_STATUSES.includes(v)) throw new HttpErr(400, `Ungültiger Status. Erlaubt: ${EVENT_STATUSES.join(", ")}.`);
    if (v === "locked") throw new HttpErr(400, "Zum Festschreiben bitte POST /api/admin/events/:id/lock verwenden.");
    fields.status = v;
  }
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
  if (b.reminder_lead_times !== undefined) fields.reminder_lead_times = parseReminderLeadTimes(b.reminder_lead_times) ?? cur.reminder_lead_times;
  if (b.guild_id !== undefined) fields.guild_id = b.guild_id == null || b.guild_id === "" ? null : String(b.guild_id).trim();
  if (b.voice_channel_id !== undefined) fields.voice_channel_id = b.voice_channel_id == null || b.voice_channel_id === "" ? null : String(b.voice_channel_id).trim();
  if (b.signup_opens_offset_minutes !== undefined) fields.signup_opens_offset_minutes = b.signup_opens_offset_minutes == null ? null : +b.signup_opens_offset_minutes;
  if (b.signup_closes_offset_minutes !== undefined) fields.signup_closes_offset_minutes = b.signup_closes_offset_minutes == null ? null : +b.signup_closes_offset_minutes;
  if (b.signup_opens_at !== undefined) fields.signup_opens_at = new Date(b.signup_opens_at);
  else if (fields.signup_opens_offset_minutes != null)
    fields.signup_opens_at = new Date((fields.start_at || cur.start_at).getTime() - fields.signup_opens_offset_minutes * 60000);
  if (b.signup_closes_at !== undefined) fields.signup_closes_at = new Date(b.signup_closes_at);
  else if (fields.signup_closes_offset_minutes != null)
    fields.signup_closes_at = new Date((fields.start_at || cur.start_at).getTime() - fields.signup_closes_offset_minutes * 60000);

  // start_at shifted without an explicit window/offset override in this request:
  // re-derive the absolute window from the event's STORED offsets (if it has any).
  if (fields.start_at !== undefined) {
    if (b.signup_opens_at === undefined && b.signup_opens_offset_minutes === undefined && cur.signup_opens_offset_minutes != null)
      fields.signup_opens_at = new Date(fields.start_at.getTime() - cur.signup_opens_offset_minutes * 60000);
    if (b.signup_closes_at === undefined && b.signup_closes_offset_minutes === undefined && cur.signup_closes_offset_minutes != null)
      fields.signup_closes_at = new Date(fields.start_at.getTime() - cur.signup_closes_offset_minutes * 60000);
  }

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

// Discord-Bot-Benachrichtigungen (sofort fällig, nicht zeitverzögert wie `reminders`):
// 'event_published' (Broadcast an alle aktiven Nutzer), 'stint_confirmed'/'stint_removed' (pro Fahrer, bei Zu-/Abweisung nach dem Festschreiben).
async function insertNotification(type, userId, eventId, payload) {
  await q(`insert into notifications(type,user_id,event_id,payload) values($1,$2,$3,$4)`,
    [type, userId, eventId, JSON.stringify(payload)]);
}

async function adminPublish(req, res, id) {
  const cur = (await q("select * from events where id=$1", [id])).rows[0];
  if (!cur) throw new HttpErr(404, "Event nicht gefunden.");
  if (cur.status !== "draft") throw new HttpErr(409, "Nur Events im Status 'draft' können veröffentlicht werden.");
  if (!cur.start_at || !cur.signup_opens_at || !cur.signup_closes_at) throw new HttpErr(400, "Event hat kein vollständiges Anmeldefenster.");
  const r = await q(`update events set status='signup', updated_at=now() where id=$1 returning *`, [id]);
  const event = r.rows[0];
  const eventPayload = { name: event.name, track: event.track, car_class: event.car_class, start_at: event.start_at.toISOString() };
  const signup_url = baseUrl(req) + "/stintplan/?event=" + id;
  const users = (await q("select id from users where active")).rows;
  for (const u of users) await insertNotification("event_published", u.id, id, { event: eventPayload, signup_url });
  return json(res, 200, event);
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

async function adminLock(req, res, id, user) {
  const cur = (await q("select * from events where id=$1", [id])).rows[0];
  if (!cur) throw new HttpErr(404, "Event nicht gefunden.");
  if (cur.status === "locked") throw new HttpErr(409, "Event ist schon gesperrt.");
  await q(`update events set status='locked', updated_at=now() where id=$1`, [id]);
  await recomputeReminders(q, id);
  await q(`insert into audit_log(user_id,action,target) values($1,'lock',$2)`, [user.id, "event:" + id]);

  const eventPayload = { name: cur.name, track: cur.track, car_class: cur.car_class, start_at: cur.start_at.toISOString() };
  const my_stints_url = baseUrl(req) + "/meine-stints/";
  const stints = (await q("select number,start_at,end_at,assigned_user_id from stints where event_id=$1 order by number", [id])).rows;
  const byUser = new Map();
  for (const s of stints) {
    if (s.assigned_user_id == null) continue;
    if (!byUser.has(s.assigned_user_id)) byUser.set(s.assigned_user_id, []);
    byUser.get(s.assigned_user_id).push({ number: s.number, start_at: s.start_at.toISOString(), end_at: s.end_at.toISOString() });
  }
  for (const [uid, myStints] of byUser)
    await insertNotification("stint_confirmed", uid, id, { event: eventPayload, stints: myStints, my_stints_url });

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

  const oldUserId = stint.assigned_user_id;
  const r = await q(`update stints set assigned_user_id=$1, assignment_source=$2, assigned_at=$3 where event_id=$4 and number=$5 returning *`,
    [assignedUserId, assignedUserId != null ? "admin" : null, assignedUserId != null ? new Date() : null, eventId, number]);

  if (event.status === "locked") {
    await q(`insert into audit_log(user_id,action,target,detail) values($1,'event_patch',$2,$3)`,
      [user.id, "event:" + eventId + ":stint:" + number, JSON.stringify({ assigned_user_id: assignedUserId })]);
    await recomputeReminders(q, eventId);

    if (oldUserId !== assignedUserId) {
      const eventPayload = { name: event.name, track: event.track, car_class: event.car_class, start_at: event.start_at.toISOString() };
      if (oldUserId != null)
        await insertNotification("stint_removed", oldUserId, eventId, { event: eventPayload, removed_by: { display_name: user.display_name } });
      if (assignedUserId != null) {
        const myStints = (await q("select number,start_at,end_at from stints where event_id=$1 and assigned_user_id=$2 order by number", [eventId, assignedUserId])).rows
          .map(s => ({ number: s.number, start_at: s.start_at.toISOString(), end_at: s.end_at.toISOString() }));
        await insertNotification("stint_confirmed", assignedUserId, eventId, { event: eventPayload, stints: myStints, my_stints_url: baseUrl(req) + "/meine-stints/" });
      }
    }
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

// --- Discord-Bot-API (/api/v1/*) ---------------------------------------
// Timestamps gehen immer explizit über .toISOString() raus (UTC, "Z"), nie lokal formatiert.
const eventJson = e => ({
  ...e,
  start_at: e.start_at.toISOString(),
  signup_opens_at: e.signup_opens_at ? e.signup_opens_at.toISOString() : null,
  signup_closes_at: e.signup_closes_at ? e.signup_closes_at.toISOString() : null,
  created_at: e.created_at ? e.created_at.toISOString() : null,
  updated_at: e.updated_at ? e.updated_at.toISOString() : null,
});

async function v1ListEvents(res, url) {
  const conds = ["status<>'draft'"], params = [];
  const from = url.searchParams.get("from"), to = url.searchParams.get("to");
  if (from) { const d = new Date(from); if (isNaN(d)) throw new HttpErr(400, "from: ungültiges Datum."); params.push(d); conds.push(`start_at >= $${params.length}`); }
  if (to) { const d = new Date(to); if (isNaN(d)) throw new HttpErr(400, "to: ungültiges Datum."); params.push(d); conds.push(`start_at <= $${params.length}`); }
  const r = await q(`select * from events where ${conds.join(" and ")} order by start_at`, params);
  return json(res, 200, { events: r.rows.map(eventJson) });
}

// Gemeinsame Event+Stints-Detailabfrage für /api/v1/events/:id und /api/admin/events/:id.
// allowDraft=false (Fahrer/Bot-Vertrag): draft-Events bleiben unsichtbar.
// allowDraft=true (Admin): auch draft, damit die Zuweisungen eines Entwurfs sichtbar sind.
async function eventDetail(id, allowDraft) {
  const event = (await q(`select * from events where id=$1${allowDraft ? "" : " and status<>'draft'"}`, [id])).rows[0];
  if (!event) throw new HttpErr(404, "Event nicht gefunden.");
  const stints = (await q(`select s.number, s.start_at, s.end_at, s.fuel_liters, s.pit_stops,
      u.display_name driver_name, u.discord_id driver_discord_id
    from stints s left join users u on u.id = s.assigned_user_id
    where s.event_id=$1 order by s.number`, [id])).rows;
  return {
    ...eventJson(event),
    stints: stints.map(s => ({
      number: s.number,
      start_at: s.start_at.toISOString(),
      end_at: s.end_at.toISOString(),
      fuel_liters: s.fuel_liters == null ? null : Number(s.fuel_liters),
      pit_stops: s.pit_stops,
      assigned_user: s.driver_name ? { display_name: s.driver_name, discord_id: s.driver_discord_id } : null,
    })),
  };
}
async function v1EventDetail(res, id) {
  return json(res, 200, await eventDetail(id, false));
}
async function adminEventDetail(res, id) {
  return json(res, 200, await eventDetail(id, true));
}

async function v1DriverStints(res, discordId, auth) {
  const target = (await q("select id, discord_id from users where discord_id=$1", [discordId])).rows[0];
  if (!target) throw new HttpErr(404, "Fahrer nicht gefunden.");
  if (!auth.bot && auth.user.discord_id !== discordId && auth.user.role !== "admin")
    throw new HttpErr(403, "Kein Zugriff auf die Stints dieses Fahrers.");
  const r = await q(`select s.number, s.start_at, s.end_at, s.fuel_liters, s.pit_stops,
      e.id event_id, e.name event_name, e.track event_track
    from stints s join events e on e.id=s.event_id
    where s.assigned_user_id=$1 and s.end_at > now() and e.status not in ('draft','cancelled')
    order by s.start_at`, [target.id]);
  return json(res, 200, { stints: r.rows.map(s => ({
    number: s.number,
    start_at: s.start_at.toISOString(),
    end_at: s.end_at.toISOString(),
    fuel_liters: s.fuel_liters == null ? null : Number(s.fuel_liters),
    pit_stops: s.pit_stops,
    event: { id: s.event_id, name: s.event_name, track: s.event_track },
  })) });
}

// Bearer-only: `authEither` erlaubt auch Session-Cookies, deshalb hier explizit zusätzlich prüfen.
async function requireBot(req) {
  const auth = await authEither(req);
  if (!auth.bot) throw new HttpErr(403, "Diese Route ist nur für den Discord-Bot (Bot-Token).");
  return auth;
}

async function v1RemindersDue(res) {
  const rows = (await q(`select r.*, u.display_name driver_name, u.discord_id driver_discord_id
    from reminders r join users u on u.id=r.user_id
    where r.status='pending' and r.due_at<=now() order by r.due_at limit 50`)).rows;
  const settings = (await q(`select guild_id, default_voice_channel_id from settings where id=1`)).rows[0];

  const eventCache = new Map();   // event_id -> { event, blocks }
  const userCache = new Map();    // user_id -> display_name
  async function driverName(userId) {
    if (userId == null) return null;
    if (!userCache.has(userId)) {
      const u = (await q("select display_name from users where id=$1", [userId])).rows[0];
      userCache.set(userId, u ? u.display_name : null);
    }
    return userCache.get(userId);
  }

  const reminders = [];
  for (const rem of rows) {
    let ctx = eventCache.get(rem.event_id);
    if (!ctx) {
      const event = (await q("select * from events where id=$1", [rem.event_id])).rows[0];
      const stints = (await q(`select number, start_at, end_at, assigned_user_id, fuel_liters, pit_stops
        from stints where event_id=$1 order by number`, [rem.event_id])).rows;
      ctx = { event, blocks: computeBlocks(stints) };
      eventCache.set(rem.event_id, ctx);
    }
    const { event, blocks } = ctx;
    const block = blocks.find(b => b.first_stint === rem.first_stint_number && b.last_stint === rem.last_stint_number);
    if (!block) continue; // Plan hat sich seit dem Erzeugen des Reminders verändert -> kein passender Block mehr

    reminders.push({
      id: rem.id,
      lead_time_minutes: rem.lead_time_minutes,
      due_at: rem.due_at.toISOString(),
      driver: { display_name: rem.driver_name, discord_id: rem.driver_discord_id },
      event: {
        name: event.name, track: event.track, car_class: event.car_class,
        start_at: event.start_at.toISOString(),
        guild_id: event.guild_id ?? settings.guild_id ?? null,
        voice_channel_id: event.voice_channel_id ?? settings.default_voice_channel_id ?? null,
      },
      block: {
        first_stint: block.first_stint,
        last_stint: block.last_stint,
        stint_count: block.stint_count,
        start_at: block.start_at.toISOString(),
        end_at: block.end_at.toISOString(),
        duration_minutes: Math.round((block.end_at - block.start_at) / 60000),
        fuel_liters: Number(block.fuel_liters),
        pit_stops: block.pit_stops,
        driver_before: await driverName(block.driver_before),
        driver_after: await driverName(block.driver_after),
      },
    });
  }
  return json(res, 200, { reminders });
}

async function v1ReminderSent(req, res, id) {
  const b = req.body || {};
  const cur = (await q("select id from reminders where id=$1", [id])).rows[0];
  if (!cur) throw new HttpErr(404, "Reminder nicht gefunden.");
  if (b.status === "sent") {
    await q("update reminders set status='sent', sent_at=now(), discord_message_id=$1 where id=$2", [b.discord_message_id ?? null, id]);
  } else if (b.status === "failed") {
    await q("update reminders set status='failed', error_text=$1 where id=$2", [b.error ?? null, id]);
  } else {
    throw new HttpErr(400, "status muss 'sent' oder 'failed' sein.");
  }
  return json(res, 200, { ok: true });
}

async function v1NotificationsDue(res) {
  const rows = (await q(`select n.*, u.display_name driver_name, u.discord_id driver_discord_id
    from notifications n join users u on u.id=n.user_id
    where n.status='pending' and n.due_at<=now() order by n.due_at limit 50`)).rows;
  return json(res, 200, { notifications: rows.map(n => ({
    id: n.id,
    type: n.type,
    due_at: n.due_at.toISOString(),
    driver: { display_name: n.driver_name, discord_id: n.driver_discord_id },
    event_id: n.event_id,
    ...n.payload,
  })) });
}

async function v1NotificationSent(req, res, id) {
  const b = req.body || {};
  const cur = (await q("select id from notifications where id=$1", [id])).rows[0];
  if (!cur) throw new HttpErr(404, "Notification nicht gefunden.");
  if (b.status === "sent") {
    await q("update notifications set status='sent', sent_at=now(), discord_message_id=$1 where id=$2", [b.discord_message_id ?? null, id]);
  } else if (b.status === "failed") {
    await q("update notifications set status='failed', error_text=$1 where id=$2", [b.error ?? null, id]);
  } else {
    throw new HttpErr(400, "status muss 'sent' oder 'failed' sein.");
  }
  return json(res, 200, { ok: true });
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
      if (evAction[2] === "publish") return await adminPublish(req, res, id);
      if (evAction[2] === "distribute") return await adminDistribute(res, id);
      return await adminLock(req, res, id, user);
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
      if (req.method === "GET") return await adminEventDetail(res, id);
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

    if (path === "/api/v1/events" && req.method === "GET") {
      await authEither(req);
      return await v1ListEvents(res, url);
    }
    const v1EventOne = path.match(/^\/api\/v1\/events\/(\d+)$/);
    if (v1EventOne && req.method === "GET") {
      await authEither(req);
      return await v1EventDetail(res, +v1EventOne[1]);
    }
    const v1DriverM = path.match(/^\/api\/v1\/drivers\/(\d+)\/stints$/);
    if (v1DriverM && req.method === "GET") {
      const auth = await authEither(req);
      return await v1DriverStints(res, v1DriverM[1], auth);
    }
    if (path === "/api/v1/reminders/due" && req.method === "GET") {
      await requireBot(req);
      return await v1RemindersDue(res);
    }
    const v1RemSent = path.match(/^\/api\/v1\/reminders\/(\d+)\/sent$/);
    if (v1RemSent && req.method === "POST") {
      await requireBot(req);
      return await v1ReminderSent(req, res, +v1RemSent[1]);
    }
    if (path === "/api/v1/notifications/due" && req.method === "GET") {
      await requireBot(req);
      return await v1NotificationsDue(res);
    }
    const v1NotifSent = path.match(/^\/api\/v1\/notifications\/(\d+)\/sent$/);
    if (v1NotifSent && req.method === "POST") {
      await requireBot(req);
      return await v1NotificationSent(req, res, +v1NotifSent[1]);
    }

    throw new HttpErr(404, "Nicht gefunden.");
  } catch (e) {
    if (e instanceof HttpErr) return json(res, e.status, { error: e.message });
    if (e.code === "23505") return json(res, 409, { error: "Diese ID ist bereits vergeben." });
    console.error(e);
    json(res, 500, { error: "Serverfehler." });
  }
}
