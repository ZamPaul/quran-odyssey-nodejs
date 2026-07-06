// src/routes/admin/oversight.js  (NEW)
//
// The oversight / exceptions engine. Surfaces what needs attention:
//   • Teacher accountability — unmarked sessions, ungraded work, overdue reports
//   • At-risk students — consecutive absences or low attendance
//   • Drill-down lists — attendance / assignments / reports (cross-teacher)
//   • Inline action — remind a teacher of their outstanding duties
//
// Exceptions are computed LIVE, so they self-clear when the underlying
// problem is fixed (teacher marks the session → it drops off). No stale
// "dismissed" state to manage.
//
// Mount in src/routes/admin/index.js:
//   import oversightRouter from './oversight.js';
//   router.use('/oversight', oversightRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
import {
  computeStudentRisk,
  isReportOverdue,
  unmarkedCutoff,
  OVERDUE_REPORT_DAYS,
} from "../../lib/oversight.js";
import { sendTeacherDutiesReminder } from "../../services/email.js";

const router = express.Router();

const COURSE_LABELS = {
  NOORANI_QAIDA: "Noorani Qaida",
  QURAN_RECITATION: "Quran Recitation",
  TAJWEED: "Tajweed",
  HIFZ: "Hifz",
  ISLAMIC_STUDIES: "Islamic Studies",
  ONE_TO_ONE: "One-to-One",
};

