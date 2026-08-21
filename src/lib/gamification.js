// src/lib/gamification.js
//
// Pure computation. No database access, no Prisma import — the route fetches,
// this module computes. Same pattern as oversight.js and analytics.js.
//
// EVERYTHING IS DERIVED from records that already exist (attendance, sessions,
// submissions, reports). Nothing is stored, so:
//   • no migration, no backfill
//   • every existing family sees their real history on day one, not zero
//   • corrections to attendance self-heal the numbers
//   • a bug is fixed by deploying a fix, not by repairing rows
//
// NOTE ON AUDIENCE: parents and children share one login and one dashboard.
// This module returns NUMBERS ONLY — never copy. The UI chooses whether to say
// "You attended 12 in a row" or "Zayd attended 12 in a row".

// ═══════════════════════════════════════════════════════════
// TUNING — every value that defines the economy lives here.
// ═══════════════════════════════════════════════════════════

export const XP = {
  SESSION_PRESENT: 10,
  SESSION_LATE: 5,
  HOMEWORK_ON_TIME: 15,
  HOMEWORK_LATE: 5,
  STRONG_REPORT: 25, // teacher rating of 4 or 5
  COURSE_COMPLETED: 100,
};

// Effort is weighted above outcome on purpose: a consistent but struggling
// child should be able to out-earn a gifted but erratic one. That is the right
// incentive for religious study.

export const STREAK = {
  // EXCUSED never breaks a streak. A child ill for a week, or away for Eid,
  // must not lose months of built-up progress. The data already distinguishes
  // this — use it.
  CONTINUES: ["PRESENT", "LATE"],
  BREAKS: ["ABSENT"],
  IGNORED: ["EXCUSED"],
};

// Cumulative XP thresholds. An engaged student attending twice weekly and doing
// homework earns roughly 40–50 XP/week, so these pace at a few weeks per level
// early on, stretching later.
//
// ⚠️ The Arabic names are the classical stages of learning and are pending
// confirmation by the client (see Phase 0 decisions). Swap `name`/`arabic`
// freely — nothing else depends on them.
export const LEVELS = [
  { level: 1, minXp: 0, name: "Beginner", arabic: "Mubtadi'" },
  { level: 2, minXp: 120, name: "Learner", arabic: "Mutaʿallim" },
  { level: 3, minXp: 320, name: "Steady", arabic: "Muthābir" },
  { level: 4, minXp: 640, name: "Intermediate", arabic: "Mutawassit" },
  { level: 5, minXp: 1100, name: "Dedicated", arabic: "Mujtahid" },
  { level: 6, minXp: 1750, name: "Advanced", arabic: "Mutaqaddim" },
  { level: 7, minXp: 2600, name: "Accomplished", arabic: "Mutqin" },
  { level: 8, minXp: 3800, name: "Master", arabic: "Ḥāfiẓ" },
];

