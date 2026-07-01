// src/routes/enrollment.js
//
// REWORKED for the multi-learner model.
//
// KEY CHANGES:
//   • POST /apply now requires `studentId` in the body, validated
//     against req.studentIds (the account's learners).
//   • The duplicate-application guard is now PER-LEARNER, not
//     per-account. A parent with 3 children can have 3 simultaneous
//     applications — one per child. (This is the fix for the original
//     multi-child problem.)
//   • GET /my returns applications across ALL the account's learners,
//     optionally filtered by ?studentId=.
//   • Admin email/notification field sources move from
//     StudentProfile → Student + Student.account (User).

import express from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, ownsStudent, requireContactDetails } from "../middleware/auth.js";
import {
  sendEnrollmentAdminNotification,
  sendEnrollmentApproved,
  sendEnrollmentRejected,
} from "../services/email.js";
import "dotenv/config";

const router = express.Router();

const VALID_COURSES = ["NOORANI_QAIDA","QURAN_RECITATION","TAJWEED","HIFZ","ISLAMIC_STUDIES","ONE_TO_ONE"];
const VALID_DAYS    = ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"];
const VALID_TIMES   = ["MORNING","AFTERNOON","EVENING"];
const VALID_GENDER  = ["MALE","FEMALE","NO_PREFERENCE"];

// A learner cannot have more than one of these open AT A TIME
const ACTIVE_STATUSES = ["PENDING","UNDER_REVIEW","APPROVED","AWAITING_PAYMENT"];

const COURSE_LABELS = {
  NOORANI_QAIDA: "Noorani Qaida",
  QURAN_RECITATION: "Quran Recitation",
  TAJWEED: "Tajweed",
  HIFZ: "Hifz Programme",
  ISLAMIC_STUDIES: "Islamic Studies",
  ONE_TO_ONE: "One-to-One Private",
};

