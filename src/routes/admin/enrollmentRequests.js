// src/routes/admin/enrollmentRequests.js  (NEW)
//
// Enrollment request review pipeline — migrates the old x-admin-secret
// workflow (PATCH /api/enrollment/admin/:id) into the panel under proper
// admin auth, and adds convert-to-enrollment.
//
// Lifecycle: PENDING → UNDER_REVIEW → APPROVED → AWAITING_PAYMENT → ACTIVE
//            (or REJECTED / CANCELLED at appropriate points)
//
// Mount in src/routes/admin/index.js:
//   import requestsRouter from './enrollmentRequests.js';
//   router.use('/enrollment-requests', requestsRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
import { sendEnrollmentApproved, sendEnrollmentRejected } from "../../services/email.js";

const router = express.Router();

const VALID_STATUSES = ["PENDING", "UNDER_REVIEW", "APPROVED", "AWAITING_PAYMENT", "ACTIVE", "REJECTED", "CANCELLED"];
const VALID_COURSES = ["NOORANI_QAIDA", "QURAN_RECITATION", "TAJWEED", "HIFZ", "ISLAMIC_STUDIES", "ONE_TO_ONE"];
const COURSE_LABELS = { NOORANI_QAIDA: "Noorani Qaida", QURAN_RECITATION: "Quran Recitation", TAJWEED: "Tajweed", HIFZ: "Hifz Programme", ISLAMIC_STUDIES: "Islamic Studies", ONE_TO_ONE: "One-to-One Private" };