export const PROGRESS_BASIS = {
  ATTENDANCE: "attendance", // sessions attended vs expected — honest, but measures attendance
  TEACHER_SET: "teacher", // teacher-supplied percent — needs a schema field
  CURRICULUM: "curriculum", // real lesson position — needs a curriculum model
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

const DAY = 86400000;
const toTime = (d) => (d ? new Date(d).getTime() : 0);
const monthKey = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * Normalise raw rows into the shape every function below expects.
 * Tolerant of missing relations so a partially-loaded student never throws.
 *
 * @param {Object} raw
 *   attendance  [{ status, markedAt, session: { scheduledAt } }]
 *   sessions    [{ status, scheduledAt }]
 *   assignments [{ dueDate, submission: { submittedAt } | null }]
 *   reports     [{ status, overallRating, sentAt }]
 *   enrollments [{ startDate, status, sessionsPerWeek, courseType, progressPercent? }]
 */
export function normalizeActivity(raw = {}) {
  const attendance = (raw.attendance || [])
    .map((a) => ({
      status: a.status,
      // Order by when the LESSON happened, not when the teacher got round to
      // marking it. Marking late must not reorder a child's history.
      at: toTime(a.session?.scheduledAt || a.markedAt),
    }))
    .filter((a) => a.at > 0)
    .sort((x, y) => x.at - y.at);

  const sessions = (raw.sessions || [])
    .map((s) => ({ status: s.status, at: toTime(s.scheduledAt) }))
    .filter((s) => s.at > 0)
    .sort((x, y) => x.at - y.at);

  const assignments = (raw.assignments || []).map((a) => {
    const due = toTime(a.dueDate);
    const submittedAt = a.submission ? toTime(a.submission.submittedAt) : null;
    return {
      due,
      submittedAt,
      submitted: !!submittedAt,
      onTime: !!submittedAt && submittedAt <= due,
    };
  });

  const reports = (raw.reports || [])
    .filter((r) => r.status === "SENT")
    .map((r) => ({ rating: r.overallRating ?? null, at: toTime(r.sentAt) }));

  const enrollments = (raw.enrollments || []).map((e) => ({
    startDate: toTime(e.startDate),
    status: e.status,
    sessionsPerWeek: e.sessionsPerWeek || 2,
    courseType: e.courseType,
    progressPercent: e.progressPercent ?? null,
  }));

  return { attendance, sessions, assignments, reports, enrollments };
}

// ═══════════════════════════════════════════════════════════
// STREAK — measured in SESSIONS, never days
// ═══════════════════════════════════════════════════════════
//
// Students attend 2–3 times a week. A day-streak would break every single day
// by design and be actively demoralising. Count consecutive attended sessions.

export function computeStreak(attendance = []) {
  const relevant = attendance.filter((a) => !STREAK.IGNORED.includes(a.status));

  let current = 0;
  let best = 0;
  let run = 0;
  let lastAttendedAt = null;

  for (const a of relevant) {
    if (STREAK.CONTINUES.includes(a.status)) {
      run += 1;
      if (run > best) best = run;
      lastAttendedAt = a.at;
    } else {
      run = 0;
    }
  }
  current = run; // the run still open at the end of the history

  return {
    current,
    best,
    lastAttendedAt: lastAttendedAt
      ? new Date(lastAttendedAt).toISOString()
      : null,
    // True when the child is currently on their best-ever run — the moment
    // worth celebrating rather than just reporting.
    isPersonalBest: current > 0 && current >= best,
  };
}

// ═══════════════════════════════════════════════════════════
// XP
// ═══════════════════════════════════════════════════════════

export function computeXp(activity, { now = Date.now() } = {}) {
  const { attendance, assignments, reports, enrollments } = activity;

  const breakdown = {
    sessions: 0,
    homework: 0,
    reports: 0,
    courses: 0,
  };

  for (const a of attendance) {
    if (a.status === "PRESENT") breakdown.sessions += XP.SESSION_PRESENT;
    else if (a.status === "LATE") breakdown.sessions += XP.SESSION_LATE;
  }

  for (const a of assignments) {
    if (!a.submitted) continue;
    breakdown.homework += a.onTime ? XP.HOMEWORK_ON_TIME : XP.HOMEWORK_LATE;
  }

  for (const r of reports) {
    if (r.rating != null && r.rating >= 4)
      breakdown.reports += XP.STRONG_REPORT;
  }

  for (const e of enrollments) {
    if (e.status === "COMPLETED") breakdown.courses += XP.COURSE_COMPLETED;
  }

  const total = Object.values(breakdown).reduce((s, n) => s + n, 0);

  // Last 7 days — drives the "earned this week" line.
  const weekAgo = now - 7 * DAY;
  let thisWeek = 0;
  for (const a of attendance) {
    if (a.at < weekAgo) continue;
    if (a.status === "PRESENT") thisWeek += XP.SESSION_PRESENT;
    else if (a.status === "LATE") thisWeek += XP.SESSION_LATE;
  }
  for (const a of assignments) {
    if (!a.submitted || a.submittedAt < weekAgo) continue;
    thisWeek += a.onTime ? XP.HOMEWORK_ON_TIME : XP.HOMEWORK_LATE;
  }

  return { total, breakdown, thisWeek };
}

// ═══════════════════════════════════════════════════════════
// LEVEL
// ═══════════════════════════════════════════════════════════

export function computeLevel(totalXp = 0) {
  let current = LEVELS[0];
  for (const l of LEVELS) if (totalXp >= l.minXp) current = l;

  const next = LEVELS.find((l) => l.level === current.level + 1) || null;
  const xpIntoLevel = totalXp - current.minXp;
  const xpForNext = next ? next.minXp - current.minXp : 0;

  return {
    level: current.level,
    name: current.name,
    arabic: current.arabic,
    totalXp,
    xpIntoLevel,
    xpForNext,
    xpToNext: next ? Math.max(next.minXp - totalXp, 0) : 0,
    percentToNext:
      next && xpForNext > 0
        ? Math.min(Math.round((xpIntoLevel / xpForNext) * 100), 100)
        : 100,
    isMax: !next,
    nextName: next ? next.name : null,
  };
}

// ═══════════════════════════════════════════════════════════
// BADGES — every one derived, so they award retroactively
// ═══════════════════════════════════════════════════════════

export const BADGES = [
  {
    key: "first_steps",
    name: "First Steps",
    description: "Completed your first class",
    icon: "🌱",
  },
  {
    key: "finding_rhythm",
    name: "Finding Rhythm",
    description: "10 classes in a row",
    icon: "🎵",
  },
  {
    key: "devoted",
    name: "Devoted",
    description: "Attended 50 classes",
    icon: "⭐",
  },
  {
    key: "centurion",
    name: "Century",
    description: "Attended 100 classes",
    icon: "💯",
  },
  {
    key: "always_on_time",
    name: "Always On Time",
    description: "20 classes in a row, never late",
    icon: "⏰",
  },
  {
    key: "homework_hero",
    name: "Homework Hero",
    description: "10 assignments handed in on time",
    icon: "📚",
  },
  {
    key: "perfect_month",
    name: "Perfect Month",
    description: "A full month with no missed classes",
    icon: "🏅",
  },
  {
    key: "praised",
    name: "Praised",
    description: "A top mark from your teacher",
    icon: "🌟",
  },
  {
    key: "course_complete",
    name: "Course Complete",
    description: "Finished a full course",
    icon: "🎓",
  },
];

const BADGE_BY_KEY = Object.fromEntries(BADGES.map((b) => [b.key, b]));

/**
 * Returns EVERY badge with its progress, earned or not — so the UI can show
 * "3 of 4 more classes to go", which motivates far better than a locked icon.
 */
export function computeBadges(activity) {
  const { attendance, assignments, reports, enrollments } = activity;
  const streak = computeStreak(attendance);

  const attended = attendance.filter((a) =>
    STREAK.CONTINUES.includes(a.status),
  );
  const onTimeHomework = assignments.filter((a) => a.onTime).length;
  const topRating = reports.some((r) => r.rating === 5);
  const completedCourses = enrollments.filter(
    (e) => e.status === "COMPLETED",
  ).length;

  // Longest run of consecutive PRESENT (excludes LATE) — for "Always On Time"
  let punctualRun = 0,
    bestPunctual = 0;
  for (const a of attendance) {
    if (a.status === "EXCUSED") continue;
    if (a.status === "PRESENT") {
      punctualRun += 1;
      if (punctualRun > bestPunctual) bestPunctual = punctualRun;
    } else punctualRun = 0;
  }

  // A calendar month with at least one session and no ABSENT
  const byMonth = new Map();
  for (const a of attendance) {
    const k = monthKey(a.at);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(a.status);
  }
  let perfectMonths = 0;
  for (const [, statuses] of byMonth) {
    const counted = statuses.filter((s) => s !== "EXCUSED");
    if (counted.length > 0 && !counted.includes("ABSENT")) perfectMonths += 1;
  }

  const defs = [
    { key: "first_steps", value: attended.length, target: 1 },
    { key: "finding_rhythm", value: streak.best, target: 10 },
    { key: "devoted", value: attended.length, target: 50 },
    { key: "centurion", value: attended.length, target: 100 },
    { key: "always_on_time", value: bestPunctual, target: 20 },
    { key: "homework_hero", value: onTimeHomework, target: 10 },
    { key: "perfect_month", value: perfectMonths, target: 1 },
    { key: "praised", value: topRating ? 1 : 0, target: 1 },
    { key: "course_complete", value: completedCourses, target: 1 },
  ];

  return defs.map((d) => {
    const meta = BADGE_BY_KEY[d.key];
    const earned = d.value >= d.target;
    return {
      ...meta,
      earned,
      value: d.value,
      target: d.target,
      percent: Math.min(Math.round((d.value / d.target) * 100), 100),
      remaining: Math.max(d.target - d.value, 0),
    };
  });
}

// ═══════════════════════════════════════════════════════════
// PROGRESS
// ═══════════════════════════════════════════════════════════
//
// ⚠️ There is no curriculum position in the schema — nothing records "lesson 12
// of 40" or "Juz 3 of 30". All three bases are implemented so the Phase 0
// decision does not block anything. `basis` and `label` are returned so the UI
// can never present attendance as if it were course completion.

export function computeProgress(
  activity,
  { basis = PROGRESS_BASIS.ATTENDANCE, now = Date.now() } = {},
) {
  const { enrollments, attendance } = activity;
  const active = enrollments.filter((e) => e.status === "ACTIVE");

  if (active.length === 0) {
    return { percent: 0, basis, label: "No active course", meaningful: false };
  }

  if (basis === PROGRESS_BASIS.TEACHER_SET) {
    const withPercent = active.filter((e) => e.progressPercent != null);
    if (withPercent.length === 0) {
      return {
        percent: 0,
        basis,
        label: "Awaiting teacher assessment",
        meaningful: false,
      };
    }
    const avg =
      withPercent.reduce((s, e) => s + e.progressPercent, 0) /
      withPercent.length;
    return {
      percent: Math.round(avg),
      basis,
      label: "Course progress",
      meaningful: true,
    };
  }

  if (basis === PROGRESS_BASIS.CURRICULUM) {
    return {
      percent: 0,
      basis,
      label: "Curriculum tracking not enabled",
      meaningful: false,
    };
  }

  // ATTENDANCE basis — attended vs expected since the course began.
  // Labelled "Attendance this course", never "Course progress".
  const earliest = Math.min(...active.map((e) => e.startDate));
  const weeks = Math.max((now - earliest) / (7 * DAY), 0);
  const perWeek = active.reduce((s, e) => s + e.sessionsPerWeek, 0);
  const expected = Math.round(weeks * perWeek);
  const attended = attendance.filter((a) =>
    STREAK.CONTINUES.includes(a.status),
  ).length;

  if (expected <= 0) {
    return {
      percent: 0,
      basis,
      label: "Just started",
      meaningful: false,
      attended,
      expected: 0,
    };
  }
  return {
    percent: Math.min(Math.round((attended / expected) * 100), 100),
    basis,
    label: "Attendance this course",
    meaningful: expected >= 4, // fewer than 4 expected sessions is noise
    attended,
    expected,
  };
}

// ═══════════════════════════════════════════════════════════
// TOP-LEVEL
// ═══════════════════════════════════════════════════════════

export function computeGamification(raw, options = {}) {
  const activity = normalizeActivity(raw);
  const streak = computeStreak(activity.attendance);
  const xp = computeXp(activity, options);
  const level = computeLevel(xp.total);
  const badges = computeBadges(activity);
  const progress = computeProgress(activity, options);

  const attended = activity.attendance.filter((a) =>
    STREAK.CONTINUES.includes(a.status),
  ).length;
  const earned = badges.filter((b) => b.earned);

  // The nearest unearned badge — the single most motivating thing to surface.
  const nextBadge =
    badges.filter((b) => !b.earned).sort((a, b) => b.percent - a.percent)[0] ||
    null;

  return {
    // A brand-new family is NOT an error state. This flag lets the UI show a
    // welcome rather than a wall of zeros — it is every new customer's first
    // impression of the feature.
    isNew: attended === 0 && xp.total === 0,
    streak,
    xp,
    level,
    progress,
    badges,
    earnedBadges: earned,
    badgeCount: earned.length,
    badgeTotal: badges.length,
    nextBadge,
    totals: {
      sessionsAttended: attended,
      homeworkSubmitted: activity.assignments.filter((a) => a.submitted).length,
      homeworkOnTime: activity.assignments.filter((a) => a.onTime).length,
      reportsReceived: activity.reports.length,
    },
  };
}
