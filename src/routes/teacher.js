// src/routes/teacher.js
import express from 'express';
import {prisma} from '../lib/prisma.js';
import { requireTeacher } from '../middleware/teacherAuth.js';
import { sendProgressReport } from '../services/email.js';

// At the top of teacher.js, add:
import {
  cleanStr,
  requireStr,
  cleanInt,
  cleanFutureDate,
  requireEnum,
  optionalEnum,
  collect,
} from '../middleware/sanitize.js';

import {
  writeLimiter,
  heavyLimiter,
} from '../middleware/rateLimiter.js';

const router = express.Router();

// Apply requireTeacher to ALL routes in this file
router.use(requireTeacher);

// ─────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────

// Returns start/end of today in UTC
function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// Returns start/end of the current week (Mon–Sun)
function getWeekRange() {
  const now   = new Date();
  const day   = now.getDay(); // 0 = Sunday
  const diff  = day === 0 ? -6 : 1 - day; // shift to Monday
  const start = new Date(now);
  start.setDate(now.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// Calculates attendance percentage from an array of AttendanceRecords
function calcAttendancePercentage(records) {
  if (!records || records.length === 0) return 0;
  const attended = records.filter(r =>
    r.status === 'PRESENT' || r.status === 'LATE'
  ).length;
  return Math.round((attended / records.length) * 100);
}

// Student select shape — reused across multiple queries
const studentSelect = {
  id:    true,
  email: true,
  studentProfile: {
    select: {
      childName:  true,
      parentName: true,
      timezone:   true,
      phone:      true,
      childAge:   true,
      country:    true,
      courseInterest: true,
    },
  },
};

// Session include shape — reused across multiple queries
const sessionInclude = {
  student: { select: studentSelect },
  enrollment: {
    select: {
      id:             true,
      courseType:     true,
      sessionsPerWeek:true,
      status:         true,
    },
  },
  attendance: {
    select: {
      id:       true,
      status:   true,
      notes:    true,
      markedAt: true,
    },
  },
};

// ─────────────────────────────────────────────────────────
// GET /api/teacher/me
// Returns the authenticated teacher's profile
// ─────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  return res.json({
    user: {
      id:    req.user.id,
      email: req.user.email,
      role:  req.user.role,
    },
    teacher: {
      id:        req.teacher.id,
      name:      req.teacher.name,
      email:     req.teacher.email,
      specialty: req.teacher.specialty,
      timezone:  req.teacher.timezone,
      gender:    req.teacher.gender,
      bio:       req.teacher.bio,
      rating:    req.teacher.rating,
      isActive:  req.teacher.isActive,
    },
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/dashboard
// Returns overview stats + today's and upcoming sessions
// ─────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const teacherId = req.teacher.id;
  const today     = getTodayRange();
  const week      = getWeekRange();

  try {
    // Run all queries in parallel — never sequentially for a dashboard
    const [
      todaySessions,
      upcomingSessions,
      enrollments,
      sessionsThisWeek,
      pendingAssignments,
      draftReports,
    ] = await Promise.all([

      // Today's sessions — ordered by time
      prisma.classSession.findMany({
        where: {
          teacherId,
          scheduledAt: { gte: today.start, lte: today.end },
        },
        include:  sessionInclude,
        orderBy:  { scheduledAt: 'asc' },
      }),

      // Upcoming sessions — next 7 days, excluding today, max 5
      prisma.classSession.findMany({
        where: {
          teacherId,
          scheduledAt: {
            gt: today.end,
            lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
          status: 'SCHEDULED',
        },
        include:  sessionInclude,
        orderBy:  { scheduledAt: 'asc' },
        take:     5,
      }),

      // Active enrollments — for student count
      prisma.enrollment.findMany({
        where:  { teacherId, status: 'ACTIVE' },
        select: { studentId: true },
      }),

      // Sessions this week count
      prisma.classSession.count({
        where: {
          teacherId,
          scheduledAt: { gte: week.start, lte: week.end },
        },
      }),

      // Pending + overdue assignments count
      prisma.assignment.count({
        where: {
          teacherId,
          status: { in: ['PENDING', 'OVERDUE'] },
        },
      }),

      // Draft progress reports count
      prisma.progressReport.count({
        where: { teacherId, status: 'DRAFT' },
      }),
    ]);

    // Unique student count from enrollments
    const totalStudents = new Set(enrollments.map(e => e.studentId)).size;

    return res.json({
      todaySessions,
      upcomingSessions,
      stats: {
        totalStudents,
        sessionsThisWeek,
        pendingAssignments,
        draftReports,
      },
    });
  } catch (err) {
    console.error('Dashboard fetch failed:', err);
    return res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/sessions
// Returns all sessions for this teacher
// Query: ?status= ?from= ?to= ?studentId=
// ─────────────────────────────────────────────────────────
router.get('/sessions', async (req, res) => {
  const { status, from, to, studentId } = req.query;

  // Validate status if provided
  const validStatuses = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'MISSED'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    });
  }

  // Build where clause
  const where = { teacherId: req.teacher.id };
  if (status)    where.status    = status;
  if (studentId) where.studentId = studentId;
  if (from || to) {
    where.scheduledAt = {};
    if (from) where.scheduledAt.gte = new Date(from);
    if (to)   where.scheduledAt.lte = new Date(to);
  }

  try {
    const sessions = await prisma.classSession.findMany({
      where,
      include:  sessionInclude,
      orderBy:  { scheduledAt: 'asc' },
    });

    return res.json({ sessions, count: sessions.length });
  } catch (err) {
    console.error('Sessions fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/sessions/:id
// Returns a single session with full details
// ─────────────────────────────────────────────────────────
router.get('/sessions/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const session = await prisma.classSession.findUnique({
      where:   { id },
      include: sessionInclude,
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Ensure teacher only sees their own sessions
    if (session.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({ session });
  } catch (err) {
    console.error('Session fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/teacher/sessions/:id
// Update session: status, zoomLink, teacherNotes
// ─────────────────────────────────────────────────────────
router.patch('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const { status, zoomLink, teacherNotes } = req.body;

  // Validate at least one field is being updated
  if (!status && zoomLink === undefined && teacherNotes === undefined) {
    return res.status(400).json({
      error: 'Provide at least one field to update: status, zoomLink, or teacherNotes',
    });
  }

  // Validate status if provided
  const validStatuses = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'MISSED'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    });
  }

  try {
    // Verify session belongs to this teacher
    const existing = await prisma.classSession.findUnique({
      where: { id },
    });

    if (!existing || existing.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Build update data
    const updateData = {};
    if (status !== undefined)       updateData.status       = status;
    if (zoomLink !== undefined)     updateData.zoomLink     = zoomLink || null;
    if (teacherNotes !== undefined) updateData.teacherNotes = teacherNotes || null;

    const updated = await prisma.classSession.update({
      where:   { id },
      data:    updateData,
      include: sessionInclude,
    });

    console.log(`✅ Session ${id} updated — status: ${updated.status}`);
    return res.json({ session: updated });
  } catch (err) {
    console.error('Session update failed:', err);
    return res.status(500).json({ error: 'Failed to update session' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/enrollments
// Returns all enrollments for this teacher
// Query: ?status= (default: ACTIVE)
// ─────────────────────────────────────────────────────────
router.get('/enrollments', async (req, res) => {
  const { status } = req.query;

  const validStatuses = ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    });
  }

  try {
    const enrollments = await prisma.enrollment.findMany({
      where: {
        teacherId: req.teacher.id,
        status:    status || 'ACTIVE',
      },
      include: {
        student: { select: studentSelect },
      },
      orderBy: { startDate: 'desc' },
    });

    return res.json({ enrollments, count: enrollments.length });
  } catch (err) {
    console.error('Enrollments fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/students
// Returns all students linked to this teacher via enrollments
// Query: ?status= (enrollment status, default: ACTIVE)
// ─────────────────────────────────────────────────────────
router.get('/students', async (req, res) => {
  const { status } = req.query;

  try {
    const enrollments = await prisma.enrollment.findMany({
      where: {
        teacherId: req.teacher.id,
        status:    status || 'ACTIVE',
      },
      include: {
        student: {
          select: {
            ...studentSelect,
            attendanceRecords: {
              where:  { teacherId: req.teacher.id },
              select: { status: true },
            },
          },
        },
      },
      orderBy: { startDate: 'desc' },
    });

    // Shape the response — combine student + enrollment + attendance %
    const students = enrollments.map(enrollment => ({
      enrollment: {
        id:              enrollment.id,
        courseType:      enrollment.courseType,
        status:          enrollment.status,
        startDate:       enrollment.startDate,
        sessionsPerWeek: enrollment.sessionsPerWeek,
      },
      student: {
        id:      enrollment.student.id,
        email:   enrollment.student.email,
        profile: enrollment.student.studentProfile,
        attendancePercentage: calcAttendancePercentage(
          enrollment.student.attendanceRecords
        ),
      },
    }));

    return res.json({ students, count: students.length });
  } catch (err) {
    console.error('Students fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/students/:id
// Returns a single student's full data for this teacher
// Includes: profile, enrollment, sessions, assignments,
//           progress reports, attendance history
// ─────────────────────────────────────────────────────────
router.get('/students/:id', async (req, res) => {
  const { id } = req.params;
  const teacherId = req.teacher.id;

  try {
    // First verify this student is enrolled with this teacher
    const enrollment = await prisma.enrollment.findFirst({
      where: { teacherId, studentId: id },
    });

    if (!enrollment) {
      // Return 404 — don't reveal the student exists to a different teacher
      return res.status(404).json({ error: 'Student not found' });
    }

    // Fetch full student data in parallel
    const [student, sessions, assignments, reports, attendanceRecords] =
      await Promise.all([

        // Student profile
        prisma.user.findUnique({
          where:  { id },
          select: studentSelect,
        }),

        // Sessions with this teacher
        prisma.classSession.findMany({
          where:   { teacherId, studentId: id },
          include: { attendance: true },
          orderBy: { scheduledAt: 'desc' },
          take:    30,
        }),

        // Assignments from this teacher
        prisma.assignment.findMany({
          where:   { teacherId, studentId: id },
          include: { submission: true },
          orderBy: { createdAt: 'desc' },
        }),

        // Progress reports from this teacher
        prisma.progressReport.findMany({
          where:   { teacherId, studentId: id },
          orderBy: { createdAt: 'desc' },
        }),

        // Attendance records from this teacher
        prisma.attendanceRecord.findMany({
          where:   { teacherId, studentId: id },
          include: {
            session: {
              select: { scheduledAt: true, courseType: true },
            },
          },
          orderBy: { markedAt: 'desc' },
        }),
      ]);

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    return res.json({
      student: {
        id:      student.id,
        email:   student.email,
        profile: student.studentProfile,
      },
      enrollment: {
        id:              enrollment.id,
        courseType:      enrollment.courseType,
        status:          enrollment.status,
        startDate:       enrollment.startDate,
        sessionsPerWeek: enrollment.sessionsPerWeek,
        notes:           enrollment.notes,
      },
      sessions,
      assignments,
      progressReports: reports,
      attendance: {
        records:    attendanceRecords,
        percentage: calcAttendancePercentage(attendanceRecords),
        total:      attendanceRecords.length,
        present:    attendanceRecords.filter(r => r.status === 'PRESENT').length,
        late:       attendanceRecords.filter(r => r.status === 'LATE').length,
        absent:     attendanceRecords.filter(r => r.status === 'ABSENT').length,
        excused:    attendanceRecords.filter(r => r.status === 'EXCUSED').length,
      },
    });
  } catch (err) {
    console.error('Student fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch student data' });
  }
});

// ─────────────────────────────────────────────────────────
// ASSIGNMENTS
// ─────────────────────────────────────────────────────────

// GET /api/teacher/assignments
// All assignments for this teacher
// Query: ?status= ?studentId= ?courseType=
router.get('/assignments', async (req, res) => {
  const { status, studentId, courseType } = req.query;

  const validStatuses = ['PENDING', 'SUBMITTED', 'GRADED', 'OVERDUE'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    });
  }

  const where = { teacherId: req.teacher.id };
  if (status)     where.status     = status;
  if (studentId)  where.studentId  = studentId;
  if (courseType) where.courseType = courseType;

  try {
    const assignments = await prisma.assignment.findMany({
      where,
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: { childName: true, parentName: true },
            },
          },
        },
        submission: true,
      },
      orderBy: { dueDate: 'asc' },
    });

    // Mark overdue assignments — dueDate passed and still PENDING
    const now = new Date();
    const withOverdue = assignments.map(a => ({
      ...a,
      isOverdue: a.status === 'PENDING' && new Date(a.dueDate) < now,
    }));

    return res.json({ assignments: withOverdue, count: assignments.length });
  } catch (err) {
    console.error('Assignments fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/assignments/:id
// Single assignment with submission
// ─────────────────────────────────────────────────────────
router.get('/assignments/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: { childName: true, parentName: true, timezone: true },
            },
          },
        },
        enrollment: {
          select: { id: true, courseType: true, status: true },
        },
        submission: true,
      },
    });

    if (!assignment || assignment.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    return res.json({ assignment });
  } catch (err) {
    console.error('Assignment fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch assignment' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/teacher/assignments
// Create a new assignment for a student
// ─────────────────────────────────────────────────────────
router.post('/assignments', writeLimiter, async (req, res) => {
  // const {
  //   studentId,
  //   enrollmentId,
  //   title,
  //   description,
  //   dueDate,
  //   courseType,
  // } = req.body;

  // Validation
  const errors = [];
  const studentId   = collect(errors, requireStr(req.body.studentId,  'studentId',  50));
  const title       = collect(errors, requireStr(req.body.title,       'title',      200));
  const courseType  = collect(errors, requireEnum(req.body.courseType, [
    'NOORANI_QAIDA','QURAN_RECITATION','TAJWEED','HIFZ','ISLAMIC_STUDIES','ONE_TO_ONE'
  ], 'courseType'));
  const dueDate     = collect(errors, cleanFutureDate(req.body.dueDate, 'dueDate'));
  const description = cleanStr(req.body.description, 1000);
  const enrollmentId = cleanStr(req.body.enrollmentId, 50);
  // if (!studentId)  errors.push('studentId is required');
  // if (!title)      errors.push('title is required');
  // if (!dueDate)    errors.push('dueDate is required');
  // if (!courseType) errors.push('courseType is required');

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  // Validate dueDate is in the future
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) {
    return res.status(400).json({ error: 'Invalid dueDate format' });
  }
  if (due < new Date()) {
    return res.status(400).json({ error: 'dueDate must be in the future' });
  }

  try {
    // Verify the student is enrolled with this teacher
    const enrollment = await prisma.enrollment.findFirst({
      where: {
        teacherId: req.teacher.id,
        studentId,
        status: 'ACTIVE',
      },
    });

    // handling duplicate heree
    const duplicate = await prisma.assignment.findFirst({
      where: { teacherId: req.teacher.id, studentId, title },
    });

    if (duplicate) return res.status(409).json({
      error: `An assignment titled "${title}" already exists for this student`,
      assignmentId: duplicate.id,
    });

    if (!enrollment) {
      return res.status(404).json({
        error: 'Student not found or not actively enrolled with you',
      });
    }

    const assignment = await prisma.assignment.create({
      data: {
        teacherId:      req.teacher.id,
        studentId,
        enrollmentId:   enrollmentId || null,
        title,
        description:    description || null,
   
        // ── NEW: file attachment from teacher ──────────────
        attachmentUrl:  cleanStr(req.body.attachmentUrl  || '', 2000) || null,
        attachmentName: cleanStr(req.body.attachmentName || '', 500)  || null,
        attachmentType: cleanStr(req.body.attachmentType || '', 100)  || null,
   
        dueDate,
        courseType,
        status: 'PENDING',
      },
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: { select: { childName: true, parentName: true } },
          },
        },
        submission: true,
      },
    });

    console.log(`✅ Assignment created: "${assignment.title}" for student ${studentId}`);
    return res.status(201).json({ assignment });
  } catch (err) {
    console.error('Assignment creation failed:', err);
    return res.status(500).json({ error: 'Failed to create assignment' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/teacher/assignments/:id
// Update assignment: title, description, dueDate, status
// Teachers can edit anything except the submission itself
// ─────────────────────────────────────────────────────────
// router.patch('/assignments/:id', writeLimiter, async (req, res) => {
//   const { id } = req.params;
//   const { title, description, dueDate, status } = req.body;

//   if (!title && !description && !dueDate && !status) {
//     return res.status(400).json({
//       error: 'Provide at least one field to update',
//     });
//   }

//   const validStatuses = ['PENDING', 'OVERDUE'];
//   if (status && !validStatuses.includes(status)) {
//     return res.status(400).json({
//       error: `Teachers can only set status to PENDING or OVERDUE. Got: ${status}`,
//     });
//   }

//   try {
//     const existing = await prisma.assignment.findUnique({ where: { id } });

//     if (!existing || existing.teacherId !== req.teacher.id) {
//       return res.status(404).json({ error: 'Assignment not found' });
//     }

//     const updateData = {};
//     if (title !== undefined)       updateData.title       = title.trim();
//     if (description !== undefined) updateData.description = description?.trim() || null;
//     if (status !== undefined)      updateData.status      = status;
//     if (dueDate !== undefined) {
//       const due = new Date(dueDate);
//       if (isNaN(due.getTime())) {
//         return res.status(400).json({ error: 'Invalid dueDate format' });
//       }
//       updateData.dueDate = due;
//     }

//     const updated = await prisma.assignment.update({
//       where:   { id },
//       data:    updateData,
//       include: { student: { select: { id: true, email: true, studentProfile: { select: { childName: true } } } }, submission: true },
//     });

//     return res.json({ assignment: updated });
//   } catch (err) {
//     console.error('Assignment update failed:', err);
//     return res.status(500).json({ error: 'Failed to update assignment' });
//   }
// });

router.patch('/assignments/:id', writeLimiter, async (req, res) => {
  const { id } = req.params;
  const title       = req.body.title       !== undefined ? cleanStr(req.body.title,       200) : undefined;
  const description = req.body.description !== undefined ? cleanStr(req.body.description, 1000) : undefined;
  const status      = req.body.status;
  let   dueDate;

  if (req.body.dueDate !== undefined) {
    const result = cleanFutureDate(req.body.dueDate, 'dueDate');
    if (result.error) return res.status(400).json({ error: result.error });
    dueDate = result.value;
  }

  if (title === undefined && description === undefined && dueDate === undefined && !status) {
    return res.status(400).json({ error: 'Provide at least one field to update' });
  }

  const validStatuses = ['PENDING','OVERDUE'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Teachers can only set status to PENDING or OVERDUE` });
  }

  try {
    const existing = await prisma.assignment.findUnique({ where:{ id } });
    if (!existing || existing.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const updateData = {};
    if (title       !== undefined) updateData.title       = title;
    if (description !== undefined) updateData.description = description;
    if (status      !== undefined) updateData.status      = status;
    if (dueDate     !== undefined) updateData.dueDate     = dueDate;

    const updated = await prisma.assignment.update({
      where: { id }, data: updateData,
      include: { student:{ select:{ id:true, email:true, studentProfile:{ select:{ childName:true } } } }, submission:true },
    });

    return res.json({ assignment: updated });
  } catch (err) {
    console.error('Assignment update failed:', err);
    return res.status(500).json({ error: 'Failed to update assignment' });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /api/teacher/assignments/:id
// Delete an assignment (only if not yet submitted)
// ─────────────────────────────────────────────────────────
router.delete('/assignments/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await prisma.assignment.findUnique({
      where:   { id },
      include: { submission: true },
    });

    if (!existing || existing.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    if (existing.submission) {
      return res.status(409).json({
        error: 'Cannot delete an assignment that has been submitted. Mark it as overdue instead.',
      });
    }

    await prisma.assignment.delete({ where: { id } });

    console.log(`✅ Assignment deleted: ${id}`);
    return res.json({ message: 'Assignment deleted successfully' });
  } catch (err) {
    console.error('Assignment deletion failed:', err);
    return res.status(500).json({ error: 'Failed to delete assignment' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/teacher/assignments/:id/grade
// Grade a submitted assignment
// Body: { grade, feedback }
// ─────────────────────────────────────────────────────────
// router.post('/assignments/:id/grade', async (req, res) => {
//   const { id } = req.params;
//   const { grade, feedback } = req.body;

//   if (!grade) {
//     return res.status(400).json({ error: 'grade is required' });
//   }

//   // Grade format: any non-empty string — "Excellent", "8/10", "B+", "MashaAllah"
//   if (typeof grade !== 'string' || grade.trim().length === 0) {
//     return res.status(400).json({ error: 'grade must be a non-empty string' });
//   }

//   try {
//     const assignment = await prisma.assignment.findUnique({
//       where:   { id },
//       include: { submission: true },
//     });

//     if (!assignment || assignment.teacherId !== req.teacher.id) {
//       return res.status(404).json({ error: 'Assignment not found' });
//     }

//     if (!assignment.submission) {
//       return res.status(409).json({
//         error: 'Cannot grade an assignment with no submission yet',
//       });
//     }

//     // Update submission with grade + feedback, and assignment status to GRADED
//     const [updatedSubmission] = await prisma.$transaction([
//       prisma.assignmentSubmission.update({
//         where: { assignmentId: id },
//         data: {
//           grade:    grade.trim(),
//           feedback: feedback?.trim() || null,
//           gradedAt: new Date(),
//         },
//       }),
//       prisma.assignment.update({
//         where: { id },
//         data:  { status: 'GRADED' },
//       }),
//     ]);

//     console.log(`✅ Assignment ${id} graded: ${grade}`);
//     return res.json({
//       message:    'Assignment graded successfully',
//       submission: updatedSubmission,
//     });
//   } catch (err) {
//     console.error('Grading failed:', err);
//     return res.status(500).json({ error: 'Failed to grade assignment' });
//   }
// });

router.post('/assignments/:id/grade', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  const grade    = cleanStr(req.body.grade,    100);
  const feedback = cleanStr(req.body.feedback, 500);

  if (!grade) return res.status(400).json({ error: 'grade is required and must be non-empty' });

  try {
    const assignment = await prisma.assignment.findUnique({ where:{ id }, include:{ submission:true } });
    if (!assignment || assignment.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    if (!assignment.submission) {
      return res.status(409).json({ error: 'Cannot grade an assignment with no submission yet' });
    }
    if (assignment.submission.gradedAt) {
      // Allow re-grading but log it
      console.log(`⚠️  Re-grading assignment ${id} by teacher ${req.teacher.id}`);
    }

    const [updatedSubmission] = await prisma.$transaction([
      prisma.assignmentSubmission.update({
        where: { assignmentId: id },
        data:  { grade, feedback, gradedAt: new Date() },
      }),
      prisma.assignment.update({
        where: { id },
        data:  { status: 'GRADED' },
      }),
    ]);

    console.log(`✅ Assignment ${id} graded: ${grade}`);
    return res.json({ message: 'Assignment graded', submission: updatedSubmission });
  } catch (err) {
    console.error('Grading failed:', err);
    return res.status(500).json({ error: 'Failed to grade assignment' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/teacher/assignments/bulk-overdue
// Mark all past-due PENDING assignments as OVERDUE
// Run manually or hook to a cron job later
// ─────────────────────────────────────────────────────────
router.post('/assignments/bulk-overdue', async (req, res) => {
  try {
    const result = await prisma.assignment.updateMany({
      where: {
        teacherId: req.teacher.id,
        status:    'PENDING',
        dueDate:   { lt: new Date() },
      },
      data: { status: 'OVERDUE' },
    });

    console.log(`✅ Marked ${result.count} assignments as OVERDUE`);
    return res.json({
      message: `${result.count} assignment(s) marked as overdue`,
      count:   result.count,
    });
  } catch (err) {
    console.error('Bulk overdue update failed:', err);
    return res.status(500).json({ error: 'Failed to update overdue assignments' });
  }
});

// ─────────────────────────────────────────────────────────
// PROGRESS REPORTS
// ─────────────────────────────────────────────────────────

// GET /api/teacher/reports
// All reports for this teacher
// Query: ?status= ?studentId=
router.get('/reports', async (req, res) => {
  const { status, studentId } = req.query;

  const validStatuses = ['DRAFT', 'SENT'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be DRAFT or SENT`,
    });
  }

  const where = { teacherId: req.teacher.id };
  if (status)    where.status    = status;
  if (studentId) where.studentId = studentId;

  try {
    const reports = await prisma.progressReport.findMany({
      where,
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: { childName: true, parentName: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ reports, count: reports.length });
  } catch (err) {
    console.error('Reports fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/reports/:id
// Single report with full detail
// ─────────────────────────────────────────────────────────
router.get('/reports/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const report = await prisma.progressReport.findUnique({
      where:   { id },
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: {
                childName:  true,
                parentName: true,
                timezone:   true,
              },
            },
          },
        },
        enrollment: {
          select: { courseType: true, status: true },
        },
      },
    });

    if (!report || report.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Report not found' });
    }

    return res.json({ report });
  } catch (err) {
    console.error('Report fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/teacher/reports
// Create a new progress report (starts as DRAFT)
// ─────────────────────────────────────────────────────────
// router.post('/reports', async (req, res) => {
//   const {
//     studentId,
//     enrollmentId,
//     period,
//     courseType,
//     overallRating,
//     tajweedProgress,
//     recitationNotes,
//     behaviourNotes,
//     homeworkNotes,
//     teacherMessage,
//     nextSteps,
//   } = req.body;

//   // Required field validation
//   const errors = [];
//   if (!studentId)  errors.push('studentId is required');
//   if (!period)     errors.push('period is required (e.g. "Week 12")');
//   if (!courseType) errors.push('courseType is required');

//   if (errors.length > 0) {
//     return res.status(400).json({ error: 'Validation failed', details: errors });
//   }

//   // Validate rating range if provided
//   if (overallRating !== undefined && overallRating !== null) {
//     const rating = Number(overallRating);
//     if (isNaN(rating) || rating < 1 || rating > 5) {
//       return res.status(400).json({
//         error: 'overallRating must be a number between 1 and 5',
//       });
//     }
//   }

//   try {
//     // Verify student is enrolled with this teacher
//     const enrollment = await prisma.enrollment.findFirst({
//       where: {
//         teacherId: req.teacher.id,
//         studentId,
//         status:    'ACTIVE',
//       },
//     });

//     if (!enrollment) {
//       return res.status(404).json({
//         error: 'Student not found or not actively enrolled with you',
//       });
//     }

//     // Check for duplicate report — same student + period + course
//     const duplicate = await prisma.progressReport.findFirst({
//       where: {
//         teacherId:  req.teacher.id,
//         studentId,
//         period:     period.trim(),
//         courseType,
//       },
//     });

//     if (duplicate) {
//       return res.status(409).json({
//         error:    `A report for "${period}" already exists for this student`,
//         reportId: duplicate.id,
//       });
//     }

//     const report = await prisma.progressReport.create({
//       data: {
//         teacherId:    req.teacher.id,
//         studentId,
//         enrollmentId: enrollmentId || enrollment.id,
//         period:       period.trim(),
//         courseType,
//         status:       'DRAFT',
//         overallRating:   overallRating ? Number(overallRating) : null,
//         tajweedProgress: tajweedProgress?.trim() || null,
//         recitationNotes: recitationNotes?.trim() || null,
//         behaviourNotes:  behaviourNotes?.trim()  || null,
//         homeworkNotes:   homeworkNotes?.trim()   || null,
//         teacherMessage:  teacherMessage?.trim()  || null,
//         nextSteps:       nextSteps?.trim()        || null,
//       },
//       include: {
//         student: {
//           select: {
//             id:    true,
//             email: true,
//             studentProfile: {
//               select: { childName: true, parentName: true },
//             },
//           },
//         },
//       },
//     });

//     console.log(`✅ Progress report created: ${report.id} — ${period}`);
//     return res.status(201).json({ report });
//   } catch (err) {
//     console.error('Report creation failed:', err);
//     return res.status(500).json({ error: 'Failed to create report' });
//   }
// });

router.post('/reports', writeLimiter, async (req, res) => {
  const errs = [];
  const studentId  = collect(errs, requireStr(req.body.studentId,  'studentId',  50));
  const period     = collect(errs, requireStr(req.body.period,      'period',     100));
  const courseType = collect(errs, requireEnum(req.body.courseType, [
    'NOORANI_QAIDA','QURAN_RECITATION','TAJWEED','HIFZ','ISLAMIC_STUDIES','ONE_TO_ONE'
  ], 'courseType'));

  if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });

  const overallRating   = req.body.overallRating !== undefined ? cleanInt(req.body.overallRating, 1, 5) : null;
  const tajweedProgress = cleanStr(req.body.tajweedProgress, 2000);
  const recitationNotes = cleanStr(req.body.recitationNotes, 2000);
  const behaviourNotes  = cleanStr(req.body.behaviourNotes,  2000);
  const homeworkNotes   = cleanStr(req.body.homeworkNotes,   2000);
  const teacherMessage  = cleanStr(req.body.teacherMessage,  2000);
  const nextSteps       = cleanStr(req.body.nextSteps,       2000);
  const enrollmentId    = cleanStr(req.body.enrollmentId,    50);

  if (req.body.overallRating !== undefined && req.body.overallRating !== null && overallRating === null) {
    return res.status(400).json({ error: 'overallRating must be a number between 1 and 5' });
  }

  try {
    const enrollment = await prisma.enrollment.findFirst({
      where: { teacherId: req.teacher.id, studentId, status: 'ACTIVE' },
    });
    if (!enrollment) return res.status(404).json({ error: 'Student not found or not actively enrolled with you' });

    const duplicate = await prisma.progressReport.findFirst({
      where: { teacherId: req.teacher.id, studentId, period, courseType },
    });
    if (duplicate) return res.status(409).json({
      error:    `A report for "${period}" already exists for this student`,
      reportId: duplicate.id,
    });

    const report = await prisma.progressReport.create({
      data: {
        teacherId:    req.teacher.id,
        studentId,
        enrollmentId: enrollmentId || enrollment.id,
        period,
        courseType,
        status:          'DRAFT',
        overallRating,
        tajweedProgress,
        recitationNotes,
        behaviourNotes,
        homeworkNotes,
        teacherMessage,
        nextSteps,
      },
      include: {
        student: { select:{ id:true, email:true, studentProfile:{ select:{ childName:true, parentName:true } } } },
      },
    });

    console.log(`✅ Report created: ${report.id} — ${period}`);
    return res.status(201).json({ report });
  } catch (err) {
    console.error('Report creation failed:', err);
    return res.status(500).json({ error: 'Failed to create report' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/teacher/reports/:id
// Update a DRAFT report
// Cannot edit a report that has already been SENT
// ─────────────────────────────────────────────────────────
router.patch('/reports/:id', async (req, res) => {
  const { id } = req.params;
  const {
    period,
    overallRating,
    tajweedProgress,
    recitationNotes,
    behaviourNotes,
    homeworkNotes,
    teacherMessage,
    nextSteps,
  } = req.body;

  try {
    const existing = await prisma.progressReport.findUnique({ where: { id } });

    if (!existing || existing.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (existing.status === 'SENT') {
      return res.status(409).json({
        error: 'Cannot edit a report that has already been sent to the parent',
      });
    }

    if (overallRating !== undefined && overallRating !== null) {
      const rating = Number(overallRating);
      if (isNaN(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({
          error: 'overallRating must be a number between 1 and 5',
        });
      }
    }

    const updateData = {};
    if (period          !== undefined) updateData.period          = period.trim();
    if (overallRating   !== undefined) updateData.overallRating   = overallRating ? Number(overallRating) : null;
    if (tajweedProgress !== undefined) updateData.tajweedProgress = tajweedProgress?.trim() || null;
    if (recitationNotes !== undefined) updateData.recitationNotes = recitationNotes?.trim() || null;
    if (behaviourNotes  !== undefined) updateData.behaviourNotes  = behaviourNotes?.trim()  || null;
    if (homeworkNotes   !== undefined) updateData.homeworkNotes   = homeworkNotes?.trim()   || null;
    if (teacherMessage  !== undefined) updateData.teacherMessage  = teacherMessage?.trim()  || null;
    if (nextSteps       !== undefined) updateData.nextSteps       = nextSteps?.trim()        || null;

    const updated = await prisma.progressReport.update({
      where:   { id },
      data:    updateData,
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: { childName: true, parentName: true },
            },
          },
        },
      },
    });

    return res.json({ report: updated });
  } catch (err) {
    console.error('Report update failed:', err);
    return res.status(500).json({ error: 'Failed to update report' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/teacher/reports/:id/send
// Send a DRAFT report to the parent via email
// Marks report as SENT — cannot be edited after this
// ─────────────────────────────────────────────────────────
router.post('/reports/:id/send', async (req, res) => {
  const { id } = req.params;

  try {
    const report = await prisma.progressReport.findUnique({
      where:   { id },
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: {
                childName:  true,
                parentName: true,
              },
            },
          },
        },
      },
    });

    if (!report || report.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (report.status === 'SENT') {
      return res.status(409).json({
        error:  'Report has already been sent',
        sentAt: report.sentAt,
      });
    }

    // Determine parent email
    // Priority: StudentProfile parentEmail field if it exists
    // Fallback: student's own email (for adult students)
    const parentEmail =
      report.student.studentProfile?.parentEmail ||
      report.student.email;

    const parentName =
      report.student.studentProfile?.parentName || 'Parent';

    const childName =
      report.student.studentProfile?.childName ||
      report.student.email.split('@')[0];

    // Send email — non-blocking failure
    // If email fails, we still mark the report as sent
    // and log the error for manual follow-up
    let emailError = null;
    try {
      await sendProgressReport({
        parentEmail,
        parentName,
        childName,
        teacherName:     req.teacher.name,
        period:          report.period,
        courseType:      report.courseType,
        overallRating:   report.overallRating,
        tajweedProgress: report.tajweedProgress,
        recitationNotes: report.recitationNotes,
        behaviourNotes:  report.behaviourNotes,
        homeworkNotes:   report.homeworkNotes,
        teacherMessage:  report.teacherMessage,
        nextSteps:       report.nextSteps,
      });

      console.log(`✅ Progress report emailed to ${parentEmail}`);
    } catch (emailErr) {
      emailError = emailErr.message;
      console.error(`❌ Email failed for report ${id}:`, emailErr.message);
    }

    // Mark report as SENT regardless of email outcome
    const updated = await prisma.progressReport.update({
      where: { id },
      data:  { status: 'SENT', sentAt: new Date() },
    });

    return res.json({
      report:     updated,
      emailSent:  !emailError,
      emailError: emailError || null,
      sentTo:     parentEmail,
    });
  } catch (err) {
    console.error('Report send failed:', err);
    return res.status(500).json({ error: 'Failed to send report' });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /api/teacher/reports/:id
// Delete a DRAFT report
// Cannot delete a SENT report
// ─────────────────────────────────────────────────────────
router.delete('/reports/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await prisma.progressReport.findUnique({ where: { id } });

    if (!existing || existing.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (existing.status === 'SENT') {
      return res.status(409).json({
        error: 'Cannot delete a report that has already been sent to the parent',
      });
    }

    await prisma.progressReport.delete({ where: { id } });

    console.log(`✅ Report deleted: ${id}`);
    return res.json({ message: 'Report deleted successfully' });
  } catch (err) {
    console.error('Report deletion failed:', err);
    return res.status(500).json({ error: 'Failed to delete report' });
  }
});

// ─────────────────────────────────────────────────────────
// ATTENDANCE
// ─────────────────────────────────────────────────────────

// GET /api/teacher/attendance
// All attendance records for this teacher
// Query: ?studentId= ?status= ?from= ?to=
router.get('/attendance', async (req, res) => {
  const { studentId, status, from, to } = req.query;

  const validStatuses = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    });
  }

  const where = { teacherId: req.teacher.id };
  if (studentId) where.studentId = studentId;
  if (status)    where.status    = status;
  if (from || to) {
    where.markedAt = {};
    if (from) where.markedAt.gte = new Date(from);
    if (to)   where.markedAt.lte = new Date(to);
  }

  try {
    const records = await prisma.attendanceRecord.findMany({
      where,
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: { childName: true, parentName: true },
            },
          },
        },
        session: {
          select: {
            id:          true,
            scheduledAt: true,
            courseType:  true,
            status:      true,
            zoomLink:    true,
          },
        },
      },
      orderBy: { markedAt: 'desc' },
    });

    return res.json({ records, count: records.length });
  } catch (err) {
    console.error('Attendance fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch attendance records' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/attendance/summary
// Attendance summary per student for this teacher
// Returns: percentage, totals, last session date per student
// ─────────────────────────────────────────────────────────
router.get('/attendance/summary', async (req, res) => {
  try {
    // Get all active enrollments for this teacher
    const enrollments = await prisma.enrollment.findMany({
      where: {
        teacherId: req.teacher.id,
        status:    'ACTIVE',
      },
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: { childName: true, parentName: true },
            },
          },
        },
      },
    });

    // For each student, fetch their attendance stats
    const summaries = await Promise.all(
      enrollments.map(async (enrollment) => {
        const records = await prisma.attendanceRecord.findMany({
          where: {
            teacherId: req.teacher.id,
            studentId: enrollment.studentId,
          },
          include: {
            session: {
              select: { scheduledAt: true },
            },
          },
          orderBy: { markedAt: 'desc' },
        });

        const total   = records.length;
        const present = records.filter(r => r.status === 'PRESENT').length;
        const late    = records.filter(r => r.status === 'LATE').length;
        const absent  = records.filter(r => r.status === 'ABSENT').length;
        const excused = records.filter(r => r.status === 'EXCUSED').length;

        // Present + Late both count as attended
        const attended   = present + late;
        const percentage = total > 0 ? Math.round((attended / total) * 100) : 0;

        const lastRecord = records[0]; // already ordered desc

        return {
          student: {
            id:      enrollment.student.id,
            email:   enrollment.student.email,
            profile: enrollment.student.studentProfile,
          },
          enrollment: {
            id:         enrollment.id,
            courseType: enrollment.courseType,
          },
          attendance: {
            percentage,
            total,
            present,
            late,
            absent,
            excused,
            lastSessionDate: lastRecord?.session?.scheduledAt || null,
          },
        };
      })
    );

    return res.json({ summaries, count: summaries.length });
  } catch (err) {
    console.error('Attendance summary failed:', err);
    return res.status(500).json({ error: 'Failed to fetch attendance summary' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/attendance/session/:sessionId
// Get attendance record for a specific session
// ─────────────────────────────────────────────────────────
router.get('/attendance/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    // Verify session belongs to this teacher
    const session = await prisma.classSession.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const record = await prisma.attendanceRecord.findUnique({
      where: { sessionId },
      include: {
        student: {
          select: {
            id:    true,
            email: true,
            studentProfile: {
              select: { childName: true },
            },
          },
        },
      },
    });

    // record can be null — session exists but not yet marked
    return res.json({
      session: {
        id:          session.id,
        scheduledAt: session.scheduledAt,
        courseType:  session.courseType,
        status:      session.status,
      },
      attendance: record || null,
      marked:     !!record,
    });
  } catch (err) {
    console.error('Session attendance fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch session attendance' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/teacher/attendance
// Mark attendance for a session
// Body: { sessionId, status, notes }
// ─────────────────────────────────────────────────────────
// router.post('/attendance', async (req, res) => {
//   const { sessionId, status, notes } = req.body;

//   // Validation
//   const errors = [];
//   if (!sessionId) errors.push('sessionId is required');
//   if (!status)    errors.push('status is required');

//   const validStatuses = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'];
//   if (status && !validStatuses.includes(status)) {
//     errors.push(`status must be one of: ${validStatuses.join(', ')}`);
//   }

//   if (errors.length > 0) {
//     return res.status(400).json({ error: 'Validation failed', details: errors });
//   }

//   try {
//     // Verify session belongs to this teacher
//     const session = await prisma.classSession.findUnique({
//       where: { id: sessionId },
//     });

//     if (!session || session.teacherId !== req.teacher.id) {
//       return res.status(404).json({ error: 'Session not found' });
//     }

//     // Check not already marked
//     const existing = await prisma.attendanceRecord.findUnique({
//       where: { sessionId },
//     });

//     if (existing) {
//       return res.status(409).json({
//         error:      'Attendance already marked for this session. Use PATCH to update.',
//         recordId:   existing.id,
//         currentStatus: existing.status,
//       });
//     }

//     // Find the enrollment for this teacher + student combination
//     const enrollment = await prisma.enrollment.findFirst({
//       where: {
//         teacherId: req.teacher.id,
//         studentId: session.studentId,
//       },
//     });

//     // Create attendance record and update session status in a transaction
//     const [record] = await prisma.$transaction([
//       prisma.attendanceRecord.create({
//         data: {
//           teacherId:    req.teacher.id,
//           studentId:    session.studentId,
//           sessionId,
//           enrollmentId: enrollment?.id || null,
//           status,
//           notes:        notes?.trim() || null,
//         },
//         include: {
//           student: {
//             select: {
//               id:    true,
//               email: true,
//               studentProfile: {
//                 select: { childName: true },
//               },
//             },
//           },
//           session: {
//             select: {
//               id:          true,
//               scheduledAt: true,
//               courseType:  true,
//             },
//           },
//         },
//       }),

//       // Auto-update session status based on attendance
//       // PRESENT/LATE → COMPLETED, ABSENT/EXCUSED → MISSED
//       prisma.classSession.update({
//         where: { id: sessionId },
//         data: {
//           status: ['PRESENT', 'LATE'].includes(status) ? 'COMPLETED' : 'MISSED',
//         },
//       }),
//     ]);

//     console.log(
//       `✅ Attendance marked: ${record.student.studentProfile?.childName || 'Student'} — ${status}`
//     );
//     return res.status(201).json({ record });
//   } catch (err) {
//     // Handle unique constraint violation gracefully
//     if (err.code === 'P2002') {
//       return res.status(409).json({
//         error: 'Attendance already marked for this session',
//       });
//     }
//     console.error('Attendance marking failed:', err);
//     return res.status(500).json({ error: 'Failed to mark attendance' });
//   }
// });

router.post('/attendance', writeLimiter, async (req, res) => {
  const errs = [];
  const sessionId = collect(errs, requireStr(req.body.sessionId, 'sessionId', 50));
  const status    = collect(errs, requireEnum(
    req.body.status,
    ['PRESENT','LATE','ABSENT','EXCUSED'],
    'status'
  ));
  const notes = cleanStr(req.body.notes, 500);

  if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });

  try {
    const session = await prisma.classSession.findUnique({ where:{ id: sessionId } });
    if (!session || session.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const existing = await prisma.attendanceRecord.findUnique({ where:{ sessionId } });
    if (existing) {
      return res.status(409).json({
        error:         'Attendance already marked. Use PATCH to update.',
        recordId:      existing.id,
        currentStatus: existing.status,
      });
    }

    const enrollment = await prisma.enrollment.findFirst({
      where: { teacherId: req.teacher.id, studentId: session.studentId },
    });

    const [record] = await prisma.$transaction([
      prisma.attendanceRecord.create({
        data: {
          teacherId:    req.teacher.id,
          studentId:    session.studentId,
          sessionId,
          enrollmentId: enrollment?.id || null,
          status,
          notes,
        },
        include: {
          student: { select:{ id:true, email:true, studentProfile:{ select:{ childName:true } } } },
          session: { select:{ id:true, scheduledAt:true, courseType:true } },
        },
      }),
      prisma.classSession.update({
        where: { id: sessionId },
        data:  { status: ['PRESENT','LATE'].includes(status) ? 'COMPLETED' : 'MISSED' },
      }),
    ]);

    console.log(`✅ Attendance: ${record.student.studentProfile?.childName || 'Student'} — ${status}`);
    return res.status(201).json({ record });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Attendance already marked for this session' });
    }
    console.error('Attendance marking failed:', err);
    return res.status(500).json({ error: 'Failed to mark attendance' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/teacher/attendance/:id
// Update an existing attendance record
// Only status and notes can be changed
// ─────────────────────────────────────────────────────────
router.patch('/attendance/:id', async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;

  if (!status && notes === undefined) {
    return res.status(400).json({
      error: 'Provide at least one field to update: status or notes',
    });
  }

  const validStatuses = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
    });
  }

  try {
    const existing = await prisma.attendanceRecord.findUnique({
      where: { id },
    });

    if (!existing || existing.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (notes  !== undefined) updateData.notes  = notes?.trim() || null;

    const [updated] = await prisma.$transaction([
      prisma.attendanceRecord.update({
        where: { id },
        data:  updateData,
        include: {
          student: {
            select: {
              id:    true,
              email: true,
              studentProfile: {
                select: { childName: true },
              },
            },
          },
          session: {
            select: {
              id:          true,
              scheduledAt: true,
              courseType:  true,
            },
          },
        },
      }),

      // Sync session status if attendance status changed
      ...(status ? [
        prisma.classSession.update({
          where: { id: existing.sessionId },
          data: {
            status: ['PRESENT', 'LATE'].includes(status) ? 'COMPLETED' : 'MISSED',
          },
        }),
      ] : []),
    ]);

    console.log(`✅ Attendance updated: ${id} → ${updated.status}`);
    return res.json({ record: updated });
  } catch (err) {
    console.error('Attendance update failed:', err);
    return res.status(500).json({ error: 'Failed to update attendance record' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/teacher/attendance/student/:studentId
// Full attendance history for one student with this teacher
// Includes percentage breakdown and per-session records
// ─────────────────────────────────────────────────────────
router.get('/attendance/student/:studentId', async (req, res) => {
  const { studentId } = req.params;
  const { from, to }  = req.query;

  try {
    // Verify student is enrolled with this teacher
    const enrollment = await prisma.enrollment.findFirst({
      where: {
        teacherId: req.teacher.id,
        studentId,
      },
    });

    if (!enrollment) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const where = {
      teacherId: req.teacher.id,
      studentId,
    };
    if (from || to) {
      where.markedAt = {};
      if (from) where.markedAt.gte = new Date(from);
      if (to)   where.markedAt.lte = new Date(to);
    }

    const records = await prisma.attendanceRecord.findMany({
      where,
      include: {
        session: {
          select: {
            id:           true,
            scheduledAt:  true,
            courseType:   true,
            status:       true,
            teacherNotes: true,
          },
        },
      },
      orderBy: { markedAt: 'desc' },
    });

    // Calculate stats
    const total   = records.length;
    const present = records.filter(r => r.status === 'PRESENT').length;
    const late    = records.filter(r => r.status === 'LATE').length;
    const absent  = records.filter(r => r.status === 'ABSENT').length;
    const excused = records.filter(r => r.status === 'EXCUSED').length;
    const attended   = present + late;
    const percentage = total > 0 ? Math.round((attended / total) * 100) : 0;

    return res.json({
      stats: {
        percentage,
        total,
        present,
        late,
        absent,
        excused,
      },
      records,
    });
  } catch (err) {
    console.error('Student attendance fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch student attendance' });
  }
});

export default router;