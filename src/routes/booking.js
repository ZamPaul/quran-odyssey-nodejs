// src/routes/booking.js
import express from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getAvailableSlots,
  createBookingEvent,
  createUniversalTrialEvent,
} from "../services/googleCalendar.js";
import { sendAdminTrialNotification, sendTrialBookingConfirmation } from "../services/email.js";
import { sendTrialBookingWhatsApp } from "../services/whatsapp.js";
import { ownsStudent } from "../middleware/auth.js";
import { requireContactDetails } from '../middleware/auth.js'; 


const router = express.Router();

const VALID_COURSES = [
  "NOORANI_QAIDA",
  "QURAN_RECITATION",
  "TAJWEED",
  "HIFZ",
  "ISLAMIC_STUDIES",
  "ONE_TO_ONE",
];

function courseEnumToLabel(enumVal) {
  return enumVal
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── GET /api/booking/teachers
// ────────────────────────────
// Returns active teachers filtered by course interest
// Used in the booking UI Step 2 to populate the teacher selection
router.get("/teachers", requireAuth, async (req, res) => {
  const { courseInterest } = req.query;

  const teachers = await prisma.teacher.findMany({
    where: {
      isActive: true,
      ...(courseInterest && {
        specialty: {
          hasSome: [courseEnumToLabel(courseInterest)],
        },
      }),
    },
    select: {
      id: true,
      name: true,
      specialty: true,
      timezone: true,
      gender: true,
      bio: true,
      rating: true,
    },
    orderBy: { rating: "desc" },
  });

  console.log("successfully fetched all available teachers with this course");

  return res.json({ teachers });
});

// ─── GET /api/booking/availability ────────────────────────
// Returns available 30-min slots for a specific teacher
// Query params:
//   teacherId  (required) — our DB teacher ID
//   daysAhead  (optional) — how many days to look ahead, default 14
// router.get("/availability", requireAuth, async (req, res) => {
//   const { teacherId, daysAhead } = req.query;

//   if (!teacherId) {
//     return res
//       .status(400)
//       .json({ error: "teacherId query parameter is required" });
//   }

//   // Fetch teacher from DB to get their calendar ID
//   const teacher = await prisma.teacher.findUnique({
//     where: { id: teacherId },
//     select: {
//       id: true,
//       name: true,
//       calendarId: true,
//       timezone: true,
//       isActive: true,
//     },
//   });

//   if (!teacher) {
//     return res.status(404).json({ error: "Teacher not found" });
//   }

//   if (!teacher.isActive) {
//     return res
//       .status(400)
//       .json({ error: "Teacher is not currently accepting bookings" });
//   }

//   if (!teacher.calendarId || teacher.calendarId.startsWith("placeholder")) {
//     return res
//       .status(503)
//       .json({ error: "Teacher calendar not configured yet" });
//   }

//   try {
//     const slots = await getAvailableSlots(
//       teacher.calendarId,
//       daysAhead ? parseInt(daysAhead, 10) : 14,
//     );

//     return res.json({
//       teacher: {
//         id: teacher.id,
//         name: teacher.name,
//         timezone: teacher.timezone,
//       },
//       slots,
//       count: slots.length,
//       generatedAt: new Date().toISOString(),
//     });
//   } catch (err) {
//     console.error("Availability fetch failed:", err.message);
//     return res.status(503).json({
//       error: "Calendar availability temporarily unavailable. Please try again.",
//     });
//   }
// });

// --------------- old one ends here

// ── GET /api/booking/availability ─────────────────────────
// Replaces the old teacher-based availability check entirely.
// Returns all 30-min slots in working hours for the next 14 days,
// minus slots already booked in trial_bookings.
router.get('/availability', async (req, res) => {
  // Working hours: 15:00–02:00 PKT (UTC+5) = 10:00–21:00 UTC
  // Slots: 10:00, 10:30, 11:00 ... 20:00, 20:30 (22 slots/day)
  const WORKING_START_UTC = 10;
  const WORKING_END_UTC   = 21; // exclusive — last slot starts at 20:30
  const SLOT_MINS         = 30;
  const DAYS_AHEAD        = 14;

  try {
    // Range: tomorrow 00:00 UTC → 14 days later 23:59 UTC
    const now = new Date();

    const rangeStart = new Date(now);
    rangeStart.setUTCDate(rangeStart.getUTCDate() + 1);
    rangeStart.setUTCHours(0, 0, 0, 0);

    const rangeEnd = new Date(rangeStart);
    rangeEnd.setUTCDate(rangeEnd.getUTCDate() + DAYS_AHEAD);
    rangeEnd.setUTCHours(23, 59, 59, 999);

    // Fetch already-booked (non-cancelled) slots in the range
    const booked = await prisma.trialBooking.findMany({
      where: {
        slotStart: { gte: rangeStart, lte: rangeEnd },
        status:    { notIn: ['CANCELLED'] },
      },
      select: { slotStart: true },
    });

    const bookedMs = new Set(booked.map(b => b.slotStart.getTime()));

    // Generate all slots
    const slots = [];

    for (let d = 0; d < DAYS_AHEAD; d++) {
      const base = new Date(rangeStart);
      base.setUTCDate(base.getUTCDate() + d);

      for (let h = WORKING_START_UTC; h < WORKING_END_UTC; h++) {
        for (let m = 0; m < 60; m += SLOT_MINS) {
          const slot = new Date(Date.UTC(
            base.getUTCFullYear(),
            base.getUTCMonth(),
            base.getUTCDate(),
            h, m, 0, 0
          ));

          if (!bookedMs.has(slot.getTime())) {
            slots.push(slot.toISOString());
          }
        }
      }
    }

    return res.json({ slots, total: slots.length });
  } catch (err) {
    console.error('Availability fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch available slots' });
  }
});

