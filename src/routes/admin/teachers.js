// src/routes/admin/teachers.js  (NEW)
//
// Teacher management. List, full profile, onboard (Clerk account +
// role TEACHER + Teacher row + userId link), edit, reassign a student's
// enrollment to a different teacher, and deactivate/reactivate.
//
// Mount in src/routes/admin/index.js:
//   import teachersRouter from './teachers.js';
//   router.use('/teachers', teachersRouter);

import express from "express";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";

const router = express.Router();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// ═════════════════════════════════════════════════════════
// GET /api/admin/teachers
// List + search + filter. Query: ?q= &active=true|false
// ═════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const { q, active } = req.query;
  const where = {};
  if (active === "true") where.isActive = true;
  if (active === "false") where.isActive = false;
  if (q && q.trim()) {
    where.OR = [
      { name: { contains: q.trim(), mode: "insensitive" } },
      { email: { contains: q.trim(), mode: "insensitive" } },
    ];
  }

  try {
    const teachers = await prisma.teacher.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        specialty: true,
        gender: true,
        timezone: true,
        rating: true,
        isActive: true,
        userId: true,
        country: true,
        _count: { select: { enrollments: true, classSessions: true } },
      },
    });

    // Active-student count = distinct students via active enrollments.
    // (_count.enrollments counts all enrollments; good enough for the list.)
    return res.json({
      teachers: teachers.map((t) => ({
        id: t.id,
        name: t.name,
        email: t.email,
        specialty: t.specialty,
        gender: t.gender,
        timezone: t.timezone,
        rating: t.rating,
        isActive: t.isActive,
        linked: !!t.userId,
        enrollments: t._count.enrollments,
        sessions: t._count.classSessions,
        country: t.country,
      })),
    });
  } catch (err) {
    console.error("Teachers list failed:", err);
    return res.status(500).json({ error: "Failed to load teachers" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /api/admin/teachers/:id
// Full profile + their active students + recent sessions.
// ═════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const teacher = await prisma.teacher.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, status: true } },
        enrollments: {
          where: { status: "ACTIVE" },
          include: {
            student: { select: { id: true, name: true, country: true } },
          },
          orderBy: { createdAt: "desc" },
        },
        classSessions: {
          orderBy: { scheduledAt: "desc" },
          take: 10,
          include: { student: { select: { name: true } } },
        },
        _count: {
          select: {
            assignments: true,
            progressReports: true,
            classSessions: true,
          },
        },
      },
    });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });
    return res.json({ teacher });
  } catch (err) {
    console.error("Teacher detail failed:", err);
    return res.status(500).json({ error: "Failed to load teacher" });
  }
});

