// src/routes/booking.js
import express from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getAvailableSlots,
  createBookingEvent,
} from "../services/googleCalendar.js";
import { sendTrialBookingConfirmation } from "../services/email.js";
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
router.get("/availability", requireAuth, async (req, res) => {
  const { teacherId, daysAhead } = req.query;

  if (!teacherId) {
    return res
      .status(400)
      .json({ error: "teacherId query parameter is required" });
  }

  // Fetch teacher from DB to get their calendar ID
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: {
      id: true,
      name: true,
      calendarId: true,
      timezone: true,
      isActive: true,
    },
  });

  if (!teacher) {
    return res.status(404).json({ error: "Teacher not found" });
  }

  if (!teacher.isActive) {
    return res
      .status(400)
      .json({ error: "Teacher is not currently accepting bookings" });
  }

  if (!teacher.calendarId || teacher.calendarId.startsWith("placeholder")) {
    return res
      .status(503)
      .json({ error: "Teacher calendar not configured yet" });
  }

  try {
    const slots = await getAvailableSlots(
      teacher.calendarId,
      daysAhead ? parseInt(daysAhead, 10) : 14,
    );

    return res.json({
      teacher: {
        id: teacher.id,
        name: teacher.name,
        timezone: teacher.timezone,
      },
      slots,
      count: slots.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Availability fetch failed:", err.message);
    return res.status(503).json({
      error: "Calendar availability temporarily unavailable. Please try again.",
    });
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
router.post("/trial", requireAuth, async (req, res) => {
  const { teacherId, slotStart, studentTimezone } = req.body;

  // ── 1. Validate input ────────────────────────────────
  if (!teacherId || !slotStart || !studentTimezone) {
    return res.status(400).json({
      error: "teacherId, slotStart, and studentTimezone are required",
    });
  }

  // Validate slotStart is a valid ISO date string
  const slotStartDate = new Date(slotStart);
  if (isNaN(slotStartDate.getTime())) {
    return res
      .status(400)
      .json({ error: "slotStart must be a valid ISO date string" });
  }

  // Reject slots in the past
  if (slotStartDate < new Date()) {
    return res.status(400).json({ error: "Cannot book a slot in the past" });
  }

  const slotEndDate = new Date(slotStartDate.getTime() + 30 * 60 * 1000);

  // ── 2. Check student doesn't already have a booking ──
  const existingBooking = await prisma.trialBooking.findFirst({
    where: { studentId: req.user.id },
  });

  if (existingBooking) {
    return res.status(409).json({
      error: "You already have a trial class booked",
      bookingId: existingBooking.id,
      slotStart: existingBooking.slotStart,
      status: existingBooking.status,
    });
  }

  // ── 3. Fetch teacher ──────────────────────────────────
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { id: true, name: true, calendarId: true, isActive: true },
  });

  if (!teacher || !teacher.isActive) {
    return res.status(404).json({ error: "Teacher not found or unavailable" });
  }

  if (!teacher.calendarId || teacher.calendarId.startsWith("placeholder")) {
    return res.status(503).json({ error: "Teacher calendar not configured" });
  }

  // ── 4. Re-check slot availability ────────────────────
  // Protects against two users booking the same slot simultaneously
  const conflictingBooking = await prisma.trialBooking.findFirst({
    where: {
      teacherId,
      slotStart: slotStartDate,
    },
  });

  if (conflictingBooking) {
    return res.status(409).json({
      error:
        "This slot was just taken by another student. Please choose a different time.",
    });
  }

  // ── 5. Create TrialBooking in DB ──────────────────────
  let booking;
  try {
    booking = await prisma.trialBooking.create({
      data: {
        studentId: req.user.id,
        teacherId: teacher.id,
        slotStart: slotStartDate,
        slotEnd: slotEndDate,
        status: "PENDING",
        studentTimezone,
      },
    });

    console.log(`✅ TrialBooking created: ${booking.id}`);
  } catch (err) {
    // Unique constraint violation — someone else booked this exact slot
    // between our check and our insert (true race condition)
    if (err.code === "P2002") {
      return res.status(409).json({
        error: "This slot was just taken. Please choose a different time.",
      });
    }

    console.error("❌ Failed to create TrialBooking:", err);
    return res.status(500).json({ error: "Failed to create booking" });
  }

  // ── 6. Create Google Calendar event ──────────────────
  // This IS blocking — if calendar fails, we still have the DB record
  // Admin can manually create the event. Log and continue.
  let calEventId = null;
  try {
    const profile = req.user.studentProfile;
    const courseLabel =
      profile?.courseInterest
        ?.replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase()) || "Quran Class";

    calEventId = await createBookingEvent({
      calendarId: teacher.calendarId,
      slotStart: slotStartDate.toISOString(),
      slotEnd: slotEndDate.toISOString(),
      studentName: profile?.childName || "Student",
      parentName: profile?.parentName || req.user.email,
      courseInterest: profile?.courseInterest || "QURAN_RECITATION",
      studentEmail: req.user.email,
    });

    // Save the calendar event ID
    await prisma.trialBooking.update({
      where: { id: booking.id },
      data: { calEventId },
    });

    console.log("calendar event created successfully");
  } catch (err) {
    console.error(
      "⚠️  Calendar event creation failed (booking still saved):",
      err.message,
    );
    // Don't return — booking is created, continue to notifications
  }

  // ── 7 & 8. Notifications — non-blocking ──────────────
  // Build shared display values for both email and WhatsApp
  const profile = req.user.studentProfile;
  const parentName = profile?.parentName || "Parent";
  const childName = profile?.childName || "your child";
  const courseLabel =
    profile?.courseInterest
      ?.replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || "Quran Class";

  const start = slotStartDate;
  const end = slotEndDate;
  const tz = studentTimezone;

  const dateDisplay = start.toLocaleDateString("en-GB", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const timeStart = start.toLocaleTimeString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });

  const timeEnd = end.toLocaleTimeString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });

  const tzAbbr = start
    .toLocaleTimeString("en-GB", {
      timeZone: tz,
      timeZoneName: "short",
    })
    .split(" ")
    .pop();

  const timeDisplay = `${timeStart} – ${timeEnd} (${tzAbbr})`;

  // Send email — fire and forget
  sendTrialBookingConfirmation({
    to: req.user.email,
    parentName,
    childName,
    teacherName: teacher.name,
    courseLabel,
    slotStart: slotStartDate.toISOString(),
    studentTimezone: tz,
    bookingId: booking.id,
  })
    .then((result) => {
      if (result.success) {
        return prisma.trialBooking.update({
          where: { id: booking.id },
          data: { emailSent: true },
        });
      }
    })
    .catch((err) => console.error("⚠️  Email update failed:", err.message));

  // Send WhatsApp — fire and forget (only if phone exists)
  if (profile?.phone) {
    sendTrialBookingWhatsApp({
      phone: profile.phone,
      parentName,
      childName,
      teacherName: teacher.name,
      courseLabel,
      dateDisplay,
      timeDisplay,
    })
      .then((result) => {
        if (result.success) {
          return prisma.trialBooking.update({
            where: { id: booking.id },
            data: { whatsappSent: true },
          });
        }
      })
      .catch((err) =>
        console.error("⚠️  WhatsApp update failed:", err.message),
      );
  }

  // ── 9. Return confirmation ────────────────────────────
  return res.status(201).json({
    booking: {
      id: booking.id,
      status: booking.status,
      slotStart: booking.slotStart,
      slotEnd: booking.slotEnd,
      teacherName: teacher.name,
      dateDisplay,
      timeDisplay,
    },
    message:
      "Trial class booked successfully. Check your email for confirmation.",
  });
});

