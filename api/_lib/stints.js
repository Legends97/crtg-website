// Block-/Reminder-/Verteil-Algorithmen für Events & Stints.
//
// Dependency Injection: jede Funktion, die die DB braucht, bekommt den Query-
// Helper `q` (Signatur wie der pool.query-Wrapper in api/index.js: (text, params) =>
// Promise<{ rows: [...] }>) als ERSTES Parameter. Kein Import eines DB-Singletons
// hier, um den Zirkelimport mit api/index.js zu vermeiden.
//
// Zeit-Werte aus der DB (timestamptz-Spalten) kommen vom pg-Treiber bereits als
// JS Date-Objekte zurück; `now` wird explizit vom Aufrufer übergeben (kein
// implizites Date.now() in dieser Datei).

// rein berechnend, keine DB, kein Date.now() intern
export function computeBlocks(stints) {  // stints sortiert nach number, Felder: number, start_at, end_at, assigned_user_id, fuel_liters, pit_stops
  const blocks = []; let cur = null;
  for (const s of stints) {
    if (s.assigned_user_id == null) { cur = null; continue; }
    if (cur && cur.user_id === s.assigned_user_id && s.number === cur.last_stint + 1) {
      cur.last_stint = s.number; cur.end_at = s.end_at; cur.stint_count++;
      cur.fuel_liters += s.fuel_liters || 0; cur.pit_stops += s.pit_stops || 0;
    } else {
      cur = { user_id: s.assigned_user_id, first_stint: s.number, last_stint: s.number,
              start_at: s.start_at, end_at: s.end_at, stint_count: 1,
              fuel_liters: s.fuel_liters || 0, pit_stops: s.pit_stops || 0 };
      blocks.push(cur);
    }
  }
  for (const b of blocks) {
    b.driver_before = stints.find(s => s.number === b.first_stint - 1)?.assigned_user_id ?? null;
    b.driver_after  = stints.find(s => s.number === b.last_stint + 1)?.assigned_user_id ?? null;
  }
  return blocks;
}

// kleine lokale Hilfsfunktion statt lodash
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

// braucht DB (liest stints/events, schreibt reminders) -> q als erstes Parameter, now als Parameter
export async function recomputeReminders(q, eventId, now = new Date()) {
  const eventRes = await q(`select * from events where id=$1`, [eventId]);
  const event = eventRes.rows[0];
  const stintsRes = await q(
    `select number, start_at, end_at, assigned_user_id, fuel_liters, pit_stops
     from stints where event_id=$1 order by number`,
    [eventId]);
  const stints = stintsRes.rows;
  const blocks = computeBlocks(stints);
  const maxLead = Math.max(...event.reminder_lead_times);

  await q(`update reminders set status='cancelled' where event_id=$1 and status='pending'`, [eventId]);

  for (const b of blocks) for (const lead of event.reminder_lead_times) {
    if (lead === maxLead) continue;                        // größte Stufe separat, s.u.
    const dueAt = new Date(b.start_at.getTime() - lead * 60000);
    if (dueAt <= now || b.start_at <= now) continue;        // Vergangenheit/läuft schon -> nicht erzeugen
    await insertReminder(q, eventId, b.user_id, b.first_stint, b.last_stint, lead, dueAt);
  }

  const byUser = groupBy(blocks, b => b.user_id);           // kleine lokale Hilfsfunktion, kein lodash
  for (const [userId, userBlocks] of byUser) {
    const first = [...userBlocks].sort((a, b) => a.start_at - b.start_at)[0];  // größte Stufe: EIN Reminder, erster Block
    const dueAt = new Date(first.start_at.getTime() - maxLead * 60000);
    if (dueAt <= now || first.start_at <= now) continue;
    await insertReminder(q, eventId, userId, first.first_stint, first.last_stint, maxLead, dueAt);
  }
}

async function insertReminder(q, eventId, userId, first, last, lead, dueAt) {
  await q(`insert into reminders(event_id,user_id,first_stint_number,last_stint_number,lead_time_minutes,due_at)
           values($1,$2,$3,$4,$5,$6)
           on conflict (event_id,user_id,lead_time_minutes,first_stint_number) where status='pending' do nothing`,
          [eventId, userId, first, last, lead, dueAt]);
}

// braucht DB -> q als erstes Parameter
export async function distributeFreeStints(q, eventId) {
  const stintsRes = await q(
    `select id, number, start_at, end_at, assigned_user_id from stints where event_id=$1 order by number`,
    [eventId]);
  const stints = stintsRes.rows;
  const free = stints.filter(s => s.assigned_user_id == null);
  const assignedIds = new Set(stints.filter(s => s.assigned_user_id).map(s => s.assigned_user_id));
  const usersRes = await q(`select id from users where active`);
  const candidates = usersRes.rows.map(r => r.id).filter(id => !assignedIds.has(id));

  let i = 0, assigned = 0;
  for (const stint of free) {
    if (!candidates.length) break;
    for (let tries = 0; tries < candidates.length; tries++, i++) {
      const uid = candidates[i % candidates.length];
      if (await hasOverlap(q, uid, stint.start_at, stint.end_at)) continue;  // Kollision mit anderem Event -> nächster Kandidat
      await q(`update stints set assigned_user_id=$1, assignment_source='auto', assigned_at=now() where id=$2`, [uid, stint.id]);
      assigned++; break;
    }
  }
  return { assigned };
}

// braucht DB -> q als erstes Parameter. Prüft Überlappung eines Users mit JEDEM Stint in JEDEM nicht-abgesagten Event.
export async function hasOverlap(q, userId, startAt, endAt) {
  const r = await q(
    `select 1 from stints s join events e on e.id=s.event_id
     where s.assigned_user_id=$1 and e.status<>'cancelled' and s.start_at<$3 and s.end_at>$2 limit 1`,
    [userId, startAt, endAt]);
  return r.rows.length > 0;
}
