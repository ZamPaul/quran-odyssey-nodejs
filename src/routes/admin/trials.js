// src/routes/admin/trials.js  (NEW)
//
// Trial booking management. Trials arrive with teacherId=null (assigned
// later). Admin: assign a teacher (creates a calendar event on the
// teacher's calendar + removes the universal placeholder), set zoom link,
// reschedule, cancel (deletes calendar event), convert to enrollment.
//
// Mount in src/routes/admin/index.js:
//   import trialsRouter from './trials.js';
//   router.use('/trials', trialsRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
import { createBookingEvent, deleteBookingEvent } from "../../services/googleCalendar.js";
import { sendEnrollmentApproved } from "../../services/email.js";

import {
  assertNoDuplicateEnrollment,
  isDuplicateEnrollmentDbError,
  duplicateEnrollmentMessage,
  DuplicateEnrollmentError,
} from "../../lib/enrollmentGuard.js";

const router = express.Router();

const COURSE_LABELS = { NOORANI_QAIDA: "Noorani Qaida", QURAN_RECITATION: "Quran Recitation", TAJWEED: "Tajweed", HIFZ: "Hifz", ISLAMIC_STUDIES: "Islamic Studies", ONE_TO_ONE: "One-to-One" };
const VALID_STATUSES = ["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED"];

