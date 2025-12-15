const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

// Placeholder scan endpoint
app.post('/api/scan', (req, res) => {
  const { repoUrl, scanMode } = req.body;

  // This will be filled in by Lovable prompts
  res.json({
    status: 'success',
    message: 'Scan endpoint ready',
    repoUrl,
    scanMode: scanMode || 'fast'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lumen Clew backend running on port ${PORT}`);
});
