const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const mqtt = require('mqtt');
const LamportClock = require('./lamport');

const app = express();
const PORT = process.env.PORT || 5001;
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:5000';
const MONGO_URI = process.env.MONGODB_URI;
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const SERVICE_ID = process.env.SERVICE_ID || 'incident-1';

app.use(cors());
app.use(express.json());

// ─── Chapter 3: Lamport Logical Clock ────────────────────────────────────────
const lamport = new LamportClock(SERVICE_ID);
let clockOffset = 0; // Cristian's clock sync offset

// Periodic clock sync with registry (Cristian's Algorithm)
const syncClock = async () => {
  try {
    const T1 = Date.now();
    const ts = lamport.send();
    const resp = await axios.post(`${REGISTRY_URL}/clock-sync`, { nodeId: SERVICE_ID, clientTime: T1, localClock: ts.ts }, { timeout: 3000 });
    const T3 = Date.now();
    clockOffset = resp.data.serverTime - T1 - (T3 - T1) / 2;
    if (resp.data.lamportTs !== undefined) lamport.receive(resp.data.lamportTs);
    console.log(`[Incident | Clock Sync] Offset: ${clockOffset.toFixed(1)}ms`);
  } catch (err) {
    console.warn(`[Incident | Clock Sync] Failed: ${err.message}`);
  }
};

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
    const ts = lamport.tick();
    console.log(`[Incident Service | L:${ts}] Connected to MQTT Message Broker`);
  });

  mqttClient.on('error', (err) => {
    console.error('[Incident Service] MQTT connection error:', err.message);
  });
};

// --- API Endpoints ---

// ─── Chapter 3: Snapshot state endpoint (Chandy-Lamport participant) ──────────
app.get('/snapshot-state', (req, res) => {
  res.json({
    nodeId: SERVICE_ID,
    lamportClock: lamport.getState(),
    clockOffset_ms: clockOffset,
    recordedAt: new Date().toISOString()
  });
});

// Get all incidents
app.get('/incidents', async (req, res) => {
  try {
    const list = await getIncidents();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all incidents
app.delete('/incidents/clear', async (req, res) => {
  try {
    if (useMongo) {
      await IncidentModel.deleteMany({});
    } else {
      fs.writeFileSync(jsonDbPath, JSON.stringify([], null, 2));
    }
    res.json({ message: 'All incidents cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Report an incident
app.post('/incidents', async (req, res) => {
  const { type, location, reportedBy, region, lamportTs: incomingTs } = req.body;

  // Lamport: receive event from client
  if (incomingTs !== undefined) lamport.receive(incomingTs);

  if (!type || !location || !reportedBy) {
    return res.status(400).json({ error: 'Missing required incident fields (type, location, reportedBy)' });
  }

  const createTs = lamport.tick();
  const incidentId = `inc-${Date.now()}`;
  const newIncident = {
    id: incidentId,
    type,
    location,
    status: 'Active',
    reportedBy,
    region: region || 'region-north',
    assignedResourceId: null,
    createdAt: new Date(),
    lamportTs: createTs  // Chapter 3: Lamport timestamp on incident creation
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

    console.log(`[Incident Service | L:${createTs}] Incident created: ${incidentId}`);

    // Publish to Message Broker asynchronously (asynchronous messaging)
    // Chapter 3: Message carries Lamport timestamp for total ordering
    if (mqttClient && mqttClient.connected) {
      const mqttTs = lamport.send();
      const topic = `incidents/new/${newIncident.region}`;
      mqttClient.publish(topic, JSON.stringify({ ...newIncident, lamportTs: mqttTs.ts }), { qos: 1 }, (err) => {
        if (err) {
          console.error('[Incident Service] Failed to publish incident to broker:', err.message);
        } else {
          console.log(`[Incident Service | L:${mqttTs.ts}] Broadcasted incident ${incidentId} on topic ${topic}`);
        }
      });
    } else {
      console.warn('[Incident Service] Message broker not connected. Incident saved but not broadcasted.');
    }

    const sendTs = lamport.send();
    res.status(201).json({ ...newIncident, lamportTs: sendTs.ts });
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

    if (status === 'Resolved') {
      const resourceId = updatedIncident.assignedResourceId;
      if (resourceId) {
        try {
          const resourceServiceUrlRes = await axios.get(`${REGISTRY_URL}/lookup/resource-service`);
          const resourceServiceUrl = resourceServiceUrlRes.data.url;
          
          const resourcesRes = await axios.get(`${resourceServiceUrl}/resources`);
          const station = resourcesRes.data.find(r => r.id === resourceId);
          const stationLoc = station ? station.location : { lat: 18.5204, lng: 73.8567 };

          await axios.post(`${resourceServiceUrl}/resources/release`, { resourceId });
          console.log(`[Incident Service] Released capacity for resource ${resourceId}`);

          await axios.post(`${REGISTRY_URL}/responders/${resourceId}/update`, {
            status: 'Available',
            location: stationLoc
          });
          console.log(`[Incident Service] Reset responder ${resourceId} status to Available and location to ${JSON.stringify(stationLoc)}`);

          if (mqttClient && mqttClient.connected) {
            mqttClient.publish(`responders/${resourceId}/location`, JSON.stringify({
              id: resourceId,
              location: stationLoc,
              status: 'Available',
              timestamp: new Date().toISOString()
            }));
            mqttClient.publish(`responders/${resourceId}/status`, JSON.stringify({
              id: resourceId,
              status: 'Available',
              timestamp: new Date().toISOString()
            }));
          }
        } catch (simErr) {
          console.error('[Incident Service] Failed backend resolution cleanup:', simErr.message);
        }
      }
    }

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
  console.log(`[Incident | ${SERVICE_ID}] Incident Service running on port ${PORT}`);
  console.log(`[Incident] Chapter 3 features enabled:`);
  console.log(`[Incident]   ✓ Lamport Logical Clocks (incidents carry timestamps)`);
  console.log(`[Incident]   ✓ Cristian's Clock Sync (periodic offset correction)`);

  // Dynamic Self-Registration in Naming Registry
  const registerWithRetry = async () => {
    try {
      const ts = lamport.send();
      await axios.post(`${REGISTRY_URL}/register`, {
        type: 'service',
        name: 'incident-service',
        url: process.env.SERVICE_URL || `http://localhost:${PORT}`,
        lamportTs: ts.ts
      });
      console.log('[Incident Service] Self-registered with Naming Registry successfully');
      // Start periodic clock sync
      syncClock();
      setInterval(syncClock, 30000);
    } catch (err) {
      console.error('[Incident Service] Self-registration with Registry failed:', err.message, '- Retrying in 5s...');
      setTimeout(registerWithRetry, 5000);
    }
  };
  registerWithRetry();
});