// ─── POST /api/booking/trial ──────────────────────────────

// router.post("/trial", requireAuth, async (req, res) => {
//   const profile = req.user.studentProfile;
//   if (!profile) {
//     return res.status(403).json({
//       error: "Complete your student profile before booking a trial class.",
//     });
//   }

//   const {
//     teacherId,
//     slotStart,
//     slotEnd,
//     courseInterest,
//     childName,
//     childAge,
//     studentTimezone,
//   } = req.body;

//   if (!teacherId || !slotStart || !slotEnd) {
//     return res.status(400).json({
//       error: "teacherId, slotStart, and slotEnd are required",
//     });
//   }

//   const resolvedCourse = courseInterest || profile.courseInterest;
//   if (!VALID_COURSES.includes(resolvedCourse)) {
//     return res.status(400).json({ error: "Invalid course interest value" });
//   }

//   const age = parseInt(childAge ?? profile.childAge, 10);
//   if (isNaN(age) || age < 4 || age > 18) {
//     return res.status(400).json({ error: "Child age must be between 4 and 18" });
//   }

//   const resolvedChildName = (childName || profile.childName)?.trim();
//   const resolvedTimezone = studentTimezone || profile.timezone;
//   if (!resolvedChildName) {
//     return res.status(400).json({ error: "Child name is required" });
//   }
//   if (!resolvedTimezone) {
//     return res.status(400).json({ error: "Timezone is required" });
//   }

//   const existingTrial = await prisma.trialBooking.findFirst({
//     where: {
//       studentId: req.user.id,
//       status: { in: ["PENDING", "CONFIRMED"] },
//     },
//   });

