// src/lib/oversight.js  (NEW)
//
// Pure oversight computation — no DB. Unit-tested against false-positive
// edge cases (EXCUSED breaks streaks; new enrollments aren't overdue;
// small samples don't trigger the % rule).

export const RISK = {
  CONSECUTIVE_ABSENCES: 3, // flag on N absences in a row
  PCT_WINDOW: 8, // look at the last N sessions
  PCT_FLOOR: 0.6, // flag if attended% below this
  PCT_MIN_SESSIONS: 5, // …but only with a big enough sample
};

export const OVERDUE_REPORT_DAYS = 30; // active enrollment w/ no SENT report in this window
export const UNMARKED_HOURS = 10; // SCHEDULED session this many hours past = unmarked

// records: [{ status, scheduledAt }]  → { atRisk, reasons[], stats }
export function computeStudentRisk(records) {
  const sorted = [...records].sort(
    (a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt),
  );
  const reasons = [];

  // Trigger 1: consecutive ABSENT (EXCUSED is legitimate and breaks the streak)
  let streak = 0;
  for (const r of sorted) {
    if (r.status === "ABSENT") {
      streak++;
      if (streak >= RISK.CONSECUTIVE_ABSENCES) break;
    } else break;
  }
  if (streak >= RISK.CONSECUTIVE_ABSENCES) {
    reasons.push({
      code: "CONSECUTIVE_ABSENCES",
      detail: `${streak} absences in a row`,
    });
  }

  // Trigger 2: low attendance % over the window (needs a minimum sample)
  const window = sorted.slice(0, RISK.PCT_WINDOW);
  const total = window.length;
  const attended = window.filter(
    (r) => r.status === "PRESENT" || r.status === "LATE",
  ).length;
  const pct = total > 0 ? attended / total : null;
  if (total >= RISK.PCT_MIN_SESSIONS && pct !== null && pct < RISK.PCT_FLOOR) {
    reasons.push({
      code: "LOW_ATTENDANCE",
      detail: `${Math.round(pct * 100)}% over last ${total}`,
    });
  }

  const breakdown = {
    present: window.filter((r) => r.status === "PRESENT").length,
    late: window.filter((r) => r.status === "LATE").length,
    absent: window.filter((r) => r.status === "ABSENT").length,
    excused: window.filter((r) => r.status === "EXCUSED").length,
  };

  return {
    atRisk: reasons.length > 0,
    reasons,
    stats: {
      windowSize: total,
      attendedPct: pct === null ? null : Math.round(pct * 100),
      consecutiveAbsences: streak,
      breakdown,
    },
  };
}

// recentReportKeys: Set of `${studentId}:${teacherId}` with a SENT report in window.
// export function isReportOverdue(
//   enrollment,
//   recentReportKeys,
//   now = new Date(),
// ) {
//   if (enrollment.status !== "ACTIVE") return false;
//   const started = new Date(enrollment.startDate);
//   const cutoff = new Date(now.getTime() - OVERDUE_REPORT_DAYS * 86400000);
//   if (started > cutoff) return false; // too new to be overdue
//   return !recentReportKeys.has(
//     `${enrollment.studentId}:${enrollment.teacherId}`,
//   );
// }

// recentReportEnrollmentIds: Set of enrollmentId values that HAVE a SENT report
// in the window. Keyed per-enrollment so a student taking two courses from the
// same teacher is tracked separately (no cross-course masking).
export function isReportOverdue(enrollment, recentReportEnrollmentIds, now = new Date()) {
  if (enrollment.status !== "ACTIVE") return false;
  const started = new Date(enrollment.startDate);
  const cutoff = new Date(now.getTime() - OVERDUE_REPORT_DAYS * 86400000);
  if (started > cutoff) return false; // too new to be overdue
  return !recentReportEnrollmentIds.has(enrollment.id);
}

export function unmarkedCutoff(now = new Date()) {
  return new Date(now.getTime() - UNMARKED_HOURS * 3600000);
}
