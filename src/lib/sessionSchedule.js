// src/lib/sessionSchedule.js  (NEW)
//
// Pure schedule-generation logic — no DB, no Express. Timezone-correct
// occurrence generation across DST boundaries. Tested against US (EST/EDT)
// and UK (GMT/BST) transitions: the student always sees the same wall-clock
// time; the underlying UTC instant shifts correctly across DST.

// Offset (ms) of `timeZone` at a given UTC instant. Positive = ahead of UTC.
function getOffset(timeZone, instantMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(instantMs));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  const hour = m.hour === "24" ? 0 : parseInt(m.hour, 10);
  const wallAsUTC = Date.UTC(
    +m.year,
    +m.month - 1,
    +m.day,
    hour,
    +m.minute,
    +m.second,
  );
  return wallAsUTC - instantMs;
}

// Convert a wall-clock time in `timeZone` to a UTC Date (DST-correct, two-pass).
export function zonedWallClockToUtc(y, mo, d, h, mi, timeZone) {
  const wallAsUTC = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = getOffset(timeZone, wallAsUTC);
  let utc = wallAsUTC - off1;
  const off2 = getOffset(timeZone, utc);
  if (off2 !== off1) utc = wallAsUTC - off2;
  return new Date(utc);
}

function parseDate(s) {
  const [y, mo, d] = s.split("-").map(Number);
  return { y, mo, d };
}
function parseTime(s) {
  const [h, mi] = s.split(":").map(Number);
  return { h, mi };
}

/**
 * Generate session occurrences (student's timezone drives wall-clock).
 * cfg: { startDate:'YYYY-MM-DD', endDate:'YYYY-MM-DD', timeZone,
 *        days:[{ weekday:0-6, startTime:'HH:MM', durationMins }],
 *        blackout:['YYYY-MM-DD'] }
 * → [{ dateISO, weekday, startUtc:Date, endUtc:Date, durationMins, blackout:bool }]
 */
export function generateOccurrences(cfg) {
  const { startDate, endDate, timeZone, days, blackout = [] } = cfg;
  const byWeekday = new Map();
  for (const d of days) byWeekday.set(Number(d.weekday), d);
  const blackoutSet = new Set(blackout);

  const start = parseDate(startDate);
  const end = parseDate(endDate);
  let cursor = Date.UTC(start.y, start.mo - 1, start.d); // UTC-midnight cursor (DST-immune)
  const endMs = Date.UTC(end.y, end.mo - 1, end.d);

  const out = [];
  while (cursor <= endMs) {
    const cd = new Date(cursor);
    const y = cd.getUTCFullYear(),
      mo = cd.getUTCMonth() + 1,
      d = cd.getUTCDate();
    const wd = cd.getUTCDay();
    const spec = byWeekday.get(wd);
    if (spec) {
      const dateISO = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const { h, mi } = parseTime(spec.startTime);
      const startUtc = zonedWallClockToUtc(y, mo, d, h, mi, timeZone);
      const endUtc = new Date(startUtc.getTime() + spec.durationMins * 60000);
      out.push({
        dateISO,
        weekday: wd,
        startUtc,
        endUtc,
        durationMins: spec.durationMins,
        blackout: blackoutSet.has(dateISO),
      });
    }
    cursor += 24 * 3600 * 1000;
  }
  return out;
}

// Two time windows [s1,e1] and [s2,e2] overlap iff s1 < e2 && s2 < e1.
export function overlaps(s1, e1, s2, e2) {
  return s1.getTime() < e2.getTime() && s2.getTime() < e1.getTime();
}
