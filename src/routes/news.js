import express from 'express';
import { getNews, receiveNews, getNewsById } from '../controllers/newsController.js';

const router = express.Router();

// GET /api/news         — Public: fetch paginated published articles for the news website
// GET /api/news/:id     — Public: fetch a single article by ID
// POST /api/news        — Internal: receive curated article from the DevFeed Bot

router.get('/', getNews);
router.get('/:id', getNewsById);
router.post('/', receiveNews);

export default router;
