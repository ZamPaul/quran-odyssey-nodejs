// src/routes/admin/sessions.js  (NEW)
//
// Cross-teacher class session oversight. List/filter all sessions across
// every teacher, create a session manually (with a calendar event on the
// teacher's calendar per decision #5), reschedule, cancel (removes the
// calendar event), and reassign to a different teacher.
//
// Mount in src/routes/admin/index.js:
//   import sessionsRouter from './sessions.js';
//   router.use('/sessions', sessionsRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
import { createBookingEvent, deleteBookingEvent } from "../../services/googleCalendar.js";

const router = express.Router();

const VALID_COURSES = ["NOORANI_QAIDA", "QURAN_RECITATION", "TAJWEED", "HIFZ", "ISLAMIC_STUDIES", "ONE_TO_ONE"];
const VALID_STATUSES = ["SCHEDULED", "COMPLETED", "CANCELLED", "MISSED"];

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

// ═════════════════════════════════════════════════════════
// GET /api/admin/sessions
// List + filter. Query: ?from= &to= &teacherId= &studentId= &status=
// Defaults to a 14-day window around today if no range given.
// ═════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const { from, to, teacherId, studentId, status } = req.query;

  const where = {};
  if (teacherId) where.teacherId = teacherId;
  if (studentId) where.studentId = studentId;
  if (status && VALID_STATUSES.includes(status)) where.status = status;

  if (from || to) {
    where.scheduledAt = {};
    if (from) where.scheduledAt.gte = startOfDay(from);
    if (to) where.scheduledAt.lte = endOfDay(to);
  } else {
    // default: 7 days back → 7 days forward
    const lo = new Date(); lo.setDate(lo.getDate() - 7);
    const hi = new Date(); hi.setDate(hi.getDate() + 7);
    where.scheduledAt = { gte: startOfDay(lo), lte: endOfDay(hi) };
  }

  try {
    const sessions = await prisma.classSession.findMany({
      where,
      orderBy: { scheduledAt: "asc" },
      include: {
        teacher: { select: { id: true, name: true, calendarId: true } },
        student: { select: { id: true, name: true, account: { select: { email: true } } } },
        attendance: { select: { status: true } },
      },
    });
    return res.json({ sessions, count: sessions.length });
  } catch (err) {
    console.error("Sessions list failed:", err);
    return res.status(500).json({ error: "Failed to load sessions" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/sessions
// Manually create a session. Fires a calendar event on the teacher's
// calendar (decision #5). Body: { teacherId, studentId, courseType,
// scheduledAt, durationMins?, zoomLink?, enrollmentId? }
// ═════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  const { teacherId, studentId, courseType, scheduledAt, durationMins, zoomLink, enrollmentId } = req.body;

  const missing = [];
  if (!teacherId) missing.push("teacherId");
  if (!studentId) missing.push("studentId");
  if (!courseType) missing.push("courseType");
  if (!scheduledAt) missing.push("scheduledAt");
  if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });
  if (!VALID_COURSES.includes(courseType)) return res.status(400).json({ error: "Invalid courseType" });

  const when = new Date(scheduledAt);
  if (isNaN(when.getTime())) return res.status(400).json({ error: "Invalid scheduledAt" });
  const dur = durationMins ? parseInt(durationMins, 10) : 30;

  try {
    const [teacher, student] = await Promise.all([
      prisma.teacher.findUnique({ where: { id: teacherId } }),
      prisma.student.findUnique({ where: { id: studentId }, include: { account: { select: { email: true, name: true } } } }),
    ]);
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });
    if (!student) return res.status(404).json({ error: "Student not found" });

    // If enrollmentId given, validate it belongs to this student+teacher
    if (enrollmentId) {
      const enr = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
      if (!enr || enr.studentId !== studentId) {
        return res.status(400).json({ error: "enrollmentId does not match this student" });
      }
    }

    // Calendar event on the teacher's calendar (non-fatal)
    let calEventId = null;
    try {
      const slotEnd = new Date(when.getTime() + dur * 60 * 1000);
      calEventId = await createBookingEvent({
        calendarId: teacher.calendarId,
        slotStart: when.toISOString(),
        slotEnd: slotEnd.toISOString(),
        studentName: student.name,
        parentName: student.account.name || student.account.email,
        courseInterest: courseType,
        studentEmail: student.account.email,
      });
    } catch (calErr) {
      console.error("⚠️  Calendar event creation failed (session still created):", calErr.message);
    }

    const session = await prisma.classSession.create({
      data: {
        teacherId, studentId, courseType, scheduledAt: when, durationMins: dur,
        zoomLink: zoomLink?.trim() || null, enrollmentId: enrollmentId || null,
        status: "SCHEDULED", calEventId,
      },
    });

    await logAudit(req, {
      action: "session.create", targetType: "ClassSession", targetId: session.id,
      targetLabel: student.name, metadata: { teacher: teacher.name, scheduledAt: when.toISOString() },
    });

    return res.status(201).json({ session });
  } catch (err) {
    console.error("Session create failed:", err);
    return res.status(500).json({ error: "Failed to create session" });
  }
});

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/sessions/:id
// Edit: reschedule (scheduledAt), zoomLink, status, teacherNotes.
// ═════════════════════════════════════════════════════════
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { scheduledAt, zoomLink, status, teacherNotes, durationMins } = req.body;

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. One of: ${VALID_STATUSES.join(", ")}` });
  }

  try {
    const existing = await prisma.classSession.findUnique({ where: { id }, include: { student: { select: { name: true } } } });
    if (!existing) return res.status(404).json({ error: "Session not found" });

    const data = {};
    if (zoomLink !== undefined) data.zoomLink = zoomLink?.trim() || null;
    if (status !== undefined) data.status = status;
    if (teacherNotes !== undefined) data.teacherNotes = teacherNotes?.trim() || null;
    if (durationMins !== undefined) data.durationMins = parseInt(durationMins, 10);
    if (scheduledAt !== undefined) {
      const when = new Date(scheduledAt);
      if (isNaN(when.getTime())) return res.status(400).json({ error: "Invalid scheduledAt" });
      data.scheduledAt = when;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "No fields to update" });

    const updated = await prisma.classSession.update({ where: { id }, data });

    await logAudit(req, {
      action: scheduledAt !== undefined ? "session.reschedule" : "session.update",
      targetType: "ClassSession", targetId: id, targetLabel: existing.student.name,
      metadata: { changed: Object.keys(data) },
    });

    return res.json({ session: updated });
  } catch (err) {
    console.error("Session update failed:", err);
    return res.status(500).json({ error: "Failed to update session" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/sessions/:id/cancel
// Cancel a session; removes its calendar event.
// ═════════════════════════════════════════════════════════
router.post("/:id/cancel", async (req, res) => {
  const { id } = req.params;
  try {
    const session = await prisma.classSession.findUnique({
      where: { id },
      include: { student: { select: { name: true } }, teacher: { select: { calendarId: true } } },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (session.calEventId && session.teacher?.calendarId) {
      try { await deleteBookingEvent(session.teacher.calendarId, session.calEventId); }
      catch (e) { console.error("⚠️  Calendar delete failed:", e.message); }
    }

    const updated = await prisma.classSession.update({ where: { id }, data: { status: "CANCELLED" } });

    await logAudit(req, {
      action: "session.cancel", targetType: "ClassSession", targetId: id, targetLabel: session.student.name,
    });

    return res.json({ session: updated });
  } catch (err) {
    console.error("Session cancel failed:", err);
    return res.status(500).json({ error: "Failed to cancel session" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/sessions/:id/reassign
// Move a single session to a different teacher. Body: { toTeacherId }
// Recreates the calendar event on the new teacher's calendar.
// ═════════════════════════════════════════════════════════
router.post("/:id/reassign", async (req, res) => {
  const { id } = req.params;
  const { toTeacherId } = req.body;
  if (!toTeacherId) return res.status(400).json({ error: "toTeacherId is required" });

  try {
    const session = await prisma.classSession.findUnique({
      where: { id },
      include: {
        student: { select: { name: true, account: { select: { email: true, name: true } } } },
        teacher: { select: { name: true, calendarId: true } },
      },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.teacherId === toTeacherId) return res.status(400).json({ error: "Already assigned to that teacher" });

    const toTeacher = await prisma.teacher.findUnique({ where: { id: toTeacherId } });
    if (!toTeacher) return res.status(404).json({ error: "Target teacher not found" });

    // Remove old calendar event, create a new one on the new teacher's calendar
    if (session.calEventId && session.teacher?.calendarId) {
      try { await deleteBookingEvent(session.teacher.calendarId, session.calEventId); }
      catch (e) { console.error("⚠️  Old calendar delete failed:", e.message); }
    }

    let newCalEventId = null;
    
    try {
      const slotEnd = new Date(new Date(session.scheduledAt).getTime() + session.durationMins * 60 * 1000);
      newCalEventId = await createBookingEvent({
        calendarId: toTeacher.calendarId,
        slotStart: new Date(session.scheduledAt).toISOString(),
        slotEnd: slotEnd.toISOString(),
        studentName: session.student.name,
        parentName: session.student.account.name || session.student.account.email,
        courseInterest: session.courseType,
        studentEmail: session.student.account.email,
      });
    } catch (e) { console.error("⚠️  New calendar event failed:", e.message); }

    const updated = await prisma.classSession.update({
      where: { id }, data: { teacherId: toTeacherId, calEventId: newCalEventId },
    });

    await logAudit(req, {
      action: "session.reassign", targetType: "ClassSession", targetId: id, targetLabel: session.student.name,
      metadata: { from: session.teacher?.name, to: toTeacher.name },
    });

    return res.json({ session: updated });
  } catch (err) {
    console.error("Session reassign failed:", err);
    return res.status(500).json({ error: "Failed to reassign session" });
  }
});

// Meta endpoints for the create modal
router.get("/meta/teachers", async (req, res) => {
  try {
    const teachers = await prisma.teacher.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
    return res.json({ teachers });
  } catch (err) { return res.status(500).json({ error: "Failed to load teachers" }); }
});

router.get("/meta/students", async (req, res) => {
  const { q } = req.query;
  try {
    const where = {};
    if (q && q.trim()) where.name = { contains: q.trim(), mode: "insensitive" };
    const students = await prisma.student.findMany({
      where, orderBy: { name: "asc" }, take: 20,
      select: { id: true, name: true, courseInterest: true, account: { select: { email: true } }, enrollments: { where: { status: "ACTIVE" }, select: { id: true, teacherId: true, courseType: true } } },
    });
    return res.json({ students });
  } catch (err) { return res.status(500).json({ error: "Failed to load students" }); }
});

export default router;