// ═════════════════════════════════════════════════════════
// GET /api/admin/oversight
// The main exceptions payload.
// ═════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const now = new Date();
  const cutoff10h = unmarkedCutoff(now);
  const reportCutoff = new Date(now.getTime() - OVERDUE_REPORT_DAYS * 86400000);
  const attendanceWindowStart = new Date(now.getTime() - 120 * 86400000); // 120d bounds the at-risk scan

  try {
    const [
      teachers,
      unmarkedGroups,
      ungradedGroups,
      activeEnrollments,
      recentReports,
      attendanceRecords,
    ] = await Promise.all([
      prisma.teacher.findMany({
        where: { isActive: true },
        select: { id: true, name: true, email: true },
      }),

      // Unmarked: SCHEDULED and >10h past
      prisma.classSession.groupBy({
        by: ["teacherId"],
        where: { status: "SCHEDULED", scheduledAt: { lt: cutoff10h } },
        _count: { _all: true },
      }),

      // Ungraded: assignment submitted but not graded
      prisma.assignment.groupBy({
        by: ["teacherId"],
        where: { status: "SUBMITTED" },
        _count: { _all: true },
      }),

      // Active enrollments (for overdue reports + at-risk student set)
      prisma.enrollment.findMany({
        where: { status: "ACTIVE" },
        select: {
          id: true,
          studentId: true,
          teacherId: true,
          courseType: true,
          startDate: true,
          student: {
            select: {
              id: true,
              name: true,
              timezone: true,
              account: { select: { email: true, name: true, phone: true } },
            },
          },
          teacher: { select: { id: true, name: true } },
        },
      }),

      // SENT reports in the last 30d → keys of student:teacher that are covered
      prisma.progressReport.findMany({
        where: { status: "SENT", sentAt: { gte: reportCutoff }, enrollmentId: { not: null } },
        select: { enrollmentId: true },
      }),

      // Attendance in the scan window for active students, with the session time
      prisma.attendanceRecord.findMany({
        where: { session: { scheduledAt: { gte: attendanceWindowStart } } },
        select: {
          studentId: true,
          status: true,
          session: { select: { scheduledAt: true } },
        },
      }),
    ]);

    const teacherById = new Map(teachers.map((t) => [t.id, t]));
    const unmarkedByTeacher = new Map(
      unmarkedGroups.map((g) => [g.teacherId, g._count._all]),
    );

    console.log("unmarked group: ", unmarkedGroups);
    console.log("unmarked group map: ", unmarkedByTeacher);

    const ungradedByTeacher = new Map(
      ungradedGroups.map((g) => [g.teacherId, g._count._all]),
    );

    // ── Overdue reports per teacher ──
    // const recentReportKeys = new Set(
    //   recentReports.map((r) => `${r.studentId}:${r.teacherId}`),
    // );
    const recentReportEnrollmentIds = new Set(recentReports.map((r) => r.enrollmentId));

    const overdueByTeacher = new Map();
    const overdueEnrollments = [];
    // for (const e of activeEnrollments) {
    //   if (
    //     isReportOverdue(
    //       {
    //         status: "ACTIVE",
    //         studentId: e.studentId,
    //         teacherId: e.teacherId,
    //         startDate: e.startDate,
    //       },
    //       recentReportKeys,
    //       now,
    //     )
    //   ) {
    //     overdueByTeacher.set(
    //       e.teacherId,
    //       (overdueByTeacher.get(e.teacherId) || 0) + 1,
    //     );
    //     overdueEnrollments.push(e);
    //   }
    // }

    for (const e of activeEnrollments) {
      if (
        isReportOverdue(
          { status: "ACTIVE", id: e.id, startDate: e.startDate },
          recentReportEnrollmentIds,
          now,
        )
      ) {
        overdueByTeacher.set(e.teacherId, (overdueByTeacher.get(e.teacherId) || 0) + 1);
        overdueEnrollments.push(e);
      }
    }

    // ── Teacher accountability rows (only teachers WITH issues) ──
    const teacherAccountability = [];
    const teacherIdsWithIssues = new Set([
      ...unmarkedByTeacher.keys(),
      ...ungradedByTeacher.keys(),
      ...overdueByTeacher.keys(),
    ]);
    for (const tid of teacherIdsWithIssues) {
      const t = teacherById.get(tid);
      if (!t) continue; // inactive/removed teacher — skip
      const unmarked = unmarkedByTeacher.get(tid) || 0;
      const ungraded = ungradedByTeacher.get(tid) || 0;
      const overdue = overdueByTeacher.get(tid) || 0;
      teacherAccountability.push({
        teacherId: tid,
        name: t.name,
        email: t.email,
        unmarkedSessions: unmarked,
        ungradedSubmissions: ungraded,
        overdueReports: overdue,
        issueScore: unmarked * 2 + ungraded + overdue * 3, // weight: overdue reports worst
      });
    }
    teacherAccountability.sort((a, b) => b.issueScore - a.issueScore);

    // ── At-risk students ──
    // Group attendance by student
    const byStudent = new Map();
    for (const a of attendanceRecords) {
      if (!byStudent.has(a.studentId)) byStudent.set(a.studentId, []);
      byStudent
        .get(a.studentId)
        .push({
          status: a.status,
          scheduledAt: a.session?.scheduledAt || null,
        });
    }
    // Only consider students with an active enrollment (dedupe)
    const activeStudentMap = new Map();
    for (const e of activeEnrollments) {
      if (!activeStudentMap.has(e.studentId))
        activeStudentMap.set(e.studentId, e);
    }

    const atRiskStudents = [];
    for (const [studentId, enr] of activeStudentMap) {
      const recs = byStudent.get(studentId) || [];
      if (recs.length === 0) continue;
      const risk = computeStudentRisk(recs);
      if (risk.atRisk) {
        atRiskStudents.push({
          studentId,
          name: enr.student.name,
          teacherId: enr.teacherId,
          teacherName: enr.teacher.name,
          courseType: enr.courseType,
          parent: {
            name: enr.student.account.name,
            email: enr.student.account.email,
            phone: enr.student.account.phone,
          },
          reasons: risk.reasons,
          stats: risk.stats,
        });
      }
    }
    // Worst first: consecutive-absence cases above low-attendance, then by attended%
    atRiskStudents.sort((a, b) => {
      const aCons = a.reasons.some((r) => r.code === "CONSECUTIVE_ABSENCES");
      const bCons = b.reasons.some((r) => r.code === "CONSECUTIVE_ABSENCES");
      if (aCons !== bCons) return aCons ? -1 : 1;
      return (a.stats.attendedPct ?? 100) - (b.stats.attendedPct ?? 100);
    });

    const summary = {
      teachersWithIssues: teacherAccountability.length,
      totalUnmarkedSessions: [...unmarkedByTeacher.values()].reduce(
        (s, n) => s + n,
        0,
      ),
      totalUngraded: [...ungradedByTeacher.values()].reduce((s, n) => s + n, 0),
      totalOverdueReports: overdueEnrollments.length,
      atRiskStudents: atRiskStudents.length,
    };

    return res.json({ summary, teacherAccountability, atRiskStudents });
  } catch (err) {
    console.error("Oversight fetch failed:", err);
    return res.status(500).json({ error: "Failed to load oversight data" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /api/admin/oversight/attendance
// Drill-down. ?studentId= &teacherId= &status= &from= &to=
// ═════════════════════════════════════════════════════════
router.get("/attendance", async (req, res) => {
  const { studentId, teacherId, status, from, to } = req.query;
  const where = {};
  if (studentId) where.studentId = studentId;
  if (teacherId) where.teacherId = teacherId;
  if (status && ["PRESENT", "LATE", "ABSENT", "EXCUSED"].includes(status))
    where.status = status;
  if (from || to) {
    where.markedAt = {};
    if (from) where.markedAt.gte = new Date(from);
    if (to) where.markedAt.lte = new Date(to);
  }
  try {
    const records = await prisma.attendanceRecord.findMany({
      where,
      orderBy: { markedAt: "desc" },
      take: 200,
      include: {
        student: { select: { id: true, name: true } },
        teacher: { select: { id: true, name: true } },
        session: { select: { scheduledAt: true, courseType: true } },
      },
    });
    return res.json({ records });
  } catch (err) {
    console.error("Oversight attendance failed:", err);
    return res.status(500).json({ error: "Failed to load attendance" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /api/admin/oversight/assignments
// ?status= &teacherId= &studentId=
// ═════════════════════════════════════════════════════════
router.get("/assignments", async (req, res) => {
  const { status, teacherId, studentId } = req.query;
  const where = {};
  if (status && ["PENDING", "SUBMITTED", "GRADED", "OVERDUE"].includes(status))
    where.status = status;
  if (teacherId) where.teacherId = teacherId;
  if (studentId) where.studentId = studentId;
  try {
    const assignments = await prisma.assignment.findMany({
      where,
      orderBy: { dueDate: "desc" },
      take: 200,
      include: {
        student: { select: { id: true, name: true } },
        teacher: { select: { id: true, name: true } },
        submission: { select: { grade: true, gradedAt: true, fileUrl: true } },
      },
    });
    return res.json({ assignments });
  } catch (err) {
    console.error("Oversight assignments failed:", err);
    return res.status(500).json({ error: "Failed to load assignments" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /api/admin/oversight/reports
// ?status= &teacherId= &studentId= &overdue=true
// overdue=true returns active enrollments missing a recent report.
// ═════════════════════════════════════════════════════════
router.get("/reports", async (req, res) => {
  const { status, teacherId, studentId, overdue } = req.query;

  if (overdue === "true") {
    // Return overdue ENROLLMENTS (no recent SENT report), not reports.
    const now = new Date();
    const reportCutoff = new Date(
      now.getTime() - OVERDUE_REPORT_DAYS * 86400000,
    );
    try {
      const [activeEnrollments, recentReports] = await Promise.all([
        prisma.enrollment.findMany({
          where: { status: "ACTIVE", ...(teacherId ? { teacherId } : {}) },
          select: {
            id: true,
            studentId: true,
            teacherId: true,
            courseType: true,
            startDate: true,
            student: { select: { name: true } },
            teacher: { select: { name: true } },
          },
        }),
        // prisma.progressReport.findMany({
        //   where: { status: "SENT", sentAt: { gte: reportCutoff } },
        //   select: { studentId: true, teacherId: true },
        // }),
        prisma.progressReport.findMany({
          where: { status: "SENT", sentAt: { gte: reportCutoff }, enrollmentId: { not: null } },
          select: { enrollmentId: true },
        }),
      ]);

      const keys = new Set(recentReports.map((r) => r.enrollmentId));
      const overdueList = activeEnrollments
        .filter((e) =>
          isReportOverdue(
            { status: "ACTIVE", id: e.id, startDate: e.startDate },
            keys,
            now,
          ),
        )
        .map((e) => ({
          enrollmentId: e.id,
          studentId: e.studentId,
          studentName: e.student.name,
          teacherId: e.teacherId,
          teacherName: e.teacher.name,
          courseType: e.courseType,
          startDate: e.startDate,
        }));

      // const keys = new Set(
      //   recentReports.map((r) => `${r.studentId}:${r.teacherId}`),
      // );
      // const overdueList = activeEnrollments
      //   .filter((e) =>
      //     isReportOverdue(
      //       {
      //         status: "ACTIVE",
      //         studentId: e.studentId,
      //         teacherId: e.teacherId,
      //         startDate: e.startDate,
      //       },
      //       keys,
      //       now,
      //     ),
      //   )
      //   .map((e) => ({
      //     enrollmentId: e.id,
      //     studentId: e.studentId,
      //     studentName: e.student.name,
      //     teacherId: e.teacherId,
      //     teacherName: e.teacher.name,
      //     courseType: e.courseType,
      //     startDate: e.startDate,
      //   }));
      
      return res.json({ overdueEnrollments: overdueList });
    } catch (err) {
      console.error("Oversight overdue reports failed:", err);
      return res.status(500).json({ error: "Failed to load overdue reports" });
    }
  }

  const where = {};
  if (status && ["DRAFT", "SENT"].includes(status)) where.status = status;
  if (teacherId) where.teacherId = teacherId;
  if (studentId) where.studentId = studentId;
  try {
    const reports = await prisma.progressReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        student: { select: { id: true, name: true } },
        teacher: { select: { id: true, name: true } },
      },
    });
    return res.json({ reports });
  } catch (err) {
    console.error("Oversight reports failed:", err);
    return res.status(500).json({ error: "Failed to load reports" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/oversight/remind-teacher
// Body: { teacherId }
// Emails the teacher a summary of their outstanding duties. Recomputes
// the counts server-side (never trusts client numbers). Audit-logged.
// ═════════════════════════════════════════════════════════
router.post("/remind-teacher", async (req, res) => {
  const { teacherId } = req.body;
  if (!teacherId)
    return res.status(400).json({ error: "teacherId is required" });

  try {
    const teacher = await prisma.teacher.findUnique({
      where: { id: teacherId },
      select: { id: true, name: true, email: true },
    });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });

    const now = new Date();
    const cutoff10h = unmarkedCutoff(now);
    const reportCutoff = new Date(
      now.getTime() - OVERDUE_REPORT_DAYS * 86400000,
    );

    const [unmarked, ungraded, activeEnrollments, recentReports] =
      await Promise.all([
        prisma.classSession.count({
          where: {
            teacherId,
            status: "SCHEDULED",
            scheduledAt: { lt: cutoff10h },
          },
        }),
        prisma.assignment.count({ where: { teacherId, status: "SUBMITTED" } }),
        prisma.enrollment.findMany({
          where: { status: "ACTIVE", teacherId },
          select: { id: true, studentId: true, teacherId: true, startDate: true },
        }),
        // prisma.progressReport.findMany({
        //   where: { status: "SENT", teacherId, sentAt: { gte: reportCutoff } },
        //   select: { studentId: true, teacherId: true },
        // }),
        prisma.progressReport.findMany({ where: { status: "SENT", teacherId, sentAt: { gte: reportCutoff }, enrollmentId: { not: null } }, select: { enrollmentId: true } }),
      ]);

    // const keys = new Set(
    //   recentReports.map((r) => `${r.studentId}:${r.teacherId}`),
    // );
    // const overdueReports = activeEnrollments.filter((e) =>
    //   isReportOverdue({ status: "ACTIVE", ...e }, keys, now),
    // ).length;

    const keys = new Set(recentReports.map((r) => r.enrollmentId));
    const overdueReports = activeEnrollments.filter((e) => isReportOverdue({ status: "ACTIVE", id: e.id, startDate: e.startDate }, keys, now)).length;

    if (unmarked === 0 && ungraded === 0 && overdueReports === 0) {
      return res
        .status(409)
        .json({ error: "This teacher has no outstanding items right now." });
    }

    let emailError = null;
    try {
      await sendTeacherDutiesReminder({
        to: teacher.email,
        teacherName: teacher.name,
        unmarkedSessions: unmarked,
        ungradedSubmissions: ungraded,
        overdueReports,
        teacherId: teacherId
      });
    } catch (e) {
      emailError = e.message;
      console.error("Reminder email failed:", e.message);
    }

    await logAudit(req, {
      action: "oversight.remindTeacher",
      targetType: "Teacher",
      targetId: teacherId,
      targetLabel: teacher.name,
      metadata: { unmarked, ungraded, overdueReports, emailSent: !emailError },
    });

    return res.json({
      reminded: true,
      emailSent: !emailError,
      emailError,
      counts: { unmarked, ungraded, overdueReports },
    });
  } catch (err) {
    console.error("Remind teacher failed:", err);
    return res.status(500).json({ error: "Failed to remind teacher" });
  }
});

router.get("/unmarked-sessions", async (req, res) => {
  const { teacherId, studentId } = req.query;
  const now = new Date();
  const cutoff10h = unmarkedCutoff(now);
 
  // SAME filter the accountability count uses: SCHEDULED and >10h past.
  const where = {
    status: "SCHEDULED",
    scheduledAt: { lt: cutoff10h },
  };
  if (teacherId) where.teacherId = teacherId;
  if (studentId) where.studentId = studentId;
 
  try {
    const sessions = await prisma.classSession.findMany({
      where,
      orderBy: { scheduledAt: "desc" },
      take: 300,
      include: {
        student: { select: { id: true, name: true } },
        teacher: { select: { id: true, name: true } },
      },
    });
    return res.json({ sessions });
  } catch (err) {
    console.error("Oversight unmarked-sessions failed:", err);
    return res.status(500).json({ error: "Failed to load unmarked sessions" });
  }
});

export default router;
