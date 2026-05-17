require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

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
// Uncomment as you build each phase
// app.use('/webhooks', require('./routes/webhooks'));
// app.use('/api/students', require('./routes/students'));
// app.use('/api/booking', require('./routes/booking'));

// ─── Error Handler ────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});