// src/services/googleCalendar.js
import { google } from 'googleapis';

// ─── Auth ─────────────────────────────────────────────────
// Parse the service account key from the env var
function getAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!keyJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set');
  }

  let credentials;
  try {
    credentials = JSON.parse(keyJson);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON');
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

// ─── Constants ────────────────────────────────────────────
const SLOT_DURATION_MINUTES = 30;

// Support hours in UTC — adjust these to cover UK + US + Canada hours
// 8am UTC = 9am BST / 4am EDT — early enough for UK, reasonable for US East
// 10pm UTC = 11pm BST / 6pm EDT / 3pm PDT — covers US West Coast evenings
const SUPPORT_HOURS = { startHour: 8, endHour: 22 };

// ─── getAvailableSlots ────────────────────────────────────
// Returns array of free 30-min slots for a teacher over the next N days
// All times in UTC ISO strings
export async function getAvailableSlots(calendarId, daysAhead = 14) {
  const auth  = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  // Window: from now until N days ahead
  const now        = new Date();
  const windowEnd  = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + daysAhead);

  // Query Google Calendar freebusy API
  // This returns all busy blocks on the calendar within the window
  let busySlots;
  try {
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin:  now.toISOString(),
        timeMax:  windowEnd.toISOString(),
        timeZone: 'UTC',
        items:    [{ id: calendarId }],
      },
    });

    busySlots = response.data.calendars?.[calendarId]?.busy ?? [];
  } catch (err) {
    console.error('Google Calendar freebusy query failed:', err.message);
    throw new Error('Failed to fetch calendar availability');
  }

  // Convert busy slots to Date ranges for easy comparison
  const busyRanges = busySlots.map(slot => ({
    start: new Date(slot.start),
    end:   new Date(slot.end),
  }));

  // Generate all possible 30-min slots within support hours
  // for each day in the window
  const availableSlots = [];
  const cursor = new Date(now);

  // Start from the next full 30-min boundary
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() < 30 ? 30 : 0);
  if (cursor.getMinutes() === 0) cursor.setHours(cursor.getHours() + 1);

  while (cursor < windowEnd) {
    const slotStart = new Date(cursor);
    const slotEnd   = new Date(cursor);
    slotEnd.setMinutes(slotEnd.getMinutes() + SLOT_DURATION_MINUTES);

    const hour = slotStart.getUTCHours();

    // Only include slots within support hours
    if (hour >= SUPPORT_HOURS.startHour && hour < SUPPORT_HOURS.endHour) {
      // Check if this slot overlaps with any busy range
      const isBusy = busyRanges.some(busy =>
        slotStart < busy.end && slotEnd > busy.start
      );

      if (!isBusy) {
        availableSlots.push({
          start: slotStart.toISOString(),
          end:   slotEnd.toISOString(),
        });
      }
    }

    // Advance cursor by 30 minutes
    cursor.setMinutes(cursor.getMinutes() + SLOT_DURATION_MINUTES);
  }

  return availableSlots;
}

// ─── createBookingEvent ───────────────────────────────────
// Creates a calendar event when a trial is booked
// Returns the created event's ID (stored in TrialBooking.calEventId)
export async function createBookingEvent({
  calendarId,
  slotStart,
  slotEnd,
  studentName,
  parentName,
  courseInterest,
  studentEmail,
  // summary = "",
}) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const courseLabel = courseInterest.replace(/_/g, ' ').toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());

  try {
    const event = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary:     `Trial Class — ${studentName} (${courseLabel})`,
        description: [
          `Student: ${studentName}`,
          `Parent: ${parentName}`,
          `Course: ${courseLabel}`,
          `Contact: ${studentEmail}`,
          '',
          'Zoom link to be added by admin before class.',
        ].join('\n'),
        start: {
          dateTime: slotStart,
          timeZone: 'UTC',
        },
        end: {
          dateTime: slotEnd,
          timeZone: 'UTC',
        },
        colorId: '7', // Teal — visually distinct on the calendar
      },
    });

    console.log(`✅ Calendar event created: ${event.data.id}`);
    return event.data.id;
  } catch (err) {
    console.error('Failed to create calendar event:', err.message);
    console.log("error log in creating booking event:", err)
    throw new Error('Failed to create booking event on calendar');
  }
}

// ─── deleteBookingEvent ───────────────────────────────────
// Cancels the calendar event if a booking is cancelled
// Non-throwing — log the error but don't crash the cancellation flow
export async function deleteBookingEvent(calendarId, eventId) {
  if (!eventId) return;

  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  try {
    await calendar.events.delete({ calendarId, eventId });
    console.log(`✅ Calendar event deleted: ${eventId}`);
  } catch (err) {
    // 410 Gone = already deleted, not a real error
    if (err.code !== 410) {
      console.error('Failed to delete calendar event:', err.message);
    }
  }
}

// Add to src/services/googleCalendar.js
export async function createUniversalTrialEvent({
  slotStart,
  durationMins = 30,
  parentName,
  childName,
  courseLabel,
  genderPreference,
  parentEmail,
}) {
  const calendarId = process.env.UNIVERSAL_CALENDAR_ID;

  if (!calendarId) {
    throw new Error('UNIVERSAL_CALENDAR_ID is not set in environment variables');
  }

  const auth = getAuth();
  const cal = google.calendar({ version: 'v3', auth });

  const start  = new Date(slotStart);
  const end    = new Date(start.getTime() + durationMins * 60 * 1000);

  const genderLabel = {
    MALE:           'Prefers male teacher',
    FEMALE:         'Prefers female teacher',
    NO_PREFERENCE:  'No teacher preference',
  }[genderPreference] || 'No preference stated';

  const event = await cal.events.insert({
    calendarId,
    requestBody: {
      summary:     `Trial Class — ${childName}`,
      description: [
        `Parent: ${parentName}`,
        `Email:  ${parentEmail}`,
        `Course: ${courseLabel}`,
        `Gender preference: ${genderLabel}`,
        '',
        '⚠️ Teacher not yet assigned — assign via Supabase and update this event.',
      ].join('\n'),
      start: { dateTime: start.toISOString(), timeZone: 'UTC' },
      end:   { dateTime: end.toISOString(),   timeZone: 'UTC' },
      colorId: '5', // banana yellow — easy to spot unassigned trials
    },
  });

  return event.data.id;
}