// ═════════════════════════════════════════════════════════
// GET /api/admin/trials
// List + filter. Query: ?status= &unassigned=true
// ═════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const { status, unassigned } = req.query;
  const where = {};
  if (status && VALID_STATUSES.includes(status)) where.status = status;
  if (unassigned === "true") where.teacherId = null;

  try {
    const trials = await prisma.trialBooking.findMany({
      where, orderBy: { slotStart: "desc" },
      include: {
        student: { select: { id: true, name: true, country: true, timezone: true, account: { select: { email: true, name: true, phone: true } } } },
        teacher: { select: { id: true, name: true, calendarId: true } },
      },
    });

    const counts = {
      unassigned: await prisma.trialBooking.count({ where: { teacherId: null, status: { in: ["PENDING", "CONFIRMED"] } } }),
      pending: await prisma.trialBooking.count({ where: { status: "PENDING" } }),
      confirmed: await prisma.trialBooking.count({ where: { status: "CONFIRMED" } }),
    };

    return res.json({ trials, counts });
  } catch (err) {
    console.error("Trials list failed:", err);
    return res.status(500).json({ error: "Failed to load trials" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/trials/:id/assign
// Assign a teacher. Creates a calendar event on the teacher's calendar,
// sets status CONFIRMED. Body: { teacherId, zoomLink? }
// ═════════════════════════════════════════════════════════
router.post("/:id/assign", async (req, res) => {
  const { id } = req.params;
  const { teacherId, zoomLink } = req.body;
  if (!teacherId) return res.status(400).json({ error: "teacherId is required" });

  try {
    const trial = await prisma.trialBooking.findUnique({
      where: { id },
      include: { student: { select: { name: true, account: { select: { email: true, name: true } } } }, teacher: { select: { calendarId: true } } },
    });
    if (!trial) return res.status(404).json({ error: "Trial not found" });

    const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });

    // Create a calendar event on the assigned teacher's calendar (non-fatal)
    let calEventId = trial.calEventId;
    try {
      const slotEnd = new Date(new Date(trial.slotStart).getTime() + trial.durationMins * 60 * 1000);
      const newEventId = await createBookingEvent({
        calendarId: teacher.calendarId,
        slotStart: new Date(trial.slotStart).toISOString(),
        slotEnd: slotEnd.toISOString(),
        studentName: trial.student.name,
        parentName: trial.student.account.name || trial.student.account.email,
        courseInterest: trial.courseInterest,
        studentEmail: trial.student.account.email,
      });
      calEventId = newEventId;
    } catch (calErr) {
      console.error("⚠️  Calendar event creation failed (assignment still saved):", calErr.message);
      console.log("error while moving event from universal to teacher:", calErr)
    }

    const updated = await prisma.trialBooking.update({
      where: { id },
      data: { teacherId, status: "CONFIRMED", calEventId, ...(zoomLink !== undefined ? { zoomLink: zoomLink?.trim() || null } : {}) },
    });

    await logAudit(req, {
      action: "trial.assign", targetType: "TrialBooking", targetId: id,
      targetLabel: trial.student.name, metadata: { teacher: teacher.name },
    });

    return res.json({ trial: updated });
  } catch (err) {
    console.error("Trial assign failed:", err);
    return res.status(500).json({ error: "Failed to assign trial" });
  }
});

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/trials/:id
// Set/update zoom link or reschedule the slot.
// Body: { zoomLink?, slotStart? }
// ═════════════════════════════════════════════════════════
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { zoomLink, slotStart } = req.body;

  try {
    const trial = await prisma.trialBooking.findUnique({ where: { id }, include: { student: { select: { name: true } } } });
    if (!trial) return res.status(404).json({ error: "Trial not found" });

    const data = {};
    if (zoomLink !== undefined) data.zoomLink = zoomLink?.trim() || null;
    if (slotStart !== undefined) {
      const d = new Date(slotStart);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid slotStart" });
      data.slotStart = d;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "No fields to update" });

    const updated = await prisma.trialBooking.update({ where: { id }, data });

    await logAudit(req, {
      action: slotStart !== undefined ? "trial.reschedule" : "trial.update",
      targetType: "TrialBooking", targetId: id, targetLabel: trial.student.name,
      metadata: { changed: Object.keys(data) },
    });

    return res.json({ trial: updated });
  } catch (err) {
    console.error("Trial update failed:", err);
    return res.status(500).json({ error: "Failed to update trial" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/trials/:id/cancel
// Cancel a trial. Deletes its calendar event.
// ═════════════════════════════════════════════════════════
router.post("/:id/cancel", async (req, res) => {
  const { id } = req.params;
  try {
    const trial = await prisma.trialBooking.findUnique({
      where: { id },
      include: { student: { select: { name: true } }, teacher: { select: { calendarId: true } } },
    });
    if (!trial) return res.status(404).json({ error: "Trial not found" });

    // Delete the calendar event (best-effort). Use the teacher's calendar if
    // assigned, else the universal one.
    if (trial.calEventId) {
      const calId = trial.teacher?.calendarId || process.env.UNIVERSAL_CALENDAR_ID;
      try { await deleteBookingEvent(calId, trial.calEventId); }
      catch (e) { console.error("⚠️  Calendar delete failed:", e.message); }
    }

    const updated = await prisma.trialBooking.update({ where: { id }, data: { status: "CANCELLED" } });

    await logAudit(req, {
      action: "trial.cancel", targetType: "TrialBooking", targetId: id, targetLabel: trial.student.name,
    });

    return res.json({ trial: updated });
  } catch (err) {
    console.error("Trial cancel failed:", err);
    return res.status(500).json({ error: "Failed to cancel trial" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/trials/:id/convert
// Convert a completed/confirmed trial into an Enrollment.
// Body: { courseType?, sessionsPerWeek?, startDate?, notes? }
// Uses the trial's teacher + course unless overridden.
// ═════════════════════════════════════════════════════════
router.post("/:id/convert", async (req, res) => {
  const { id } = req.params;
  const { courseType, sessionsPerWeek, startDate, notes } = req.body;

  try {
    const trial = await prisma.trialBooking.findUnique({
      where: { id },
      include: { student: { select: { id: true, name: true, account: { select: { email: true, name: true } } } }, teacher: true },
    });
    if (!trial) return res.status(404).json({ error: "Trial not found" });
    if (!trial.teacherId) return res.status(400).json({ error: "Assign a teacher before converting" });

    const effectiveCourse = courseType || trial.courseInterest;
    try {
      await assertNoDuplicateEnrollment({
        studentId: trial.student.id,
        courseType: effectiveCourse,
        teacherId: trial.teacherId,
      });
    } catch (e) {
      if (e instanceof DuplicateEnrollmentError) {
        return res.status(409).json({ error: e.message });
      }
      throw e;
    }

    let enrollment;
    try {
      enrollment = await prisma.enrollment.create({
        data: {
          studentId: trial.student.id, teacherId: trial.teacherId,
          courseType: effectiveCourse,
          sessionsPerWeek: sessionsPerWeek ? parseInt(sessionsPerWeek, 10) : 2,
          startDate: startDate ? new Date(startDate) : new Date(),
          status: "ACTIVE", notes: notes?.trim() || null,
        },
      });
    } catch (e) {
      if (isDuplicateEnrollmentDbError(e)) {
        return res.status(409).json({ error: duplicateEnrollmentMessage() });
      }
      throw e;
    }

    // const enrollment = await prisma.enrollment.create({
    //   data: {
    //     studentId: trial.student.id, teacherId: trial.teacherId,
    //     courseType: courseType || trial.courseInterest,
    //     sessionsPerWeek: sessionsPerWeek ? parseInt(sessionsPerWeek, 10) : 2,
    //     startDate: startDate ? new Date(startDate) : new Date(),
    //     status: "ACTIVE", notes: notes?.trim() || null,
    //   },
    // });

    // Mark the trial completed
    await prisma.trialBooking.update({ where: { id }, data: { status: "COMPLETED" } });

    await logAudit(req, {
      action: "trial.convert", targetType: "Enrollment", targetId: enrollment.id,
      targetLabel: trial.student.name, metadata: { fromTrial: id, teacher: trial.teacher?.name },
    });

    sendEnrollmentApproved({
      to: trial.student.account.email,
      parentName: trial.student.account.name || "Parent",
      childName: trial.student.name,
      courseLabel: COURSE_LABELS[courseType || trial.courseInterest] || (courseType || trial.courseInterest),
      applicationId: enrollment.id,
    }).catch((e) => console.error("⚠️  Email failed:", e.message));

    return res.status(201).json({ enrollment });
  } catch (err) {
    console.error("Trial convert failed:", err);
    return res.status(500).json({ error: "Failed to convert trial" });
  }
});

// Teachers list for the assign/convert dropdowns
router.get("/meta/teachers", async (req, res) => {
  try {
    const teachers = await prisma.teacher.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, specialty: true, gender: true } });
    return res.json({ teachers });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load teachers" });
  }
});

export default router;