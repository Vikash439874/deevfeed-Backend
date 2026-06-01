import mongoose from 'mongoose';

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
  category: {
    type: String,
    enum: ['AI', 'Tech', 'IT', 'Biotech', 'Neurotech', 'Health', 'Research Labs', 'Funding', 'Company News', 'Data Science', 'Web3', 'Gaming', 'Cloud', 'DevOps', 'Fintech', 'Cybersecurity', 'Open Source', 'Education', 'Productivity', 'Product Hunt', 'Reddit', 'Venture Capital', 'Research', 'AI Safety', 'AI Ethics', 'AI Governance', 'AI Policy', 'AI Applications', 'AI Development', 'AI Tools', 'AI Company'],
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

const Article = mongoose.model('Article', articleSchema);
export default Article;