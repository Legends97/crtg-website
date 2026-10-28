// Sprit-Formel, hergeleitet aus sprit/index.html (maxLaps = floor(tank/cons) - reserve),
// aber über die ganze Renndauer durchgerechnet statt pro Stint isoliert, damit
// Boxenstopps korrekt auf Stintgrenzen fallen.
//
// Zeit-Parameter (raceStartAt, stintStartAt, stintEndAt) sind JS Date-Objekte
// oder ms-Timestamps (Subtraktion funktioniert in beiden Fällen gleich).
// Reine Funktionen: kein Date.now(), kein DB-Zugriff.

export function lapSeconds(v) {
  v = String(v).trim().replace(",", ".");
  const m = v.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  return m ? +m[1] * 60 + +m[2] : (/^\d+(\.\d+)?$/.test(v) ? +v : 0);
}

export function computeStintFuel({ raceStartAt, stintStartAt, stintEndAt, lapSec, consPerLap, tankLiters, reserveLaps }) {
  const maxLaps = Math.max(1, Math.floor(tankLiters / consPerLap) - reserveLaps);
  const lapsBefore = Math.floor((stintStartAt - raceStartAt) / 1000 / lapSec);
  const lapsAfter  = Math.floor((stintEndAt   - raceStartAt) / 1000 / lapSec);
  const lapsInStint = Math.max(0, lapsAfter - lapsBefore);
  return {
    fuel_liters: Math.round(lapsInStint * consPerLap * 10) / 10,
    pit_stops: Math.floor(lapsAfter / maxLaps) - Math.floor(lapsBefore / maxLaps),
  };
}
