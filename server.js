const express = require('express');
const app = express();

app.use(express.json());

app.post('/api/scan', (req, res) => {
  res.json({ status: 'success', message: 'Backend ready' });
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Server running on port 3000');
});
