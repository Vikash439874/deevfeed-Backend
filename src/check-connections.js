/**
 * DevFeed Bot — Connection Diagnostic Script
 * 
 * Run this BEFORE starting the server to confirm all services are reachable:
 *   node src/check-connections.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Redis from 'ioredis';

console.log('\n====================================');
console.log('  DevFeed Bot — Connection Checker');
console.log('====================================\n');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/devfeed-bot';
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

// ── Test 1: MongoDB ─────────────────────────────────────────────
console.log(`[1/2] Testing MongoDB connection...`);
console.log(`      → URI: ${MONGO_URI}\n`);

try {
  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 4000,
    family: 4
  });
  const ping = await mongoose.connection.db.admin().ping();
  console.log(`      ✅ MongoDB is ONLINE. Ping result:`, ping);
  await mongoose.disconnect();
} catch (err) {
  console.error(`      ❌ MongoDB FAILED: ${err.message}`);
  console.error(`      → Make sure MongoDB service is running.`);
  console.error(`      → Open Windows Services (Win+R → services.msc) and start "MongoDB Server".\n`);
}

// ── Test 2: Redis / Memurai ─────────────────────────────────────
console.log(`\n[2/2] Testing Redis/Memurai connection...`);
console.log(`      → Host: ${REDIS_HOST}:${REDIS_PORT}\n`);

const redisTest = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  connectTimeout: 4000,
  maxRetriesPerRequest: 1,
  lazyConnect: true // Don't auto-connect, we'll connect manually
});

try {
  await redisTest.connect();
  const pong = await redisTest.ping();
  if (pong === 'PONG') {
    console.log(`      ✅ Redis/Memurai is ONLINE. Response: ${pong}`);
  } else {
    console.log(`      ⚠️  Redis responded with unexpected: ${pong}`);
  }
  redisTest.disconnect();
} catch (err) {
  console.error(`      ❌ Redis/Memurai FAILED: ${err.message}`);
  console.error(`\n      → SOLUTION: Memurai is not running on port ${REDIS_PORT}.`);
  console.error(`      → Step 1: Open Start Menu → search "Memurai" → Open "Memurai Manager"`);
  console.error(`      → Step 2: If it shows "Stopped", click "Start Service"`);
  console.error(`      → Step 3: Or open Services (Win+R → services.msc) → find "Memurai" → Start`);
  console.error(`      → Step 4: Re-run this script to confirm.\n`);
}

console.log('\n====================================\n');
process.exit(0);
