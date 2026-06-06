// src/routes/parent.js
import express from 'express';
import { prisma } from '../lib/prisma.js';
import { requireParent } from '../middleware/parentAuth.js';

const router = express.Router();

// Apply requireParent to ALL routes in this file
router.use(requireParent);

// ─── Helpers ──────────────────────────────────────────────
function calcAttendancePct(records) {
  if (!records || records.length === 0) return 0;
  const attended = records.filter(r => r.status === 'PRESENT' || r.status === 'LATE').length;
  return Math.round((attended / records.length) * 100);
}

// ─────────────────────────────────────────────────────────
// GET /api/parent/me
// Returns parent profile + all linked children with
// basic info: name, course, attendance %, next session.
// ─────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    // Guard: parent with no linked children
    if (req.childIds.length === 0) {
      return res.json({
        parent: {
          id:    req.parentProfile.id,
          name:  req.parentProfile.name,
          phone: req.parentProfile.phone,
          email: req.user.email,
        },
        children: [],
      });
    }

    // Fetch all linked children in parallel
    const children = await Promise.all(
      req.childIds.map(async (childId) => {
        const [user, enrollment, nextSession, attendanceRecords] = await Promise.all([
          prisma.user.findUnique({
            where:  { id: childId },
            select: {
              id:    true,
              email: true,
              studentProfile: {
                select: {
                  childName:     true,
                  childAge:      true,
                  courseInterest:true,
                  timezone:      true,
                  country:       true,
                },
              },
            },
          }),
          prisma.enrollment.findFirst({
            where:   { studentId: childId, status: 'ACTIVE' },
            select:  { id: true, courseType: true, sessionsPerWeek: true, status: true },
            orderBy: { startDate: 'desc' },
          }),
          prisma.classSession.findFirst({
            where:   { studentId: childId, status: 'SCHEDULED' },
            select:  {
              id:          true,
              scheduledAt: true,
              courseType:  true,
              durationMins:true,
              zoomLink:    true,
              teacher:     { select: { name: true } },
            },
            orderBy: { scheduledAt: 'asc' },
          }),
          prisma.attendanceRecord.findMany({
            where:  { studentId: childId },
            select: { status: true },
          }),
        ]);

        return {
          id:                 childId,
          email:              user?.email,
          profile:            user?.studentProfile || null,
          enrollment:         enrollment || null,
          nextSession:        nextSession || null,
          attendancePercentage: calcAttendancePct(attendanceRecords),
          totalSessions:      attendanceRecords.length,
        };
      })
    );

    return res.json({
      parent: {
        id:    req.parentProfile.id,
        name:  req.parentProfile.name,
        phone: req.parentProfile.phone,
        email: req.user.email,
      },
      children,
    });
  } catch (err) {
    console.error('Parent /me fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch parent data' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/parent/children
// Lightweight list of linked children.
// ─────────────────────────────────────────────────────────
router.get('/children', async (req, res) => {
  if (req.childIds.length === 0) {
    return res.json({ children: [] });
  }

  try {
    const children = await prisma.user.findMany({
      where:  { id: { in: req.childIds } },
      select: {
        id:    true,
        email: true,
        studentProfile: {
          select: {
            childName:      true,
            childAge:       true,
            courseInterest: true,
            timezone:       true,
            country:        true,
          },
        },
      },
    });

    return res.json({ children });
  } catch (err) {
    console.error('Parent children fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch children' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/parent/children/:id/sessions
// Upcoming + past sessions for a linked child.
// Parent is read-only — no Join button on parent side.
// ─────────────────────────────────────────────────────────
router.get('/children/:id/sessions', async (req, res) => {
  const { id } = req.params;

  // CRITICAL: verify child belongs to this parent
  if (!req.childIds.includes(id)) {
    return res.status(404).json({ error: 'Child not found' });
  }

  try {
    const [upcoming, past] = await Promise.all([
      prisma.classSession.findMany({
        where:   { studentId: id, status: 'SCHEDULED' },
        include: {
          teacher:    { select: { name: true, gender: true } },
          attendance: { select: { status: true } },
        },
        orderBy: { scheduledAt: 'asc' },
        take:    20,
      }),
      prisma.classSession.findMany({
        where:   { studentId: id, status: { in: ['COMPLETED', 'MISSED', 'CANCELLED'] } },
        include: {
          teacher:    { select: { name: true, gender: true } },
          attendance: { select: { status: true } },
        },
        orderBy: { scheduledAt: 'desc' },
        take:    20,
      }),
    ]);

    return res.json({ upcoming, past });
  } catch (err) {
    console.error('Parent child sessions fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/parent/children/:id/progress
// Attendance stats + SENT progress reports for a child.
// ─────────────────────────────────────────────────────────
router.get('/children/:id/progress', async (req, res) => {
  const { id } = req.params;

  if (!req.childIds.includes(id)) {
    return res.status(404).json({ error: 'Child not found' });
  }

  try {
    const [attendanceRecords, reports] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where:   { studentId: id },
        select:  { status: true, markedAt: true },
        orderBy: { markedAt: 'desc' },
      }),
      prisma.progressReport.findMany({
        where:   { studentId: id, status: 'SENT' },
        include: { teacher: { select: { name: true } } },
        orderBy: { sentAt: 'desc' },
        take:    10,
      }),
    ]);

    const total      = attendanceRecords.length;
    const present    = attendanceRecords.filter(r => r.status === 'PRESENT').length;
    const late       = attendanceRecords.filter(r => r.status === 'LATE').length;
    const absent     = attendanceRecords.filter(r => r.status === 'ABSENT').length;
    const excused    = attendanceRecords.filter(r => r.status === 'EXCUSED').length;
    const percentage = calcAttendancePct(attendanceRecords);

    return res.json({
      attendance: { total, present, late, absent, excused, percentage },
      reports,
    });
  } catch (err) {
    console.error('Parent child progress fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/parent/children/:id/assignments
// All assignments for a child — read-only for parent.
// ─────────────────────────────────────────────────────────
router.get('/children/:id/assignments', async (req, res) => {
  const { id } = req.params;

  if (!req.childIds.includes(id)) {
    return res.status(404).json({ error: 'Child not found' });
  }

  try {
    const assignments = await prisma.assignment.findMany({
      where:   { studentId: id },
      include: {
        teacher:    { select: { name: true } },
        submission: true,
      },
      orderBy: { dueDate: 'asc' },
    });

    return res.json({ assignments, count: assignments.length });
  } catch (err) {
    console.error('Parent child assignments fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/parent/children/:id/attendance
// Full attendance history with stats for a child.
// ─────────────────────────────────────────────────────────
router.get('/children/:id/attendance', async (req, res) => {
  const { id } = req.params;

  if (!req.childIds.includes(id)) {
    return res.status(404).json({ error: 'Child not found' });
  }

  try {
    const records = await prisma.attendanceRecord.findMany({
      where:   { studentId: id },
      include: {
        session: {
          select: {
            scheduledAt: true,
            courseType:  true,
            status:      true,
            teacher:     { select: { name: true } },
          },
        },
      },
      orderBy: { markedAt: 'desc' },
    });

    const total      = records.length;
    const present    = records.filter(r => r.status === 'PRESENT').length;
    const late       = records.filter(r => r.status === 'LATE').length;
    const absent     = records.filter(r => r.status === 'ABSENT').length;
    const excused    = records.filter(r => r.status === 'EXCUSED').length;
    const percentage = calcAttendancePct(records);

    return res.json({
      stats: { total, present, late, absent, excused, percentage },
      records,
    });
  } catch (err) {
    console.error('Parent child attendance fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/parent/children/:id/reports
// All SENT progress reports for a child — full content.
// ─────────────────────────────────────────────────────────
router.get('/children/:id/reports', async (req, res) => {
  const { id } = req.params;

  if (!req.childIds.includes(id)) {
    return res.status(404).json({ error: 'Child not found' });
  }

  try {
    const reports = await prisma.progressReport.findMany({
      where:   { studentId: id, status: 'SENT' },
      include: { teacher: { select: { name: true } } },
      orderBy: { sentAt: 'desc' },
    });

    return res.json({ reports, count: reports.length });
  } catch (err) {
    console.error('Parent child reports fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

export default router;