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
// Returns the current user's trial booking if one exists
// Used by the dashboard to show upcoming class
router.get("/mine", requireAuth, async (req, res) => {
  const booking = await prisma.trialBooking.findFirst({
    where: { studentId: req.user.id },
    include: { teacher: { select: { name: true, specialty: true } } },
    orderBy: { createdAt: "desc" },
  });

  return res.json({ booking: booking || null });
});

// TEMPORARY — delete after testing
router.get("/test-whatsapp", requireAuth, async (req, res) => {
  const { sendTrialBookingWhatsApp } = await import("../services/whatsapp.js");

  // Replace with your actual WhatsApp number
  const result = await sendTrialBookingWhatsApp({
    phone: "447911123456",
    parentName: "Fatimah Ahmed",
    childName: "Ahmed",
    teacherName: "Sister Aisha",
    courseLabel: "Noorani Qaida",
    dateDisplay: "Wednesday, 28 May 2026",
    timeDisplay: "6:00 PM – 6:30 PM (BST)",
  });

  res.json(result);
});

// ─── POST /api/booking/trial ──────────────────────────────
// router.post("/trial", requireAuth, async (req, res) => {
//   const { teacherId, slotStart, studentTimezone } = req.body;

//   // ── 1. Validate input ────────────────────────────────
//   if (!teacherId || !slotStart || !studentTimezone) {
//     return res.status(400).json({
//       error: "teacherId, slotStart, and studentTimezone are required",
//     });
//   }

//   // Validate slotStart is a valid ISO date string
//   const slotStartDate = new Date(slotStart);
//   if (isNaN(slotStartDate.getTime())) {
//     return res
//       .status(400)
//       .json({ error: "slotStart must be a valid ISO date string" });
//   }

//   // Reject slots in the past
//   if (slotStartDate < new Date()) {
//     return res.status(400).json({ error: "Cannot book a slot in the past" });
//   }

//   const slotEndDate = new Date(slotStartDate.getTime() + 30 * 60 * 1000);

//   // ── 2. Check student doesn't already have a booking ──
//   const existingBooking = await prisma.trialBooking.findFirst({
//     where: { studentId: req.user.id },
//   });

//   if (existingBooking) {
//     return res.status(409).json({
//       error: "You already have a trial class booked",
//       bookingId: existingBooking.id,
//       slotStart: existingBooking.slotStart,
//       status: existingBooking.status,
//     });
//   }

//   // ── 3. Fetch teacher ──────────────────────────────────
//   const teacher = await prisma.teacher.findUnique({
//     where: { id: teacherId },
//     select: { id: true, name: true, calendarId: true, isActive: true },
//   });

//   if (!teacher || !teacher.isActive) {
//     return res.status(404).json({ error: "Teacher not found or unavailable" });
//   }

//   if (!teacher.calendarId || teacher.calendarId.startsWith("placeholder")) {
//     return res.status(503).json({ error: "Teacher calendar not configured" });
//   }

//   // ── 4. Re-check slot availability ────────────────────
//   // Protects against two users booking the same slot simultaneously
//   const conflictingBooking = await prisma.trialBooking.findFirst({
//     where: {
//       teacherId,
//       slotStart: slotStartDate,
//     },
//   });

//   if (conflictingBooking) {
//     return res.status(409).json({
//       error:
//         "This slot was just taken by another student. Please choose a different time.",
//     });
//   }

//   // ── 5. Create TrialBooking in DB ──────────────────────
//   let booking;
//   try {
//     booking = await prisma.trialBooking.create({
//       data: {
//         studentId: req.user.id,
//         teacherId: teacher.id,
//         slotStart: slotStartDate,
//         slotEnd: slotEndDate,
//         status: "PENDING",
//         studentTimezone,
//       },
//     });

//     console.log(`✅ TrialBooking created: ${booking.id}`);
//   } catch (err) {
//     // Unique constraint violation — someone else booked this exact slot
//     // between our check and our insert (true race condition)
//     if (err.code === "P2002") {
//       return res.status(409).json({
//         error: "This slot was just taken. Please choose a different time.",
//       });
//     }

//     console.error("❌ Failed to create TrialBooking:", err);
//     return res.status(500).json({ error: "Failed to create booking" });
//   }

//   // ── 6. Create Google Calendar event ──────────────────
//   // This IS blocking — if calendar fails, we still have the DB record
//   // Admin can manually create the event. Log and continue.
//   let calEventId = null;
//   try {
//     const profile = req.user.studentProfile;
//     const courseLabel =
//       profile?.courseInterest
//         ?.replace(/_/g, " ")
//         .toLowerCase()
//         .replace(/\b\w/g, (c) => c.toUpperCase()) || "Quran Class";

