// src/routes/admin/leads.js  (NEW)
//
// The lead pipeline: list/filter, per-lead status + notes, and the
// legitimate conversion link — detect the User account a lead became
// (by email match) and let the admin confirm-link it (status → CONVERTED,
// convertedUserId set). Conversion is admin-verified, not guessed.
//
// Mount in src/routes/admin/index.js:
//   import leadsRouter from './leads.js';
//   router.use('/leads', leadsRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";

const router = express.Router();

const LEAD_STATUSES = ["NEW", "CONTACTED", "BOOKED", "CONVERTED", "LOST"];

// ─────────────────────────────────────────────────────────
// GET /  — pipeline list. ?status= &q= &page= &pageSize=
// Also returns per-status counts for the pipeline columns/summary.
// ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { status, q, page = "1", pageSize = "50" } = req.query;
  const take = Math.min(parseInt(pageSize, 10) || 50, 200);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

  const where = {};
  if (status && LEAD_STATUSES.includes(status)) where.status = status;
  if (q && q.trim()) {
    where.OR = [
      { firstName: { contains: q.trim(), mode: "insensitive" } },
      { lastName: { contains: q.trim(), mode: "insensitive" } },
      { email: { contains: q.trim(), mode: "insensitive" } },
      { phone: { contains: q.trim(), mode: "insensitive" } },
    ];
  }

  try {
    const [leads, total, statusCounts] = await Promise.all([
      prisma.trialLead.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      prisma.trialLead.count({ where }),
      prisma.trialLead.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(LEAD_STATUSES.map(s => [s, 0]));
    for (const g of statusCounts) counts[g.status] = g._count._all;
    return res.json({ leads, total, page: parseInt(page, 10) || 1, pageSize: take, counts });
  } catch (err) {
    console.error("Leads list failed:", err);
    return res.status(500).json({ error: "Failed to load leads" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /:id — single lead + conversion detection.
// Detects a User whose email matches the lead, and surfaces their
// enrollment count so the admin can verify a real conversion.
// ─────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const lead = await prisma.trialLead.findUnique({
      where: { id: req.params.id },
      include: { convertedUser: { select: { id: true, email: true, name: true } } },
    });
    if (!lead) return res.status(404).json({ error: "Not found" });

    // Candidate match: a User with the same email (case-insensitive)
    let candidate = null;
    if (!lead.convertedUserId) {
      const user = await prisma.user.findFirst({
        where: { email: { equals: lead.email, mode: "insensitive" } },
        select: { id: true, email: true, name: true, managedStudents: { select: { id: true } } },
      });
      if (user) {
        const studentIds = user.managedStudents.map(s => s.id);
        const activeEnrollments = studentIds.length
          ? await prisma.enrollment.count({ where: { studentId: { in: studentIds }, status: "ACTIVE" } })
          : 0;
        candidate = { userId: user.id, email: user.email, name: user.name, studentCount: studentIds.length, activeEnrollments };
      }
    }

    return res.json({ lead, candidate });
  } catch (err) {
    console.error("Lead detail failed:", err);
    return res.status(500).json({ error: "Failed to load lead" });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /:id — update status and/or notes
// ─────────────────────────────────────────────────────────
router.patch("/:id", async (req, res) => {
  const { status, notes } = req.body;
  const data = {};
  if (status !== undefined) {
    if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });
    data.status = status;
  }
  if (notes !== undefined) data.notes = notes;
  if (Object.keys(data).length === 0) return res.status(400).json({ error: "Nothing to update" });

  try {
    const lead = await prisma.trialLead.update({ where: { id: req.params.id }, data });
    await logAudit(req, {
      action: "lead.update", targetType: "TrialLead", targetId: lead.id,
      targetLabel: `${lead.firstName} ${lead.lastName}`,
      metadata: { status: data.status || undefined, notesChanged: data.notes !== undefined },
    });
    return res.json({ lead });
  } catch (err) {
    console.error("Lead update failed:", err);
    return res.status(500).json({ error: "Failed to update lead" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /:id/link — confirm the conversion link to a User account.
// Body: { userId }.  Sets convertedUserId and status → CONVERTED.
// Admin-verified (they saw the matched account + its enrollments first).
// ─────────────────────────────────────────────────────────
router.post("/:id/link", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) return res.status(404).json({ error: "Account not found" });

    const lead = await prisma.trialLead.update({
      where: { id: req.params.id },
      data: { convertedUserId: userId, status: "CONVERTED" },
    });
    await logAudit(req, {
      action: "lead.convert", targetType: "TrialLead", targetId: lead.id,
      targetLabel: `${lead.firstName} ${lead.lastName}`, metadata: { linkedUser: user.email },
    });
    return res.json({ lead });
  } catch (err) {
    console.error("Lead link failed:", err);
    return res.status(500).json({ error: "Failed to link lead" });
  }
});

// ─────────────────────────────────────────────────────────
// POST /:id/unlink — undo a conversion link (mistake correction)
// ─────────────────────────────────────────────────────────
router.post("/:id/unlink", async (req, res) => {
  try {
    const lead = await prisma.trialLead.update({
      where: { id: req.params.id },
      data: { convertedUserId: null, status: "CONTACTED" },
    });
    await logAudit(req, { action: "lead.unlink", targetType: "TrialLead", targetId: lead.id, targetLabel: `${lead.firstName} ${lead.lastName}` });
    return res.json({ lead });
  } catch (err) {
    return res.status(500).json({ error: "Failed to unlink" });
  }
});

export default router;