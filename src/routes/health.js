import express from 'express';
import mongoose from 'mongoose';
import { getRedisClient } from '../config/redis.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const healthInfo = {
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    status: 'healthy',
    services: {
      mongodb: 'checking...',
      redis: 'checking...'
    }
  };

  let overallOk = true;

  // ── 1. MongoDB Check ──────────────────────────────────────────
  try {
    const mongoState = mongoose.connection.readyState;
    // readyState: 0=disconnected 1=connected 2=connecting 3=disconnecting
    if (mongoState === 1) {
      const t0 = Date.now();
      await mongoose.connection.db.admin().ping();
      healthInfo.services.mongodb = `online (${Date.now() - t0}ms)`;
    } else if (mongoState === 2) {
      healthInfo.services.mongodb = 'connecting... (try again in a moment)';
      overallOk = false;
    } else {
      healthInfo.services.mongodb = `offline (state=${mongoState})`;
      overallOk = false;
    }
  } catch (err) {
    healthInfo.services.mongodb = `error: ${err.message}`;
    overallOk = false;
  }

  // ── 2. Redis / Memurai Check ──────────────────────────────────
  // We PING directly — don't rely on .status which can be stale
  try {
    const redis = getRedisClient();

    // Give it up to 2 seconds to respond
    const pingPromise = redis.ping();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Redis ping timed out after 2s')), 2000)
    );

    const t0 = Date.now();
    const result = await Promise.race([pingPromise, timeoutPromise]);

    if (result === 'PONG') {
      healthInfo.services.redis = `online (${Date.now() - t0}ms)`;
    } else {
      healthInfo.services.redis = `unexpected reply: ${result}`;
      overallOk = false;
    }
  } catch (err) {
    // Give a helpful message depending on the error
    if (err.message.includes('timed out')) {
      healthInfo.services.redis = 'offline — Memurai is not responding (start Memurai service)';
    } else if (err.message.includes('ECONNREFUSED')) {
      healthInfo.services.redis = 'offline — connection refused on 127.0.0.1:6379 (is Memurai running?)';
    } else {
      healthInfo.services.redis = `error: ${err.message}`;
    }
    overallOk = false;
  }

  healthInfo.status = overallOk ? 'healthy' : 'degraded';
  res.status(overallOk ? 200 : 503).json(healthInfo);
});

export default router;
