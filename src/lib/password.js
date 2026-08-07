// src/lib/password.js  (NEW)
//
// Replaces the Math.random() generator used in accounts.js and teachers.js.
//
// Math.random() is NOT cryptographically secure — it's a seeded PRNG whose
// output is predictable in principle. It was generating the initial
// credential for every account and teacher on the platform. crypto.randomBytes
// is a CSPRNG and is the correct tool.

import crypto from "crypto";

// Ambiguous characters removed (0/O, 1/l/I) so a temporary password can be
// read aloud over the phone without confusion.
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYMBOL = "!@#$%*?";
const ALL = LOWER + UPPER + DIGIT + SYMBOL;

// Uniform pick from a CSPRNG, rejecting values in the biased tail.
function pick(alphabet) {
  const max = 256 - (256 % alphabet.length);
  let byte;
  do {
    byte = crypto.randomBytes(1)[0];
  } while (byte >= max);
  return alphabet[byte % alphabet.length];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Cryptographically secure temporary password.
 * 16 chars, guaranteed to contain each character class so it always satisfies
 * Clerk's complexity rules. Random enough never to appear in a breach list.
 */
export function generatePassword(length = 16) {
  const required = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  const rest = Array.from({ length: Math.max(length - required.length, 4) }, () => pick(ALL));
  return shuffle([...required, ...rest]).join("");
}

/**
 * Local sanity check before we bother Clerk. Clerk enforces its own rules
 * (minimum 8 characters, rejected if found in known breach lists) — this just
 * catches the obvious cases and gives a better error message.
 */
export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (pw.length > 72) {
    return "Password must be 72 characters or fewer.";
  }
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    return "Password must contain both letters and numbers.";
  }
  return null;
}