// src/lib/audit.js
//
// logAudit() — write an attributed audit record. Call it from any
// admin route AFTER a successful mutation. Never throws (a logging
// failure must not break the actual operation).
//
// Usage inside an admin route (req.user is the acting admin):
//
//   await logAudit(req, {
//     action: 'account.suspend',
//     targetType: 'User',
//     targetId: target.id,
//     targetLabel: target.email,
//     metadata: { from: 'ACTIVE', to: 'SUSPENDED' },
//   });

import { prisma } from "./prisma.js";

export async function logAudit(
  req,
  {
    action,
    targetType = null,
    targetId = null,
    targetLabel = null,
    metadata = null,
  },
) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: req?.user?.id || null,
        actorEmail: req?.user?.email || null,
        action,
        targetType,
        targetId,
        targetLabel,
        metadata: metadata || undefined,
        ip: req?.clientIp || null,
      },
    });
  } catch (err) {
    // Audit logging is best-effort — never block the real operation.
    console.error("⚠️  Audit log write failed:", err.message);
  }
}

// Convenience: read recent audit entries (used by the dashboard
// activity feed in Phase 2 and the full viewer in Phase 11).
export async function getRecentAudit({ limit = 20, cursor } = {}) {
  return prisma.auditLog.findMany({
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { createdAt: "desc" },
  });
}
