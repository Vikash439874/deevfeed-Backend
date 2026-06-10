// Force the environment variable directly at startup
const apiKey = process.env.GEMINI_API_KEY;


import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Force the worker to look exactly 2 folders up for your .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Your other worker imports go below this line...
import { Worker } from 'bullmq';
import { redisConfig } from '../config/redis.js';
import connectDB from '../config/db.js';
import fetcherService from '../services/fetcherService.js';
import aiService from '../services/aiService.js';
import publisherService from '../services/publisherService.js';
import Article from '../models/Article.js';
import { aiProcessQueue } from '../queue/queue.js';
import logger from '../utils/loggerWrapper.js';
import { captureException } from '../config/sentry.js';

// Load environment variables
dotenv.config();

// Ensure database is connected for worker runtime
let dbConnected = false;

const initWorkerRuntime = async () => {
  if (!dbConnected) {
    await connectDB();
    dbConnected = true;
  }
};

/**
 * 1. RSS Fetcher Worker
 * Pulls jobs from 'rss-fetch-queue', downloads RSS XML feed, filters local URL duplicates,
 * and schedules AI processing for each novel article.
 */
const rssFetchWorker = new Worker(
  'rss-fetch-queue',
  async (job) => {
    await initWorkerRuntime();
    const { sourceId } = job.data;

    logger.info(`[Fetch Worker] Job ${job.id} started. Syncing Source ID: ${sourceId}`);

    const result = await fetcherService.fetchFeed(sourceId);

    if (result.status === 'new' && result.items.length > 0) {
      logger.info(`[Fetch Worker] Queuing ${result.items.length} articles for AI processing.`);

      // Add each article as an independent job in 'ai-process-queue'
      const jobs = result.items.map((item) => ({
        name: `ai-process-${item.title.substring(0, 30)}`,
        data: item,
        opts: {
          jobId: `ai-item-${Buffer.from(item.originalUrl).toString('base64').substring(0, 100)}` // Unique ID to prevent queuing same item twice in Redis
        }
      }));

      await aiProcessQueue.addBulk(jobs);
    }

    return { status: result.status, itemsFetched: result.items.length };
  },
  {
    connection: redisConfig,
    concurrency: 2 // Fetch up to 2 RSS XML files concurrently
  }
);

/**
 * 2. AI Processing Worker
 * Takes raw novel articles, runs them through the Gemini cognitive logic (summarizer, clustering, hashtags),
 * stores the finalized item in MongoDB, and triggers publication if clean.
 */
const aiProcessWorker = new Worker(
  'ai-process-queue',
  async (job) => {
    await initWorkerRuntime();
    const rawArticle = job.data;

    logger.info(`[AI Worker] Job ${job.id} processing article: "${rawArticle.title}"`);

    try {
      // 1. Process article details using Gemini AI (summarize, tag, categorize, deduplicate)
      const aiResult = await aiService.processArticle(rawArticle);

      if (aiResult.isDuplicate) {
        logger.info(`[AI Worker] Article detected as semantic duplicate of master ID: ${aiResult.clusterId}`);

        // Save as duplicate referencing the master cluster
        const duplicateArticle = await Article.create({
          title: rawArticle.title,
          originalUrl: rawArticle.originalUrl.toLowerCase(),
          summary: `[Semantic Duplicate] ${aiResult.summary || 'Content matches master cluster.'}`,
          originalContent: rawArticle.originalContent,
          body: aiResult.body || rawArticle.originalContent,
          eli12: aiResult.eli12 || '',
          keyPoints: aiResult.keyPoints || [],
          whyMatters: aiResult.whyMatters || '',
          category: aiResult.category || rawArticle.feedCategory,
          tags: aiResult.tags || [],
          sourceName: rawArticle.sourceName,
          publishedAt: rawArticle.publishedAt,
          status: 'duplicate',
          isClusterMaster: false,
          clusterId: aiResult.clusterId,
          readingTime: aiResult.readingTime || 1,
          rawPayload: rawArticle
        });

        return { status: 'duplicate', articleId: duplicateArticle._id };
      }

      // 2. Create the Master Article in MongoDB
      const masterArticle = await Article.create({
        title: aiResult.title || rawArticle.title, // AI-generated polished title
        originalUrl: rawArticle.originalUrl.toLowerCase(),
        summary: aiResult.summary, // Bulleted TL;DR summary
        originalContent: rawArticle.originalContent,
        body: aiResult.body,
        eli12: aiResult.eli12,
        keyPoints: aiResult.keyPoints,
        whyMatters: aiResult.whyMatters,
        category: aiResult.category,
        tags: aiResult.tags,
        sourceName: rawArticle.sourceName,
        publishedAt: rawArticle.publishedAt,
        status: 'pending', // Pending publication to devfeed website
        isClusterMaster: true,
        clusterId: null, // Masters point to null clusterId, children point to master ID
        readingTime: aiResult.readingTime || 1,
        rawPayload: rawArticle
      });

      // 3. Immediately publish to DevFeed website
      logger.info(`[AI Worker] Publishing master article ID ${masterArticle._id} to DevFeed API...`);
      const publishResult = await publisherService.publishArticle(masterArticle);

      if (publishResult.success) {
        masterArticle.status = 'published';
      } else {
        masterArticle.status = 'failed';
        logger.warn(`[AI Worker] Publication failed for ID ${masterArticle._id}, saved as failed for retry.`);
      }
      await masterArticle.save();

      return { status: masterArticle.status, articleId: masterArticle._id };

    } catch (error) {
      logger.error(`[AI Worker] Execution crashed on job ${job.id}: ${error.message}`, {
        article: rawArticle.title,
        url: rawArticle.originalUrl,
        stack: error.stack
      });
      captureException(error, {
        tags: { service: 'ai-process-worker', article: rawArticle.title },
        extra: { url: rawArticle.originalUrl }
      });
      throw error; // Let BullMQ handle retry exponential backoff
    }
  },
  {
    connection: redisConfig,
    concurrency: 1 // Process AI requests sequentially to avoid rate limits (Gemini API constraints)
  }
);

// Worker Event Listeners
rssFetchWorker.on('completed', (job, result) => {
  logger.info(`[Fetch Worker] Job ${job.id} succeeded. Feed sync complete:`, result);
});

rssFetchWorker.on('failed', (job, err) => {
  logger.error(`[Fetch Worker] Job ${job.id} failed: ${err.message}`);
});

aiProcessWorker.on('completed', (job, result) => {
  logger.info(`[AI Worker] Job ${job.id} succeeded:`, result);
});

aiProcessWorker.on('failed', (job, err) => {
  logger.error(`[AI Worker] Job ${job.id} failed: ${err.message}`);
});

logger.info('[Worker] BullMQ Background Workers started successfully and listening for jobs.');
