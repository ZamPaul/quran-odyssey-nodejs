// src/routes/admin/analytics.js  (NEW)
//
// Analytics & Reporting. Three endpoints:
//   GET /            — trends + funnel + regional (fast; ?range=30d|90d|12m|all)
//   GET /retention   — cohort matrix (heavier; loads separately)
//   GET /export/:dataset — CSV download (enrollments|students|leads|funnel)
//
// "Trial-to-enrolled" funnel (no payment data yet — enrolled is terminal
// until Stripe/Phase 12). Labelled honestly in the UI.
//
// Mount: router.use('/analytics', analyticsRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import {
  makeBuckets,
  bucketKeyOf,
  computeCohortMatrix,
  funnelRates,
  monthKey,
} from "../../lib/analytics.js";

const router = express.Router();

const COURSE_LABELS = {
  NOORANI_QAIDA: "Noorani Qaida",
  QURAN_RECITATION: "Quran Recitation",
  TAJWEED: "Tajweed",
  HIFZ: "Hifz",
  ISLAMIC_STUDIES: "Islamic Studies",
  ONE_TO_ONE: "One-to-One",
};

function rangeToStart(range) {
  const now = new Date();
  const d = new Date();
  if (range === "30d") {
    d.setDate(d.getDate() - 30);
    return { start: d, granularity: "day" };
  }
  if (range === "12m") {
    d.setMonth(d.getMonth() - 12);
    return { start: d, granularity: "month" };
  }
  if (range === "all") {
    return { start: null, granularity: "month" };
  }
  d.setDate(d.getDate() - 90);
  return { start: d, granularity: "day" }; // default 90d
}

// ── Country normalization (reuse the dashboard's approach, condensed) ──
const ALIASES = {
  uk: "United Kingdom",
  "united kingdom": "United Kingdom",
  gb: "United Kingdom",
  britain: "United Kingdom",
  england: "United Kingdom",
  scotland: "United Kingdom",
  wales: "United Kingdom",
  us: "United States",
  usa: "United States",
  america: "United States",
  "united states": "United States",
  canada: "Canada",
  ca: "Canada",
  uae: "United Arab Emirates",
  ksa: "Saudi Arabia",
  pak: "Pakistan",
  pk: "Pakistan",
};

