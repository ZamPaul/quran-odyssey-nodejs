// src/routes/admin/assignments.js  (NEW)
//
// Assignments — admin oversight. READ + MODERATE, never author or grade.
// Setting and marking homework is a curriculum judgement that belongs to the
// teacher. Admins get complete visibility, a platform-wide overdue sweep,
// audited access to student submissions, and delete.
//
// Mount in src/routes/admin/index.js:
//   import assignmentsRouter from './assignments.js';
//   router.use('/assignments', assignmentsRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
// NOTE: match this import path to the one used in src/routes/teacher.js
import { deleteStoredFile } from "../../lib/storageAdmin.js";

const router = express.Router();

// How long a submission may sit ungraded before it counts as neglected.
export const UNGRADED_GRACE_DAYS = 3;
const COURSES = ["NOORANI_QAIDA","QURAN_RECITATION","TAJWEED","HIFZ","ISLAMIC_STUDIES","ONE_TO_ONE"];
const STATUSES = ["PENDING", "SUBMITTED", "GRADED", "OVERDUE"];

// TRUE overdue, computed from dueDate — never trusted from `status`.
// `POST /api/teacher/assignments/bulk-overdue` is per-teacher and manual, so
// the stored OVERDUE status is unreliable platform-wide.
function overdueWhere(now) {
  return { dueDate: { lt: now }, submission: { is: null }, status: { not: "GRADED" } };
}
function ungradedWhere(cutoff) {
  return { submission: { is: { gradedAt: null, submittedAt: { lt: cutoff } } } };
}