//   if (existingTrial) {
//     return res.status(409).json({
//       code: "TRIAL_EXISTS",
//       error: "You already have a trial class booked.",
//       bookingId: existingTrial.id,
//     });
//   }

//   const teacher = await prisma.teacher.findUnique({
//     where: { id: teacherId },
//   });

//   if (!teacher || !teacher.isActive) {
//     return res.status(404).json({ error: "Teacher not found or inactive" });
//   }

//   if (!teacher.calendarId || teacher.calendarId.startsWith("placeholder")) {
//     return res.status(503).json({ error: "Teacher calendar not configured yet" });
//   }

//   const slotStartIso = new Date(slotStart).toISOString();
//   const slotEndIso = new Date(slotEnd).toISOString();
//   const expectedEnd = new Date(new Date(slotStartIso).getTime() + 30 * 60 * 1000);
//   if (slotEndIso !== expectedEnd.toISOString()) {
//     return res.status(400).json({ error: "Invalid slot duration" });
//   }

//   try {
//     const slots = await getAvailableSlots(teacher.calendarId, 14);
//     const stillAvailable = slots.some((s) => s.start === slotStartIso);
//     if (!stillAvailable) {
//       return res.status(409).json({
//         code: "SLOT_TAKEN",
//         error: "This slot was just taken. Please pick another.",
//       });
//     }
//   } catch (err) {
//     console.error("Slot re-check failed:", err.message);
//     return res.status(503).json({
//       error: "Could not verify slot availability. Please try again.",
//     });
//   }

//   const courseLabel = courseEnumToLabel(resolvedCourse);
//   let booking;

//   try {
//     booking = await prisma.trialBooking.create({
//       data: {
//         studentId: req.user.id,
//         teacherId: teacher.id,
//         slotStart: new Date(slotStartIso),
//         slotEnd: new Date(slotEndIso),
//         status: "PENDING",
//         studentTimezone: resolvedTimezone,
//       },
//       include: { teacher: { select: { name: true } } },
//     });
//   } catch (err) {
//     if (err.code === "P2002") {
//       return res.status(409).json({
//         code: "SLOT_TAKEN",
//         error: "This slot was just taken. Please pick another.",
//       });
//     }
//     console.error("TrialBooking create failed:", err);
//     return res.status(500).json({ error: "Failed to create booking" });
//   }

//   let calEventId;
//   try {
//     calEventId = await createBookingEvent({
//       calendarId: teacher.calendarId,
//       slotStart: slotStartIso,
//       slotEnd: slotEndIso,
//       studentName: resolvedChildName,
//       parentName: profile.parentName,
//       courseInterest: resolvedCourse,
//       studentEmail: req.user.email,
//     });
//   } catch (err) {
//     console.error("Calendar event failed, rolling back booking:", err.message);
//     await prisma.trialBooking.delete({ where: { id: booking.id } });
//     return res.status(503).json({
//       error: "Could not reserve this slot on the calendar. Please try another.",
//     });
//   }

//   booking = await prisma.trialBooking.update({
//     where: { id: booking.id },
//     data: { calEventId },
//     include: { teacher: { select: { name: true } } },
//   });

//   try {
//     const emailResult = await sendTrialBookingConfirmation({
//       to: req.user.email,
//       parentName: profile.parentName,
//       childName: resolvedChildName,
//       teacherName: teacher.name,
//       courseLabel,
//       slotStart: slotStartIso,
//       studentTimezone: resolvedTimezone,
//       bookingId: booking.id,
//     });
//     if (emailResult.success) {
//       await prisma.trialBooking.update({
//         where: { id: booking.id },
//         data: { emailSent: true },
//       });
//     }
//   } catch (err) {
//     console.error("Email notification failed:", err.message);
//   }

//   try {
//     const waResult = await sendTrialBookingWhatsApp({
//       to: profile.phone,
//       parentName: profile.parentName,
//       childName: resolvedChildName,
//       teacherName: teacher.name,
//       courseLabel,
//       slotStart: slotStartIso,
//       studentTimezone: resolvedTimezone,
//       bookingId: booking.id,
//     });
//     if (waResult.success) {
//       await prisma.trialBooking.update({
//         where: { id: booking.id },
//         data: { whatsappSent: true },
//       });
//     }
//   } catch (err) {
//     console.error("WhatsApp notification failed:", err.message);
//   }

//   return res.status(201).json({
//     bookingId: booking.id,
//     status: booking.status,
//     teacher: { id: teacher.id, name: teacher.name },
//     slotStart: slotStartIso,
//     slotEnd: slotEndIso,
//     childName: resolvedChildName,
//     courseInterest: resolvedCourse,
//     courseLabel,
//     studentTimezone: resolvedTimezone,
//     bookingRef: booking.id.toUpperCase().slice(-8),
//   });
// });

export default router;
