// src/routes/admin/dashboard.js  (NEW)
//
// The admin dashboard aggregation endpoint. One call returns everything
// the landing screen needs: attention KPIs, trend charts, regional
// breakdown, and the recent-activity feed (from the audit log).
//
// Mount in src/routes/admin/index.js:
//   import dashboardRouter from './dashboard.js';
//   router.use('/dashboard', dashboardRouter);
//
// (requireAdmin is already applied by the parent admin router.)

import express from "express";
import { prisma } from "../../lib/prisma.js";

const router = express.Router();

// ── Date helpers ──────────────────────────────────────────
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}
function monthKey(date) {
  return date.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}

// Country → region bucket (UK / USA / Canada / Other)
// function regionOf(country) {
//   if (!country) return "Other";
//   const c = country.toLowerCase();
//   if (
//     c.includes("united kingdom") ||
//     c === "uk" ||
//     c.includes("britain") ||
//     c.includes("england") ||
//     c.includes("scotland") ||
//     c.includes("wales")
//   )
//     return "UK";
//   if (
//     c.includes("united states") ||
//     c === "usa" ||
//     c === "us" ||
//     c.includes("america")
//   )
//     return "USA";
//   if (c.includes("canada")) return "Canada";
//   return "Other";
// }

// Common aliases → canonical country name. Extend freely as you spot
// new variants in your data. Keys are compared in lowercase, trimmed,
// punctuation-stripped form.
const COUNTRY_ALIASES = {
  // United Kingdom
  "uk": "United Kingdom",
  "u k": "United Kingdom",
  "gb": "United Kingdom",
  "gbr": "United Kingdom",
  "britain": "United Kingdom",
  "great britain": "United Kingdom",
  "england": "United Kingdom",
  "scotland": "United Kingdom",
  "wales": "United Kingdom",
  "northern ireland": "United Kingdom",
  "united kingdom": "United Kingdom",
 
  // United States
  "us": "United States",
  "u s": "United States",
  "usa": "United States",
  "u s a": "United States",
  "america": "United States",
  "united states of america": "United States",
  "united states": "United States",
 
  // Canada
  "canada": "Canada",
  "ca": "Canada",
 
  // A few other common ones (extend as needed)
  "uae": "United Arab Emirates",
  "ksa": "Saudi Arabia",
  "saudi": "Saudi Arabia",
  "pak": "Pakistan",
  "pk": "Pakistan",
  "aus": "Australia",
  "nz": "New Zealand",
  "ire": "Ireland",
  "rsa": "South Africa",
  "za": "South Africa",
};
 
