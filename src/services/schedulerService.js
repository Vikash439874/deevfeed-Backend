import cron from 'node-cron';
import FeedSource from '../models/FeedSource.js';
import logger from '../utils/loggerWrapper.js';
import { captureException } from '../config/sentry.js';

class SchedulerService {
  constructor() {
    this.syncJob = null;
  }

  /**
   * Initializes the cron scheduler process
   */
  async initScheduler() {
    const cronInterval = process.env.BOT_SYNC_INTERVAL || '*/15 * * * *';

    if (!cron.validate(cronInterval)) {
      logger.error(`[Scheduler] Invalid cron expression: "${cronInterval}". Scheduler failed to start.`);
      return;
    }

    logger.info(`[Scheduler] Initializing RSS fetch scheduler. Interval: "${cronInterval}"`);

    this.syncJob = cron.schedule(cronInterval, async () => {
      logger.info('[Scheduler] Chron trigger fired. Preparing background RSS sync task...');
      try {
        const activeSources = await FeedSource.find({ isActive: true });

        if (activeSources.length === 0) {
          logger.warn('[Scheduler] Sync aborted. No active RSS sources in database.');
          return;
        }

        // Map active sources to BullMQ bulk jobs
        const jobs = activeSources.map((source) => ({
          name: `fetch-${source.name.replace(/\s+/g, '-')}`,
          data: { sourceId: source._id.toString() },
          opts: {
            jobId: `fetch-source-${source._id}-${new Date().setMinutes(0, 0, 0)}` // Hourly deduplication key lock
          }
        }));

        await rssFetchQueue.addBulk(jobs);
        logger.info(`[Scheduler] Dispatched ${jobs.length} jobs to rss-fetch-queue.`);

      } catch (error) {
        logger.error(`[Scheduler] Fetch scheduling failed: ${error.message}`);
        captureException(error, { tags: { service: 'scheduler-service' } });
      }
    });

    logger.info('[Scheduler] Cron loop active and polling.');
  }

  /**
   * Stops the active cron schedule (useful for clean app shutdowns)
   */
  stopScheduler() {
    if (this.syncJob) {
      this.syncJob.stop();
      logger.info('[Scheduler] Cron scheduler halted.');
    }
  }
}

export default new SchedulerService();
export { SchedulerService };
