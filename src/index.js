import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

// Routessss
import webhooksRouter from './routes/webhooks.js';
import studentsRouter from './routes/students.js'
import bookingRouter  from './routes/booking.js'; 
import leadsRouter from './routes/leads.js';
import teacherRouter from "./routes/teacher.js"
import enrollmentRouter from './routes/enrollments.js';

import adminRouter from './routes/admin/index.js';

import {
  teacherLimiter,
  bookingLimiter,
  webhookLimiter,
} from './middleware/rateLimiter.js';

const app = express();
const PORT = process.env.PORT || 3001;


// ── Security headers ───────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,   // allow Clerk iframes
  contentSecurityPolicy:     false,   // handled at CDN/Vercel level
}));

// ── Logging ────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ─── CORS ─────────────────────────────────
// Allow your Next.js frontend to call this backend
const allowedOrigins = [
  'http://localhost:3000',
  'https://quranodyssey.com',
  'https://www.quranodyssey.com',
  'https://quran-odyssey-nextjs.vercel.app',
  // production domain
  process.env.FRONTEND_URL,             // set on Railway
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman, server-to-server, mobile apps)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked: origin ${origin} not allowed`));
  },
  credentials: true,
  methods:     ['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ─── Body Parsing ─────────────────────────
// IMPORTANT: raw body needed for Clerk webhook signature verification
// Must come BEFORE express.json()
app.use('/webhooks', express.raw({ type: 'application/json' }));
// Limit request body size — prevent large payload attacks
app.use(express.json({ limit: '200kb' }));

// ── Request timeout ────────────────────────────────────────
// Any request that takes > 30 seconds is terminated
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  next();
});

// ── Health check ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV || 'development',
  });
});

// ─── Routes ───────────────────────────────
app.use('/webhooks', webhookLimiter, webhooksRouter);
app.use('/api/students', studentsRouter);
app.use('/api/booking', bookingRouter); 
// Add after existing routes
app.use('/api/leads', leadsRouter);
app.use('/api/teacher', teacherLimiter, teacherRouter);   // ADD THIS
app.use('/api/enrollment', enrollmentRouter);
app.use('/api/admin', adminRouter);
// Uncomment as you build each phase

// ── 404 handler ────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ───────────────────────────────────
// Intentionally minimal — never leak stack traces in production
app.use((err, req, res, next) => {
  const status = err.status || 500;

  // Always log server errors
  if (status >= 500) {
    console.error('❌ Server error:', err.stack || err.message);
  }

  // CORS errors become 403
  if (err.message?.startsWith('CORS blocked')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  // In production, never expose internal error details for 5xx
  const message =
    process.env.NODE_ENV === 'production' && status >= 500
      ? 'Internal server error'
      : err.message || 'Something went wrong';

  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  if (!process.env.CLERK_SECRET_KEY)        console.warn('⚠️  CLERK_SECRET_KEY not set');
  if (!process.env.DATABASE_URL)            console.warn('⚠️  DATABASE_URL not set');
  if (!process.env.CLERK_WEBHOOK_SECRET)    console.warn('⚠️  CLERK_WEBHOOK_SECRET not set');
});