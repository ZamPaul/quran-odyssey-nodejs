// src/services/purge.js  (NEW)
//
// Hard deletes remove ROWS. They do not remove:
//   • files in Supabase Storage (including children's recitation recordings)
//   • Google Calendar events on teachers' calendars
//   • the Clerk identity (which keeps the email address occupied forever)
//
// This module builds a MANIFEST of those external artifacts BEFORE the delete,
// so they can be purged AFTER the database delete succeeds.
//
// ORDER MATTERS: manifest → DB delete → purge.
// Purging first would leave live rows pointing at dead files if the DB delete
// then failed. This way a mid-purge failure leaves orphaned artifacts and a
// CONSISTENT database, and the manifest is written to the audit log so the
// cleanup can be retried by hand.

import { prisma } from "../lib/prisma.js";
// NOTE: match these two import paths to the ones already used in src/routes/teacher.js
// import { deleteStoredFile } from "./storage.js";
import { deleteStoredFile } from "../lib/storageAdmin.js";
import { deleteBookingEvent } from "./googleCalendar.js";

const TRIAL_CALENDAR_ID =
  process.env.TRIAL_CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || null;

function pushFile(list, { url, path, bucket }) {
  if (!url && !path) return;
  list.push({ url: url || null, path: path || null, bucket: bucket || null });
}

// ─────────────────────────────────────────────────────────
// Build the manifest for ONE learner.
// ─────────────────────────────────────────────────────────
export async function collectStudentManifest(studentId) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { id: true, name: true, accountId: true },
  });
  if (!student) return null;

  const [sessions, assignments, submissions, reports, attendance, enrollments, trials, requests] =
    await Promise.all([
      prisma.classSession.findMany({
        where: { studentId },
        select: { id: true, calEventId: true, teacher: { select: { calendarId: true } } },
      }),
      prisma.assignment.findMany({
        where: { studentId },
        select: { id: true, attachmentUrl: true, attachmentPath: true },
      }),
      prisma.assignmentSubmission.findMany({
        where: { studentId },
        select: { id: true, fileUrl: true, filePath: true },
      }),
      prisma.progressReport.findMany({
        where: { studentId },
        select: { id: true, attachmentUrl: true, attachmentPath: true },
      }),
      prisma.attendanceRecord.count({ where: { studentId } }),
      prisma.enrollment.count({ where: { studentId } }),
      prisma.trialBooking.findMany({ where: { studentId }, select: { id: true, calEventId: true } }),
      prisma.enrollmentRequest.count({ where: { studentId } }),
    ]);

  const files = [];
  for (const a of assignments) pushFile(files, { url: a.attachmentUrl, path: a.attachmentPath });
  for (const s of submissions) pushFile(files, { url: s.fileUrl, path: s.filePath });
  for (const r of reports) pushFile(files, { url: r.attachmentUrl, path: r.attachmentPath, bucket: "reports" });

  const calendarEvents = [];
  for (const s of sessions) {
    if (s.calEventId) {
      calendarEvents.push({ eventId: s.calEventId, calendarId: s.teacher?.calendarId || null, kind: "session" });
    }
  }
  for (const t of trials) {
    if (t.calEventId) {
      calendarEvents.push({ eventId: t.calEventId, calendarId: TRIAL_CALENDAR_ID, kind: "trial" });
    }
  }

  return {
    scope: "student",
    targetId: student.id,
    label: student.name,
    clerkIds: [],
    files,
    calendarEvents,
    counts: {
      students: 1,
      sessions: sessions.length,
      assignments: assignments.length,
      submissions: submissions.length,
      reports: reports.length,
      attendance,
      enrollments,
      trials: trials.length,
      enrollmentRequests: requests,
      files: files.length,
      calendarEvents: calendarEvents.length,
    },
  };
}

