// src/routes/admin/communications.js  (NEW)
//
// The communications log: searchable/filterable list, single view,
// retry (re-fire stored payload), resend-with-edit, failure count for the
// nav badge, and dismiss (mark a failure resolved without resending).
//
// Mount in src/routes/admin/index.js:
//   import commsRouter from './communications.js';
//   router.use('/communications', commsRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
import { resendRendered } from "../../services/email.js";

const router = express.Router();

const VALID_STATUS = ["SENT", "FAILED"];
const VALID_TYPES = [
  "LEAD_CONFIRMATION","ADMIN_LEAD_NOTIFICATION","TRIAL_BOOKING_CONFIRMATION",
  "ADMIN_TRIAL_NOTIFICATION","ENROLLMENT_ADMIN_NOTIFICATION","ENROLLMENT_APPROVED",
  "ENROLLMENT_REJECTED","PROGRESS_REPORT","TEACHER_DUTIES_REMINDER","OTHER",
];

// ─────────────────────────────────────────────────────────
// GET /  — list with filters + pagination
// ?status= &type= &q= (recipient/subject) &from= &to= &page= &pageSize=
// Failures float first by default.
// ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { status, type, q, from, to, page = "1", pageSize = "25" } = req.query;
  const take = Math.min(parseInt(pageSize, 10) || 25, 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

  const where = {};
  if (status && VALID_STATUS.includes(status)) where.status = status;
  if (type && VALID_TYPES.includes(type)) where.type = type;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (q && q.trim()) {
    where.OR = [
      { toAddress: { contains: q.trim(), mode: "insensitive" } },
      { subject: { contains: q.trim(), mode: "insensitive" } },
    ];
  }

  try {
    const [rows, total, failedUnresolved] = await Promise.all([
      prisma.communicationLog.findMany({
        where,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }], // FAILED (< SENT alphabetically) first
        skip, take,
        select: {
          id: true, channel: true, type: true, status: true, toAddress: true, subject: true,
          providerId: true, failureReason: true, failureCode: true, relatedType: true, relatedId: true,
          resendOfId: true, resolvedAt: true, createdAt: true,
        },
      }),
      prisma.communicationLog.count({ where }),
      prisma.communicationLog.count({ where: { status: "FAILED", resolvedAt: null } }),
    ]);
    return res.json({ rows, total, page: parseInt(page, 10) || 1, pageSize: take, failedUnresolved });
  } catch (err) {
    console.error("Comms list failed:", err);
    return res.status(500).json({ error: "Failed to load communications" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /failure-count — for the nav badge (unresolved failures)
// ─────────────────────────────────────────────────────────
router.get("/failure-count", async (_req, res) => {
  try {
    const failed = await prisma.communicationLog.count({ where: { status: "FAILED", resolvedAt: null } });
    return res.json({ failed });
  } catch (err) {
    return res.status(500).json({ error: "Failed" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /:id — single log row incl. the html body (for view / edit-before-resend)
// ─────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const row = await prisma.communicationLog.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ row });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /:id/retry — re-fire the stored payload AS-IS
// ─────────────────────────────────────────────────────────
router.post("/:id/retry", async (req, res) => {
  try {
    const orig = await prisma.communicationLog.findUnique({ where: { id: req.params.id } });
    if (!orig) return res.status(404).json({ error: "Not found" });
    if (!orig.html) return res.status(400).json({ error: "No stored body to retry (older row)." });

    const result = await resendRendered({
      to: orig.toAddress.split(",").map(s => s.trim()),
      subject: orig.subject, html: orig.html, from: orig.fromAddress,
      type: orig.type, relatedType: orig.relatedType, relatedId: orig.relatedId,
      resendOfId: orig.id,
    });

    await logAudit(req, {
      action: "comms.retry", targetType: "CommunicationLog", targetId: orig.id,
      targetLabel: orig.toAddress, metadata: { success: result.success, failureReason: result.failureReason || null },
    });

    return res.json({ success: result.success, failureReason: result.failureReason, newLogId: result.logId });
  } catch (err) {
    console.error("Retry failed:", err);
    return res.status(500).json({ error: "Retry failed" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /:id/resend — resend WITH EDITS  Body: { to, subject, html }
// ─────────────────────────────────────────────────────────
router.post("/:id/resend", async (req, res) => {
  const { to, subject, html } = req.body;
  if (!to || !subject || !html) return res.status(400).json({ error: "to, subject and html are required" });
  try {
    const orig = await prisma.communicationLog.findUnique({ where: { id: req.params.id } });
    if (!orig) return res.status(404).json({ error: "Not found" });

    const result = await resendRendered({
      to: Array.isArray(to) ? to : to.split(",").map(s => s.trim()),
      subject, html, from: orig.fromAddress,
      type: orig.type, relatedType: orig.relatedType, relatedId: orig.relatedId,
      resendOfId: orig.id,
    });

    await logAudit(req, {
      action: "comms.resendEdited", targetType: "CommunicationLog", targetId: orig.id,
      targetLabel: Array.isArray(to) ? to.join(", ") : to,
      metadata: { success: result.success, edited: true, failureReason: result.failureReason || null },
    });

    return res.json({ success: result.success, failureReason: result.failureReason, newLogId: result.logId });
  } catch (err) {
    console.error("Resend failed:", err);
    return res.status(500).json({ error: "Resend failed" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /:id/dismiss — mark a FAILED row resolved without resending
// (e.g. the recipient was contacted another way, or it's a dud address)
// ─────────────────────────────────────────────────────────
router.post("/:id/dismiss", async (req, res) => {
  try {
    const row = await prisma.communicationLog.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.status !== "FAILED") return res.status(400).json({ error: "Only failed items can be dismissed." });
    await prisma.communicationLog.update({ where: { id: row.id }, data: { resolvedAt: new Date() } });
    await logAudit(req, { action: "comms.dismiss", targetType: "CommunicationLog", targetId: row.id, targetLabel: row.toAddress });
    return res.json({ dismissed: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to dismiss" });
  }
});

export default router;