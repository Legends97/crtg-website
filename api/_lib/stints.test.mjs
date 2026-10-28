// Plain Node assert tests, no test runner package. Run with:
//   node api/_lib/stints.test.mjs
import assert from "node:assert/strict";
import { computeBlocks, recomputeReminders, distributeFreeStints, hasOverlap } from "./stints.js";
import { computeStintFuel, lapSeconds } from "./fuel.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---------------------------------------------------------------------------
// computeBlocks
// ---------------------------------------------------------------------------

await test("computeBlocks: unbroken block (same driver, consecutive numbers)", () => {
  const t0 = new Date(0), t1 = new Date(60000), t2 = new Date(120000), t3 = new Date(180000);
  const stints = [
    { number: 1, start_at: t0, end_at: t1, assigned_user_id: 7, fuel_liters: 10, pit_stops: 0 },
    { number: 2, start_at: t1, end_at: t2, assigned_user_id: 7, fuel_liters: 12, pit_stops: 1 },
    { number: 3, start_at: t2, end_at: t3, assigned_user_id: 7, fuel_liters: 11, pit_stops: 0 },
  ];
  assert.deepStrictEqual(computeBlocks(stints), [
    { user_id: 7, first_stint: 1, last_stint: 3, start_at: t0, end_at: t3, stint_count: 3,
      fuel_liters: 33, pit_stops: 1, driver_before: null, driver_after: null },
  ]);
});

await test("computeBlocks: gap from a free stint splits one driver into two blocks", () => {
  const t0 = new Date(0), t1 = new Date(60000), t2 = new Date(120000), t3 = new Date(180000);
  const stints = [
    { number: 1, start_at: t0, end_at: t1, assigned_user_id: 7, fuel_liters: 5, pit_stops: 0 },
    { number: 2, start_at: t1, end_at: t2, assigned_user_id: null, fuel_liters: null, pit_stops: 0 },
    { number: 3, start_at: t2, end_at: t3, assigned_user_id: 7, fuel_liters: 6, pit_stops: 0 },
  ];
  assert.deepStrictEqual(computeBlocks(stints), [
    { user_id: 7, first_stint: 1, last_stint: 1, start_at: t0, end_at: t1, stint_count: 1,
      fuel_liters: 5, pit_stops: 0, driver_before: null, driver_after: null },
    { user_id: 7, first_stint: 3, last_stint: 3, start_at: t2, end_at: t3, stint_count: 1,
      fuel_liters: 6, pit_stops: 0, driver_before: null, driver_after: null },
  ]);
});

await test("computeBlocks: driver change mid-sequence splits into two blocks", () => {
  const t0 = new Date(0), t1 = new Date(60000), t2 = new Date(120000), t3 = new Date(180000), t4 = new Date(240000);
  const stints = [
    { number: 1, start_at: t0, end_at: t1, assigned_user_id: 7, fuel_liters: 10, pit_stops: 0 },
    { number: 2, start_at: t1, end_at: t2, assigned_user_id: 7, fuel_liters: 10, pit_stops: 0 },
    { number: 3, start_at: t2, end_at: t3, assigned_user_id: 9, fuel_liters: 8, pit_stops: 0 },
    { number: 4, start_at: t3, end_at: t4, assigned_user_id: 9, fuel_liters: 8, pit_stops: 1 },
  ];
  assert.deepStrictEqual(computeBlocks(stints), [
    { user_id: 7, first_stint: 1, last_stint: 2, start_at: t0, end_at: t2, stint_count: 2,
      fuel_liters: 20, pit_stops: 0, driver_before: null, driver_after: 9 },
    { user_id: 9, first_stint: 3, last_stint: 4, start_at: t2, end_at: t4, stint_count: 2,
      fuel_liters: 16, pit_stops: 1, driver_before: 7, driver_after: null },
  ]);
});

await test("computeBlocks: fuel_liters as STRINGS (real pg numeric columns) sums numerically, not by concatenation", () => {
  // pg returns `numeric` columns as strings. Regression test for a bug where
  // cur.fuel_liters += s.fuel_liters (both strings) did "20.5" + "15.5" ->
  // "20.515.5" instead of 36.
  const t0 = new Date(0), t1 = new Date(60000), t2 = new Date(120000);
  const stints = [
    { number: 1, start_at: t0, end_at: t1, assigned_user_id: 7, fuel_liters: "20.5", pit_stops: 0 },
    { number: 2, start_at: t1, end_at: t2, assigned_user_id: 7, fuel_liters: "15.5", pit_stops: 0 },
  ];
  const blocks = computeBlocks(stints);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].fuel_liters, 36);
});