// GET /api/admin/teachers/:id/workload
// Splits what they hold into ACTIVE (reassignable) and HISTORICAL (not).
router.get("/:id/workload", async (req, res) => {
  const { id } = req.params;
  const now = new Date();
  try {
    const teacher = await prisma.teacher.findUnique({
      where: { id },
      select: { id: true, name: true, isActive: true },
    });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });
 
    const [
      activeEnrollments, futureSessions, openAssignments, draftReports,
      pastSessions, gradedAssignments, sentReports, attendance, trials,
    ] = await Promise.all([
      prisma.enrollment.count({ where: { teacherId: id, status: { in: ["ACTIVE", "PAUSED"] } } }),
      prisma.classSession.count({ where: { teacherId: id, status: "SCHEDULED", scheduledAt: { gte: now } } }),
      prisma.assignment.count({ where: { teacherId: id, status: { not: "GRADED" } } }),
      prisma.progressReport.count({ where: { teacherId: id, status: "DRAFT" } }),
      prisma.classSession.count({ where: { teacherId: id, OR: [{ status: { not: "SCHEDULED" } }, { scheduledAt: { lt: now } }] } }),
      prisma.assignment.count({ where: { teacherId: id, status: "GRADED" } }),
      prisma.progressReport.count({ where: { teacherId: id, status: "SENT" } }),
      prisma.attendanceRecord.count({ where: { teacherId: id } }),
      prisma.trialBooking.count({ where: { teacherId: id } }),
    ]);
 
    const active = { enrollments: activeEnrollments, sessions: futureSessions, assignments: openAssignments, reports: draftReports };
    const historical = { sessions: pastSessions, assignments: gradedAssignments, reports: sentReports, attendance };
    const activeTotal = Object.values(active).reduce((a, b) => a + b, 0);
    const historicalTotal = Object.values(historical).reduce((a, b) => a + b, 0);
 
    return res.json({
      teacher, active, historical, trials,
      activeTotal, historicalTotal,
      // Deletable only when NOTHING references them at all.
      canDelete: activeTotal === 0 && historicalTotal === 0,
      reason: historicalTotal > 0
        ? "This teacher has teaching history. History is never reassigned or deleted — deactivate them instead."
        : activeTotal > 0
          ? "Reassign their active work to another teacher first."
          : null,
    });
  } catch (err) {
    console.error("Teacher workload failed:", err);
    return res.status(500).json({ error: "Failed to load workload" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/teachers
// Onboard a teacher. Creates:
//   1. Clerk user (publicMetadata.role = TEACHER)
//   2. DB User row (upsert — handles webhook race), role TEACHER
//   3. Teacher row, linked via userId
//
// Body: { email, name, specialty[] , timezone, gender, calendarId,
//         bio?, password? }
// calendarId is REQUIRED + unique (the teacher's Google Calendar ID).
// Returns the temp password once (if generated).
// ═════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  const {
    email,
    name,
    specialty,
    timezone,
    gender,
    calendarId,
    bio,
    password,
    country
  } = req.body;


  const missing = [];
  if (!email) missing.push("email");
  if (!name) missing.push("name");
  if (!timezone) missing.push("timezone");
  if (!gender) missing.push("gender");
  if (!calendarId) missing.push("calendarId");
  if (missing.length)
    return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });

  const specialtyArr = Array.isArray(specialty)
    ? specialty
    : specialty
      ? [specialty]
      : [];
  const genPassword =
    password ||
    Math.random().toString(36).slice(2, 10) +
      "A1!" +
      Math.random().toString(36).slice(2, 6);

  try {
    // Guard: calendarId must be unique
    const calClash = await prisma.teacher.findUnique({
      where: { calendarId: calendarId.trim() },
    });
    if (calClash)
      return res
        .status(409)
        .json({ error: "That calendar ID is already used by another teacher" });

    // 1) Clerk user
    let clerkUser;
    try {
      clerkUser = await clerk.users.createUser({
        emailAddress: [email.trim()],
        password: genPassword,
        publicMetadata: { role: "TEACHER" },
        firstName: name.trim().split(" ")[0],
        lastName: name.trim().split(" ").slice(1).join(" ") || undefined,
      });
    } catch (clerkErr) {
      const msg =
        clerkErr?.errors?.[0]?.message ||
        clerkErr.message ||
        "Clerk user creation failed";
      return res
        .status(409)
        .json({ error: `Could not create teacher account: ${msg}` });
    }

    // 2) DB User row (upsert — handles webhook race), role TEACHER
    const dbUser = await prisma.user.upsert({
      where: { clerkId: clerkUser.id },
      update: { role: "TEACHER", name: name.trim() },
      create: {
        clerkId: clerkUser.id,
        email: email.trim(),
        role: "TEACHER",
        name: name.trim(),
      },
    });

    // 3) Teacher row linked via userId
    const teacher = await prisma.teacher.create({
      data: {
        name: name.trim(),
        email: email.trim(),
        specialty: specialtyArr,
        timezone: timezone.trim(),
        country: country?.trim() || null,
        gender: gender.trim(),
        calendarId: calendarId.trim(),
        bio: bio?.trim() || null,
        isActive: true,
        userId: dbUser.id,
      },
    });

    await logAudit(req, {
      action: "teacher.create",
      targetType: "Teacher",
      targetId: teacher.id,
      targetLabel: teacher.name,
      metadata: { email: teacher.email, viaPanel: true },
    });

    return res.status(201).json({
      teacher,
      temporaryPassword: password ? undefined : genPassword,
    });
  } catch (err) {
    console.error("Teacher onboard failed:", err);
    return res.status(500).json({ error: "Failed to onboard teacher" });
  }
});

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/teachers/:id
// Edit profile fields. Body may include name, specialty[], timezone,
// gender, bio, rating, calendarId.
// ═════════════════════════════════════════════════════════
router.patch("/:id", async (req, res) => {
  const { id } = req.params;

  const { name, specialty, timezone, gender, bio, rating, calendarId, country } = req.body;

  try {
    const existing = await prisma.teacher.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Teacher not found" });

    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (specialty !== undefined)
      data.specialty = Array.isArray(specialty)
        ? specialty
        : [specialty].filter(Boolean);
    if (timezone !== undefined) data.timezone = timezone.trim();
    if (country !== undefined) data.country = country?.trim() || null;
    if (gender !== undefined) data.gender = gender.trim();
    if (bio !== undefined) data.bio = bio?.trim() || null;
    if (rating !== undefined) {
      const r = parseFloat(rating);
      if (isNaN(r) || r < 0 || r > 5)
        return res.status(400).json({ error: "Rating must be 0–5" });
      data.rating = r;
    }
    if (calendarId !== undefined && calendarId.trim() !== existing.calendarId) {
      const clash = await prisma.teacher.findUnique({
        where: { calendarId: calendarId.trim() },
      });
      if (clash)
        return res
          .status(409)
          .json({ error: "That calendar ID is already used" });
      data.calendarId = calendarId.trim();
    }
    if (Object.keys(data).length === 0)
      return res.status(400).json({ error: "No fields to update" });

    const updated = await prisma.teacher.update({ where: { id }, data });

    await logAudit(req, {
      action: "teacher.update",
      targetType: "Teacher",
      targetId: id,
      targetLabel: updated.name,
      metadata: { changed: Object.keys(data) },
    });

    return res.json({ teacher: updated });
  } catch (err) {
    console.error("Teacher update failed:", err);
    return res.status(500).json({ error: "Failed to update teacher" });
  }
});

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/teachers/:id/status
// Activate / deactivate. Body: { isActive: true|false }
// Deactivating blocks the teacher portal (requireTeacher checks isActive).
// ═════════════════════════════════════════════════════════
router.patch("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body;
  if (typeof isActive !== "boolean")
    return res.status(400).json({ error: "isActive must be true or false" });

  try {
    const existing = await prisma.teacher.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        isActive: true,
        _count: { select: { enrollments: true } },
      },
    });
    if (!existing) return res.status(404).json({ error: "Teacher not found" });

    // Warn (not block) if deactivating a teacher with active enrollments
    const activeEnrollments = await prisma.enrollment.count({
      where: { teacherId: id, status: "ACTIVE" },
    });

    const updated = await prisma.teacher.update({
      where: { id },
      data: { isActive },
    });

    await logAudit(req, {
      action: isActive ? "teacher.activate" : "teacher.deactivate",
      targetType: "Teacher",
      targetId: id,
      targetLabel: updated.name,
      metadata: { activeEnrollments },
    });

    return res.json({
      teacher: {
        id: updated.id,
        name: updated.name,
        isActive: updated.isActive,
      },
      activeEnrollments,
    });
  } catch (err) {
    console.error("Teacher status change failed:", err);
    return res.status(500).json({ error: "Failed to change teacher status" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/teachers/:id/reassign
// Move an enrollment (and optionally its future sessions) to another
// teacher. Body: { enrollmentId, toTeacherId, reassignSessions? }
// Used when a teacher leaves.
// ═════════════════════════════════════════════════════════

router.post("/:id/reassign", async (req, res) => {
  const { id } = req.params; // current teacher (for context/audit)
  const { enrollmentId, toTeacherId, reassignSessions } = req.body;

  if (!enrollmentId || !toTeacherId) {
    return res
      .status(400)
      .json({ error: "enrollmentId and toTeacherId are required" });
  }

  try {
    const [enrollment, toTeacher] = await Promise.all([
      prisma.enrollment.findUnique({
        where: { id: enrollmentId },
        include: {
          student: { select: { name: true } },
          teacher: { select: { name: true } },
        },
      }),
      prisma.teacher.findUnique({ where: { id: toTeacherId } }),
    ]);
    if (!enrollment)
      return res.status(404).json({ error: "Enrollment not found" });
    if (!toTeacher)
      return res.status(404).json({ error: "Target teacher not found" });
    if (enrollment.teacherId === toTeacherId)
      return res
        .status(400)
        .json({ error: "Already assigned to that teacher" });

    const fromTeacherName = enrollment.teacher?.name;

    // Repoint the enrollment
    await prisma.enrollment.update({
      where: { id: enrollmentId },
      data: { teacherId: toTeacherId },
    });

    // Optionally repoint future scheduled sessions for this enrollment
    let movedSessions = 0;
    if (reassignSessions) {
      const result = await prisma.classSession.updateMany({
        where: {
          enrollmentId,
          scheduledAt: { gte: new Date() },
          status: "SCHEDULED",
        },
        data: { teacherId: toTeacherId },
      });
      movedSessions = result.count;
    }

    await logAudit(req, {
      action: "teacher.reassign",
      targetType: "Enrollment",
      targetId: enrollmentId,
      targetLabel: enrollment.student?.name,
      metadata: { from: fromTeacherName, to: toTeacher.name, movedSessions },
    });

    return res.json({ message: "Enrollment reassigned", movedSessions });
  } catch (err) {
    console.error("Reassign failed:", err);
    return res.status(500).json({ error: "Failed to reassign" });
  }
});

// POST /api/admin/teachers/:id/reassign-all
// Body: { toTeacherId, scope: 'future' | 'all' }
//
// 'future' (default) moves only work that hasn't happened yet — enrolments,
// scheduled future sessions, ungraded assignments, draft reports.
//
// 'all' additionally rewrites COMPLETED sessions, GRADED assignments, SENT
// reports and ATTENDANCE to the new teacher. That is a falsification of
// history — it makes it look like the new teacher taught lessons they did
// not. Only use it to correct a genuine data-entry error.
router.post("/:id/reassign-all", async (req, res) => {
  const { id } = req.params;
  const { toTeacherId, scope = "future" } = req.body || {};
  const now = new Date();
 
  if (!toTeacherId) return res.status(400).json({ error: "toTeacherId is required" });
  if (toTeacherId === id) return res.status(400).json({ error: "Cannot reassign a teacher to themselves." });
  if (!["future", "all"].includes(scope)) return res.status(400).json({ error: "scope must be 'future' or 'all'" });
 
  try {
    const [from, to] = await Promise.all([
      prisma.teacher.findUnique({ where: { id }, select: { id: true, name: true } }),
      prisma.teacher.findUnique({ where: { id: toTeacherId }, select: { id: true, name: true, isActive: true } }),
    ]);
    if (!from) return res.status(404).json({ error: "Teacher not found" });
    if (!to) return res.status(404).json({ error: "Target teacher not found" });
    if (!to.isActive) return res.status(409).json({ error: "Target teacher is deactivated." });
 
    const sessionWhere = scope === "all"
      ? { teacherId: id }
      : { teacherId: id, status: "SCHEDULED", scheduledAt: { gte: now } };
    const assignmentWhere = scope === "all"
      ? { teacherId: id }
      : { teacherId: id, status: { not: "GRADED" } };
    const reportWhere = scope === "all"
      ? { teacherId: id }
      : { teacherId: id, status: "DRAFT" };
 
    const ops = [
      prisma.enrollment.updateMany({
        where: scope === "all" ? { teacherId: id } : { teacherId: id, status: { in: ["ACTIVE", "PAUSED"] } },
        data: { teacherId: toTeacherId },
      }),
      // Moving a session invalidates its calendar event: it sits on the OLD
      // teacher's calendar. Null the id and re-sync (same pattern as bulk
      // reassign in Class Sessions).
      prisma.classSession.updateMany({ where: sessionWhere, data: { teacherId: toTeacherId, calEventId: null } }),
      prisma.assignment.updateMany({ where: assignmentWhere, data: { teacherId: toTeacherId } }),
      prisma.progressReport.updateMany({ where: reportWhere, data: { teacherId: toTeacherId } }),
      prisma.trialBooking.updateMany({ where: { teacherId: id }, data: { teacherId: toTeacherId } }),
    ];
    if (scope === "all") {
      ops.push(prisma.attendanceRecord.updateMany({ where: { teacherId: id }, data: { teacherId: toTeacherId } }));
    }
 
    const results = await prisma.$transaction(ops);
    const moved = {
      enrollments: results[0].count,
      sessions: results[1].count,
      assignments: results[2].count,
      reports: results[3].count,
      trials: results[4].count,
      attendance: scope === "all" ? results[5].count : 0,
    };
 
    await logAudit(req, {
      action: scope === "all" ? "teacher.reassignAll" : "teacher.reassign",
      targetType: "Teacher",
      targetId: id,
      targetLabel: from.name,
      metadata: { to: to.name, toId: to.id, scope, moved, rewritesHistory: scope === "all" },
    });
 
    return res.json({
      reassigned: true,
      from: from.name,
      to: to.name,
      scope,
      moved,
      calendarResyncNeeded: moved.sessions > 0,
    });
  } catch (err) {
    console.error("Teacher reassign failed:", err);
    return res.status(500).json({ error: "Failed to reassign" });
  }
});

// DELETE /api/admin/teachers/:id     Body: { confirmName }
// Permitted only when the teacher holds NOTHING. Teacher FKs are RESTRICT,
// so this is enforced by the database as well as by this guard.
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const { confirmName } = req.body || {};
  try {
    const teacher = await prisma.teacher.findUnique({
      where: { id }, select: { id: true, name: true, email: true },
    });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });
    if (confirmName !== teacher.name) {
      return res.status(400).json({ error: "Confirmation name does not match. Delete aborted." });
    }
 
    const [sessions, enrollments, assignments, reports, attendance] = await Promise.all([
      prisma.classSession.count({ where: { teacherId: id } }),
      prisma.enrollment.count({ where: { teacherId: id } }),
      prisma.assignment.count({ where: { teacherId: id } }),
      prisma.progressReport.count({ where: { teacherId: id } }),
      prisma.attendanceRecord.count({ where: { teacherId: id } }),
    ]);
    const total = sessions + enrollments + assignments + reports + attendance;
    if (total > 0) {
      return res.status(409).json({
        error: "This teacher still holds records and cannot be deleted.",
        counts: { sessions, enrollments, assignments, reports, attendance },
        guidance: "Reassign their active work, then deactivate them. Teaching history is never deleted.",
      });
    }
 
    await prisma.teacher.delete({ where: { id } });
    await logAudit(req, {
      action: "teacher.delete", targetType: "Teacher", targetId: id,
      targetLabel: teacher.name, metadata: { email: teacher.email, hadNoRecords: true },
    });
    return res.json({ deleted: true });
  } catch (err) {
    console.error("Teacher delete failed:", err);
    if (err.code === "P2003") {
      return res.status(409).json({ error: "Database still holds references to this teacher." });
    }
    return res.status(500).json({ error: "Failed to delete teacher" });
  }
});

export default router;