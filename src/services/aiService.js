import { GoogleGenAI } from '@google/genai';
import mongoose from 'mongoose';
import logger from '../utils/loggerWrapper.js';
import { captureException } from '../config/sentry.js';

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
   * Processes a raw article: checks duplicates, polishes title, writes summary, categories & tags.
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
    const prompt = `
You are an elite technology journalist. Review the following article and write a polished headline, summarize it as bullet points, classify it, and extract key tags with confidence scores.

Article:
Title: ${rawArticle.title}
Source: ${rawArticle.sourceName}
Category Hint: ${rawArticle.feedCategory}
Content: ${rawArticle.originalContent}

Instructions:
1. "title": Create a polished, highly professional, dev-focused headline. Clean up clickbait or raw RSS feed titles.
2. "summary": Create a TL;DR summary using 2-4 clean, concise bullet points (use standard hyphen '-' format). Do not include introductory text.
3. "category": Must match one of these exact values: "AI", "Tech", "IT", "Biotech", "Neurotech", "Health", "Research", "Funding", "Company News".
4. "tags": Extract relevant technology tags/hashtags. For each, supply a confidence score between 0.0 and 1.0 based on how central the keyword is to the article. Output tags with a '#' prefix.
5. "readingTime": Calculate an estimated reading time in minutes based on article length and density.

Respond in strict JSON format matching this schema:
{
  "title": "string",
  "summary": "string",
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

    // Apply confidence threshold: Filter out tags with confidence < 0.8
    if (result.tags && Array.isArray(result.tags)) {
      result.tags = result.tags
        .filter(t => t.confidence >= 0.8)
        .map(t => ({
          name: t.name.startsWith('#') ? t.name : `#${t.name}`,
          confidence: t.confidence
        }));
    }

    return result;
  }

  /**
   * Heuristic processing that does not require an API key.
   */
  heuristicMockProcess(rawArticle) {
    logger.info(`[AI Service] Mock-processing article: ${rawArticle.title}`);

    const words = rawArticle.originalContent.split(/\s+/).length;
    const readingTime = Math.max(1, Math.ceil(words / 200));

    // Simple heuristic summary
    const sentences = rawArticle.originalContent.match(/[^.!?]+[.!?]+/g) || [rawArticle.title];
    const bullet1 = sentences[0] ? sentences[0].trim() : rawArticle.title;
    const bullet2 = sentences[1] ? sentences[1].trim() : `Coverage brought to you by ${rawArticle.sourceName}.`;
    const summary = `- ${bullet1}\n- ${bullet2}`;

    // Simple tagging
    const tags = [];
    const lowerContent = rawArticle.originalContent.toLowerCase();

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
      category: rawArticle.feedCategory || 'Tech',
      tags,
      readingTime
    };
  }
}

export default new AIService();
export { AIService };
