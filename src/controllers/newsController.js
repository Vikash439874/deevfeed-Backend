import Article from '../models/Article.js';

/**
 * GET /api/news
 * Public endpoint — returns paginated published articles for the news website frontend
 */
export const getNews = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    let category = req.query.category || req.query.cat || null;
    if (category) {
      // Map lowercase categories from frontend to DB category values
      const catMap = {
        ai: 'AI',
        tech: 'Tech',
        sci: 'Science',
        space: 'Space',
        start: 'Startups',
        india: 'India',
        world: 'World',
        health: 'Health',
        cyber: 'Cybersecurity'
      };
      category = catMap[category.toLowerCase()] || category;
    }

    const filter = { status: 'published' };
    if (category) filter.category = category;

    const [articles, total] = await Promise.all([
      Article.find(filter)
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('title summary body eli12 keyPoints whyMatters category tags sourceName originalUrl publishedAt readingTime createdAt'),
      Article.countDocuments(filter)
    ]);

    res.json({
      ok: true,
      articles,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch news articles' });
  }
};

/**
 * POST /api/news
 * Internal endpoint — receives curated articles from the DevFeed Bot
 * Requires a shared secret via Authorization header: Bearer <DEVFEED_API_KEY>
 */
export const receiveNews = async (req, res) => {
  try {
    // Optional API key protection
    const apiKey = process.env.DEVFEED_API_KEY;
    if (apiKey) {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;
      if (token !== apiKey) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const {
      title,
      summary,
      body,
      eli12,
      keyPoints,
      whyMatters,
      category,
      tags,
      sourceName,
      originalUrl,
      publishedAt,
      readingTime
    } = req.body;

    if (!title || !summary || !category || !originalUrl || !sourceName) {
      return res.status(400).json({ error: 'Missing required fields: title, summary, category, originalUrl, sourceName' });
    }

    // Upsert: update if URL already exists, create if not
    const article = await Article.findOneAndUpdate(
      { originalUrl: originalUrl.toLowerCase() },
      {
        title,
        summary,
        body: body || summary,
        eli12: eli12 || '',
        keyPoints: Array.isArray(keyPoints) ? keyPoints : [],
        whyMatters: whyMatters || '',
        category,
        tags: tags ? tags.map(t => ({ name: t, confidence: 1.0 })) : [],
        sourceName,
        originalUrl: originalUrl.toLowerCase(),
        publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
        readingTime: readingTime || 1,
        status: 'published',
        isClusterMaster: true
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ success: true, articleId: article._id });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Article with this URL already exists' });
    }
    res.status(500).json({ error: 'Failed to save article', details: error.message });
  }
};

/**
 * GET /api/news/:id
 * Public endpoint — returns a single article by ID
 */
export const getNewsById = async (req, res) => {
  try {
    const article = await Article.findById(req.params.id)
      .select('title summary body eli12 keyPoints whyMatters category tags sourceName originalUrl publishedAt readingTime createdAt');
    if (!article) return res.status(404).json({ error: 'Article not found' });
    res.json(article);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch article' });
  }
};
