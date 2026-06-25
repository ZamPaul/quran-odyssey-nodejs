// ═══════════════════════════════════════════════════════════
// AGE / BIRTHDAY HELPER  →  src/lib/age.js  (NEW FILE)
//
// Used by both backend and frontend (pure functions, no deps).
// Backend: import where you build student responses.
// Frontend: copy into a matching util (or share if your repo allows).
//
// Option (c): when dateOfBirth exists, age is ALWAYS derived from it.
// The stored `age` int is only used as a fallback when dateOfBirth is null.
// ═══════════════════════════════════════════════════════════

// Compute age in whole years from a date of birth.
export function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// The age to DISPLAY for a student: derived from DOB when present,
// otherwise the stored int.
export function resolveAge(student) {
  const derived = ageFromDob(student?.dateOfBirth);
  return derived != null ? derived : (student?.age ?? null);
}

// Is today the student's birthday? (month + day match, ignoring year)
export function isBirthdayToday(dob) {
  if (!dob) return false;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// The age the student turns on their NEXT birthday (for "turns 10" copy).
export function turningAge(dob) {
  const a = ageFromDob(dob);
  if (a == null) return null;
  // If today is the birthday, they're turning (age) today; otherwise next birthday is age+1
  return isBirthdayToday(dob) ? a : a + 1;
}

// Days until the next birthday (0 = today). Null if no dob.
export function daysUntilBirthday(dob, fromDate = new Date()) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;

  const from = new Date(
    fromDate.getFullYear(),
    fromDate.getMonth(),
    fromDate.getDate(),
  );
  let next = new Date(from.getFullYear(), d.getMonth(), d.getDate());
  if (next < from)
    next = new Date(from.getFullYear() + 1, d.getMonth(), d.getDate());

  // Handle Feb 29 birthdays in non-leap years → treat as Mar 1
  if (d.getMonth() === 1 && d.getDate() === 29 && next.getMonth() === 2) {
    // JS rolled it to Mar 1 automatically; that's fine
  }
  const ms = next - from;
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

// ─── Validation (used on save) ────────────────────────────
// DOB must: be a valid date, not be in the future, imply age 1..99.
// Returns { ok: true, date } or { ok: false, error }.
export function validateDob(input) {
  if (input === null || input === undefined || input === "") {
    return { ok: true, date: null }; // clearing the DOB is allowed
  }
  const d = new Date(input);
  if (isNaN(d.getTime()))
    return { ok: false, error: "Date of birth is not a valid date" };

  const now = new Date();
  if (d > now)
    return { ok: false, error: "Date of birth cannot be in the future" };

  const age = ageFromDob(d);
  if (age < 1)
    return { ok: false, error: "Date of birth implies an age under 1 year" };
  if (age > 99)
    return { ok: false, error: "Date of birth implies an age over 99 years" };

  return { ok: true, date: d };
}
