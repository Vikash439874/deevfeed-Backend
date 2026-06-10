import mongoose from 'mongoose';

function cleanGeneratedContent(value = '') {
  return String(value)
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(line => line && !/^[-\s]*(article|comments?)\s+url\s*:/i.test(line))
    .filter(line => !/^[-\s]*https?:\/\/\S+\s*$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasMeaningfulContent(value = '') {
  const cleaned = cleanGeneratedContent(value);
  return cleaned.split(/\s+/).filter(Boolean).length >= 5;
}

const tagSchema = new mongoose.Schema({
  name: { type: String, required: true },
  confidence: { type: Number, required: true }
}, { _id: false });

const articleSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Article title is required'],
    trim: true
  },
  originalUrl: {
    type: String,
    required: [true, 'Original source URL is required'],
    unique: true,
    trim: true,
    lowercase: true,
    index: true
  },
  summary: {
    type: String,
    required: [true, 'Bulleted summary is required']
  },
  originalContent: {
    type: String,
    default: ''
  },
  body: {
    type: String,
    default: ''
  },
  eli12: {
    type: String,
    default: ''
  },
  keyPoints: {
    type: [String],
    default: []
  },
  whyMatters: {
    type: String,
    default: ''
  },
  category: {
    type: String,
    enum: ['AI', 'Tech', 'IT', 'Biotech', 'Neurotech', 'Health', 'Research Labs', 'Funding', 'Company News', 'Data Science', 'Web3', 'Gaming', 'Cloud', 'DevOps', 'Fintech', 'Cybersecurity', 'Open Source', 'Education', 'Productivity', 'Product Hunt', 'Reddit', 'Venture Capital', 'Research', 'AI Safety', 'AI Ethics', 'AI Governance', 'AI Policy', 'AI Applications', 'AI Development', 'AI Tools', 'AI Company', 'Science', 'Space', 'Startups', 'India', 'World'],
    required: true,
    index: true
  },
  tags: [tagSchema],
  sourceName: {
    type: String,
    required: true,
    index: true
  },
  publishedAt: {
    type: Date,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'published', 'failed', 'duplicate'],
    default: 'pending',
    index: true
  },

  // Deduplication & Clustering parameters
  isClusterMaster: {
    type: Boolean,
    default: false,
    index: true
  },
  clusterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Article',
    default: null,
    index: true
  },

  readingTime: {
    type: Number,
    required: true, // estimated read time in minutes
    default: 1
  },
  rawPayload: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Setup indexes for sorting/filtering recent articles
articleSchema.index({ createdAt: -1 });
articleSchema.index({ isClusterMaster: 1, createdAt: -1 });

articleSchema.pre('validate', function sanitizeReaderFields(next) {
  this.summary = cleanGeneratedContent(this.summary);
  this.body = cleanGeneratedContent(this.body);
  this.eli12 = cleanGeneratedContent(this.eli12);
  this.whyMatters = cleanGeneratedContent(this.whyMatters);
  this.keyPoints = Array.isArray(this.keyPoints)
    ? this.keyPoints.map(cleanGeneratedContent).filter(hasMeaningfulContent)
    : [];

  const originalContent = cleanGeneratedContent(this.originalContent);

  if (!hasMeaningfulContent(this.body)) {
    this.body = hasMeaningfulContent(originalContent) ? originalContent : this.summary || this.title;
  }

  if (!hasMeaningfulContent(this.summary)) {
    this.summary = this.body || this.title;
  }

  next();
});

const Article = mongoose.model('Article', articleSchema);
export default Article;