// ─── GET /api/booking/mine ────────────────────────────────
// All trials across the account's learners (optional ?studentId=).
router.get('/mine', requireAuth, async (req, res) => {
  const { studentId } = req.query;
 
  let studentFilter;
  if (studentId) {
    if (!ownsStudent(req, studentId)) {
      return res.status(404).json({ error: 'Learner not found' });
    }
    studentFilter = studentId;
  } else {
    studentFilter = { in: req.studentIds };
  }
 
  try {
    const bookings = await prisma.trialBooking.findMany({
      where:   { studentId: studentFilter },
      include: {
        teacher: { select: { name: true, specialty: true } },
        student: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
 
    return res.json({ bookings });
  } catch (err) {
    console.error('Trials fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch trial bookings' });
  }
});

// TEMPORARY — delete after testing

// ── POST /api/booking/trial ────────────────────────────────
// Updated: no teacher assignment, universal calendar, admin notification

router.post('/trial', requireAuth, requireContactDetails, async (req, res) => {
  const {
    studentId,                 // optional — if omitted, we create a learner inline
    slotStart,
    courseInterest,
    childName,
    childAge,
    country,
    timezone,
    genderPreference,
  } = req.body;
 
  // ── Validate ───────────────────────────────────────────
  const errors = [];
  if (!slotStart)      errors.push('slotStart is required');
  if (!courseInterest) errors.push('courseInterest is required');
  if (errors.length)   return res.status(400).json({ error: 'Validation failed', details: errors });
 
  const validCourses = ['NOORANI_QAIDA','QURAN_RECITATION','TAJWEED','HIFZ','ISLAMIC_STUDIES','ONE_TO_ONE'];
  if (!validCourses.includes(courseInterest)) {
    return res.status(400).json({ error: 'Invalid courseInterest' });
  }
 
  const validGender = ['MALE','FEMALE','NO_PREFERENCE'];
  const cleanGender = validGender.includes(genderPreference) ? genderPreference : 'NO_PREFERENCE';
 
  
  const slot = new Date(slotStart);
  if (isNaN(slot.getTime()))  return res.status(400).json({ error: 'slotStart must be a valid ISO date' });
  if (slot < new Date())      return res.status(400).json({ error: 'Cannot book a slot in the past' });
 
  const userTimezone = timezone || 'UTC';
 
  try {
    // ── Resolve which learner this trial is for ──────────
    let learner;
 
    if (studentId) {
      // Existing learner — must belong to this account
      if (!ownsStudent(req, studentId)) {
        return res.status(404).json({ error: 'Learner not found' });
      }
      learner = await prisma.student.findUnique({
        where:   { id: studentId },
        include: { account: { select: { email: true, name: true, phone: true } } },
      });
      if (!learner) return res.status(404).json({ error: 'Learner not found' });
    } else {
      // No learner yet — create one inline from the booking fields.
      if (!childName) {
        return res.status(400).json({ error: 'childName is required when no studentId is given' });
      }
      const ageNum = childAge ? parseInt(childAge, 10) : 0;
      learner = await prisma.student.create({
        data: {
          accountId:      req.user.id,
          name:           childName.trim(),
          age:            isNaN(ageNum) ? 0 : ageNum,
          country:        country?.trim() || 'Unknown',
          timezone:       userTimezone,
          courseInterest,
          gender:         null,
          isSelf:         false,
        },
        include: { account: { select: { email: true, name: true, phone: true } } },
      });
      console.log(`✅ Inline learner created during trial booking: ${learner.name}`);
    }
 
    // ── Guard: this learner already has a trial booked ────
    const existing = await prisma.trialBooking.findFirst({
      where: { studentId: learner.id },
    });
    if (existing) {
      return res.status(409).json({
        error:     'This learner already has a trial class booked',
        bookingId: existing.id,
        status:    existing.status,
      });
    }
 
    const courseLabel = courseInterest
      .replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
 
    // ── Create the booking ────────────────────────────────
    const booking = await prisma.trialBooking.create({
      data: {
        studentId:        learner.id,
        teacherId:        null,           // assigned later by admin
        slotStart:        slot,
        durationMins:     30,
        courseInterest,
        genderPreference: cleanGender,
        status:           'PENDING',
      },
    });
 
    console.log(`✅ Trial booked: ${booking.id} for learner ${learner.name}`);
 
    // ── Google Calendar event (non-fatal) ─────────────────
    try {
      const calEventId = await createUniversalTrialEvent({
        slotStart:        slot,
        durationMins:     30,
        parentName:       learner.account.name || learner.account.email,
        childName:        learner.name,
        courseLabel,
        genderPreference: cleanGender,
        parentEmail:      learner.account.email,
      });
      await prisma.trialBooking.update({ where: { id: booking.id }, data: { calEventId } });
    } catch (calErr) {
      console.error('❌ Calendar event creation failed (booking still confirmed):', calErr.message);
    }
 
    // ── Notifications (non-blocking) ──────────────────────
    const notifications = await Promise.allSettled([
      sendTrialBookingConfirmation({
        to:              learner.account.email,
        parentName:      learner.account.name || 'Parent',
        childName:       learner.name,
        courseLabel,
        slotStart:       slot.toISOString(),
        studentTimezone: userTimezone,
        bookingId:       booking.id,
        studentId: studentId,
      }),
      learner.account.phone
        ? sendTrialBookingWhatsApp({
            phone:       learner.account.phone,
            parentName:  learner.account.name || 'Parent',
            childName:   learner.name,
            courseLabel,
            dateDisplay: slot.toDateString(),
            timeDisplay: slot.toISOString(),
          })
        : Promise.resolve({ success: false, error: 'No phone' }),
    ]);
 
    const [emailResult] = notifications;
    if (emailResult.status === 'fulfilled' && emailResult.value?.success) {
      prisma.trialBooking.update({ where: { id: booking.id }, data: { emailSent: true } }).catch(() => {});
    }

    try {
      await sendAdminTrialNotification({
        parentName:       learner.account.name || learner.account.email,
        childName:        learner.name,
        parentEmail:      learner.account.email,
        phone:            learner.account.phone || null,
        country:          learner.country,        
        courseLabel,
        genderPreference: cleanGender,
        studentTimezone: userTimezone,
        dateDisplay:      slot.toDateString(),
        timeDisplay:      slot.toISOString(),
        studentId: studentId
      });
    } catch (adminEmailErr) {
      console.error('❌ Admin notification failed (booking still confirmed):', adminEmailErr.message);
    }
 
    return res.status(201).json({
      booking: {
        id:        booking.id,
        status:    booking.status,
        slotStart: booking.slotStart,
        studentId: learner.id,
      },
      message: 'Trial class booked successfully. Check your email for confirmation.',
    });
  } catch (err) {
    console.error('Trial booking failed:', err);
    return res.status(500).json({ error: 'Failed to book trial class' });
  }
});

export default router;
