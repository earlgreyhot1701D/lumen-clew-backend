import express from 'express';
import cors from 'cors';
import { handleScanRequest } from './api/scan.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.set('trust proxy', true);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main scan endpoint
app.post('/api/scan', handleScanRequest);

// Start server
app.listen(PORT, () => {
  console.log(`[LumenClew] Server running on port ${PORT}`);
});
