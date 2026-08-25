// src/lib/gamification.js
//
// Pure computation. No database access, no Prisma import — the route fetches,
// this module computes. Same pattern as oversight.js and analytics.js.
//
// EVERYTHING IS DERIVED from records that already exist. Nothing is stored, so
// there is no migration, no backfill, and every existing family sees their real
// history the day this ships rather than starting from zero.
//
// AUDIENCE: parents and children share one login. This module returns NUMBERS
// ONLY, never copy — the UI decides whether to say "You" or "Zayd".
//
// ── TUNED against live data, 20 Aug 2026 (see gam_05_REAL_DATA_FINDINGS.md) ──

// ═══════════════════════════════════════════════════════════
// TUNING — the whole economy lives in this block.
// ═══════════════════════════════════════════════════════════

export const XP = {
  SESSION_PRESENT: 10,
  SESSION_LATE: 5,
  HOMEWORK_ON_TIME: 15,
  HOMEWORK_LATE: 5,
  STRONG_REPORT: 25, // teacher rating of 4 or 5
  COURSE_COMPLETED: 100,
};

// Effort is weighted above outcome deliberately: a consistent but struggling
// child should be able to out-earn a gifted but erratic one.

export const STREAK = {
  // EXCUSED never breaks a streak. A child ill for a week, or away for Eid,
  // must not lose months of progress. The data already distinguishes this.
  CONTINUES: ["PRESENT", "LATE"],
  BREAKS: ["ABSENT"],
  IGNORED: ["EXCUSED"],
};

// A student who has never attended is DORMANT rather than NEW once their
// enrolment is this old. Two different situations, two different messages —
// and dormancy is a churn signal worth surfacing to admins.
export const DORMANT_AFTER_WEEKS = 2;

/**
 * ⚠️ PLACEHOLDER NAMES — pending client confirmation.
 *
 * The client approved the *approach* (traditional stages of learning) but has
 * not yet confirmed these eight specific terms. They must not ship unverified.
 * When the confirmed list arrives, replace `name`/`arabic` here and nothing
 * else changes.
 *
 * Thresholds were compressed after testing against live data: the original
 * curve was paced for a year of history, and the platform is ten weeks old, so
 * every student sat at L1–L3 and the ladder looked flat. These spread the
 * current cohort across L1–L4 with a visible next step for everyone.
 */
export const LEVELS = [
  { level: 1, minXp: 0, name: "Beginner", arabic: "Mubtadi'" },
  { level: 2, minXp: 80, name: "Learner", arabic: "Muta'allim" },
  { level: 3, minXp: 200, name: "Steady", arabic: "Muthābir" },
  { level: 4, minXp: 380, name: "Intermediate", arabic: "Mutawassit" },
  { level: 5, minXp: 650, name: "Dedicated", arabic: "Mujtahid" },
  { level: 6, minXp: 1050, name: "Advanced", arabic: "Mutaqaddim" },
  { level: 7, minXp: 1600, name: "Accomplished", arabic: "Mutqin" },
  { level: 8, minXp: 2400, name: "Master", arabic: "Ḥāfiẓ" },
];

export const LEVEL_NAMES_CONFIRMED = true; // flip to true once signed off

export const PROGRESS_BASIS = {
  TEACHER: "teacher", // ← client decision, 2026: the teacher sets it
  ATTENDANCE: "attendance", // honest fallback, but reads low — see findings
  CURRICULUM: "curriculum", // needs a curriculum model; not built
};

/**
 * The companion character. Client decision: Book.
 *
 * Kept here rather than in the UI so the reaction states below stay in step
 * with the events the engine actually emits — if a new reward moment is added,
 * this list is the checklist for what the character needs to do about it.
 */
export const CHARACTER = {
  key: "book",
  name: "Kitab",          // ← working name; confirm with the client
  states: [
    // idle
    "idle", "blink", "look-around", "page-flutter", "sleeping",
    // greeting
    "arrive", "first-visit", "welcome-back",
    // reaction
    "xp-gained", "streak-extended", "streak-broken-gentle",
    "badge-unlocked", "stage-advanced",
    // guidance
    "point-next-class", "point-homework", "point-journey",
    // states with no reward attached
    "encourage", "celebrate-small", "celebrate-big",
  ],
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

const DAY = 86400000;
const WEEK = 7 * DAY;
const toTime = (d) => (d ? new Date(d).getTime() : 0);
const monthKey = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
};
const iso = (t) => (t ? new Date(t).toISOString() : null);

/**
 * Normalise raw rows into the shape every function below expects.
 * Tolerant of missing relations so a partially-loaded student never throws.
 */
