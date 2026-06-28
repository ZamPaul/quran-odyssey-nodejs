// ═══════════════════════════════════════════════════════════
// ENROLLMENT DUPLICATE FIX — Layer 1: shared application guard
//
// NEW FILE: src/lib/enrollmentGuard.js
//
// One helper used by ALL three enrollment-creation paths:
//   • POST /api/admin/students/:id/enroll              (Phase 4)
//   • POST /api/admin/enrollment-requests/:id/convert  (Phase 6)
//   • POST /api/admin/trials/:id/convert               (Phase 6)
//
// It does two things:
//   1. assertNoDuplicateEnrollment() — pre-check that throws a tagged
//      error if an ACTIVE/PAUSED enrollment already exists for the same
//      student + course + teacher.
//   2. isDuplicateEnrollmentDbError() — recognises the Postgres unique-
//      violation from the partial index (P2002), so even a race that
//      slips past the pre-check returns a clean 409, not a 500.
// ═══════════════════════════════════════════════════════════

import { prisma } from "./prisma.js";

// Statuses that count as a "live" enrollment (block duplicates).
const BLOCKING_STATUSES = ["ACTIVE", "PAUSED"];

const COURSE_LABELS = {
  NOORANI_QAIDA: "Noorani Qaida", QURAN_RECITATION: "Quran Recitation",
  TAJWEED: "Tajweed", HIFZ: "Hifz", ISLAMIC_STUDIES: "Islamic Studies",
  ONE_TO_ONE: "One-to-One",
};

// Custom error so routes can map it to a 409 cleanly.
export class DuplicateEnrollmentError extends Error {
  constructor(message, existing) {
    super(message);
    this.name = "DuplicateEnrollmentError";
    this.code = "DUPLICATE_ENROLLMENT";
    this.existing = existing; // the conflicting enrollment (for context)
  }
}

// Pre-check. Throws DuplicateEnrollmentError if a live enrollment exists
// for this student + course + teacher.
export async function assertNoDuplicateEnrollment({ studentId, courseType, teacherId }) {
  const existing = await prisma.enrollment.findFirst({
    where: {
      studentId,
      courseType,
      teacherId,
      status: { in: BLOCKING_STATUSES },
    },
    include: { teacher: { select: { name: true } } },
  });

  if (existing) {
    const courseLabel = COURSE_LABELS[courseType] || courseType;
    const teacherName = existing.teacher?.name || "this teacher";
    throw new DuplicateEnrollmentError(
      `This student is already enrolled in ${courseLabel} with ${teacherName} (status: ${existing.status}). ` +
      `Complete or cancel the existing enrolment before creating a new one.`,
      existing
    );
  }
}

// Recognise the DB-level unique violation from the partial index.
// Prisma throws P2002 on unique-constraint violations.
export function isDuplicateEnrollmentDbError(err) {
  return (
    err?.code === "P2002" &&
    // the partial index name (best signal) OR the target columns
    (String(err?.meta?.target || "").includes("enrollments_active_unique") ||
      String(err?.meta?.target || "").includes("studentId"))
  );
}

// Convenience: a friendly message for the DB-race case.
export function duplicateEnrollmentMessage() {
  return "This student already has an active enrolment for that course with that teacher.";
}