//     calEventId = await createBookingEvent({
//       calendarId: teacher.calendarId,
//       slotStart: slotStartDate.toISOString(),
//       slotEnd: slotEndDate.toISOString(),
//       studentName: profile?.childName || "Student",
//       parentName: profile?.parentName || req.user.email,
//       courseInterest: profile?.courseInterest || "QURAN_RECITATION",
//       studentEmail: req.user.email,
//     });

//     // Save the calendar event ID
//     await prisma.trialBooking.update({
//       where: { id: booking.id },
//       data: { calEventId },
//     });

//     console.log("calendar event created successfully");
//   } catch (err) {
//     console.error(
//       "⚠️  Calendar event creation failed (booking still saved):",
//       err.message,
//     );
//     // Don't return — booking is created, continue to notifications
//   }

//   // ── 7 & 8. Notifications — non-blocking ──────────────
//   // Build shared display values for both email and WhatsApp
//   const profile = req.user.studentProfile;
//   const parentName = profile?.parentName || "Parent";
//   const childName = profile?.childName || "your child";
//   const courseLabel =
//     profile?.courseInterest
//       ?.replace(/_/g, " ")
//       .toLowerCase()
//       .replace(/\b\w/g, (c) => c.toUpperCase()) || "Quran Class";

//   const start = slotStartDate;
//   const end = slotEndDate;
//   const tz = studentTimezone;

//   const dateDisplay = start.toLocaleDateString("en-GB", {
//     timeZone: tz,
//     weekday: "long",
//     year: "numeric",
//     month: "long",
//     day: "numeric",
//   });

//   const timeStart = start.toLocaleTimeString("en-GB", {
//     timeZone: tz,
//     hour: "2-digit",
//     minute: "2-digit",
//   });

//   const timeEnd = end.toLocaleTimeString("en-GB", {
//     timeZone: tz,
//     hour: "2-digit",
//     minute: "2-digit",
//   });

//   const tzAbbr = start
//     .toLocaleTimeString("en-GB", {
//       timeZone: tz,
//       timeZoneName: "short",
//     })
//     .split(" ")
//     .pop();

//   const timeDisplay = `${timeStart} – ${timeEnd} (${tzAbbr})`;

//   // // Send email — fire and forget
//   // sendTrialBookingConfirmation({
//   //   to: req.user.email,
//   //   parentName,
//   //   childName,
//   //   teacherName: teacher.name,
//   //   courseLabel,
//   //   slotStart: slotStartDate.toISOString(),
//   //   studentTimezone: tz,
//   //   bookingId: booking.id,
//   // })
//   //   .then((result) => {
//   //     if (result.success) {
//   //       return prisma.trialBooking.update({
//   //         where: { id: booking.id },
//   //         data: { emailSent: true },
//   //       });
//   //     }
//   //   })
//   //   .catch((err) => console.error("⚠️  Email update failed:", err.message));

//   // // Send WhatsApp — fire and forget (only if phone exists)
//   // if (profile?.phone) {
//   //   sendTrialBookingWhatsApp({
//   //     phone: profile.phone,
//   //     parentName,
//   //     childName,
//   //     teacherName: teacher.name,
//   //     courseLabel,
//   //     dateDisplay,
//   //     timeDisplay,
//   //   })
//   //     .then((result) => {
//   //       if (result.success) {
//   //         return prisma.trialBooking.update({
//   //           where: { id: booking.id },
//   //           data: { whatsappSent: true },
//   //         });
//   //       }
//   //     })
//   //     .catch((err) =>
//   //       console.error("⚠️  WhatsApp update failed:", err.message),
//   //     );
//   // }

//   // Replace the existing notification section with this
  
//   const notifications = await Promise.allSettled([
//     sendTrialBookingConfirmation({
//       to:              req.user.email,
//       parentName,
//       childName,
//       teacherName:     teacher.name,
//       courseLabel,
//       slotStart:       slotStartDate.toISOString(),
//       studentTimezone: tz,
//       bookingId:       booking.id,
//     }),
//     profile?.phone ? sendTrialBookingWhatsApp({
//       phone:       profile.phone,
//       parentName,
//       childName,
//       teacherName: teacher.name,
//       courseLabel,
//       dateDisplay,
//       timeDisplay,
//     }) : Promise.resolve({ success: false, error: 'No phone' }),
//   ]);

