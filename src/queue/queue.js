import { Queue } from 'bullmq';
import { redisConfig } from '../config/redis.js';

// Shared BullMQ job options
const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000
  },
  removeOnComplete: { age: 3600 },  // auto-clean completed jobs after 1 hour
  removeOnFail: { age: 86400 }       // auto-clean failed jobs after 24 hours
};

// Queue 1: Fetches raw RSS XML feed files
const rssFetchQueue = new Queue('rss-fetch-queue', {
  connection: redisConfig,
  defaultJobOptions
});

// Queue 2: Processes articles through Gemini AI and publishes them
const aiProcessQueue = new Queue('ai-process-queue', {
  connection: redisConfig,
  defaultJobOptions: {
    ...defaultJobOptions,
    limiter: {
      max: 15,       // Max 15 Gemini requests per minute (free tier limit)
      duration: 60000
    }
  }
});

console.log('[Queue] ✅ BullMQ queues initialized: rss-fetch-queue, ai-process-queue');

export { rssFetchQueue, aiProcessQueue };
