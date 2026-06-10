import axios from 'axios';
import logger from '../utils/loggerWrapper.js';
import { captureException } from '../config/sentry.js';

class PublisherService {
  /**
   * Pushes a finalized, curated master article to the devfeed external website.
   * @param {Object} article - The mongoose Article document
   * @returns {Promise<{success: boolean, response: any}>}
   */
  async publishArticle(article) {
    const targetUrl = process.env.DEVFEED_API_URL;
    const apiKey = process.env.DEVFEED_API_KEY;

    if (!targetUrl || targetUrl.trim() === '' || targetUrl.includes('localhost:3000/api/news')) {
      logger.warn(`[Publisher] Target API URL not configured or set to default local. Simulating mock publishing for article: "${article.title}"`);
      return { success: true, mock: true };
    }

    const payload = {
      title: article.title,
      summary: article.summary,
      body: article.body,
      eli12: article.eli12,
      keyPoints: article.keyPoints,
      whyMatters: article.whyMatters,
      category: article.category,
      tags: article.tags.map(t => t.name),
      sourceName: article.sourceName,
      originalUrl: article.originalUrl,
      publishedAt: article.publishedAt,
      readingTime: article.readingTime
    };

    try {
      logger.info(`[Publisher] POST request sending to ${targetUrl} for article ID ${article._id}...`);

      const headers = {
        'Content-Type': 'application/json'
      };

      if (apiKey) {
        // Send authorization header (support standard Bearer or direct key check)
        headers['Authorization'] = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
      }

      const response = await axios.post(targetUrl, payload, {
        headers,
        timeout: 8000 // 8-second request timeout limit
      });

      logger.info(`[Publisher] Successfully posted to devfeed! HTTP Response Code: ${response.status}`);
      return { success: true, response: response.data };

    } catch (error) {
      logger.error(`[Publisher] Failed to post article ID ${article._id} to target: ${error.message}`, {
        url: targetUrl,
        response: error.response?.data
      });
      captureException(error, {
        tags: { service: 'publisher-service', target: targetUrl },
        extra: { articleId: article._id, payload }
      });
      return { success: false, error: error.message };
    }
  }
}

export default new PublisherService();
export { PublisherService };