// ---------------------------------------------------------------------------
// computeStintFuel (+ lapSeconds)
// ---------------------------------------------------------------------------

await test("lapSeconds: parses mm:ss and plain seconds", () => {
  assert.strictEqual(lapSeconds("1:30"), 90);
  assert.strictEqual(lapSeconds("1:30,5"), 90.5);
  assert.strictEqual(lapSeconds("95"), 95);
  assert.strictEqual(lapSeconds("garbage"), 0);
});

await test("computeStintFuel: pit stop falls exactly on the stint boundary", () => {
  // consPerLap=2, tankLiters=20, reserveLaps=0 -> maxLaps=10. lapSec=60.
  const raceStartAt = 0;
  const common = { lapSec: 60, consPerLap: 2, tankLiters: 20, reserveLaps: 0 };
  const stint1 = computeStintFuel({ raceStartAt, stintStartAt: 0, stintEndAt: 600000, ...common });
  const stint2 = computeStintFuel({ raceStartAt, stintStartAt: 600000, stintEndAt: 1200000, ...common });
  // Laps 0-10 then 10-20: the fuel-out boundary (every 10 laps) lands exactly
  // on both stint boundaries, so each stint accounts for exactly one stop.
  assert.deepStrictEqual(stint1, { fuel_liters: 20, pit_stops: 1 });
  assert.deepStrictEqual(stint2, { fuel_liters: 20, pit_stops: 1 });
});

await test("computeStintFuel: pit stop falls mid-stint (not on a boundary)", () => {
  // consPerLap=2, tankLiters=14, reserveLaps=0 -> maxLaps=7. lapSec=60.
  // Stint covers laps 0-10, so the lap-7 fuel-out point is mid-stint.
  const r = computeStintFuel({
    raceStartAt: 0, stintStartAt: 0, stintEndAt: 600000,
    lapSec: 60, consPerLap: 2, tankLiters: 14, reserveLaps: 0,
  });
  assert.deepStrictEqual(r, { fuel_liters: 20, pit_stops: 1 });
});

await test("computeStintFuel: reserveLaps shrinks maxLaps and adds an extra stop", () => {
  // consPerLap=2, tankLiters=20, reserveLaps=2 -> maxLaps=8 (vs. 10 with no reserve).
  const r = computeStintFuel({
    raceStartAt: 0, stintStartAt: 0, stintEndAt: 600000,
    lapSec: 60, consPerLap: 2, tankLiters: 20, reserveLaps: 2,
  });
  // 10 laps in stint, maxLaps=8 -> one stop crossed at lap 8.
  assert.deepStrictEqual(r, { fuel_liters: 20, pit_stops: 1 });
});

// ---------------------------------------------------------------------------
// Fake q() mock for the DB-touching functions.
// Each handler is tried in order; first whose `match` (substring of the SQL
// text) hits wins. Every call is logged so tests can assert on what was sent.
// ---------------------------------------------------------------------------

function makeFakeQ(handlers) {
  const calls = [];
  const q = async (text, params = []) => {
    calls.push({ text, params });
    for (const h of handlers) {
      if (text.includes(h.match)) return h.handle(params);
    }
    throw new Error(`fake q: no handler for SQL: ${text}`);
  };
  q.calls = calls;
  return q;
}

// ---------------------------------------------------------------------------
// hasOverlap
// ---------------------------------------------------------------------------

await test("hasOverlap: true when the mock returns an overlapping row", async () => {
  const q = makeFakeQ([
    { match: "from stints s join events e", handle: () => ({ rows: [{ "?column?": 1 }] }) },
  ]);
  const result = await hasOverlap(q, 42, new Date(0), new Date(1000));
  assert.strictEqual(result, true);
});

await test("hasOverlap: false when the mock returns no rows", async () => {
  const q = makeFakeQ([
    { match: "from stints s join events e", handle: () => ({ rows: [] }) },
  ]);
  const result = await hasOverlap(q, 42, new Date(0), new Date(1000));
  assert.strictEqual(result, false);
});

// ---------------------------------------------------------------------------
// recomputeReminders
// ---------------------------------------------------------------------------

