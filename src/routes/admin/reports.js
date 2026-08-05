// src/routes/admin/reports.js  (NEW)
//
// Progress Reports — admin oversight. READ + MODERATE, never author.
// Admins cannot create or edit report content: a report is a teacher's
// assessment of a child, signed with the teacher's name and emailed to the
// parent. Admins can read everything, re-send, nudge the teacher, and delete.
//
// Mount in src/routes/admin/index.js:
//   import reportsRouter from './reports.js';
//   router.use('/reports', reportsRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
import { sendProgressReport } from "../../services/email.js";
// NOTE: match this import path to the one used in src/routes/teacher.js
// import { deleteStoredFile } from "../../services/storage.js";
import { deleteStoredFile } from "../../lib/storageAdmin.js";

const router = express.Router();

const STALE_DRAFT_DAYS = 30;
const COURSES = ["NOORANI_QAIDA","QURAN_RECITATION","TAJWEED","HIFZ","ISLAMIC_STUDIES","ONE_TO_ONE"];

// A report is "thin" when the parent gets no personal message AND no next
// steps — the two fields families actually read. Deliberately narrow and
// DB-expressible; it flags neglect, not style.
const THIN_WHERE = {
  AND: [
    { OR: [{ teacherMessage: null }, { teacherMessage: "" }] },
    { OR: [{ nextSteps: null }, { nextSteps: "" }] },
  ],
};

// Reports whose parent email failed and was never resolved.
// Guarded: if Phase 9's communication_logs table isn't deployed, this
// degrades to "no delivery data" rather than breaking the page.
async function failedReportIds() {
  try {
    const rows = await prisma.communicationLog.findMany({
      where: { relatedType: "ProgressReport", status: "FAILED", resolvedAt: null, relatedId: { not: null } },
      select: { relatedId: true },
      distinct: ["relatedId"],
    });
    return rows.map((r) => r.relatedId);
  } catch {
    return null; // null = comms log unavailable
  }
}