// ═════════════════════════════════════════════════════════
// GET /api/admin/enrollment-requests
// Queue: list + filter by status/course. Query: ?status= &course=
// ═════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const { status, course } = req.query;
  const where = {};
  if (status && VALID_STATUSES.includes(status)) where.status = status;
  if (course && VALID_COURSES.includes(course)) where.courseType = course;

  try {
    const requests = await prisma.enrollmentRequest.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: {
        student: {
          select: {
            id: true, name: true, age: true, country: true, timezone: true, gender: true,
            account: { select: { id: true, email: true, name: true, phone: true } },
          },
        },
      },
    });

    // Count by status for the queue tabs
    const counts = {};
    for (const s of VALID_STATUSES) counts[s] = 0;
    const all = await prisma.enrollmentRequest.groupBy({ by: ["status"], _count: true });
    all.forEach((r) => { counts[r.status] = r._count; });

    return res.json({ requests, counts });
  } catch (err) {
    console.error("Requests list failed:", err);
    return res.status(500).json({ error: "Failed to load enrollment requests" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /api/admin/enrollment-requests/:id
// ═════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const request = await prisma.enrollmentRequest.findUnique({
      where: { id },
      include: { student: { select: { id: true, name: true, age: true, country: true, timezone: true, gender: true, courseInterest: true, account: { select: { id: true, email: true, name: true, phone: true } } } } },
    });
    if (!request) return res.status(404).json({ error: "Request not found" });
    return res.json({ request });
  } catch (err) {
    console.error("Request detail failed:", err);
    return res.status(500).json({ error: "Failed to load request" });
  }
});

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/enrollment-requests/:id
// Move through the lifecycle. Body: { status, adminNotes?, rejectionReason? }
// Fires approval/rejection emails (same as the old admin route).
// ═════════════════════════════════════════════════════════
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { status, adminNotes, rejectionReason } = req.body;

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. One of: ${VALID_STATUSES.join(", ")}` });
  }
  if (status === "REJECTED" && !rejectionReason?.trim()) {
    return res.status(400).json({ error: "rejectionReason is required when rejecting" });
  }

  try {
    const existing = await prisma.enrollmentRequest.findUnique({
      where: { id },
      include: { student: { select: { name: true, account: { select: { email: true, name: true } } } } },
    });
    if (!existing) return res.status(404).json({ error: "Request not found" });

    const data = { status };
    if (adminNotes !== undefined) data.adminNotes = adminNotes?.trim() || null;
    if (rejectionReason !== undefined) data.rejectionReason = rejectionReason?.trim() || null;

    const updated = await prisma.enrollmentRequest.update({ where: { id }, data });

    await logAudit(req, {
      action: status === "APPROVED" ? "enrollmentRequest.approve" : status === "REJECTED" ? "enrollmentRequest.reject" : "enrollmentRequest.update",
      targetType: "EnrollmentRequest", targetId: id, targetLabel: existing.student.name,
      metadata: { status, from: existing.status },
    });

    // Fire emails (non-blocking) — same behaviour as the retired secret route
    const toEmail = existing.student.account.email;
    const parentName = existing.student.account.name || toEmail;
    const childName = existing.student.name || "your child";
    const courseLabel = COURSE_LABELS[existing.courseType] || existing.courseType;

    if (status === "APPROVED") {
      sendEnrollmentApproved({ to: toEmail, parentName, childName, courseLabel, applicationId: id })
        .catch((e) => console.error("⚠️  Approval email failed:", e.message));
    }
    if (status === "REJECTED") {
      sendEnrollmentRejected({ to: toEmail, parentName, childName, courseLabel, rejectionReason: rejectionReason.trim() })
        .catch((e) => console.error("⚠️  Rejection email failed:", e.message));
    }

    return res.json({ request: updated });
  } catch (err) {
    console.error("Request update failed:", err);
    return res.status(500).json({ error: "Failed to update request" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/enrollment-requests/:id/convert
// Convert an approved request into a real Enrollment.
// Body: { teacherId, sessionsPerWeek?, startDate?, notes? }
// Marks the request ACTIVE and creates the Enrollment. Fires the
// approval email if not already sent.
// ═════════════════════════════════════════════════════════
router.post("/:id/convert", async (req, res) => {
  const { id } = req.params;
  const { teacherId, sessionsPerWeek, startDate, notes } = req.body;
  if (!teacherId) return res.status(400).json({ error: "teacherId is required" });

  try {
    const request = await prisma.enrollmentRequest.findUnique({
      where: { id },
      include: { student: { select: { id: true, name: true, account: { select: { email: true, name: true } } } } },
    });
    if (!request) return res.status(404).json({ error: "Request not found" });

    const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });

    // Create the enrollment + flip the request to ACTIVE in a transaction
    const [enrollment] = await prisma.$transaction([
      prisma.enrollment.create({
        data: {
          studentId: request.student.id, teacherId, courseType: request.courseType,
          sessionsPerWeek: sessionsPerWeek ? parseInt(sessionsPerWeek, 10) : 2,
          startDate: startDate ? new Date(startDate) : new Date(),
          status: "ACTIVE", notes: notes?.trim() || null,
        },
      }),
      prisma.enrollmentRequest.update({ where: { id }, data: { status: "ACTIVE" } }),
    ]);

    await logAudit(req, {
      action: "enrollmentRequest.convert", targetType: "Enrollment", targetId: enrollment.id,
      targetLabel: request.student.name, metadata: { fromRequest: id, teacher: teacher.name },
    });

    // Confirmation email
    sendEnrollmentApproved({
      to: request.student.account.email,
      parentName: request.student.account.name || "Parent",
      childName: request.student.name,
      courseLabel: COURSE_LABELS[request.courseType] || request.courseType,
      applicationId: enrollment.id,
    }).catch((e) => console.error("⚠️  Email failed:", e.message));

    return res.status(201).json({ enrollment });
  } catch (err) {
    console.error("Convert failed:", err);
    return res.status(500).json({ error: "Failed to convert request" });
  }
});

// Lightweight teachers list for the convert dropdown (reuses pattern)
router.get("/meta/teachers", async (req, res) => {
  try {
    const teachers = await prisma.teacher.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, specialty: true, gender: true } });
    return res.json({ teachers });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load teachers" });
  }
});

export default router;