await test("recomputeReminders: cancels pending reminders, then inserts per-block and one max-lead reminder", async () => {
  const eventId = 1;
  const startAt = new Date(120_000_000); // 2000 min after epoch
  const endAt = new Date(123_600_000);
  const q = makeFakeQ([
    { match: "from events where id=$1", handle: () => ({ rows: [{ id: eventId, reminder_lead_times: [1440, 120, 20] }] }) },
    { match: "from stints where event_id=$1", handle: () => ({ rows: [
      { number: 1, start_at: startAt, end_at: endAt, assigned_user_id: 5, fuel_liters: 10, pit_stops: 0 },
    ] }) },
    { match: "update reminders set status='cancelled'", handle: () => ({ rows: [] }) },
    { match: "insert into reminders", handle: () => ({ rows: [] }) },
  ]);

  await recomputeReminders(q, eventId, new Date(0));

  const cancels = q.calls.filter(c => c.text.includes("update reminders set status='cancelled'"));
  assert.strictEqual(cancels.length, 1);
  assert.deepStrictEqual(cancels[0].params, [eventId]);

  const inserts = q.calls.filter(c => c.text.includes("insert into reminders"));
  // leads [1440,120,20]: 1440 is maxLead -> handled once via the byUser loop;
  // 120 and 20 handled in the per-block loop. Total 3 inserts.
  assert.strictEqual(inserts.length, 3);

  const leadsUsed = inserts.map(c => c.params[4]).sort((a, b) => a - b);
  assert.deepStrictEqual(leadsUsed, [20, 120, 1440]);
  for (const c of inserts) {
    assert.strictEqual(c.params[0], eventId);
    assert.strictEqual(c.params[1], 5);   // user_id
    assert.strictEqual(c.params[2], 1);   // first_stint
    assert.strictEqual(c.params[3], 1);   // last_stint
  }
});

await test("recomputeReminders: block already started -> no reminders inserted", async () => {
  const eventId = 4;
  const startAt = new Date(120_000_000);
  const endAt = new Date(123_600_000);
  const q = makeFakeQ([
    { match: "from events where id=$1", handle: () => ({ rows: [{ id: eventId, reminder_lead_times: [1440, 120, 20] }] }) },
    { match: "from stints where event_id=$1", handle: () => ({ rows: [
      { number: 1, start_at: startAt, end_at: endAt, assigned_user_id: 5, fuel_liters: 10, pit_stops: 0 },
    ] }) },
    { match: "update reminders set status='cancelled'", handle: () => ({ rows: [] }) },
    { match: "insert into reminders", handle: () => ({ rows: [] }) },
  ]);

  // now is AFTER the block's start_at -> every dueAt/start_at check should skip.
  await recomputeReminders(q, eventId, new Date(startAt.getTime() + 1000));

  assert.strictEqual(q.calls.filter(c => c.text.includes("insert into reminders")).length, 0);
});

// ---------------------------------------------------------------------------
// distributeFreeStints
// ---------------------------------------------------------------------------

await test("distributeFreeStints: assigns a free stint to the first non-overlapping candidate", async () => {
  const eventId = 2;
  const freeStint = { id: 101, number: 1, start_at: new Date(0), end_at: new Date(60000), assigned_user_id: null };
  let overlapCallCount = 0;
  const q = makeFakeQ([
    { match: "from stints where event_id=$1 order by number", handle: () => ({ rows: [freeStint] }) },
    { match: "from users where active", handle: () => ({ rows: [{ id: 11 }, { id: 22 }] }) },
    { match: "from stints s join events e", handle: () => {
      overlapCallCount++;
      // First candidate (11) overlaps elsewhere, second candidate (22) is free.
      return { rows: overlapCallCount === 1 ? [{ "?column?": 1 }] : [] };
    } },
    { match: "update stints set assigned_user_id", handle: () => ({ rows: [] }) },
  ]);

  const result = await distributeFreeStints(q, eventId);

  assert.deepStrictEqual(result, { assigned: 1 });
  const updates = q.calls.filter(c => c.text.includes("update stints set assigned_user_id"));
  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(updates[0].params, [22, 101]); // skipped candidate 11 (overlap), used 22
});

await test("distributeFreeStints: no candidates left -> nothing assigned, no update calls", async () => {
  const eventId = 3;
  const freeStint = { id: 202, number: 1, start_at: new Date(0), end_at: new Date(60000), assigned_user_id: null };
  const q = makeFakeQ([
    { match: "from stints where event_id=$1 order by number", handle: () => ({ rows: [freeStint] }) },
    { match: "from users where active", handle: () => ({ rows: [] }) },
    { match: "update stints set assigned_user_id", handle: () => ({ rows: [] }) },
  ]);

  const result = await distributeFreeStints(q, eventId);

  assert.deepStrictEqual(result, { assigned: 0 });
  assert.strictEqual(q.calls.filter(c => c.text.includes("update stints set assigned_user_id")).length, 0);
});

console.log(`\n${passed} tests passed`);