//   // Log notification results
//   const [emailResult, waResult] = notifications;

//   if (emailResult.status === 'fulfilled' && emailResult.value?.success) {
//     prisma.trialBooking.update({ where: { id: booking.id }, data: { emailSent: true } })
//       .catch(() => {});
//   } else {
//     console.error('⚠️  Email notification failed:', emailResult.reason || emailResult.value?.error);
//   }
  
//   if (waResult.status === 'fulfilled' && waResult.value?.success) {
//     prisma.trialBooking.update({ where: { id: booking.id }, data: { whatsappSent: true } })
//       .catch(() => {});
//   } else {
//     console.warn('⚠️  WhatsApp notification skipped or failed:', waResult.reason || waResult.value?.error);
//   }

//   // ── 9. Return confirmation ────────────────────────────
//   return res.status(201).json({
//     booking: {
//       id: booking.id,
//       status: booking.status,
//       slotStart: booking.slotStart,
//       slotEnd: booking.slotEnd,
//       teacherName: teacher.name,
//       dateDisplay,
//       timeDisplay,
//     },
//     message:
//       "Trial class booked successfully. Check your email for confirmation.",
//   });
// });


// ── POST /api/booking/trial ────────────────────────────────
// Updated: no teacher assignment, universal calendar, admin notification

