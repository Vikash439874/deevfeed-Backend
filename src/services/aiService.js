import { GoogleGenAI } from '@google/genai';
import mongoose from 'mongoose';
import logger from '../utils/loggerWrapper.js';
import { captureException } from '../config/sentry.js';
import Article from '../models/Article.js';

class AIService {
  constructor() {
    this.ai = null;
    this.isMock = false;
    this.initClient();
  }

  initClient() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_gemini_api_key_here')) {
      logger.warn('[AI Service] GEMINI_API_KEY is not configured. Falling back to heuristic mock AI processing.');
      this.isMock = true;
    } else {
      try {
        this.ai = new GoogleGenAI({ apiKey });
        logger.info('[AI Service] Google Gemini API Client initialized successfully.');
      } catch (error) {
        logger.error(`[AI Service] Failed to initialize Gemini client: ${error.message}`);
        this.isMock = true;
      }
    }
  }

  /**
   * Processes a raw article: checks duplicates, polishes title, writes summary, reader content, categories & tags.
   */
  async processArticle(rawArticle) {
    if (this.isMock) {
      return this.heuristicMockProcess(rawArticle);
    }

    try {
      // 1. Semantic Deduplication check against recent master articles (past 36 hours)
      const deduplicationResult = await this.checkDeduplication(rawArticle);
      if (deduplicationResult.isDuplicate) {
        return {
          isDuplicate: true,
          clusterId: deduplicationResult.matchedMasterId,
          summary: deduplicationResult.reason,
          tags: [],
          readingTime: 1
        };
      }

      // 2. Perform curation processing (polish title, categorize, tag, summarize, readTime)
      const curationResult = await this.curateContent(rawArticle);
      return {
        isDuplicate: false,
        clusterId: null,
        ...curationResult
      };

    } catch (error) {
      logger.error(`[AI Service] Error processing article "${rawArticle.title}": ${error.message}`);
      captureException(error, { tags: { service: 'ai-service', operation: 'processArticle' } });
      // Fail-safe: fallback to mockup rather than crashing the worker
      return this.heuristicMockProcess(rawArticle);
    }
  }

  /**
   * Stage 1: Call Gemini to compare new content with a list of recent covers
   */
  async checkDeduplication(rawArticle) {
    const sinceDate = new Date(Date.now() - 36 * 60 * 60 * 1000); // 36h sliding window
    const recentMasters = await Article.find({
      isClusterMaster: true,
      createdAt: { $gte: sinceDate }
    }).select('_id title category summary');

    if (recentMasters.length === 0) {
      return { isDuplicate: false, matchedMasterId: null, reason: 'No recent articles to compare' };
    }

    const recentList = recentMasters.map(m => `[ID: ${m._id}] Title: ${m.title} | Cat: ${m.category}\nSummary: ${m.summary}`).join('\n---\n');

    const prompt = `
You are a senior tech news editor. Your task is to determine if the "New Article" covers the exact same announcement, press release, product launch, funding news, or research paper as any of the "Recent Coverages" in our database.

Recent Coverages:
${recentList}

New Article:
Title: ${rawArticle.title}
Source: ${rawArticle.sourceName}
Content: ${rawArticle.originalContent}

Compare them. If the new article is about the same event, launch, or news story (even if by a different publisher or with slightly different wording), mark it as a duplicate and output the exact ID of the matching Recent Coverage.
If it covers a different news item, product, repo, or event, it is NOT a duplicate.

You must respond in strict JSON format matching this schema:
{
  "isDuplicate": boolean,
  "matchedMasterId": string | null,
  "reason": "Explain the decision in 1 sentence. If duplicate, describe how it matches the master."
}
`;

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const text = response.text;
      const result = JSON.parse(text);

      if (result.isDuplicate && result.matchedMasterId) {
        // Double check the matched master actually exists in DB
        const matchExists = recentMasters.some(m => m._id.toString() === result.matchedMasterId);
        if (matchExists) {
          return result;
        }
      }

      return { isDuplicate: false, matchedMasterId: null, reason: 'Not a duplicate' };
    } catch (error) {
      logger.error(`[AI Service] Deduplication API request failed: ${error.message}`);
      return { isDuplicate: false, matchedMasterId: null, reason: 'API call error fallback' };
    }
  }

  /**
   * Stage 2: Call Gemini to curate content
   */
  async curateContent(rawArticle) {
    const cleanContent = this.fallbackBody(rawArticle);
    const prompt = `
You are an elite technology journalist. Review the following article and write reader-ready news content for a student-focused tech news website.

Article:
Title: ${rawArticle.title}
Source: ${rawArticle.sourceName}
Category Hint: ${rawArticle.feedCategory}
Content: ${cleanContent}

Instructions:
1. "title": Create a polished, highly professional, dev-focused headline. Clean up clickbait or raw RSS feed titles.
2. "summary": Create a TL;DR summary using 2-4 clean, concise bullet points with standard hyphen '-' bullets.
3. "body": Write 2-5 short paragraphs of article body text based only on the article content and title.
4. "eli12": Explain the article simply for a curious 12-year-old in 2-3 sentences.
5. "keyPoints": Return 3-5 meaningful takeaway strings.
6. "whyMatters": Explain why this story matters in 1-2 concise sentences.
7. "category": Must match one of these exact values: "AI", "Tech", "Science", "Space", "Startups", "India", "World", "Health", "Cybersecurity".
8. "tags": Extract relevant technology tags/hashtags. For each, supply a confidence score between 0.0 and 1.0 based on how central the keyword is to the article. Output tags with a '#' prefix.
9. "readingTime": Calculate an estimated reading time in minutes based on article length and density.

Never use "Article URL:", "Comments URL:", a bare URL, or source-link boilerplate as summary, body, eli12, keyPoints, or whyMatters.

Respond in strict JSON format matching this schema:
{
  "title": "string",
  "summary": "string",
  "body": "string",
  "eli12": "string",
  "keyPoints": ["string"],
  "whyMatters": "string",
  "category": "string",
  "tags": [
    { "name": "string", "confidence": number }
  ],
  "readingTime": number
}
`;

    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const result = JSON.parse(response.text);

    return this.sanitizeCurationResult(result, rawArticle);
  }

  /**
   * Heuristic processing that does not require an API key.
   */
  heuristicMockProcess(rawArticle) {
    logger.info(`[AI Service] Mock-processing article: ${rawArticle.title}`);

    const body = this.fallbackBody(rawArticle);
    const words = body.split(/\s+/).length;
    const readingTime = Math.max(1, Math.ceil(words / 200));

    const sentences = body.match(/[^.!?]+[.!?]+/g) || [rawArticle.title];
    const bullet1 = sentences[0] ? sentences[0].trim() : rawArticle.title;
    const bullet2 = sentences[1] ? sentences[1].trim() : `Coverage brought to you by ${rawArticle.sourceName}.`;
    const summary = `- ${bullet1}\n- ${bullet2}`;

    // Simple tagging
    const tags = [];
    const lowerContent = `${rawArticle.title} ${body}`.toLowerCase();

    if (lowerContent.includes('ai') || lowerContent.includes('gpt') || lowerContent.includes('llm') || lowerContent.includes('model')) {
      tags.push({ name: '#AI', confidence: 0.95 });
    }
    if (lowerContent.includes('github') || lowerContent.includes('repo') || lowerContent.includes('code')) {
      tags.push({ name: '#GitHub', confidence: 0.92 });
    }
    if (lowerContent.includes('funding') || lowerContent.includes('seed') || lowerContent.includes('raised')) {
      tags.push({ name: '#Funding', confidence: 0.90 });
    }
    if (tags.length === 0) {
      tags.push({ name: '#TechNews', confidence: 0.85 });
    }

    return {
      isDuplicate: false,
      clusterId: null,
      title: `[Polished] ${rawArticle.title}`,
      summary,
      body,
      eli12: this.buildSimpleExplanation(rawArticle, body),
      keyPoints: this.buildKeyPoints(rawArticle, body),
      whyMatters: this.buildWhyMatters(rawArticle, body),
      category: rawArticle.feedCategory || 'Tech',
      tags,
      readingTime
    };
  }

  sanitizeCurationResult(result, rawArticle) {
    const body = this.meaningfulText(result.body)
      ? this.cleanText(result.body)
      : this.fallbackBody(rawArticle);

    const summary = this.meaningfulText(result.summary)
      ? this.cleanText(result.summary)
      : this.buildSummary(rawArticle, body);

    const keyPoints = Array.isArray(result.keyPoints)
      ? result.keyPoints.map(point => this.cleanText(point)).filter(point => this.meaningfulText(point, 4)).slice(0, 5)
      : [];

    const tags = Array.isArray(result.tags)
      ? result.tags
          .filter(t => Number(t.confidence) >= 0.8 && t.name)
          .map(t => ({
            name: String(t.name).startsWith('#') ? String(t.name) : `#${t.name}`,
            confidence: Number(t.confidence)
          }))
      : [];

    return {
      title: this.cleanText(result.title || rawArticle.title || 'Untitled Article').slice(0, 220),
      summary,
      body,
      eli12: this.meaningfulText(result.eli12)
        ? this.cleanText(result.eli12)
        : this.buildSimpleExplanation(rawArticle, body),
      keyPoints: keyPoints.length ? keyPoints : this.buildKeyPoints(rawArticle, body),
      whyMatters: this.meaningfulText(result.whyMatters)
        ? this.cleanText(result.whyMatters)
        : this.buildWhyMatters(rawArticle, body),
      category: this.validCategory(result.category) ? result.category : (rawArticle.feedCategory || 'Tech'),
      tags,
      readingTime: Math.max(1, Number(result.readingTime) || Math.ceil(body.split(/\s+/).length / 200))
    };
  }

  validCategory(category) {
    return ['AI', 'Tech', 'Science', 'Space', 'Startups', 'India', 'World', 'Health', 'Cybersecurity'].includes(category);
  }

  cleanText(text = '') {
    return String(text)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .split(/\r?\n+/)
      .map(line => line.trim())
      .filter(line => line && !/^[-\s]*(article|comments?)\s+url\s*:/i.test(line))
      .filter(line => !/^[-\s]*https?:\/\/\S+\s*$/i.test(line))
      .join('\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  meaningfulText(text = '', minWords = 8) {
    const cleaned = this.cleanText(text);
    if (!cleaned) return false;
    if (/^article url\s*:/i.test(cleaned)) return false;
    if (/^https?:\/\/\S+$/i.test(cleaned)) return false;
    return cleaned.split(/\s+/).filter(Boolean).length >= minWords;
  }

  fallbackBody(rawArticle) {
    const content = this.cleanText(rawArticle.originalContent || '');
    if (this.meaningfulText(content, 12)) return content;

    return this.cleanText([
      rawArticle.title || 'Untitled Article',
      `This ${rawArticle.feedCategory || 'Tech'} story was collected from ${rawArticle.sourceName || 'a trusted feed'}.`,
      'The source feed did not provide enough full article text, so this entry is summarized from the available headline and source metadata.'
    ].join(' '));
  }

  buildSummary(rawArticle, body) {
    const sentences = body.match(/[^.!?]+[.!?]+/g) || [body || rawArticle.title];
    const bullets = sentences
      .map(sentence => this.cleanText(sentence))
      .filter(sentence => this.meaningfulText(sentence, 5))
      .slice(0, 3);

    if (bullets.length === 0) {
      bullets.push(this.cleanText(rawArticle.title || 'New article discovered by DeevFeed Bot.'));
    }

    return bullets.map(point => `- ${point}`).join('\n');
  }

  buildSimpleExplanation(rawArticle, body) {
    const first = this.cleanText((body.match(/[^.!?]+[.!?]+/) || [body])[0] || rawArticle.title);
    return `${first} In simple terms, this is a ${rawArticle.feedCategory || 'technology'} update worth watching because it may affect developers, students, researchers, or the tools they use.`;
  }

  buildKeyPoints(rawArticle, body) {
    const sentences = body.match(/[^.!?]+[.!?]+/g) || [];
    const points = sentences
      .map(sentence => this.cleanText(sentence))
      .filter(sentence => this.meaningfulText(sentence, 5))
      .slice(0, 4);

    if (points.length < 3) {
      points.push(this.cleanText(rawArticle.title || 'A new story was detected by the bot.'));
      points.push(`Source: ${rawArticle.sourceName || 'DeevFeed Bot'}`);
      points.push(`Category: ${rawArticle.feedCategory || 'Tech'}`);
    }

    return [...new Set(points)].slice(0, 5);
  }

  buildWhyMatters(rawArticle, body) {
    const category = rawArticle.feedCategory || 'Tech';
    return `This matters because it adds a fresh signal in ${category}, helping readers track important changes without reading every source manually.`;
  }
}

export default new AIService();
export { AIService };