function normCountry(raw) {
  if (!raw || typeof raw !== "string") return "Unknown";
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[.\-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!key) return "Unknown";
  return ALIASES[key] || key.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ═════════════════════════════════════════════════════════
// GET /  — trends + funnel + regional
// ═════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const { range = "90d" } = req.query;
  const { start, granularity } = rangeToStart(range);
  const now = new Date();
  const dateFilter = start ? { gte: start } : undefined;

  try {
    const [enrolments, trials, leads, requests, activeEnrollments, students] =
      await Promise.all([
        prisma.enrollment.findMany({
          where: dateFilter ? { createdAt: dateFilter } : {},
          select: { createdAt: true },
        }),
        prisma.trialBooking.findMany({
          where: dateFilter ? { createdAt: dateFilter } : {},
          select: { createdAt: true },
        }),
        prisma.trialLead.findMany({
          where: dateFilter ? { createdAt: dateFilter } : {},
          select: { createdAt: true },
        }),
        prisma.enrollmentRequest.findMany({
          where: dateFilter ? { createdAt: dateFilter } : {},
          select: { createdAt: true, status: true },
        }),
        prisma.enrollment.count({ where: { status: "ACTIVE" } }),
        prisma.student.findMany({ select: { country: true, id: true } }),
      ]);

    // ── Trends (multi-series over buckets) ──
    const effStart =
      start ||
      new Date(
        Math.min(
          ...[...enrolments, ...trials, ...leads]
            .map((x) => new Date(x.createdAt).getTime())
            .filter(Boolean),
          now.getTime(),
        ),
      );
    const buckets = makeBuckets(effStart, now, granularity);
    const scaffold = new Map(
      buckets.map((b) => [
        b.bucket,
        {
          bucket: b.bucket,
          label: b.label,
          enrolments: 0,
          trials: 0,
          leads: 0,
        },
      ]),
    );
    const tally = (items, key) =>
      items.forEach((it) => {
        const bk = bucketKeyOf(it.createdAt, granularity);
        if (scaffold.has(bk)) scaffold.get(bk)[key]++;
      });
    tally(enrolments, "enrolments");
    tally(trials, "trials");
    tally(leads, "leads");
    const trends = [...scaffold.values()];

    // ── Funnel (trial-to-enrolled; stage counts over the window) ──
    const enrolledCount =
      requests.filter((r) => r.status === "ACTIVE").length || activeEnrollments;
    const funnel = funnelRates([
      { key: "leads", label: "Leads", count: leads.length },
      { key: "trials", label: "Trials booked", count: trials.length },
      { key: "requests", label: "Enrolment requests", count: requests.length },
      { key: "enrolled", label: "Enrolled", count: enrolledCount },
    ]);

    // ── Regional deep-dive ──
    const studentIds = students.map((s) => s.id);
    const activeByStudent = studentIds.length
      ? await prisma.enrollment.findMany({
          where: { studentId: { in: studentIds }, status: "ACTIVE" },
          select: { studentId: true },
        })
      : [];
    const activeSet = new Set(activeByStudent.map((e) => e.studentId));
    const regionMap = new Map();
    for (const s of students) {
      const c = normCountry(s.country);
      if (!regionMap.has(c))
        regionMap.set(c, { country: c, students: 0, activeEnrolled: 0 });
      const row = regionMap.get(c);
      row.students++;
      if (activeSet.has(s.id)) row.activeEnrolled++;
    }
    const regional = [...regionMap.values()].sort(
      (a, b) => b.students - a.students || a.country.localeCompare(b.country),
    );

    return res.json({ range, granularity, trends, funnel, regional });
  } catch (err) {
    console.error("Analytics failed:", err);
    return res.status(500).json({ error: "Failed to load analytics" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /retention — cohort matrix (separate; heavier)
// Cohort = month of a student's first enrolment.
// "Active in month M" = has a COMPLETED session that month.
// ═════════════════════════════════════════════════════════
router.get("/retention", async (_req, res) => {
  try {
    const [firstEnrolments, completedSessions] = await Promise.all([
      // earliest enrolment per student
      prisma.enrollment.findMany({
        select: { studentId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.classSession.findMany({
        where: { status: "COMPLETED" },
        select: { studentId: true, scheduledAt: true },
      }),
    ]);

    const cohortByStudent = new Map();
    for (const e of firstEnrolments) {
      if (!cohortByStudent.has(e.studentId))
        cohortByStudent.set(e.studentId, monthKey(e.createdAt));
    }
    const activeByStudent = new Map();
    for (const s of completedSessions) {
      if (!activeByStudent.has(s.studentId))
        activeByStudent.set(s.studentId, new Set());
      activeByStudent.get(s.studentId).add(monthKey(s.scheduledAt));
    }

    const students = [...cohortByStudent.entries()].map(
      ([studentId, cohortMonth]) => ({
        studentId,
        cohortMonth,
        activeMonths: activeByStudent.get(studentId) || new Set(),
      }),
    );

    const nowMonth = monthKey(new Date());
    const matrix = computeCohortMatrix(students, nowMonth);
    const maxOffset = matrix.reduce(
      (m, c) => Math.max(m, c.retention.length - 1),
      0,
    );

    // Honesty flag: retention needs history to mean anything.
    const monthsOfData = matrix.length;
    const meaningful = monthsOfData >= 3;

    return res.json({ matrix, maxOffset, monthsOfData, meaningful });
  } catch (err) {
    console.error("Retention failed:", err);
    return res.status(500).json({ error: "Failed to load retention" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /export/:dataset — CSV download
// dataset: enrollments | students | leads | funnel
// ═════════════════════════════════════════════════════════
function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  const head = headers.join(",");
  const body = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  return `${head}\n${body}`;
}
function sendCsv(res, filename, csv) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(csv);
}

router.get("/export/:dataset", async (req, res) => {
  const { dataset } = req.params;
  try {
    if (dataset === "enrollments") {
      const rows = await prisma.enrollment.findMany({
        include: {
          student: { select: { name: true } },
          teacher: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      const csv = toCsv(
        [
          "id",
          "student",
          "course",
          "teacher",
          "status",
          "sessionsPerWeek",
          "startDate",
          "createdAt",
        ],
        rows.map((r) => [
          r.id,
          r.student?.name,
          COURSE_LABELS[r.courseType] || r.courseType,
          r.teacher?.name,
          r.status,
          r.sessionsPerWeek,
          r.startDate?.toISOString?.() || r.startDate,
          r.createdAt.toISOString(),
        ]),
      );
      return sendCsv(res, "enrollments.csv", csv);
    }
    if (dataset === "students") {
      const rows = await prisma.student.findMany({
        include: {
          account: { select: { email: true, name: true, phone: true } },
        },
        orderBy: { name: "asc" },
      });
      const csv = toCsv(
        [
          "id",
          "name",
          "age",
          "country",
          "timezone",
          "courseInterest",
          "accountEmail",
          "accountName",
          "accountPhone",
        ],
        rows.map((r) => [
          r.id,
          r.name,
          r.age,
          r.country,
          r.timezone,
          COURSE_LABELS[r.courseInterest] || r.courseInterest,
          r.account?.email,
          r.account?.name,
          r.account?.phone,
        ]),
      );
      return sendCsv(res, "students.csv", csv);
    }
    if (dataset === "leads") {
      const rows = await prisma.trialLead.findMany({
        orderBy: { createdAt: "desc" },
      });
      const csv = toCsv(
        [
          "id",
          "firstName",
          "lastName",
          "email",
          "phone",
          "status",
          "source",
          "converted",
          "createdAt",
        ],
        rows.map((r) => [
          r.id,
          r.firstName,
          r.lastName,
          r.email,
          r.phone,
          r.status,
          r.source,
          r.convertedUserId ? "yes" : "no",
          r.createdAt.toISOString(),
        ]),
      );
      return sendCsv(res, "leads.csv", csv);
    }
    if (dataset === "funnel") {
      const [leads, trials, requests, active] = await Promise.all([
        prisma.trialLead.count(),
        prisma.trialBooking.count(),
        prisma.enrollmentRequest.count(),
        prisma.enrollment.count({ where: { status: "ACTIVE" } }),
      ]);
      const stages = funnelRates([
        { key: "leads", label: "Leads", count: leads },
        { key: "trials", label: "Trials booked", count: trials },
        { key: "requests", label: "Enrolment requests", count: requests },
        { key: "enrolled", label: "Enrolled", count: active },
      ]);
      const csv = toCsv(
        ["stage", "count", "pctOfPrevious", "pctOfFirst"],
        stages.map((s) => [
          s.label,
          s.count,
          s.pctOfPrev + "%",
          s.pctOfFirst + "%",
        ]),
      );
      return sendCsv(res, "funnel.csv", csv);
    }
    return res
      .status(400)
      .json({
        error: "Unknown dataset. Use: enrollments | students | leads | funnel",
      });
  } catch (err) {
    console.error("Export failed:", err);
    return res.status(500).json({ error: "Export failed" });
  }
});


export default router;
