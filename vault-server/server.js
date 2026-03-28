const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const VAULT_FILE = path.join(__dirname, 'vault.json');

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Support large session loads

// Init vault if missing
if (!fs.existsSync(VAULT_FILE)) {
  fs.writeFileSync(VAULT_FILE, JSON.stringify({ board: [], sc: [], jc: [] }, null, 2));
}

// GET /vault
app.get('/vault', (req, res) => {
  try {
    const data = fs.readFileSync(VAULT_FILE, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ error: 'Failed to read vault' });
  }
});

// POST /vault
app.post('/vault', (req, res) => {
  try {
    fs.writeFileSync(VAULT_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write vault' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 FlowState Vault Server running locally at http://localhost:${PORT}`);
  console.log(`Storage File: ${VAULT_FILE}`);
});