router.post('/trial', requireAuth, async (req, res) => {
  const { slotStart, courseInterest, childName, childAge, timezone, genderPreference } = req.body;

  // Validate required fields
  const errors = [];
  if (!slotStart)      errors.push('slotStart is required');
  if (!courseInterest) errors.push('courseInterest is required');
  if (!childName)      errors.push('childName is required');
  if (errors.length)   return res.status(400).json({ error: 'Validation failed', details: errors });

  const validCourses = ['NOORANI_QAIDA','QURAN_RECITATION','TAJWEED','HIFZ','ISLAMIC_STUDIES','ONE_TO_ONE'];
  if (!validCourses.includes(courseInterest)) {
    return res.status(400).json({ error: 'Invalid courseInterest' });
  }

  const validGender = ['MALE','FEMALE','NO_PREFERENCE'];
  const cleanGender = validGender.includes(genderPreference) ? genderPreference : 'NO_PREFERENCE';

  const slot = new Date(slotStart);
  if (isNaN(slot.getTime())) {
    return res.status(400).json({ error: 'Invalid slotStart date' });
  }

  // Must be in the future
  if (slot <= new Date()) {
    return res.status(400).json({ error: 'Selected slot is in the past' });
  }

  try {
    // Step 2 — Check student doesn't already have an active trial
    const existingBooking = await prisma.trialBooking.findFirst({
      where: {
        studentId: req.user.id,
        status:    { notIn: ['CANCELLED'] },
      },
    });
    if (existingBooking) {
      return res.status(409).json({
        error:     'You already have a trial class booked',
        bookingId: existingBooking.id,
        slotStart: existingBooking.slotStart,
      });
    }

    // Step 3 — Race condition guard: re-check slot is still available
    const slotTaken = await prisma.trialBooking.findFirst({
      where: {
        slotStart: slot,
        status:    { notIn: ['CANCELLED'] },
      },
    });
    if (slotTaken) {
      return res.status(409).json({
        error: 'This slot was just taken by someone else. Please select another time.',
      });
    }

    // Step 4 — Get student profile for email/WhatsApp
    const profile = await prisma.studentProfile.findUnique({
      where: { userId: req.user.id },
    });

    const courseLabels = {
      NOORANI_QAIDA:    'Noorani Qaida',
      QURAN_RECITATION: 'Quran Recitation',
      TAJWEED:          'Tajweed',
      HIFZ:             'Hifz Programme',
      ISLAMIC_STUDIES:  'Islamic Studies',
      ONE_TO_ONE:       'One-to-One Private',
    };
    const courseLabel = courseLabels[courseInterest] || courseInterest;

    const userTimezone = timezone || profile?.timezone || 'UTC';
    const dateDisplay  = slot.toLocaleDateString('en-GB', {
      timeZone: userTimezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    const timeDisplay  = slot.toLocaleTimeString('en-GB', {
      timeZone: userTimezone, hour: '2-digit', minute: '2-digit', hour12: false,
    });

    // Step 5 — Create booking record
    const booking = await prisma.trialBooking.create({
      data: {
        studentId:        req.user.id,
        teacherId:        null,         // assigned by admin after booking
        slotStart:        slot,
        durationMins:     30,
        courseInterest,
        genderPreference: cleanGender,
        status:           'PENDING',
      },
    });

    console.log(`✅ Trial booked: ${booking.id} — ${dateDisplay} ${timeDisplay}`);

    // Step 6 — Create Google Calendar event in universal trials calendar
    let calEventId = null;
    try {
      // const { createUniversalTrialEvent } = await import('../services/googleCalendar.js');
      calEventId = await createUniversalTrialEvent({
        slotStart:        slot,
        durationMins:     30,
        parentName:       profile?.parentName || req.user.email,
        childName:        childName || profile?.childName || 'Student',
        courseLabel,
        genderPreference: cleanGender,
        parentEmail:      req.user.email,
      });

      await prisma.trialBooking.update({
        where: { id: booking.id },
        data:  { calEventId },
      });
    } catch (calErr) {
      console.error('❌ Calendar event creation failed (booking still confirmed):', calErr.message);
    }

    // // Step 7 — Send student confirmation email
    // try {
    //   const { sendTrialConfirmation } = await import('../services/email.js');
    //   await sendTrialConfirmation({
    //     parentEmail:  dbUser.email,
    //     parentName:   profile?.parentName || 'Parent',
    //     childName:    childName || profile?.childName || 'your child',
    //     courseLabel,
    //     dateDisplay,
    //     timeDisplay,
    //   });
    // } catch (emailErr) {
    //   console.error('❌ Student confirmation email failed:', emailErr.message);
    // }

    // // Step 8 — Send WhatsApp to student
    // try {
    //   const { sendTrialConfirmationWA } = await import('../services/whatsapp.js');
    //   if (profile?.phone) {
    //     await sendTrialBookingWhatsApp({
    //       to:          profile.phone,
    //       parentName:  profile.parentName || 'Parent',
    //       childName:   childName || profile.childName || 'your child',
    //       courseLabel,
    //       dateDisplay,
    //       timeDisplay,
    //     });
    //   }
    // } catch (waErr) {
    //   console.error('❌ WhatsApp notification failed:', waErr.message);
    // }

    const notifications = await Promise.allSettled([
      sendTrialBookingConfirmation({
        to: req.user.email,
        parentName: profile?.parentName || 'Parent',
        childName: profile?.childName || "Your child",
        // teacherName:     teacher.name,
        courseLabel,
        slotStart:       slot.toISOString(),
        studentTimezone: userTimezone,
        bookingId:       booking.id,
      }),
      profile?.phone ? sendTrialBookingWhatsApp({
        phone: profile.phone,
        parentName: profile?.parentName || 'Parent',
        childName: profile?.childName || "Your child",
        // teacherName: teacher.name,
        courseLabel,
        dateDisplay,
        timeDisplay,
      }) : Promise.resolve({ success: false, error: 'No phone' }),
    ]);
  
    // Log notification results
    const [emailResult, waResult] = notifications;
  
    if (emailResult.status === 'fulfilled' && emailResult.value?.success) {
      prisma.trialBooking.update({ where: { id: booking.id }, data: { emailSent: true } })
        .catch(() => {});
    } else {
      console.error('⚠️  Email notification failed:', emailResult.reason || emailResult.value?.error);
    }
    
    if (waResult.status === 'fulfilled' && waResult.value?.success) {
      prisma.trialBooking.update({ where: { id: booking.id }, data: { whatsappSent: true } })
        .catch(() => {});
    } else {
      console.warn('⚠️  WhatsApp notification skipped or failed:', waResult.reason || waResult.value?.error);
    }

    // Step 9 — Send admin notification emails
    try {
      // const { sendAdminTrialNotification } = await import('../services/email.js');
      await sendAdminTrialNotification({
        parentName:       profile?.parentName || req.user.email,
        childName:        childName || profile?.childName || 'Unknown',
        parentEmail:      req.user.email,
        phone:            profile?.phone || null,
        courseLabel,
        genderPreference: cleanGender,
        dateDisplay,
        timeDisplay,
      });
    } catch (adminEmailErr) {
      console.error('❌ Admin notification failed (booking still confirmed):', adminEmailErr.message);
    }

    return res.status(201).json({
      booking: {
        id:        booking.id,
        slotStart: booking.slotStart,
        status:    booking.status,
        courseInterest: booking.courseInterest,
      },
      dateDisplay,
      timeDisplay,
      message: "Your trial is confirmed. A teacher will be assigned and you'll receive class details within 24 hours.",
    });

  } catch (err) {
    console.error('Trial booking failed:', err);
    return res.status(500).json({ error: 'Failed to create booking' });
  }
});



export default router;