// Turn a raw, possibly-messy country string into a canonical name.
// Unknown countries keep their own (title-cased) name — they are NOT
// collapsed into "Other".
function normalizeCountry(raw) {
  if (!raw || typeof raw !== "string") return "Unknown";
 
  // clean: trim, collapse internal whitespace, drop punctuation, lowercase
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[.\-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
 
  if (!key) return "Unknown";
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
 
  // Not a known alias — keep it, but title-case it for display
  // ("pakistan" → "Pakistan", "south africa" → "South Africa").
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}
 
// Count → top-N + rolled-up tail. Returns an array of { region, count }
// where the last item may be "Other (N)" if there are more than `topN`
// distinct countries. Always global, never hardcoded.
function buildRegional(countries, topN = 6) {
  const counts = {};
  for (const c of countries) {
    const name = normalizeCountry(c);
    counts[name] = (counts[name] || 0) + 1;
  }
 
  // Sort by count desc, then name asc for stability
  const sorted = Object.entries(counts)
    .map(([region, count]) => ({ region, count }))
    .sort((a, b) => b.count - a.count || a.region.localeCompare(b.region));
 
  if (sorted.length <= topN) return sorted;
 
  const top = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  const tailCount = tail.reduce((sum, r) => sum + r.count, 0);
  top.push({ region: `Other (${tail.length})`, count: tailCount, isOther: true });
  return top;
}

// ─────────────────────────────────────────────────────────
// GET /api/admin/dashboard
// ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const today0 = startOfToday();
    const today1 = endOfToday();
    const since90 = daysAgo(90);

    const [
      // ── Attention KPIs ──
      pendingEnrollmentRequests,
      unassignedTrials,
      todaySessionsCount,
      draftReports,
      newLeads,

      // ── Totals (header stats) ──
      totalAccounts,
      totalStudents,
      totalTeachers,
      activeEnrollments,

      // ── Chart data ──
      enrollmentsForTrend, // active enrollments w/ createdAt (last 90d)
      requestsForConversion, // enrollment requests last 90d (status)
      studentsForRegion, // students w/ country
      recentAudit, // activity feed
    ] = await Promise.all([
      prisma.enrollmentRequest.count({ where: { status: "PENDING" } }),
      prisma.trialBooking.count({
        where: { teacherId: null, status: { in: ["PENDING", "CONFIRMED"] } },
      }),
      prisma.classSession.count({
        where: { scheduledAt: { gte: today0, lte: today1 } },
      }),
      prisma.progressReport.count({ where: { status: "DRAFT" } }),
      prisma.trialLead.count({ where: { status: "NEW" } }),

      prisma.user.count({ where: { role: { in: ["PARENT", "STUDENT"] } } }),
      prisma.student.count(),
      prisma.teacher.count({ where: { isActive: true } }),
      prisma.enrollment.count({ where: { status: "ACTIVE" } }),

      prisma.enrollment.findMany({
        where: { createdAt: { gte: since90 } },
        select: { createdAt: true },
      }),
      prisma.enrollmentRequest.findMany({
        where: { createdAt: { gte: since90 } },
        select: { status: true, createdAt: true },
      }),
      prisma.student.findMany({ select: { country: true } }),
      prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    ]);

    // ── Enrollments-over-time (group by month, last ~3 months) ──
    const trendMap = {};
    for (let i = 2; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i, 1);
      trendMap[monthKey(d)] = 0;
    }
    enrollmentsForTrend.forEach((e) => {
      const k = monthKey(new Date(e.createdAt));
      if (k in trendMap) trendMap[k]++;
    });
    const enrollmentTrend = Object.entries(trendMap).map(([month, count]) => ({
      month,
      count,
    }));

    // ── Trial → paid conversion ──
    // Of requests in the window, how many reached ACTIVE vs not.
    const totalReq = requestsForConversion.length;
    const converted = requestsForConversion.filter(
      (r) => r.status === "ACTIVE",
    ).length;
    const conversionRate =
      totalReq > 0 ? Math.round((converted / totalReq) * 100) : 0;

    // ── Regional breakdown ──
    // const regionMap = { UK: 0, USA: 0, Canada: 0, Other: 0 };
    // studentsForRegion.forEach((s) => {
    //   regionMap[regionOf(s.country)]++;
    // });
    // const regional = Object.entries(regionMap).map(([region, count]) => ({
    //   region,
    //   count,
    // }));

    const regional = buildRegional(studentsForRegion.map((s) => s.country), 6);

    // ── Activity feed ──
    const activity = recentAudit.map((a) => ({
      id: a.id,
      action: a.action,
      actorEmail: a.actorEmail,
      targetType: a.targetType,
      targetLabel: a.targetLabel,
      createdAt: a.createdAt,
    }));

    return res.json({
      kpis: {
        pendingEnrollmentRequests,
        unassignedTrials,
        todaySessions: todaySessionsCount,
        draftReports,
        newLeads,
      },
      totals: {
        accounts: totalAccounts,
        students: totalStudents,
        teachers: totalTeachers,
        activeEnrollments,
      },
      charts: {
        enrollmentTrend,
        conversion: { rate: conversionRate, converted, total: totalReq },
        regional,
      },
      activity,
    });
  } catch (err) {
    console.error("Admin dashboard failed:", err);
    return res.status(500).json({ error: "Failed to load dashboard" });
  }
});

export default router;