// ─────────────────────────────────────────────────────────
// GET /  — list + filters + attention counts
// ?q= &teacherId= &studentId= &course= &status= &from= &to=
// &flag=edited-not-resent|delivery-failed|stale-draft|thin|no-rating
// &page= &pageSize=
// ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { q, teacherId, studentId, course, status, from, to, flag, page = "1", pageSize = "25" } = req.query;
  const take = Math.min(parseInt(pageSize, 10) || 25, 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_DRAFT_DAYS * 86400000);

  const where = {};
  if (teacherId) where.teacherId = teacherId;
  if (studentId) where.studentId = studentId;
  if (course && COURSES.includes(course)) where.courseType = course;
  if (status === "DRAFT" || status === "SENT") where.status = status;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { period: { contains: term, mode: "insensitive" } },
      { student: { name: { contains: term, mode: "insensitive" } } },
      { teacher: { name: { contains: term, mode: "insensitive" } } },
    ];
  }

  const failedIds = await failedReportIds();

  // Apply the attention flag on top of the base filters.
  if (flag === "edited-not-resent") where.updatedSinceSent = true;
  else if (flag === "stale-draft") { where.status = "DRAFT"; where.createdAt = { ...(where.createdAt || {}), lt: staleCutoff }; }
  else if (flag === "no-rating") where.overallRating = null;
  else if (flag === "thin") Object.assign(where, THIN_WHERE);
  else if (flag === "delivery-failed") where.id = { in: failedIds || [] };

  const select = {
    id: true, period: true, courseType: true, status: true, overallRating: true,
    updatedSinceSent: true, sentAt: true, lastSentAt: true, createdAt: true,
    attachmentUrl: true, attachmentName: true,
    teacherMessage: true, nextSteps: true,
    student: { select: { id: true, name: true, account: { select: { email: true } } } },
    teacher: { select: { id: true, name: true } },
  };

  try {
    const [rows, total, cEdited, cStale, cThin, cNoRating] = await Promise.all([
      prisma.progressReport.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, select }),
      prisma.progressReport.count({ where }),
      prisma.progressReport.count({ where: { updatedSinceSent: true } }),
      prisma.progressReport.count({ where: { status: "DRAFT", createdAt: { lt: staleCutoff } } }),
      prisma.progressReport.count({ where: THIN_WHERE }),
      prisma.progressReport.count({ where: { overallRating: null } }),
    ]);

    const failedSet = new Set(failedIds || []);
    const withDelivery = rows.map((r) => ({
      ...r,
      deliveryFailed: failedSet.has(r.id),
      // don't ship full narrative text to the list
      teacherMessage: undefined,
      nextSteps: undefined,
      isThin: !r.teacherMessage && !r.nextSteps,
    }));

    return res.json({
      rows: withDelivery,
      total,
      page: parseInt(page, 10) || 1,
      pageSize: take,
      commsAvailable: failedIds !== null,
      counts: {
        editedNotResent: cEdited,
        staleDraft: cStale,
        thin: cThin,
        noRating: cNoRating,
        deliveryFailed: failedIds ? failedIds.length : 0,
      },
    });
  } catch (err) {
    console.error("Admin reports list failed:", err);
    return res.status(500).json({ error: "Failed to load reports" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /facets — dropdown values
// ─────────────────────────────────────────────────────────
router.get("/facets", async (_req, res) => {
  try {
    const [teachers, students] = await Promise.all([
      prisma.teacher.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.student.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    ]);
    return res.json({ teachers, students, courses: COURSES });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load filters" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /:id — full report + delivery history
// ─────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const report = await prisma.progressReport.findUnique({
      where: { id: req.params.id },
      include: {
        student: { select: { id: true, name: true, account: { select: { id: true, name: true, email: true } } } },
        teacher: { select: { id: true, name: true, email: true } },
      },
    });
    if (!report) return res.status(404).json({ error: "Report not found" });

    let delivery = [];
    try {
      delivery = await prisma.communicationLog.findMany({
        where: { relatedType: "ProgressReport", relatedId: report.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, toAddress: true, failureReason: true, createdAt: true, resolvedAt: true },
      });
    } catch { delivery = []; }

    return res.json({ report, delivery });
  } catch (err) {
    console.error("Admin report detail failed:", err);
    return res.status(500).json({ error: "Failed to load report" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /:id/resend — re-send an ALREADY SENT report to the parent.
// Drafts are deliberately NOT sendable from here: deciding a report is
// finished is the teacher's call. Use the nudge instead.
// ─────────────────────────────────────────────────────────
router.post("/:id/resend", async (req, res) => {
  try {
    const report = await prisma.progressReport.findUnique({
      where: { id: req.params.id },
      include: {
        student: { select: { id: true, name: true, account: { select: { name: true, email: true } } } },
        teacher: { select: { id: true, name: true } },
      },
    });
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (report.status !== "SENT") {
      return res.status(409).json({ error: "Only a sent report can be re-sent. Nudge the teacher to send the draft." });
    }

    const parentEmail = report.student.account.email;
    let emailError = null;
    try {
      await sendProgressReport({
        parentEmail,
        parentName: report.student.account.name || "Parent",
        childName: report.student.name,
        teacherName: report.teacher.name,
        period: report.period,
        courseType: report.courseType,
        overallRating: report.overallRating,
        tajweedProgress: report.tajweedProgress,
        recitationNotes: report.recitationNotes,
        behaviourNotes: report.behaviourNotes,
        homeworkNotes: report.homeworkNotes,
        teacherMessage: report.teacherMessage,
        nextSteps: report.nextSteps,
        attachmentUrl: report.attachmentUrl,
        attachmentName: report.attachmentName,
        isResend: true,
        reportId: report.id,
      });
    } catch (e) { emailError = e.message; }

    if (!emailError) {
      await prisma.progressReport.update({
        where: { id: report.id },
        data: { lastSentAt: new Date(), updatedSinceSent: false },
      });
    }

    await logAudit(req, {
      action: "report.resend", targetType: "ProgressReport", targetId: report.id,
      targetLabel: `${report.student.name} — ${report.period}`,
      metadata: { to: parentEmail, success: !emailError, error: emailError || undefined },
    });

    return res.json({ sent: !emailError, error: emailError, sentTo: parentEmail });
  } catch (err) {
    console.error("Admin report resend failed:", err);
    return res.status(500).json({ error: "Failed to re-send report" });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /:id — hard delete. Body: { confirmName } must equal the
// learner's name. Cleans up the attachment. Always audited.
// ─────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const { confirmName } = req.body || {};
  try {
    const report = await prisma.progressReport.findUnique({
      where: { id: req.params.id },
      include: { student: { select: { name: true } }, teacher: { select: { name: true } } },
    });
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (confirmName !== report.student.name) {
      return res.status(400).json({ error: "Confirmation name does not match. Delete aborted." });
    }

    if (report.attachmentUrl) {
      await deleteStoredFile({ path: report.attachmentPath, url: report.attachmentUrl, bucket: "reports" })
        .catch((e) => console.error("Report attachment cleanup failed:", e.message));
    }
    await prisma.progressReport.delete({ where: { id: report.id } });

    await logAudit(req, {
      action: "report.delete", targetType: "ProgressReport", targetId: req.params.id,
      targetLabel: `${report.student.name} — ${report.period}`,
      metadata: { teacher: report.teacher.name, wasStatus: report.status, hadAttachment: !!report.attachmentUrl },
    });
    return res.json({ deleted: true });
  } catch (err) {
    console.error("Admin report delete failed:", err);
    return res.status(500).json({ error: "Failed to delete report" });
  }
});

export default router;