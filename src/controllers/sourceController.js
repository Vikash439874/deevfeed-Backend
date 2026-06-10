import FeedSource from '../models/FeedSource.js';
import logger from '../utils/loggerWrapper.js';

/**
 * Seed default RSS feed sources if the collection is empty.
 * Sets up GitHub, Hacker News RSS, Machine Learning subreddits, Biotech, and Health feeds.
 */
const seedDefaultSources = async () => {
  const defaults = [
    {
      name: 'Hacker News (Algolia API Proxy)',
      url: 'https://hnrss.org/frontpage',
      category: 'Tech',
      isActive: true
    },
    {
      name: 'Reddit Machine Learning RSS',
      url: 'https://www.reddit.com/r/MachineLearning/.rss',
      category: 'AI',
      isActive: true
    },
    {
      name: 'GitHub Trending RSS (Ryotarai)',
      url: 'https://github-rss.ryotarai.info/flux/trending/daily/javascript',
      category: 'Tech',
      isActive: true
    },
    {
      name: 'Nature Biotech News RSS',
      url: 'https://www.nature.com/nbt.rss',
      category: 'Science',
      isActive: true
    },
    {
      name: 'MIT Technology Review health',
      url: 'https://www.technologyreview.com/category/biomedicine/feed',
      category: 'Health',
      isActive: true
    },
    {
      name: 'TechCrunch Startups RSS',
      url: 'https://techcrunch.com/category/startups/feed/',
      category: 'Startups',
      isActive: true
    },
    {
      name: 'NASA Breaking News RSS',
      url: 'https://www.nasa.gov/feed/',
      category: 'Space',
      isActive: true
    },
    {
      name: 'Google News - India Tech RSS',
      url: 'https://news.google.com/rss/search?q=technology+India&hl=en-IN&gl=IN&ceid=IN:en',
      category: 'India',
      isActive: true
    },
    {
      name: 'BBC News Technology RSS',
      url: 'http://feeds.bbci.co.uk/news/technology/rss.xml',
      category: 'World',
      isActive: true
    },
    {
      name: 'Wired Security RSS',
      url: 'https://www.wired.com/feed/category/security/latest/rss',
      category: 'Cybersecurity',
      isActive: true
    }
  ];

  try {
    const count = await FeedSource.countDocuments();
    if (count === 0) {
      await FeedSource.insertMany(defaults);
      logger.info(`[Source Seed] Seeded ${defaults.length} default RSS feeds successfully.`);
    }
  } catch (error) {
    logger.error(`[Source Seed] Failed seeding RSS defaults: ${error.message}`);
  }
};

const getSources = async (req, res) => {
  try {
    const sources = await FeedSource.find({}).sort({ name: 1 });
    res.json(sources);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createSource = async (req, res) => {
  const { name, url, category } = req.body;
  try {
    if (!name || !url || !category) {
      return res.status(400).json({ error: 'Name, url, and category are required' });
    }
    const source = await FeedSource.create({ name, url, category });
    logger.info(`[Sources API] Admin added feed source: "${name}" (${url})`);
    res.status(201).json(source);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'A feed source with this URL already exists' });
    }
    res.status(500).json({ error: error.message });
  }
};

const toggleSource = async (req, res) => {
  const { id } = req.params;
  try {
    const source = await FeedSource.findById(id);
    if (!source) {
      return res.status(404).json({ error: 'Feed source not found' });
    }
    source.isActive = !source.isActive;
    await source.save();
    logger.info(`[Sources API] Admin toggled source "${source.name}" to active=${source.isActive}`);
    res.json(source);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteSource = async (req, res) => {
  const { id } = req.params;
  try {
    const source = await FeedSource.findByIdAndDelete(id);
    if (!source) {
      return res.status(404).json({ error: 'Feed source not found' });
    }
    logger.info(`[Sources API] Admin deleted source: "${source.name}"`);
    res.json({ message: 'Feed source deleted successfully', deletedId: id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export { getSources, createSource, toggleSource, deleteSource, seedDefaultSources };
