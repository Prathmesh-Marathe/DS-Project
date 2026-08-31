const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 5003;
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:5000';
const MONGO_URI = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());

// --- Database Configuration (Mongo + JSON Fallback) ---
let useMongo = false;
const jsonDbPath = path.join(__dirname, 'data-resources.json');

// Mongoose schema (for when MongoDB is active)
const ResourceStationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  type: { type: String, required: true }, // ambulance, fire, police
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  capacity: { type: Number, required: true },
  availableCount: { type: Number, required: true }
});
let ResourceModel;

// Helper to initialize JSON DB
const initJsonDb = () => {
  const initialData = [
    { id: 'station-1', name: 'Hospital Alpha', type: 'ambulance', location: { lat: 18.5204, lng: 73.8567 }, capacity: 20, availableCount: 20 },
    { id: 'station-2', name: 'City Medical Center', type: 'ambulance', location: { lat: 18.5504, lng: 73.8867 }, capacity: 15, availableCount: 15 },
    { id: 'station-3', name: 'Fire Station Central', type: 'fire', location: { lat: 18.5104, lng: 73.8367 }, capacity: 10, availableCount: 10 },
    { id: 'station-4', name: 'Police Precinct 5', type: 'police', location: { lat: 18.4904, lng: 73.8667 }, capacity: 18, availableCount: 18 },
    { id: 'station-5', name: 'Metro General Hospital', type: 'ambulance', location: { lat: 18.5304, lng: 73.8467 }, capacity: 15, availableCount: 15 },
    { id: 'station-6', name: 'West End Fire Station', type: 'fire', location: { lat: 18.5404, lng: 73.8267 }, capacity: 12, availableCount: 12 },
    { id: 'station-7', name: 'North District Police HQ', type: 'police', location: { lat: 18.5604, lng: 73.8767 }, capacity: 20, availableCount: 20 }
  ];
  if (!fs.existsSync(jsonDbPath) || JSON.parse(fs.readFileSync(jsonDbPath, 'utf8')).length < 7) {
    fs.writeFileSync(jsonDbPath, JSON.stringify(initialData, null, 2));
  }
};

const getResources = async () => {
  if (useMongo) {
    return await ResourceModel.find({});
  } else {
    initJsonDb();
    const data = fs.readFileSync(jsonDbPath, 'utf8');
    return JSON.parse(data);
  }
};

const saveResources = async (resources) => {
  if (useMongo) {
    // Mongo handles saves atomically, this helper is for JSON fallback
    return;
  } else {
    fs.writeFileSync(jsonDbPath, JSON.stringify(resources, null, 2));
  }
};

// Initialize DB Connection
const connectDB = async () => {
  if (MONGO_URI) {
    try {
      await mongoose.connect(MONGO_URI);
      ResourceModel = mongoose.model('ResourceStation', ResourceStationSchema);
      useMongo = true;
      console.log('[Resource Service] Connected to MongoDB');
      
      // Seed Mongo if empty
      const count = await ResourceModel.countDocuments();
      if (count === 0) {
        const initialData = [
          { id: 'station-1', name: 'Hospital Alpha', type: 'ambulance', location: { lat: 18.5204, lng: 73.8567 }, capacity: 20, availableCount: 20 },
          { id: 'station-2', name: 'City Medical Center', type: 'ambulance', location: { lat: 18.5504, lng: 73.8867 }, capacity: 15, availableCount: 15 },
          { id: 'station-3', name: 'Fire Station Central', type: 'fire', location: { lat: 18.5104, lng: 73.8367 }, capacity: 10, availableCount: 10 },
          { id: 'station-4', name: 'Police Precinct 5', type: 'police', location: { lat: 18.4904, lng: 73.8667 }, capacity: 18, availableCount: 18 },
          { id: 'station-5', name: 'Metro General Hospital', type: 'ambulance', location: { lat: 18.5304, lng: 73.8467 }, capacity: 15, availableCount: 15 },
          { id: 'station-6', name: 'West End Fire Station', type: 'fire', location: { lat: 18.5404, lng: 73.8267 }, capacity: 12, availableCount: 12 },
          { id: 'station-7', name: 'North District Police HQ', type: 'police', location: { lat: 18.5604, lng: 73.8767 }, capacity: 20, availableCount: 20 }
        ];
        await ResourceModel.insertMany(initialData);
        console.log('[Resource Service] Seeded MongoDB with initial resources');
      }
    } catch (err) {
      console.error('[Resource Service] MongoDB connection failed. Falling back to local JSON.', err.message);
      useMongo = false;
      initJsonDb();
    }
  } else {
    console.log('[Resource Service] No MONGODB_URI provided. Using local JSON DB.');
    useMongo = false;
    initJsonDb();
  }
};

