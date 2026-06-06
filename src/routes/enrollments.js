// src/routes/enrollment.js
import express from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { sendEnrollmentAdminNotification, sendEnrollmentApproved, sendEnrollmentRejected } from '../services/email.js';
import "dotenv/config";

const router = express.Router();

// ─── Constants ────────────────────────────────────────────
const VALID_COURSES = ['NOORANI_QAIDA','QURAN_RECITATION','TAJWEED','HIFZ','ISLAMIC_STUDIES','ONE_TO_ONE'];
const VALID_DAYS    = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];
const VALID_TIMES   = ['MORNING','AFTERNOON','EVENING'];
const VALID_GENDER  = ['MALE','FEMALE','NO_PREFERENCE'];

// Active statuses — student cannot have more than one of these open
const ACTIVE_STATUSES = ['PENDING','UNDER_REVIEW','APPROVED','AWAITING_PAYMENT'];

const COURSE_LABELS = {
  NOORANI_QAIDA:    'Noorani Qaida',
  QURAN_RECITATION: 'Quran Recitation',
  TAJWEED:          'Tajweed',
  HIFZ:             'Hifz Programme',
  ISLAMIC_STUDIES:  'Islamic Studies',
  ONE_TO_ONE:       'One-to-One Private',
};

// ─────────────────────────────────────────────────────────
// POST /api/enrollment/apply
// Student submits an enrollment application.
// Guards:
//   - Cannot have >1 active application
//   - Cannot apply for a course already actively enrolled in
// ─────────────────────────────────────────────────────────
router.post('/apply', requireAuth, async (req, res) => {
  const { courseType, genderPreference, preferredDays, preferredTime, message } = req.body;

  // ── Validation ─────────────────────────────────────────
  const errors = [];
  if (!courseType)                            errors.push('courseType is required');
  if (courseType && !VALID_COURSES.includes(courseType)) errors.push(`Invalid courseType. Must be one of: ${VALID_COURSES.join(', ')}`);
  if (!preferredDays || !Array.isArray(preferredDays) || preferredDays.length === 0) errors.push('preferredDays must be a non-empty array');
  if (preferredDays && !preferredDays.every(d => VALID_DAYS.includes(d))) errors.push(`Invalid day in preferredDays. Must be one of: ${VALID_DAYS.join(', ')}`);
  if (!preferredTime)                         errors.push('preferredTime is required');
  if (preferredTime && !VALID_TIMES.includes(preferredTime)) errors.push(`Invalid preferredTime. Must be one of: ${VALID_TIMES.join(', ')}`);
  if (genderPreference && !VALID_GENDER.includes(genderPreference)) errors.push(`Invalid genderPreference. Must be one of: ${VALID_GENDER.join(', ')}`);
  if (message && message.trim().length > 500) errors.push('Message cannot exceed 500 characters');

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  try {
    // ── Guard 1: existing active application ───────────────
    const existingApplication = await prisma.enrollmentRequest.findFirst({
      where: {
        studentId: req.user.id,
        status:    { in: ACTIVE_STATUSES },
      },
    });

    if (existingApplication) {
      return res.status(409).json({
        error:   'You already have an active enrollment application',
        details: `Current status: ${existingApplication.status}. Cancel your existing application before submitting a new one.`,
        applicationId: existingApplication.id,
        status:        existingApplication.status,
      });
    }

    // ── Guard 2: already actively enrolled in this course ──
    const existingEnrollment = await prisma.enrollment.findFirst({
      where: {
        studentId:  req.user.id,
        courseType: courseType,
        status:     'ACTIVE',
      },
    });

    if (existingEnrollment) {
      return res.status(409).json({
        error: `You are already actively enrolled in ${COURSE_LABELS[courseType] || courseType}`,
      });
    }

    // ── Create application ─────────────────────────────────
    const application = await prisma.enrollmentRequest.create({
      data: {
        studentId:        req.user.id,
        courseType,
        genderPreference: genderPreference || 'NO_PREFERENCE',
        preferredDays,
        preferredTime,
        message:          message?.trim() || null,
        status:           'PENDING',
      },
    });

    console.log(`✅ Enrollment application created: ${application.id} by student ${req.user.id}`);

    // ── Admin notification — non-blocking ─────────────────
    const profile = req.user.studentProfile;
    sendEnrollmentAdminNotification({
      applicationId:    application.id,
      parentName:       profile?.parentName || req.user.email,
      childName:        profile?.childName  || 'Student',
      parentEmail:      req.user.email,
      phone:            profile?.phone      || null,
      courseLabel:      COURSE_LABELS[courseType] || courseType,
      genderPreference: genderPreference || 'NO_PREFERENCE',
      preferredDays,
      preferredTime,
      message:          message?.trim() || null,
    }).catch(err => console.error('⚠️  Enrollment admin notification failed:', err.message));

    return res.status(201).json({
      application,
      message: 'Your enrollment application has been submitted. We will review it and get back to you within 24 hours.',
    });
  } catch (err) {
    console.error('Enrollment application failed:', err);
    return res.status(500).json({ error: 'Failed to submit enrollment application' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/enrollment/my
// All enrollment requests for the logged-in student,
// ordered by createdAt desc.
// ─────────────────────────────────────────────────────────
router.get('/my', requireAuth, async (req, res) => {
  try {
    const applications = await prisma.enrollmentRequest.findMany({
      where:   { studentId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });

    // Attach human-readable course label
    const enriched = applications.map(a => ({
      ...a,
      courseLabel: COURSE_LABELS[a.courseType] || a.courseType,
    }));

    return res.json({ applications: enriched, count: enriched.length });
  } catch (err) {
    console.error('Student enrollment fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch enrollment applications' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/enrollment/:id/cancel
// Student can cancel their application only if PENDING.
// ─────────────────────────────────────────────────────────
router.patch('/:id/cancel', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const application = await prisma.enrollmentRequest.findUnique({ where: { id } });

    if (!application || application.studentId !== req.user.id) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (application.status !== 'PENDING') {
      return res.status(409).json({
        error:   `Cannot cancel an application with status ${application.status}`,
        details: 'Only PENDING applications can be cancelled by students. Contact us to cancel applications that are under review or approved.',
      });
    }

    const cancelled = await prisma.enrollmentRequest.update({
      where: { id },
      data:  { status: 'CANCELLED' },
    });

    console.log(`✅ Enrollment application ${id} cancelled by student ${req.user.id}`);
    return res.json({ application: cancelled, message: 'Application cancelled successfully' });
  } catch (err) {
    console.error('Enrollment cancellation failed:', err);
    return res.status(500).json({ error: 'Failed to cancel application' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/admin/enrollments/:id
// Admin updates application status + notes.
// No auth middleware here — protected via ADMIN_SECRET header
// or plug into your admin auth pattern when you have one.
// For now: requires a shared secret from env.
// ─────────────────────────────────────────────────────────
router.patch('/admin/:id', async (req, res) => {
  // Simple admin secret guard — replace with proper admin role check
  // when you build the admin panel in a future module
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { id } = req.params;
  const { status, adminNotes, rejectionReason } = req.body;

  const VALID_ADMIN_STATUSES = ['UNDER_REVIEW','APPROVED','AWAITING_PAYMENT','ACTIVE','REJECTED','CANCELLED'];
  if (!status || !VALID_ADMIN_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_ADMIN_STATUSES.join(', ')}` });
  }

  if (status === 'REJECTED' && !rejectionReason?.trim()) {
    return res.status(400).json({ error: 'rejectionReason is required when rejecting an application' });
  }

  try {
    const existing = await prisma.enrollmentRequest.findUnique({
      where:   { id },
      include: {
        student: {
          select: {
            email: true,
            studentProfile: { select: { parentName: true, childName: true } },
          },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const updateData = { status };
    if (adminNotes      !== undefined) updateData.adminNotes      = adminNotes?.trim() || null;
    if (rejectionReason !== undefined) updateData.rejectionReason = rejectionReason?.trim() || null;

    const updated = await prisma.enrollmentRequest.update({
      where: { id },
      data:  updateData,
    });

    console.log(`✅ Enrollment ${id} updated to ${status} by admin`);

    // ── Send student email based on new status ─────────────
    const profile    = existing.student.studentProfile;
    const parentName = profile?.parentName || existing.student.email;
    const childName  = profile?.childName  || 'your child';
    const courseLabel = COURSE_LABELS[existing.courseType] || existing.courseType;

    if (status === 'APPROVED') {
      sendEnrollmentApproved({
        to:          existing.student.email,
        parentName,
        childName,
        courseLabel,
        applicationId: id,
      }).catch(err => console.error('⚠️  Approval email failed:', err.message));
    }

    if (status === 'REJECTED') {
      sendEnrollmentRejected({
        to:              existing.student.email,
        parentName,
        childName,
        courseLabel,
        rejectionReason: rejectionReason.trim(),
      }).catch(err => console.error('⚠️  Rejection email failed:', err.message));
    }

    return res.json({ application: updated });
  } catch (err) {
    console.error('Admin enrollment update failed:', err);
    return res.status(500).json({ error: 'Failed to update enrollment application' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/admin/enrollments
// List all applications — admin only (same secret guard).
// Query: ?status=  ?courseType=
// ─────────────────────────────────────────────────────────
router.get('/admin', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { status, courseType } = req.query;
  const where = {};
  if (status)     where.status     = status;
  if (courseType) where.courseType = courseType;

  try {
    const applications = await prisma.enrollmentRequest.findMany({
      where,
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: { parentName: true, childName: true, phone: true, country: true, timezone: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const enriched = applications.map(a => ({
      ...a,
      courseLabel: COURSE_LABELS[a.courseType] || a.courseType,
    }));

    return res.json({ applications: enriched, count: enriched.length });
  } catch (err) {
    console.error('Admin enrollment list failed:', err);
    return res.status(500).json({ error: 'Failed to fetch enrollment applications' });
  }
});

export default router;