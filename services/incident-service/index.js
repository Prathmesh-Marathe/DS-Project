const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const mqtt = require('mqtt');

const app = express();
const PORT = process.env.PORT || 5001;
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:5000';
const MONGO_URI = process.env.MONGODB_URI;
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';

app.use(cors());
app.use(express.json());

// --- Database Configuration (Mongo + JSON Fallback) ---
let useMongo = false;
const jsonDbPath = path.join(__dirname, 'data-incidents.json');

const IncidentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  type: { type: String, required: true }, // medical, fire, police
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  status: { type: String, default: 'Active' }, // Active, Dispatched, Resolved
  reportedBy: { type: String, required: true },
  region: { type: String, default: 'region-north' },
  assignedResourceId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});
let IncidentModel;

const initJsonDb = () => {
  if (!fs.existsSync(jsonDbPath)) {
    fs.writeFileSync(jsonDbPath, JSON.stringify([], null, 2));
  }
};

const getIncidents = async () => {
  if (useMongo) {
    return await IncidentModel.find({});
  } else {
    initJsonDb();
    const data = fs.readFileSync(jsonDbPath, 'utf8');
    return JSON.parse(data);
  }
};

const saveIncidents = async (incidents) => {
  if (useMongo) return;
  fs.writeFileSync(jsonDbPath, JSON.stringify(incidents, null, 2));
};

const connectDB = async () => {
  if (MONGO_URI) {
    try {
      await mongoose.connect(MONGO_URI);
      IncidentModel = mongoose.model('Incident', IncidentSchema);
      useMongo = true;
      console.log('[Incident Service] Connected to MongoDB');
    } catch (err) {
      console.error('[Incident Service] MongoDB connection failed. Falling back to local JSON.', err.message);
      useMongo = false;
      initJsonDb();
    }
  } else {
    console.log('[Incident Service] No MONGODB_URI provided. Using local JSON DB.');
    useMongo = false;
    initJsonDb();
  }
};

// --- MQTT Communication setup ---
let mqttClient = null;
const connectMQTT = () => {
  console.log(`[Incident Service] Connecting to MQTT broker at ${MQTT_URL}...`);
  mqttClient = mqtt.connect(MQTT_URL, { connectTimeout: 4000 });
  
  mqttClient.on('connect', () => {
    console.log('[Incident Service] Connected to MQTT Message Broker');
  });

  mqttClient.on('error', (err) => {
    console.error('[Incident Service] MQTT connection error:', err.message);
  });
};

// --- API Endpoints ---

// Get all incidents
app.get('/incidents', async (req, res) => {
  try {
    const list = await getIncidents();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Report an incident
app.post('/incidents', async (req, res) => {
  const { type, location, reportedBy, region } = req.body;

  if (!type || !location || !reportedBy) {
    return res.status(400).json({ error: 'Missing required incident fields (type, location, reportedBy)' });
  }

  const incidentId = `inc-${Date.now()}`;
  const newIncident = {
    id: incidentId,
    type,
    location,
    status: 'Active',
    reportedBy,
    region: region || 'region-north',
    assignedResourceId: null,
    createdAt: new Date()
  };

  try {
    if (useMongo) {
      const doc = new IncidentModel(newIncident);
      await doc.save();
    } else {
      const list = await getIncidents();
      list.push(newIncident);
      await saveIncidents(list);
    }

    console.log(`[Incident Service] Incident created: ${incidentId}`);

    // Publish to Message Broker asynchronously (asynchronous messaging)
    if (mqttClient && mqttClient.connected) {
      const topic = `incidents/new/${newIncident.region}`;
      mqttClient.publish(topic, JSON.stringify(newIncident), { qos: 1 }, (err) => {
        if (err) {
          console.error('[Incident Service] Failed to publish incident to broker:', err.message);
        } else {
          console.log(`[Incident Service] Broadcasted incident ${incidentId} on topic ${topic}`);
        }
      });
    } else {
      console.warn('[Incident Service] Message broker not connected. Incident saved but not broadcasted.');
    }

    res.status(201).json(newIncident);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update incident status (e.g. Dispatched / Resolved)
app.patch('/incidents/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, assignedResourceId } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Missing status update' });
  }

  try {
    let updatedIncident = null;

    if (useMongo) {
      const updateData = { status };
      if (assignedResourceId !== undefined) {
        updateData.assignedResourceId = assignedResourceId;
      }
      updatedIncident = await IncidentModel.findOneAndUpdate(
        { id },
        updateData,
        { new: true }
      );
    } else {
      const list = await getIncidents();
      const idx = list.findIndex(inc => inc.id === id);
      if (idx !== -1) {
        list[idx].status = status;
        if (assignedResourceId !== undefined) {
          list[idx].assignedResourceId = assignedResourceId;
        }
        updatedIncident = list[idx];
        await saveIncidents(list);
      }
    }

    if (!updatedIncident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    console.log(`[Incident Service] Updated incident ${id} status to: ${status}`);

    // Publish update to broker
    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(`incidents/update/${id}`, JSON.stringify(updatedIncident));
    }

    res.json(updatedIncident);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start service
app.listen(PORT, async () => {
  await connectDB();
  connectMQTT();
  console.log(`Incident Service running on port ${PORT}`);

  // Dynamic Self-Registration in Naming Registry
  try {
    await axios.post(`${REGISTRY_URL}/register`, {
      type: 'service',
      name: 'incident-service',
      url: process.env.SERVICE_URL || `http://localhost:${PORT}`
    });
    console.log('[Incident Service] Self-registered with Naming Registry successfully');
  } catch (err) {
    console.error('[Incident Service] Self-registration with Registry failed:', err.message);
  }
});
