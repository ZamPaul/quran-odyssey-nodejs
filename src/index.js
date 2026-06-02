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

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Security & Logging ───────────────────
app.use(helmet());
app.use(morgan('dev'));

// ─── CORS ─────────────────────────────────
// Allow your Next.js frontend to call this backend
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://quranodyssey.com',
    'https://www.quranodyssey.com',
    'https://quran-odyssey-nextjs.vercel.app',
    // production domain
    process.env.FRONTEND_URL,             // set on Railway
  ].filter(Boolean),
  credentials: true,
}));

// ─── Body Parsing ─────────────────────────
// IMPORTANT: raw body needed for Clerk webhook signature verification
// Must come BEFORE express.json()
app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── Health Check ─────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────
app.use('/webhooks', webhooksRouter);
app.use('/api/students', studentsRouter);
app.use('/api/booking', bookingRouter); 
// Add after existing routes
app.use('/api/leads', leadsRouter);
app.use('/api/teacher',  teacherRouter);   // ADD THIS
// Uncomment as you build each phase

// ─── Error Handler ────────────────────────
app.use((err, req, res, next) => {
  console.log("Error handler working: ")
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});