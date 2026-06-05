// src/middleware/rateLimiter.js
import rateLimit from 'express-rate-limit';

const defaults = {
  standardHeaders: true,
  legacyHeaders:   false,
};

// Teacher dashboard routes — authenticated, moderate limit
export const teacherLimiter = rateLimit({
  ...defaults,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      300,
  message:  { error: 'Too many requests. Please slow down and try again in 15 minutes.' },
  // Skip rate limiting in test environment
  skip: () => process.env.NODE_ENV === 'test',
});

// Write operations — create/update/delete
export const writeLimiter = rateLimit({
  ...defaults,
  windowMs: 15 * 60 * 1000,
  max:      60,
  message:  { error: 'Too many write requests. Please try again in 15 minutes.' },
  skip: () => process.env.NODE_ENV === 'test',
});

// Grading and sending reports — heavier operations
export const heavyLimiter = rateLimit({
  ...defaults,
  windowMs: 60 * 60 * 1000, // 1 hour
  max:      100,
  message:  { error: 'Too many requests for this operation. Please try again in an hour.' },
  skip: () => process.env.NODE_ENV === 'test',
});

// Booking — prevent spam
export const bookingLimiter = rateLimit({
  ...defaults,
  windowMs: 60 * 60 * 1000,
  max:      10,
  message:  { error: 'Too many booking attempts. Please try again in an hour.' },
  skip: () => process.env.NODE_ENV === 'test',
});

// Webhook endpoint — generous but bounded
export const webhookLimiter = rateLimit({
  ...defaults,
  windowMs: 5 * 60 * 1000,
  max:      50,
  message:  { error: 'Webhook rate limit exceeded.' },
});