// src/routes/admin/audit.js  (NEW)
//
// Audit Trail Viewer backend. The audit log is ALREADY being written by
// logAudit() across every admin mutation — this surfaces it: searchable,
// filterable, paginated, with the distinct actors/actions/targetTypes for
// the filter dropdowns.
//
// Mount in src/routes/admin/index.js:
//   import auditRouter from './audit.js';
//   router.use('/audit', auditRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";

const router = express.Router();

const VALID_TARGET_TYPES = [
  "User", "Student", "Teacher", "Enrollment", "ClassSession", "TrialBooking",
  "EnrollmentRequest", "ProgressReport", "CommunicationLog", "TrialLead",
];

// ─────────────────────────────────────────────────────────
// GET /api/admin/audit
// Filters: ?q= (targetLabel/actorEmail search) &actorEmail= &action=
//          &targetType= &from= &to= &page= &pageSize=
// Cursor-free offset pagination (audit volume is modest; offset is fine
// and lets the UI show page numbers).
// ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const { q, actorEmail, action, targetType, from, to, page = "1", pageSize = "50" } = req.query;
  const take = Math.min(parseInt(pageSize, 10) || 50, 200);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

  const where = {};
  if (actorEmail) where.actorEmail = actorEmail;
  if (action) where.action = action;
  if (targetType && VALID_TARGET_TYPES.includes(targetType)) where.targetType = targetType;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { targetLabel: { contains: term, mode: "insensitive" } },
      { actorEmail: { contains: term, mode: "insensitive" } },
      { action: { contains: term, mode: "insensitive" } },
    ];
  }

  try {
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      prisma.auditLog.count({ where }),
    ]);
    return res.json({ rows, total, page: parseInt(page, 10) || 1, pageSize: take });
  } catch (err) {
    console.error("Audit list failed:", err);
    return res.status(500).json({ error: "Failed to load audit log" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/admin/audit/facets
// Distinct values for the filter dropdowns (actors, actions, targetTypes).
// ─────────────────────────────────────────────────────────
router.get("/facets", async (_req, res) => {
  try {
    const [actors, actions, targetTypes] = await Promise.all([
      prisma.auditLog.findMany({ where: { actorEmail: { not: null } }, distinct: ["actorEmail"], select: { actorEmail: true }, orderBy: { actorEmail: "asc" } }),
      prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } }),
      prisma.auditLog.findMany({ where: { targetType: { not: null } }, distinct: ["targetType"], select: { targetType: true }, orderBy: { targetType: "asc" } }),
    ]);
    return res.json({
      actors: actors.map(a => a.actorEmail),
      actions: actions.map(a => a.action),
      targetTypes: targetTypes.map(t => t.targetType),
    });
  } catch (err) {
    console.error("Audit facets failed:", err);
    return res.status(500).json({ error: "Failed to load filters" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/admin/audit/administrators
// Read-only list of current ADMINs (from the DB). Changing who is an admin
// happens in the Clerk Dashboard — this is a window, not a control panel.
// ─────────────────────────────────────────────────────────
router.get("/administrators", async (_req, res) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true, email: true, name: true, createdAt: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    return res.json({ admins });
  } catch (err) {
    console.error("Administrators list failed:", err);
    return res.status(500).json({ error: "Failed to load administrators" });
  }
});

export default router;