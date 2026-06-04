import 'dotenv/config'; // Loads .env first — must stay at the top!
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import connectDB from './config/db.js';
import { getRedisClient } from './config/redis.js';
import { initSentry } from './config/sentry.js';
import logger from './utils/loggerWrapper.js';
import * as Sentry from '@sentry/node';

// Load routes
import authRoutes from './routes/auth.js';
import botRoutes from './routes/bot.js';
import sourceRoutes from './routes/sources.js';
import healthRoutes from './routes/health.js';
import newsRoutes from './routes/news.js';


import './models/Source.js';
import './models/Article.js';

// Load initial seeding helpers
import { seedDefaultAdmin } from './controllers/authController.js';
import { seedDefaultSources } from './controllers/sourceController.js';

// Load background scheduler
import schedulerService from './services/schedulerService.js';
import './workers/rssWorker.js';


const app = express();
const PORT = process.env.PORT || 5000;

// 1. Initialize Sentry APM Tracking
initSentry(app);

// The Sentry request handler must be the first middleware on the app
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.requestHandler());
}

// 2. Production Security Hardening
app.use(helmet()); // Apply strict headers (CSP, XSS Protection, frameguard, etc.)

// Enable CORS
app.use(cors({
  origin: '*', // We can restrict this in production (e.g. to our Netlify dashboard URL)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. API Route Bindings
app.use('/health', healthRoutes); // Public unthrottled healthcheck endpoint
app.use('/api/auth', authRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/sources', sourceRoutes);
app.use('/api/news', newsRoutes); // Public news feed + bot submission endpoint

// Base Route
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'DevFeed News Curation Bot API Server',
    version: '1.0.0',
    healthCheck: `http://localhost:${PORT}/health`
  });
});

// The Sentry error handler must be before any other error middleware and after all controllers
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// 4. Global Error Handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';

  logger.error(`[Server Error] ${status} - ${message} - Request IP: ${req.ip} - Path: ${req.originalUrl}`, {
    stack: err.stack
  });

  res.status(status).json({
    error: {
      message,
      status
    }
  });
});

// Database connection & Server startup
const startServer = async () => {
  try {
    // Step 1: Connect MongoDB
    logger.info('[Server] Connecting to MongoDB...');
    await connectDB();

    // Step 2: Pre-warm Redis/Memurai connection
    logger.info('[Server] Connecting to Redis/Memurai...');
    const redisClient = getRedisClient();
    // Wait up to 5s for Redis to become ready
    await new Promise((resolve, reject) => {
      if (redisClient.status === 'ready') return resolve();
      const timeout = setTimeout(() => {
        logger.warn('[Server] Redis did not connect within 5s. Continuing anyway — health endpoint will show degraded status.');
        resolve(); // Don't crash — Redis might just be slow
      }, 5000);
      redisClient.once('ready', () => { clearTimeout(timeout); resolve(); });
      redisClient.once('error', (err) => {
        clearTimeout(timeout);
        logger.warn(`[Server] Redis connection warning: ${err.message}. Make sure Memurai is running.`);
        resolve(); // Still don't crash — app works without Redis for basic routes
      });
    });

    // Step 3: Seed initial Admin User & Popular RSS feeds if not present
    await seedDefaultAdmin();
    await seedDefaultSources();

    // Step 4: Start background schedulers
    await schedulerService.initScheduler();

    app.listen(PORT, () => {
      logger.info(`[Server] ✅ DevFeed Bot running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
      logger.info(`[Server] 🌐 Dashboard API: http://localhost:${PORT}/`);
      logger.info(`[Server] 💚 Health Check:  http://localhost:${PORT}/health`);
    });
  } catch (error) {
    logger.error(`[Server] Startup failed: ${error.message}`);
    process.exit(1);
  }
};

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

startServer();