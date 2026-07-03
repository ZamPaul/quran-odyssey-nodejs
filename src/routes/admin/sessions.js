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
import { generateOccurrences, overlaps } from "../../lib/sessionSchedule.js";

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

router.get("/meta/enrollments", async (req, res) => {
  const { studentId } = req.query;
  if (!studentId) return res.status(400).json({ error: "studentId is required" });
  try {
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId, status: { in: ["ACTIVE", "PAUSED"] } },
      orderBy: { createdAt: "desc" },
      include: { teacher: { select: { id: true, name: true, calendarId: true } } },
    });
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, timezone: true, account: { select: { email: true, name: true } } },
    });
    if (!student) return res.status(404).json({ error: "Student not found" });
    return res.json({ student, enrollments });
  } catch (err) {
    console.error("Enrollments meta failed:", err);
    return res.status(500).json({ error: "Failed to load enrollments" });
  }
});
 
// Shared: build + validate the config, generate occurrences, tag clashes.
async function buildBulkPlan(body) {
  const { enrollmentId, days, startDate, endDate, blackout } = body;
 
  if (!enrollmentId) throw { status: 400, msg: "enrollmentId is required" };
  if (!Array.isArray(days) || days.length === 0) throw { status: 400, msg: "Pick at least one weekday" };
  if (!startDate || !endDate) throw { status: 400, msg: "startDate and endDate are required" };
  if (endDate < startDate) throw { status: 400, msg: "endDate must be on or after startDate" };
 
  for (const d of days) {
    if (d.weekday == null || !/^\d{2}:\d{2}$/.test(d.startTime || "") || !d.durationMins) {
      throw { status: 400, msg: "Each day needs weekday, startTime (HH:MM), durationMins" };
    }
  }
 
  const enrollment = await prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      teacher: { select: { id: true, name: true, calendarId: true } },
      student: { select: { id: true, name: true, timezone: true, account: { select: { email: true, name: true } } } },
    },
  });
  if (!enrollment) throw { status: 404, msg: "Enrollment not found" };
 
  const timeZone = enrollment.student.timezone || "UTC";
 
  // Generate the wall-clock-correct occurrences in the student's zone.
  const occ = generateOccurrences({ startDate, endDate, timeZone, days, blackout: blackout || [] });
 
  if (occ.length === 0) {
    return { enrollment, timeZone, plan: [], summary: { total: 0, willCreate: 0, blackout: 0, conflict: 0 } };
  }
 
  // Fetch existing sessions in range for BOTH this student and this teacher,
  // to detect double-booking either side.
  const rangeStart = occ[0].startUtc;
  const rangeEnd = occ[occ.length - 1].endUtc;
  const existing = await prisma.classSession.findMany({
    where: {
      status: { in: ["SCHEDULED", "COMPLETED"] },
      scheduledAt: { gte: new Date(rangeStart.getTime() - 86400000), lte: new Date(rangeEnd.getTime() + 86400000) },
      OR: [{ studentId: enrollment.student.id }, { teacherId: enrollment.teacher.id }],
    },
    select: { id: true, studentId: true, teacherId: true, scheduledAt: true, durationMins: true },
  });
 
  const plan = occ.map((o) => {
    let status = "ok";
    let reason = null;
    if (o.blackout) { status = "blackout"; reason = "Blackout date"; }
    else {
      for (const ex of existing) {
        const exStart = new Date(ex.scheduledAt);
        const exEnd = new Date(exStart.getTime() + (ex.durationMins || 30) * 60000);
        if (overlaps(o.startUtc, o.endUtc, exStart, exEnd)) {
          const who = ex.studentId === enrollment.student.id ? "student" : "teacher";
          status = "conflict"; reason = `Overlaps an existing ${who} session`; break;
        }
      }
    }
    return {
      dateISO: o.dateISO, weekday: o.weekday,
      startUtc: o.startUtc.toISOString(), endUtc: o.endUtc.toISOString(),
      durationMins: o.durationMins, status, reason,
    };
  });
 
  const summary = {
    total: plan.length,
    willCreate: plan.filter((p) => p.status === "ok").length,
    blackout: plan.filter((p) => p.status === "blackout").length,
    conflict: plan.filter((p) => p.status === "conflict").length,
  };
 
  // sessionsPerWeek sanity (non-blocking warning)
  const chosenPerWeek = new Set(days.map((d) => d.weekday)).size;
  const warning =
    enrollment.sessionsPerWeek && chosenPerWeek !== enrollment.sessionsPerWeek
      ? `This enrolment is ${enrollment.sessionsPerWeek}×/week, but you selected ${chosenPerWeek} day(s).`
      : null;
 
  return { enrollment, timeZone, plan, summary, warning };
}

