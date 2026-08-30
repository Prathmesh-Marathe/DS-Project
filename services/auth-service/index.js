const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5005;
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:5000';
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-derrcs';

app.use(cors());
app.use(express.json());

// In-memory fallback
let useMongo = false;
const usersFallback = [
  { username: 'admin', password: 'password', role: 'admin', name: 'System Admin' },
  { username: 'dispatcher1', password: 'password', role: 'dispatch', name: 'Dispatcher 1' },
  { username: 'citizen1', password: 'password', role: 'citizen', name: 'John Doe' },
  { username: 'responder1', password: 'password', role: 'responder', name: 'Ambulance Station-1' },
  { username: 'responder2', password: 'password', role: 'responder', name: 'Fire Station Central' }
];

const connectDB = async () => {
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      useMongo = true;
      console.log('[Auth Service] Connected to MongoDB');
      // A full implementation would define schemas and seed data here
    } catch (err) {
      console.error('[Auth Service] MongoDB connection failed:', err.message);
      useMongo = false;
    }
  } else {
    console.log('[Auth Service] Using local memory auth fallback.');
  }
};

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  // Simplified auth logic (using fallback data for demo)
  const user = usersFallback.find(u => u.username === username && u.password === password);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { username: user.username, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({ token, user: { username: user.username, role: user.role, name: user.name } });
});

app.get('/health', (req, res) => res.json({ status: 'UP' }));

app.listen(PORT, async () => {
  await connectDB();
  console.log(`Auth Service running on port ${PORT}`);

  const registerWithRetry = async () => {
    try {
      await axios.post(`${REGISTRY_URL}/register`, {
        type: 'service',
        name: 'auth-service',
        url: process.env.SERVICE_URL || `http://localhost:${PORT}`
      });
      console.log('[Auth Service] Self-registered with Naming Registry successfully');
    } catch (err) {
      console.error('[Auth Service] Self-registration failed:', err.message, '- Retrying in 5s...');
      setTimeout(registerWithRetry, 5000);
    }
  };
  registerWithRetry();
});