// ─────────────────────────────────────────────────────────
// POST /api/enrollment/apply
// Apply to enroll a SPECIFIC learner in a course.
// Guards (now per-learner):
//   - That learner cannot have >1 active application
//   - That learner cannot already be ACTIVE in this course
// ─────────────────────────────────────────────────────────
router.post("/apply", requireAuth, requireContactDetails, async (req, res) => {
  const {
    studentId,
    courseType,
    genderPreference,
    preferredDays,
    preferredTime,
    message,
  } = req.body;

  // ── Validation ─────────────────────────────────────────
  const errors = [];
  if (!studentId) errors.push("studentId is required");
  if (!courseType) errors.push("courseType is required");
  if (courseType && !VALID_COURSES.includes(courseType))
    errors.push(`Invalid courseType. Must be one of: ${VALID_COURSES.join(", ")}`);
  if (!preferredDays || !Array.isArray(preferredDays) || preferredDays.length === 0)
    errors.push("preferredDays must be a non-empty array");
  if (preferredDays && !preferredDays.every((d) => VALID_DAYS.includes(d)))
    errors.push(`Invalid day in preferredDays. Must be one of: ${VALID_DAYS.join(", ")}`);
  if (!preferredTime) errors.push("preferredTime is required");
  if (preferredTime && !VALID_TIMES.includes(preferredTime))
    errors.push(`Invalid preferredTime. Must be one of: ${VALID_TIMES.join(", ")}`);
  if (genderPreference && !VALID_GENDER.includes(genderPreference))
    errors.push(`Invalid genderPreference. Must be one of: ${VALID_GENDER.join(", ")}`);
  if (message && message.trim().length > 500)
    errors.push("Message cannot exceed 500 characters");

  if (errors.length > 0) {
    return res.status(400).json({ error: "Validation failed", details: errors });
  }

  // ── Ownership: the learner must belong to this account ─
  if (!ownsStudent(req, studentId)) {
    return res.status(404).json({ error: "Learner not found" });
  }

  try {
    // Fetch the learner (for the notification + to confirm existence)
    const student = await prisma.student.findUnique({
      where:   { id: studentId },
      include: { account: { select: { email: true, name: true, phone: true } } },
    });
    if (!student) {
      return res.status(404).json({ error: "Learner not found" });
    }

    // ── Guard 1: existing active application FOR THIS LEARNER ──
    const existingApplication = await prisma.enrollmentRequest.findFirst({
      where: { studentId, status: { in: ACTIVE_STATUSES } },
    });
    if (existingApplication) {
      return res.status(409).json({
        error: "This learner already has an active enrollment application",
        details: `Current status: ${existingApplication.status}. Cancel it before submitting a new one for this learner.`,
        applicationId: existingApplication.id,
        status: existingApplication.status,
      });
    }

    // ── Guard 2: this learner already ACTIVE in this course ──
    const existingEnrollment = await prisma.enrollment.findFirst({
      where: { studentId, courseType, status: "ACTIVE" },
    });
    if (existingEnrollment) {
      return res.status(409).json({
        error: `This learner is already actively enrolled in ${COURSE_LABELS[courseType] || courseType}`,
      });
    }

    // ── Create application ─────────────────────────────────
    const application = await prisma.enrollmentRequest.create({
      data: {
        studentId,
        courseType,
        genderPreference: genderPreference || "NO_PREFERENCE",
        preferredDays,
        preferredTime,
        message: message?.trim() || null,
        status: "PENDING",
      },
    });

    console.log(`✅ Enrollment application ${application.id} for learner ${studentId}`);

    // ── Admin notification — non-blocking ─────────────────
    // Field sources now: child name from Student, parent contact from Student.account
    sendEnrollmentAdminNotification({
      applicationId: application.id,
      parentName:    student.account.name || student.account.email,
      childName:     student.name,
      parentEmail:   student.account.email,
      phone:         student.account.phone || null,
      courseLabel:   COURSE_LABELS[courseType] || courseType,
      genderPreference: genderPreference || "NO_PREFERENCE",
      preferredDays,
      preferredTime,
      message: message?.trim() || null,
    }).catch((err) => console.error("⚠️  Enrollment admin notification failed:", err.message));

    return res.status(201).json({
      application,
      message: "Your enrollment application has been submitted. We will review it and get back to you within 24 hours.",
    });
  } catch (err) {
    console.error("Enrollment application failed:", err);
    return res.status(500).json({ error: "Failed to submit enrollment application" });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/enrollment/my
// All enrollment requests across the account's learners.
// Optional filter: ?studentId=  (must be owned).
// ─────────────────────────────────────────────────────────
router.get("/my", requireAuth, async (req, res) => {
  const { studentId } = req.query;

  // Build the studentId filter
  let studentFilter;
  if (studentId) {
    if (!ownsStudent(req, studentId)) {
      return res.status(404).json({ error: "Learner not found" });
    }
    studentFilter = studentId;
  } else {
    studentFilter = { in: req.studentIds };
  }

  try {
    const applications = await prisma.enrollmentRequest.findMany({
      where:   { studentId: studentFilter },
      include: { student: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });

    const enriched = applications.map((a) => ({
      ...a,
      courseLabel: COURSE_LABELS[a.courseType] || a.courseType,
    }));

    return res.json({ applications: enriched, count: enriched.length });
  } catch (err) {
    console.error("Enrollment fetch failed:", err);
    return res.status(500).json({ error: "Failed to fetch enrollment applications" });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/enrollment/:id/cancel
// Cancel an application (only if PENDING). Must belong to a
// learner this account owns.
// ─────────────────────────────────────────────────────────
router.patch("/:id/cancel", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const application = await prisma.enrollmentRequest.findUnique({ where: { id } });

    // Must exist AND belong to one of this account's learners
    if (!application || !ownsStudent(req, application.studentId)) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (application.status !== "PENDING") {
      return res.status(409).json({
        error: `Cannot cancel an application with status ${application.status}`,
        details: "Only PENDING applications can be cancelled. Contact us to cancel one that is under review or approved.",
      });
    }

    const cancelled = await prisma.enrollmentRequest.update({
      where: { id },
      data:  { status: "CANCELLED" },
    });

    console.log(`✅ Enrollment application ${id} cancelled`);
    return res.json({ application: cancelled, message: "Application cancelled successfully" });
  } catch (err) {
    console.error("Enrollment cancellation failed:", err);
    return res.status(500).json({ error: "Failed to cancel application" });
  }
});

// ═════════════════════════════════════════════════════════
// ADMIN ROUTES (x-admin-secret protected — unchanged auth pattern)
// Field sources updated: Student + Student.account.
// ═════════════════════════════════════════════════════════

export default router;