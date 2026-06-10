import mongoose from 'mongoose';

const feedSourceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Feed name is required'],
    trim: true
  },
  url: {
    type: String,
    required: [true, 'Feed URL is required'],
    unique: true,
    trim: true,
    lowercase: true
  },
  category: {
    type: String,
    required: [true, 'Feed category is required'],
    enum: ['AI', 'Tech', 'Science', 'Space', 'Startups', 'India', 'World', 'Health', 'Cybersecurity'],
    default: 'Tech'
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  eTag: {
    type: String,
    default: null
  },
  lastModified: {
    type: String,
    default: null
  },
  lastSyncedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

const FeedSource = mongoose.model('FeedSource', feedSourceSchema);
export default FeedSource;