// ─────────────────────────────────────────────────────────
// POST /api/admin/sessions/bulk/preview
// Body: { enrollmentId, days:[{weekday,startTime,durationMins}],
//         startDate, endDate, blackout:[] }
// Returns the full plan with per-occurrence status. Writes NOTHING.
// ─────────────────────────────────────────────────────────
router.post("/bulk/preview", async (req, res) => {
  try {
    const { enrollment, timeZone, plan, summary, warning } = await buildBulkPlan(req.body);
    return res.json({
      timeZone,
      student: { id: enrollment.student.id, name: enrollment.student.name },
      teacher: { id: enrollment.teacher.id, name: enrollment.teacher.name },
      courseType: enrollment.courseType,
      plan, summary, warning,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.msg });
    console.error("Bulk preview failed:", e);
    return res.status(500).json({ error: "Failed to preview sessions" });
  }
});
 
// ─────────────────────────────────────────────────────────
// POST /api/admin/sessions/bulk/commit
// Same body as preview. Re-generates + re-checks clashes server-side
// (never trusts client instants), inserts ONLY 'ok' occurrences in a
// transaction. Calendar events are NOT created here (use /sync-calendar).
// Returns created session IDs + skipped summary.
// ─────────────────────────────────────────────────────────
router.post("/bulk/commit", async (req, res) => {
  try {
    const { enrollment, plan, summary, warning } = await buildBulkPlan(req.body);
    const toCreate = plan.filter((p) => p.status === "ok");
    if (toCreate.length === 0) {
      return res.status(409).json({ error: "Nothing to create — all occurrences were blackout or conflicts.", summary });
    }
 
    const created = await prisma.$transaction(
      toCreate.map((p) =>
        prisma.classSession.create({
          data: {
            teacherId: enrollment.teacher.id,
            studentId: enrollment.student.id,
            enrollmentId: enrollment.id,
            courseType: enrollment.courseType,
            scheduledAt: new Date(p.startUtc),
            durationMins: p.durationMins,
            status: "SCHEDULED",
            calEventId: null, // synced separately
          },
          select: { id: true, scheduledAt: true },
        })
      )
    );
 
    await logAudit(req, {
      action: "session.bulkCreate", targetType: "Enrollment", targetId: enrollment.id,
      targetLabel: enrollment.student.name,
      metadata: { created: created.length, skipped: summary.total - created.length, teacher: enrollment.teacher.name },
    });
 
    return res.status(201).json({
      createdCount: created.length,
      createdIds: created.map((c) => c.id),
      skipped: { blackout: summary.blackout, conflict: summary.conflict },
      warning,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.msg });
    console.error("Bulk commit failed:", e);
    return res.status(500).json({ error: "Failed to create sessions" });
  }
});
 
// ─────────────────────────────────────────────────────────
// POST /api/admin/sessions/sync-calendar
// Body: { sessionIds: [] }
// Creates Google Calendar events for the given sessions that don't have
// one yet. Best-effort, per-session result reporting. This is the admin's
// explicit "sync" action — NOT automatic.
// ─────────────────────────────────────────────────────────
router.post("/sync-calendar", async (req, res) => {
  const { sessionIds } = req.body;
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return res.status(400).json({ error: "sessionIds array is required" });
  }
  // Bound the batch to avoid a runaway request.
  if (sessionIds.length > 60) {
    return res.status(400).json({ error: "Sync at most 60 sessions at a time." });
  }
 
  try {
    const sessions = await prisma.classSession.findMany({
      where: { id: { in: sessionIds } },
      include: {
        teacher: { select: { calendarId: true, name: true } },
        student: { select: { name: true, account: { select: { email: true, name: true } } } },
      },
    });
 
    const results = [];
    for (const s of sessions) {
      if (s.calEventId) { results.push({ id: s.id, status: "already-synced" }); continue; }
      try {
        const slotEnd = new Date(new Date(s.scheduledAt).getTime() + s.durationMins * 60000);
        const eventId = await createBookingEvent({
          calendarId: s.teacher.calendarId,
          slotStart: new Date(s.scheduledAt).toISOString(),
          slotEnd: slotEnd.toISOString(),
          studentName: s.student.name,
          parentName: s.student.account.name || s.student.account.email,
          courseInterest: s.courseType,
          studentEmail: s.student.account.email,
        });
        await prisma.classSession.update({ where: { id: s.id }, data: { calEventId: eventId } });
        results.push({ id: s.id, status: "synced" });
      } catch (calErr) {
        console.error(`⚠️  Calendar sync failed for ${s.id}:`, calErr.message);
        results.push({ id: s.id, status: "failed", error: calErr.message });
      }
    }
 
    const synced = results.filter((r) => r.status === "synced").length;
    const failed = results.filter((r) => r.status === "failed").length;
 
    await logAudit(req, {
      action: "session.syncCalendar", targetType: "ClassSession", targetId: null,
      targetLabel: `${synced} synced`, metadata: { synced, failed, total: sessions.length },
    });
 
    return res.json({ synced, failed, alreadySynced: results.filter(r => r.status === "already-synced").length, results });
  } catch (err) {
    console.error("Calendar sync failed:", err);
    return res.status(500).json({ error: "Failed to sync calendar" });
  }
});

export default router;