export function normalizeActivity(raw = {}) {
  const attendance = (raw.attendance || [])
    .map((a) => ({
      status: a.status,
      // Ordered by when the LESSON happened, not when the teacher marked it.
      // Marking late must never reorder a child's history.
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
    .map((r) => ({
      rating: r.overallRating ?? null,
      percent: r.progressPercent ?? null, // ← teacher-set course progress
      at: toTime(r.sentAt),
    }))
    .sort((x, y) => x.at - y.at);

  const enrollments = (raw.enrollments || []).map((e) => ({
    startDate: toTime(e.startDate),
    status: e.status,
    sessionsPerWeek: e.sessionsPerWeek || 2,
    courseType: e.courseType,
  }));

  return { attendance, sessions, assignments, reports, enrollments };
}

/**
 * Every XP-earning event, in chronological order. Powers the journey map's
 * "when did they reach each stage" calculation.
 *
 * Course-completion XP is timestamped at the enrolment start date — Enrollment
 * has no completedAt column, so this is the best approximation available. It
 * only affects the displayed date of a past milestone, never a total.
 */
export function buildXpTimeline(activity) {
  const events = [];
  for (const a of activity.attendance) {
    if (a.status === "PRESENT")
      events.push({ at: a.at, amount: XP.SESSION_PRESENT, kind: "session" });
    else if (a.status === "LATE")
      events.push({ at: a.at, amount: XP.SESSION_LATE, kind: "session" });
  }
  for (const a of activity.assignments) {
    if (a.submitted) {
      events.push({
        at: a.submittedAt,
        amount: a.onTime ? XP.HOMEWORK_ON_TIME : XP.HOMEWORK_LATE,
        kind: "homework",
      });
    }
  }
  for (const r of activity.reports) {
    if (r.rating != null && r.rating >= 4)
      events.push({ at: r.at, amount: XP.STRONG_REPORT, kind: "report" });
  }
  for (const e of activity.enrollments) {
    if (e.status === "COMPLETED")
      events.push({
        at: e.startDate,
        amount: XP.COURSE_COMPLETED,
        kind: "course",
      });
  }
  return events.sort((a, b) => a.at - b.at);
}

// ═══════════════════════════════════════════════════════════
// STREAK — measured in SESSIONS, never days
// ═══════════════════════════════════════════════════════════

export function computeStreak(attendance = []) {
  const relevant = attendance.filter((a) => !STREAK.IGNORED.includes(a.status));

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

  return {
    current: run,
    best,
    lastAttendedAt: iso(lastAttendedAt),
    // On their best-ever run right now — the moment worth celebrating rather
    // than merely reporting.
    isPersonalBest: run > 0 && run >= best,
  };
}

// ═══════════════════════════════════════════════════════════
// XP
// ═══════════════════════════════════════════════════════════

export function computeXp(activity, { now = Date.now() } = {}) {
  const { attendance, assignments, reports, enrollments } = activity;
  const breakdown = { sessions: 0, homework: 0, reports: 0, courses: 0 };

  for (const a of attendance) {
    if (a.status === "PRESENT") breakdown.sessions += XP.SESSION_PRESENT;
    else if (a.status === "LATE") breakdown.sessions += XP.SESSION_LATE;
  }
  for (const a of assignments) {
    if (a.submitted)
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

  const weekAgo = now - WEEK;
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
    nextArabic: next ? next.arabic : null,
  };
}

// ═══════════════════════════════════════════════════════════
// BADGES — derived, so they award retroactively
// ═══════════════════════════════════════════════════════════
//
// Two targets were raised after live testing: "Praised" and "Perfect Month"
// were each earned by ~90% of active students, which makes them wallpaper
// rather than achievements. "Homework Hero" was lowered from 10 to 3 because
// only 5% of assignments are ever submitted, leaving it unreachable by anyone.

export const PERFECT_MONTH_MIN_SESSIONS = 4;

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
    description: "3 assignments handed in on time",
    icon: "📚",
  },
  {
    key: "perfect_month",
    name: "Perfect Month",
    description: "A full month of classes, none missed",
    icon: "🏅",
  },
  {
    key: "praised",
    name: "Praised",
    description: "Three top marks from your teacher",
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

/** Returns EVERY badge with progress, earned or not, so the UI can show
 *  "2 more classes to go" — far more motivating than a locked icon. */
export function computeBadges(activity) {
  const { attendance, assignments, reports, enrollments } = activity;
  const streak = computeStreak(attendance);

  const attended = attendance.filter((a) =>
    STREAK.CONTINUES.includes(a.status),
  );
  const onTimeHomework = assignments.filter((a) => a.onTime).length;
  const topRatings = reports.filter((r) => r.rating === 5).length;
  const completedCourses = enrollments.filter(
    (e) => e.status === "COMPLETED",
  ).length;

  // Longest run of consecutive PRESENT (LATE breaks it) — "Always On Time"
  let punctualRun = 0,
    bestPunctual = 0;
  for (const a of attendance) {
    if (a.status === "EXCUSED") continue;
    if (a.status === "PRESENT") {
      punctualRun += 1;
      if (punctualRun > bestPunctual) bestPunctual = punctualRun;
    } else punctualRun = 0;
  }

  // A calendar month with at least PERFECT_MONTH_MIN_SESSIONS and no ABSENT.
  // The minimum is what stops a two-lesson month qualifying as "perfect".
  const byMonth = new Map();
  for (const a of attendance) {
    const k = monthKey(a.at);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(a.status);
  }
  let perfectMonths = 0;
  for (const [, statuses] of byMonth) {
    const counted = statuses.filter((s) => s !== "EXCUSED");
    if (
      counted.length >= PERFECT_MONTH_MIN_SESSIONS &&
      !counted.includes("ABSENT")
    )
      perfectMonths += 1;
  }

  const defs = [
    { key: "first_steps", value: attended.length, target: 1 },
    { key: "finding_rhythm", value: streak.best, target: 10 },
    { key: "devoted", value: attended.length, target: 50 },
    { key: "centurion", value: attended.length, target: 100 },
    { key: "always_on_time", value: bestPunctual, target: 20 },
    { key: "homework_hero", value: onTimeHomework, target: 3 },
    { key: "perfect_month", value: perfectMonths, target: 1 },
    { key: "praised", value: topRatings, target: 3 },
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
// PROGRESS — teacher-set (client decision)
// ═══════════════════════════════════════════════════════════

export function computeProgress(
  activity,
  { basis = PROGRESS_BASIS.TEACHER, now = Date.now() } = {},
) {
  const { enrollments, attendance, reports } = activity;
  const active = enrollments.filter((e) => e.status === "ACTIVE");

  if (active.length === 0) {
    return { percent: 0, basis, label: "No active course", meaningful: false };
  }

  if (basis === PROGRESS_BASIS.TEACHER) {
    // Most recent report carrying a percentage wins.
    const withPercent = reports.filter((r) => r.percent != null);
    if (withPercent.length === 0) {
      return {
        percent: 0,
        basis,
        label: "Awaiting teacher assessment",
        meaningful: false,
        // The journey map still works — it is XP-driven and always has a value.
        // The UI should lead with the journey and treat this as secondary.
        awaitingTeacher: true,
      };
    }
    const latest = withPercent[withPercent.length - 1];
    return {
      percent: Math.max(0, Math.min(latest.percent, 100)),
      basis,
      label: "Course progress",
      meaningful: true,
      assessedAt: iso(latest.at),
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

  // ATTENDANCE fallback. Reads LOW in practice because sessionsPerWeek exceeds
  // sessions actually scheduled — never present this as "course progress".
  const earliest = Math.min(...active.map((e) => e.startDate));
  const weeks = Math.max((now - earliest) / WEEK, 0);
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
    meaningful: expected >= 4,
    attended,
    expected,
  };
}

// ═══════════════════════════════════════════════════════════
// JOURNEY MAP  ·  "Quran Odyssey" — the brand is a journey
// ═══════════════════════════════════════════════════════════
//
// The visual spine of the new dashboard: a path winding through the eight
// stages. Each attended session moves the marker; each stage is a landmark.
//
// Why this and not just a progress ring:
//   • The teacher-set percentage updates MONTHLY — static and dull between
//     reports. The journey moves EVERY session.
//   • It gives fast feedback (steps) and slow prestige (landmarks) at once.
//   • It is XP-driven, so it always has a value, even before any teacher
//     assessment exists.

export function computeJourney(activity, { now = Date.now() } = {}) {
  const timeline = buildXpTimeline(activity);
  const totalXp = timeline.reduce((s, e) => s + e.amount, 0);
  const level = computeLevel(totalXp);

  // When was each stage first reached? Walk the timeline accumulating XP.
  const reachedAt = {};
  let running = 0;
  for (const e of timeline) {
    const before = running;
    running += e.amount;
    for (const l of LEVELS) {
      if (before < l.minXp && running >= l.minXp) reachedAt[l.level] = e.at;
    }
  }
  reachedAt[1] = reachedAt[1] ?? timeline[0]?.at ?? null;

  const stages = LEVELS.map((l) => ({
    level: l.level,
    name: l.name,
    arabic: l.arabic,
    minXp: l.minXp,
    state:
      l.level < level.level
        ? "complete"
        : l.level === level.level
          ? "current"
          : "locked",
    reachedAt: iso(reachedAt[l.level] ?? null),
  }));

  const currentStage = stages.find((s) => s.state === "current");
  const nextStage = stages.find((s) => s.level === level.level + 1) || null;

  // Steps taken = attended sessions. Each is a node on the path.
  const attended = activity.attendance.filter((a) =>
    STREAK.CONTINUES.includes(a.status),
  );
  const totalSteps = attended.length;

  // Steps taken since entering the current stage — used to draw the segment
  // between the last landmark and the marker.
  const stageStartAt = reachedAt[level.level] ?? null;
  const stepsInStage = stageStartAt
    ? attended.filter((a) => a.at >= stageStartAt).length
    : totalSteps;

  // "About 4 more classes to reach Mutawassit" — concrete and motivating.
  // Uses this student's own recent earning rate, not a global average.
  const recent = timeline.filter((e) => e.at >= now - 28 * DAY);
  const recentSessions = recent.filter((e) => e.kind === "session").length;
  const xpPerSession =
    recentSessions > 0
      ? recent.reduce((s, e) => s + e.amount, 0) / recentSessions
      : XP.SESSION_PRESENT;
  const sessionsToNext = nextStage
    ? Math.max(Math.ceil(level.xpToNext / Math.max(xpPerSession, 1)), 1)
    : 0;

  // The last few steps, newest last — for animating the marker's arrival.
  const recentSteps = attended.slice(-8).map((a) => ({
    at: iso(a.at),
    status: a.status,
  }));

  // The nearest thing worth celebrating: next stage, or the closest badge.
  const badges = computeBadges(activity);
  const nearestBadge =
    badges.filter((b) => !b.earned).sort((a, b) => b.percent - a.percent)[0] ||
    null;

  let nextMilestone = null;
  if (nextStage && sessionsToNext <= 4) {
    nextMilestone = {
      type: "stage",
      label: nextStage.name,
      arabic: nextStage.arabic,
      remaining: sessionsToNext,
      unit: "classes",
    };
  } else if (nearestBadge) {
    nextMilestone = {
      type: "badge",
      label: nearestBadge.name,
      icon: nearestBadge.icon,
      remaining: nearestBadge.remaining,
      unit: nearestBadge.key === "homework_hero" ? "assignments" : "classes",
    };
  } else if (nextStage) {
    nextMilestone = {
      type: "stage",
      label: nextStage.name,
      arabic: nextStage.arabic,
      remaining: sessionsToNext,
      unit: "classes",
    };
  }

  return {
    stages,
    currentStage,
    nextStage,
    // 0–100 within the current stage — drives the path segment fill.
    percentThroughStage: level.percentToNext,
    // 0–100 along the entire journey — drives the zoomed-out overview.
    percentOfJourney: Math.min(
      Math.round((totalXp / LEVELS[LEVELS.length - 1].minXp) * 100),
      100,
    ),
    totalSteps,
    stepsInStage,
    recentSteps,
    sessionsToNext,
    nextMilestone,
    startedAt: iso(timeline[0]?.at ?? null),
    namesConfirmed: LEVEL_NAMES_CONFIRMED,
  };
}

// ═══════════════════════════════════════════════════════════
// TOP-LEVEL
// ═══════════════════════════════════════════════════════════

export function computeGamification(raw, options = {}) {
  const { now = Date.now() } = options;
  const activity = normalizeActivity(raw);

  const streak = computeStreak(activity.attendance);
  const xp = computeXp(activity, options);
  const level = computeLevel(xp.total);
  const badges = computeBadges(activity);
  const progress = computeProgress(activity, options);
  const journey = computeJourney(activity, options);

  const attended = activity.attendance.filter((a) =>
    STREAK.CONTINUES.includes(a.status),
  ).length;
  const earned = badges.filter((b) => b.earned);

  // ── New vs dormant ──
  // A child who signed up three days ago and one who enrolled two months ago
  // and never started are NOT the same situation. One gets a welcome; the
  // other needs a nudge — and is a churn signal for the admin panel.
  const earliestEnrolment = activity.enrollments.length
    ? Math.min(...activity.enrollments.map((e) => e.startDate))
    : null;
  const weeksEnrolled = earliestEnrolment
    ? (now - earliestEnrolment) / WEEK
    : 0;
  const neverAttended = attended === 0 && xp.total === 0;

  return {
    isNew: neverAttended && weeksEnrolled < DORMANT_AFTER_WEEKS,
    isDormant: neverAttended && weeksEnrolled >= DORMANT_AFTER_WEEKS,
    weeksEnrolled: Math.floor(weeksEnrolled),
    streak,
    xp,
    level,
    progress,
    journey,
    badges,
    earnedBadges: earned,
    badgeCount: earned.length,
    badgeTotal: badges.length,
    nextBadge:
      badges
        .filter((b) => !b.earned)
        .sort((a, b) => b.percent - a.percent)[0] || null,
    totals: {
      sessionsAttended: attended,
      homeworkSubmitted: activity.assignments.filter((a) => a.submitted).length,
      homeworkOnTime: activity.assignments.filter((a) => a.onTime).length,
      reportsReceived: activity.reports.length,
    },
  };
}
