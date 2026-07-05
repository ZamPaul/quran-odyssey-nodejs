// src/lib/analytics.js  (NEW)
//
// Pure analytics computation — no DB. Unit-tested (17 cases): cohort matrix,
// funnel rates, date bucketing, month arithmetic.

export function monthKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function addMonths(ym, k) {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + k;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}
export function monthsBetween(a, b) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return by * 12 + bm - (ay * 12 + am);
}

export function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

export function makeBuckets(start, end, granularity) {
  const buckets = [];
  if (granularity === "day") {
    let cur = Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
    );
    const endMs = Date.UTC(
      end.getUTCFullYear(),
      end.getUTCMonth(),
      end.getUTCDate(),
    );
    while (cur <= endMs) {
      const d = new Date(cur);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      buckets.push({
        bucket: key,
        label: d.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        }),
      });
      cur += 86400000;
    }
  } else {
    let cur = monthKey(start);
    const endK = monthKey(end);
    while (monthsBetween(cur, endK) >= 0) {
      buckets.push({ bucket: cur, label: monthLabel(cur) });
      cur = addMonths(cur, 1);
    }
  }
  return buckets;
}

export function bucketKeyOf(date, granularity) {
  const d = new Date(date);
  if (granularity === "day")
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return monthKey(date);
}

// students: [{ studentId, cohortMonth, activeMonths:Set }] ; nowMonth 'YYYY-MM'
// M0 = 100% baseline (enrolled). M(k>=1) = % of cohort with activity in month C+k.
export function computeCohortMatrix(students, nowMonth) {
  const byCohort = new Map();
  for (const s of students) {
    if (!byCohort.has(s.cohortMonth)) byCohort.set(s.cohortMonth, []);
    byCohort.get(s.cohortMonth).push(s);
  }
  return [...byCohort.keys()].sort().map((cohort) => {
    const members = byCohort.get(cohort);
    const size = members.length;
    const maxOffset = monthsBetween(cohort, nowMonth);
    const retention = [];
    for (let k = 0; k <= maxOffset; k++) {
      if (k === 0) {
        retention.push({ offset: 0, pct: 100, n: size });
        continue;
      }
      const targetMonth = addMonths(cohort, k);
      const n = members.filter((m) => m.activeMonths.has(targetMonth)).length;
      retention.push({
        offset: k,
        pct: size ? Math.round((n / size) * 100) : 0,
        n,
      });
    }
    return { cohort, label: monthLabel(cohort), size, retention };
  });
}

export function funnelRates(stages) {
  const first = stages[0]?.count || 0;
  return stages.map((s, i) => {
    const prev = i > 0 ? stages[i - 1].count : s.count;
    return {
      ...s,
      pctOfPrev: prev ? Math.round((s.count / prev) * 100) : 0,
      pctOfFirst: first ? Math.round((s.count / first) * 100) : 0,
    };
  });
}