// ─────────────────────────────────────────────────────────
// Build the manifest for an ACCOUNT (all of its learners + the Clerk id).
// ─────────────────────────────────────────────────────────
export async function collectAccountManifest(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, clerkId: true, role: true,
      managedStudents: { select: { id: true } },
      teacher: { select: { id: true, name: true } },
    },
  });
  if (!user) return null;

  const perStudent = [];
  for (const s of user.managedStudents) {
    const m = await collectStudentManifest(s.id);
    if (m) perStudent.push(m);
  }

  const files = perStudent.flatMap((m) => m.files);
  const calendarEvents = perStudent.flatMap((m) => m.calendarEvents);
  const sum = (k) => perStudent.reduce((acc, m) => acc + (m.counts[k] || 0), 0);

  return {
    scope: "account",
    targetId: user.id,
    label: user.email,
    role: user.role,
    linkedTeacher: user.teacher ? { id: user.teacher.id, name: user.teacher.name } : null,
    clerkIds: user.clerkId ? [user.clerkId] : [],
    files,
    calendarEvents,
    counts: {
      students: perStudent.length,
      sessions: sum("sessions"),
      assignments: sum("assignments"),
      submissions: sum("submissions"),
      reports: sum("reports"),
      attendance: sum("attendance"),
      enrollments: sum("enrollments"),
      trials: sum("trials"),
      enrollmentRequests: sum("enrollmentRequests"),
      files: files.length,
      calendarEvents: calendarEvents.length,
    },
  };
}

// ─────────────────────────────────────────────────────────
// Purge the external artifacts. Best-effort: every failure is collected and
// returned so the caller can write it to the audit trail for manual retry.
// Never throws.
// ─────────────────────────────────────────────────────────
export async function purgeArtifacts(manifest, { deleteClerk = false } = {}) {
  const failures = [];
  let filesDeleted = 0, eventsDeleted = 0, clerkDeleted = 0;

  // 1. Storage files
  for (const f of manifest.files || []) {
    try {
      await deleteStoredFile({ path: f.path, url: f.url, ...(f.bucket ? { bucket: f.bucket } : {}) });
      filesDeleted++;
    } catch (err) {
      failures.push({ kind: "file", ref: f.path || f.url, error: err.message });
    }
  }

  // 2. Google Calendar events
  for (const e of manifest.calendarEvents || []) {
    if (!e.eventId || !e.calendarId) {
      failures.push({ kind: "calendar", ref: e.eventId || "(no id)", error: "missing calendarId" });
      continue;
    }
    try {
      // NOTE: match this call to your deleteBookingEvent signature.
      await deleteBookingEvent(e.calendarId, e.eventId);
      eventsDeleted++;
    } catch (err) {
      failures.push({ kind: "calendar", ref: e.eventId, error: err.message });
    }
  }

  // 3. Clerk identity — LAST, and only for account deletion.
  // Irreversible, and frees the email address for future re-registration.
  if (deleteClerk) {
    for (const clerkId of manifest.clerkIds || []) {
      try {
        const { createClerkClient } = await import("@clerk/backend");
        const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
        await clerk.users.deleteUser(clerkId);
        clerkDeleted++;
      } catch (err) {
        failures.push({ kind: "clerk", ref: clerkId, error: err.message });
      }
    }
  }

  return {
    filesDeleted,
    eventsDeleted,
    clerkDeleted,
    failures,
    ok: failures.length === 0,
  };
}

// Compact manifest for the audit trail — enough to retry a failed purge by
// hand, without dumping every field into the log.
export function manifestForAudit(manifest, purgeResult) {
  return {
    counts: manifest.counts,
    filesDeleted: purgeResult.filesDeleted,
    eventsDeleted: purgeResult.eventsDeleted,
    clerkDeleted: purgeResult.clerkDeleted,
    purgeOk: purgeResult.ok,
    failures: purgeResult.failures.slice(0, 50),
    // The identifiers needed to finish the job manually if something failed.
    orphanedFiles: purgeResult.failures.filter((f) => f.kind === "file").map((f) => f.ref).slice(0, 50),
    orphanedEvents: purgeResult.failures.filter((f) => f.kind === "calendar").map((f) => f.ref).slice(0, 50),
  };
}