// ─────────────────────────────────────────────────────────
// GET /  — list + filters + attention counts
// ?q= &teacherId= &studentId= &course= &status= &dueFrom= &dueTo=
// &flag=overdue|ungraded|awaiting-grading &page= &pageSize=
// ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { q, teacherId, studentId, course, status, dueFrom, dueTo, flag, page = "1", pageSize = "25" } = req.query;
  const take = Math.min(parseInt(pageSize, 10) || 25, 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const now = new Date();
  const gradeCutoff = new Date(now.getTime() - UNGRADED_GRACE_DAYS * 86400000);

  const where = {};
  if (teacherId) where.teacherId = teacherId;
  if (studentId) where.studentId = studentId;
  if (course && COURSES.includes(course)) where.courseType = course;
  if (status && STATUSES.includes(status)) where.status = status;
  if (dueFrom || dueTo) {
    where.dueDate = {};
    if (dueFrom) where.dueDate.gte = new Date(dueFrom);
    if (dueTo) where.dueDate.lte = new Date(dueTo);
  }
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { title: { contains: term, mode: "insensitive" } },
      { student: { name: { contains: term, mode: "insensitive" } } },
      { teacher: { name: { contains: term, mode: "insensitive" } } },
    ];
  }

  if (flag === "overdue") Object.assign(where, overdueWhere(now));
  else if (flag === "ungraded") Object.assign(where, ungradedWhere(gradeCutoff));
  else if (flag === "awaiting-grading") where.submission = { is: { gradedAt: null } };

  try {
    const [rows, total, cOverdue, cUngraded, cAwaiting] = await Promise.all([
      prisma.assignment.findMany({
        where, orderBy: { dueDate: "desc" }, skip, take,
        select: {
          id: true, title: true, courseType: true, status: true, dueDate: true, createdAt: true,
          attachmentUrl: true, attachmentName: true,
          student: { select: { id: true, name: true } },
          teacher: { select: { id: true, name: true } },
          submission: { select: { id: true, submittedAt: true, gradedAt: true, grade: true, fileUrl: true, fileName: true, fileType: true } },
        },
      }),
      prisma.assignment.count({ where }),
      prisma.assignment.count({ where: overdueWhere(now) }),
      prisma.assignment.count({ where: ungradedWhere(gradeCutoff) }),
      prisma.assignment.count({ where: { submission: { is: { gradedAt: null } } } }),
    ]);

    // Decorate with the TRUE state so the UI never shows a stale status.
    const decorated = rows.map((a) => {
      const isOverdue = !a.submission && new Date(a.dueDate) < now && a.status !== "GRADED";
      const awaitingGrading = !!a.submission && !a.submission.gradedAt;
      const ungradedDays = awaitingGrading
        ? Math.floor((now - new Date(a.submission.submittedAt)) / 86400000)
        : null;
      return {
        ...a,
        isOverdue,
        awaitingGrading,
        ungradedDays,
        staleStatus: isOverdue && a.status !== "OVERDUE", // stored status is behind reality
      };
    });

    return res.json({
      rows: decorated,
      total,
      page: parseInt(page, 10) || 1,
      pageSize: take,
      ungradedGraceDays: UNGRADED_GRACE_DAYS,
      counts: { overdue: cOverdue, ungraded: cUngraded, awaitingGrading: cAwaiting },
    });
  } catch (err) {
    console.error("Admin assignments list failed:", err);
    return res.status(500).json({ error: "Failed to load assignments" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /facets
// ─────────────────────────────────────────────────────────
router.get("/facets", async (_req, res) => {
  try {
    const [teachers, students] = await Promise.all([
      prisma.teacher.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.student.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    ]);
    return res.json({ teachers, students, courses: COURSES });
  } catch {
    return res.status(500).json({ error: "Failed to load filters" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /sweep-overdue — platform-wide.
// The teacher-side sweep is per-teacher and manual, so past-due work can sit
// as PENDING indefinitely. This corrects every teacher in one pass.
// ─────────────────────────────────────────────────────────
router.post("/sweep-overdue", async (req, res) => {
  try {
    const now = new Date();
    const result = await prisma.assignment.updateMany({
      where: { status: "PENDING", dueDate: { lt: now }, submission: { is: null } },
      data: { status: "OVERDUE" },
    });
    await logAudit(req, {
      action: "assignment.sweepOverdue", targetType: "Assignment",
      targetLabel: `${result.count} assignment(s)`, metadata: { count: result.count },
    });
    return res.json({ updated: result.count });
  } catch (err) {
    console.error("Overdue sweep failed:", err);
    return res.status(500).json({ error: "Overdue sweep failed" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /:id — full detail incl. submission
// ─────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const assignment = await prisma.assignment.findUnique({
      where: { id: req.params.id },
      include: {
        student: { select: { id: true, name: true, account: { select: { id: true, name: true, email: true } } } },
        teacher: { select: { id: true, name: true, email: true } },
        submission: true,
      },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const now = new Date();
    const isOverdue = !assignment.submission && new Date(assignment.dueDate) < now && assignment.status !== "GRADED";
    return res.json({ assignment, isOverdue });
  } catch (err) {
    console.error("Admin assignment detail failed:", err);
    return res.status(500).json({ error: "Failed to load assignment" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /:id/submission-access — AUDITED access to a child's submission.
//
// Students upload audio/video of themselves reciting. Every admin view or
// download of that media is recorded, so there is always a record of who
// opened a child's recording and when. The file URL is only returned
// through this endpoint — never rendered directly into the list.
// Body: { intent: 'view' | 'download' }
// ─────────────────────────────────────────────────────────
router.post("/:id/submission-access", async (req, res) => {
  const intent = req.body?.intent === "download" ? "download" : "view";
  try {
    const assignment = await prisma.assignment.findUnique({
      where: { id: req.params.id },
      include: {
        student: { select: { id: true, name: true } },
        teacher: { select: { name: true } },
        submission: { select: { fileUrl: true, fileName: true, fileType: true, submittedAt: true } },
      },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    if (!assignment.submission?.fileUrl) return res.status(404).json({ error: "No submitted file" });

    await logAudit(req, {
      action: "assignment.submissionAccess",
      targetType: "Assignment",
      targetId: assignment.id,
      targetLabel: `${assignment.student.name} — ${assignment.title}`,
      metadata: {
        intent,
        studentId: assignment.student.id,
        fileName: assignment.submission.fileName,
        fileType: assignment.submission.fileType,
        teacher: assignment.teacher.name,
      },
    });

    return res.json({
      url: assignment.submission.fileUrl,
      fileName: assignment.submission.fileName,
      fileType: assignment.submission.fileType,
    });
  } catch (err) {
    console.error("Submission access failed:", err);
    return res.status(500).json({ error: "Failed to open submission" });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /:id — hard delete.
// Body: { confirmName, force }.  confirmName must equal the learner's name.
// If a submission exists, `force: true` is additionally required — mirrors
// the teacher-side guard so a child's work can't be discarded by accident.
// ─────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const { confirmName, force } = req.body || {};
  try {
    const assignment = await prisma.assignment.findUnique({
      where: { id: req.params.id },
      include: { student: { select: { name: true } }, teacher: { select: { name: true } }, submission: true },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    if (confirmName !== assignment.student.name) {
      return res.status(400).json({ error: "Confirmation name does not match. Delete aborted." });
    }
    if (assignment.submission && force !== true) {
      return res.status(409).json({
        error: "This assignment has a submission from the student. Deleting removes their work too.",
        requiresForce: true,
      });
    }

    if (assignment.submission?.fileUrl) {
      await deleteStoredFile({ path: assignment.submission.filePath, url: assignment.submission.fileUrl })
        .catch((e) => console.error("Submission file cleanup failed:", e.message));
    }
    if (assignment.attachmentUrl) {
      await deleteStoredFile({ path: assignment.attachmentPath, url: assignment.attachmentUrl })
        .catch((e) => console.error("Assignment attachment cleanup failed:", e.message));
    }

    // Cascade removes the submission row.
    await prisma.assignment.delete({ where: { id: assignment.id } });

    await logAudit(req, {
      action: "assignment.delete", targetType: "Assignment", targetId: req.params.id,
      targetLabel: `${assignment.student.name} — ${assignment.title}`,
      metadata: { teacher: assignment.teacher.name, hadSubmission: !!assignment.submission, forced: force === true },
    });
    return res.json({ deleted: true });
  } catch (err) {
    console.error("Admin assignment delete failed:", err);
    return res.status(500).json({ error: "Failed to delete assignment" });
  }
});

export default router;