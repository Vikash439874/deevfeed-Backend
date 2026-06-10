import axios from 'axios';
import Parser from 'rss-parser';
import FeedSource from '../models/FeedSource.js';
import Article from '../models/Article.js';
import logger from '../utils/loggerWrapper.js';
import { captureException } from '../config/sentry.js';

const parser = new Parser({
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['dc:creator', 'creator']
    ]
  }
});

const MIN_USEFUL_CONTENT_CHARS = 180;
const MAX_ARTICLE_CONTENT_CHARS = 12000;

function decodeHtmlEntities(text = '') {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(html = '') {
  return decodeHtmlEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|article|section)>/gi, '. ')
    .replace(/<[^>]+>/g, ' '));
}

function removeFeedBoilerplate(text = '') {
  return String(text)
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(line => line && !/^[-\s]*(article|comments?)\s+url\s*:/i.test(line))
    .filter(line => !/^[-\s]*https?:\/\/\S+\s*$/i.test(line))
    .join('\n');
}

function normalizeText(text = '') {
  return removeFeedBoilerplate(stripHtml(text))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

function isUsefulArticleText(text = '') {
  const cleaned = normalizeText(text);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (cleaned.length < MIN_USEFUL_CONTENT_CHARS || words.length < 25) return false;
  if (/^article url\s*:/i.test(cleaned)) return false;
  if (/^https?:\/\/\S+$/i.test(cleaned)) return false;
  return true;
}

function chooseFeedContent(item) {
  return [
    item.contentEncoded,
    item['content:encoded'],
    item.content,
    item.summary,
    item.contentSnippet,
    item.description
  ].filter(Boolean).join('\n');
}

function extractArticleUrl(item) {
  const raw = chooseFeedContent(item);
  const match = raw.match(/article\s+url\s*:\s*(https?:\/\/[^\s<]+)/i);
  return match?.[1] ? decodeHtmlEntities(match[1]).replace(/[),.]+$/, '').trim() : '';
}

function extractReadableTextFromHtml(html = '') {
  const withoutNoise = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');

  const articleMatch = withoutNoise.match(/<article[\s\S]*?<\/article>/i);
  const mainMatch = withoutNoise.match(/<main[\s\S]*?<\/main>/i);
  const bodyMatch = withoutNoise.match(/<body[\s\S]*?<\/body>/i);
  const candidate = articleMatch?.[0] || mainMatch?.[0] || bodyMatch?.[0] || withoutNoise;

  return normalizeText(candidate).slice(0, MAX_ARTICLE_CONTENT_CHARS);
}

/**
 * Service to fetch and parse RSS feeds with HTTP header optimizations.
 */
class FetcherService {
  /**
   * Fetches an RSS feed, checking for updates using ETag and Last-Modified headers.
   * @param {string} sourceId - The MongoDB ID of the FeedSource.
   * @returns {Promise<{status: string, items: Array}>} status: 'new' | 'not_modified' | 'error', and new items list
   */
  async fetchFeed(sourceId) {
    const source = await FeedSource.findById(sourceId);
    if (!source) {
      throw new Error(`FeedSource with ID ${sourceId} not found`);
    }

    if (!source.isActive) {
      logger.warn(`[Fetcher] Skipping inactive feed: ${source.name}`);
      return { status: 'inactive', items: [] };
    }

    const headers = {
      'User-Agent': 'DevFeed-Curation-Bot/1.0 (Enterprise News Curator; http://localhost:5000)'
    };

    if (source.eTag) {
      headers['If-None-Match'] = source.eTag;
    }
    if (source.lastModified) {
      headers['If-Modified-Since'] = source.lastModified;
    }

    try {
      logger.info(`[Fetcher] Requesting RSS: ${source.name} (${source.url})`, {
        eTag: source.eTag,
        lastModified: source.lastModified
      });

      const response = await axios.get(source.url, {
        headers,
        timeout: 10000,
        validateStatus: (status) => status === 200 || status === 304
      });

      if (response.status === 304) {
        logger.info(`[Fetcher] 304 Not Modified: ${source.name}. Skipping parsing.`);
        
        // Update last synced timestamp
        source.lastSyncedAt = new Date();
        await source.save();
        
        return { status: 'not_modified', items: [] };
      }

      // If we get 200, parse the XML feed body
      const xmlData = response.data;
      const feed = await parser.parseString(xmlData);
      
      // Update ETag and Last-Modified headers from response metadata
      const newETag = response.headers['etag'] || null;
      const newLastModified = response.headers['last-modified'] || null;

      source.eTag = newETag;
      source.lastModified = newLastModified;
      source.lastSyncedAt = new Date();
      await source.save();

      logger.info(`[Fetcher] Parsed ${feed.items?.length || 0} items from ${source.name}. Headers updated.`);

      // Filter duplicates based on unique URLs already recorded in MongoDB
      const newItems = [];
      for (const item of (feed.items || [])) {
        const itemUrl = (extractArticleUrl(item) || item.link || item.guid || '').trim();
        if (!itemUrl) continue;

        // Fast lookup in DB index
        const exists = await Article.exists({ originalUrl: itemUrl.toLowerCase() });
        if (!exists) {
          const feedText = normalizeText(chooseFeedContent(item));
          const linkedText = isUsefulArticleText(feedText)
            ? ''
            : await this.fetchLinkedArticleText(itemUrl, source.name);
          const originalContent = isUsefulArticleText(feedText)
            ? feedText
            : linkedText || this.buildSparseFallback(item, source);

          newItems.push({
            title: item.title || 'Untitled Article',
            originalUrl: itemUrl,
            originalContent,
            publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
            sourceName: source.name,
            feedCategory: source.category
          });
        }
      }

      logger.info(`[Fetcher] Found ${newItems.length} novel articles not in database.`);
      return { status: 'new', items: newItems };

    } catch (error) {
      logger.error(`[Fetcher] Failed to fetch feed ${source.name}: ${error.message}`, {
        url: source.url,
        stack: error.stack
      });
      captureException(error, {
        tags: { service: 'fetcher-service', feed: source.name },
        extra: { url: source.url }
      });
      return { status: 'error', items: [] };
    }
  }

  async fetchLinkedArticleText(url, sourceName) {
    if (!/^https?:\/\//i.test(url)) return '';

    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'DevFeed-Curation-Bot/1.0 (Article Content Extractor)'
        },
        timeout: 12000,
        maxContentLength: 2_000_000,
        validateStatus: (status) => status >= 200 && status < 300
      });

      const text = extractReadableTextFromHtml(response.data);
      if (isUsefulArticleText(text)) return text;

      logger.warn(`[Fetcher] Linked article text was not useful for ${sourceName}: ${url}`);
      return '';
    } catch (error) {
      logger.warn(`[Fetcher] Could not fetch linked article body for ${sourceName}: ${error.message}`, { url });
      return '';
    }
  }

  buildSparseFallback(item, source) {
    const title = normalizeText(item.title || 'Untitled Article');
    const creator = normalizeText(item.creator || item.author || source.name);
    const category = normalizeText(source.category || 'Tech');

    return [
      title,
      `This ${category} story was discovered from ${source.name}.`,
      creator && creator !== source.name ? `Original author or feed creator: ${creator}.` : ''
    ].filter(Boolean).join(' ');
  }
}

export default new FetcherService();
export { FetcherService };
