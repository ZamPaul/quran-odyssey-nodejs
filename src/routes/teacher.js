// src/routes/teacher.js
import express from 'express';
import {prisma} from '../lib/prisma.js';
import { requireTeacher } from '../middleware/teacherAuth.js';

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
router.post('/assignments', async (req, res) => {
  const {
    studentId,
    enrollmentId,
    title,
    description,
    dueDate,
    courseType,
  } = req.body;

  // Validation
  const errors = [];
  if (!studentId)  errors.push('studentId is required');
  if (!title)      errors.push('title is required');
  if (!dueDate)    errors.push('dueDate is required');
  if (!courseType) errors.push('courseType is required');

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

    if (!enrollment) {
      return res.status(404).json({
        error: 'Student not found or not actively enrolled with you',
      });
    }

    const assignment = await prisma.assignment.create({
      data: {
        teacherId:    req.teacher.id,
        studentId,
        enrollmentId: enrollmentId || enrollment.id,
        title:        title.trim(),
        description:  description?.trim() || null,
        dueDate:      due,
        courseType,
        status:       'PENDING',
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
router.patch('/assignments/:id', async (req, res) => {
  const { id } = req.params;
  const { title, description, dueDate, status } = req.body;

  if (!title && !description && !dueDate && !status) {
    return res.status(400).json({
      error: 'Provide at least one field to update',
    });
  }

  const validStatuses = ['PENDING', 'OVERDUE'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({
      error: `Teachers can only set status to PENDING or OVERDUE. Got: ${status}`,
    });
  }

  try {
    const existing = await prisma.assignment.findUnique({ where: { id } });

    if (!existing || existing.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const updateData = {};
    if (title !== undefined)       updateData.title       = title.trim();
    if (description !== undefined) updateData.description = description?.trim() || null;
    if (status !== undefined)      updateData.status      = status;
    if (dueDate !== undefined) {
      const due = new Date(dueDate);
      if (isNaN(due.getTime())) {
        return res.status(400).json({ error: 'Invalid dueDate format' });
      }
      updateData.dueDate = due;
    }

    const updated = await prisma.assignment.update({
      where:   { id },
      data:    updateData,
      include: { student: { select: { id: true, email: true, studentProfile: { select: { childName: true } } } }, submission: true },
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
router.post('/assignments/:id/grade', async (req, res) => {
  const { id } = req.params;
  const { grade, feedback } = req.body;

  if (!grade) {
    return res.status(400).json({ error: 'grade is required' });
  }

  // Grade format: any non-empty string — "Excellent", "8/10", "B+", "MashaAllah"
  if (typeof grade !== 'string' || grade.trim().length === 0) {
    return res.status(400).json({ error: 'grade must be a non-empty string' });
  }

  try {
    const assignment = await prisma.assignment.findUnique({
      where:   { id },
      include: { submission: true },
    });

    if (!assignment || assignment.teacherId !== req.teacher.id) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    if (!assignment.submission) {
      return res.status(409).json({
        error: 'Cannot grade an assignment with no submission yet',
      });
    }

    // Update submission with grade + feedback, and assignment status to GRADED
    const [updatedSubmission] = await prisma.$transaction([
      prisma.assignmentSubmission.update({
        where: { assignmentId: id },
        data: {
          grade:    grade.trim(),
          feedback: feedback?.trim() || null,
          gradedAt: new Date(),
        },
      }),
      prisma.assignment.update({
        where: { id },
        data:  { status: 'GRADED' },
      }),
    ]);

    console.log(`✅ Assignment ${id} graded: ${grade}`);
    return res.json({
      message:    'Assignment graded successfully',
      submission: updatedSubmission,
    });
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

export default router;