// Helper: Haversine distance for coordinates
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// --- API Endpoints ---

// Get all resources
app.get('/resources', async (req, res) => {
  try {
    const list = await getResources();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query nearest resources by type and coordinates
app.get('/resources/nearest', async (req, res) => {
  const { type, lat, lng } = req.query;

  if (!type || !lat || !lng) {
    return res.status(400).json({ error: 'Missing parameters type, lat, or lng' });
  }

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  try {
    const list = await getResources();
    const filtered = list.filter(r => r.type === type && r.availableCount > 0);
    
    // Map with distance and sort
    const sorted = filtered.map(r => {
      const distance = calculateDistance(userLat, userLng, r.location.lat, r.location.lng);
      return { ...(r.toObject ? r.toObject() : r), distance };
    }).sort((a, b) => a.distance - b.distance);

    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atomic allocation: Claim resource capacity
app.post('/resources/claim', async (req, res) => {
  const { resourceId } = req.body;

  if (!resourceId) {
    return res.status(400).json({ error: 'Missing resourceId' });
  }

  try {
    if (useMongo) {
      // Mongo Atomic Update
      const updated = await ResourceModel.findOneAndUpdate(
        { id: resourceId, availableCount: { $gt: 0 } },
        { $inc: { availableCount: -1 } },
        { new: true }
      );

      if (!updated) {
        return res.status(409).json({ error: 'Resource unavailable or capacity exhausted' });
      }

      console.log(`[Resource Service] Atomically claimed capacity for ${resourceId}. Remaining: ${updated.availableCount}`);
      return res.json({ success: true, resource: updated });
    } else {
      // JSON File Lock & Update
      const list = await getResources();
      const idx = list.findIndex(r => r.id === resourceId);

      if (idx === -1) {
        return res.status(404).json({ error: 'Resource station not found' });
      }

      if (list[idx].availableCount <= 0) {
        return res.status(409).json({ error: 'Resource capacity exhausted' });
      }

      list[idx].availableCount -= 1;
      await saveResources(list);

      console.log(`[Resource Service] Atomically claimed capacity for ${resourceId}. Remaining: ${list[idx].availableCount}`);
      return res.json({ success: true, resource: list[idx] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Release resource capacity
app.post('/resources/release', async (req, res) => {
  const { resourceId } = req.body;

  if (!resourceId) {
    return res.status(400).json({ error: 'Missing resourceId' });
  }

  try {
    if (useMongo) {
      const updated = await ResourceModel.findOneAndUpdate(
        { id: resourceId, $expr: { $lt: ["$availableCount", "$capacity"] } },
        { $inc: { availableCount: 1 } },
        { new: true }
      );

      if (!updated) {
        // Fallback update in case it goes beyond capacity limit
        const doc = await ResourceModel.findOne({ id: resourceId });
        if (doc && doc.availableCount < doc.capacity) {
          doc.availableCount += 1;
          await doc.save();
          return res.json({ success: true, resource: doc });
        }
        return res.status(400).json({ error: 'Cannot release: Capacity already full' });
      }

      return res.json({ success: true, resource: updated });
    } else {
      const list = await getResources();
      const idx = list.findIndex(r => r.id === resourceId);

      if (idx === -1) {
        return res.status(404).json({ error: 'Resource station not found' });
      }

      if (list[idx].availableCount >= list[idx].capacity) {
        return res.status(400).json({ error: 'Capacity already at maximum' });
      }

      list[idx].availableCount += 1;
      await saveResources(list);

      console.log(`[Resource Service] Released capacity for ${resourceId}. Available: ${list[idx].availableCount}`);
      return res.json({ success: true, resource: list[idx] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start service
app.listen(PORT, async () => {
  await connectDB();
  console.log(`Resource Service running on port ${PORT}`);

  // Dynamic Self-Registration in Naming Registry
  const registerWithRetry = async () => {
    try {
      await axios.post(`${REGISTRY_URL}/register`, {
        type: 'service',
        name: 'resource-service',
        url: process.env.SERVICE_URL || `http://localhost:${PORT}`
      });
      console.log('[Resource Service] Self-registered with Naming Registry successfully');
    } catch (err) {
      console.error('[Resource Service] Self-registration with Registry failed:', err.message, '- Retrying in 5s...');
      setTimeout(registerWithRetry, 5000);
    }
  };
  registerWithRetry();
});
