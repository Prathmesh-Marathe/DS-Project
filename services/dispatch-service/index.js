const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mqtt = require('mqtt');

const app = express();
const PORT = process.env.PORT || 5002;
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:5000';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';

app.use(cors());
app.use(express.json());

// --- Connect to MQTT Broker ---
let mqttClient = null;
const connectMQTT = () => {
  console.log(`[Dispatch Service] Connecting to MQTT broker at ${MQTT_URL}...`);
  mqttClient = mqtt.connect(MQTT_URL, { connectTimeout: 4000 });
  
  mqttClient.on('connect', () => {
    console.log('[Dispatch Service] Connected to MQTT Message Broker');
  });

  mqttClient.on('error', (err) => {
    console.error('[Dispatch Service] MQTT connection error:', err.message);
  });
};

// Helper: Dynamic service address lookup (Location Transparency)
const resolveService = async (serviceName) => {
  try {
    const response = await axios.get(`${REGISTRY_URL}/lookup/${serviceName}`);
    return response.data.url;
  } catch (err) {
    console.error(`[Dispatch Service] Service resolution failed for ${serviceName}:`, err.message);
    throw new Error(`Cannot resolve service: ${serviceName}`);
  }
};

// --- API Endpoints ---

// Check service health
app.get('/health', (req, res) => {
  res.json({ status: 'UP', service: 'dispatch-service' });
});

// Assign a resource to an incident
app.post('/dispatch/assign', async (req, res) => {
  const { incidentId, resourceId } = req.body;

  if (!incidentId || !resourceId) {
    return res.status(400).json({ error: 'Missing incidentId or resourceId' });
  }

  console.log(`[Dispatch Service] Attempting assignment: ${resourceId} -> Incident ${incidentId}`);

  try {
    // 1. Dynamic Naming Resolution
    const resourceServiceUrl = await resolveService('resource-service');
    const incidentServiceUrl = await resolveService('incident-service');

    console.log(`[Dispatch Service] Resolved endpoints: resource-service -> ${resourceServiceUrl}, incident-service -> ${incidentServiceUrl}`);

    // 2. Perform Atomic Capacity Claim
    console.log(`[Dispatch Service] Claiming capacity on resource ${resourceId}...`);
    let claimRes;
    try {
      claimRes = await axios.post(`${resourceServiceUrl}/resources/claim`, { resourceId });
    } catch (claimErr) {
      if (claimErr.response && claimErr.response.status === 409) {
        return res.status(409).json({ error: 'Selected resource has no available capacity' });
      }
      throw claimErr;
    }

    const claimedResource = claimRes.data.resource;
    console.log(`[Dispatch Service] Claim successful for resource: ${claimedResource.name}`);

    // 3. Update Incident status to 'Dispatched'
    console.log(`[Dispatch Service] Updating incident status...`);
    const incidentRes = await axios.patch(`${incidentServiceUrl}/incidents/${incidentId}/status`, {
      status: 'Dispatched',
      assignedResourceId: resourceId
    });

    const updatedIncident = incidentRes.data;

    // 4. Update Responder status in Naming Registry and start simulation
    console.log(`[Dispatch Service] Updating responder state in registry...`);
    
    // Start background simulation loop in Node.js
    let currentLat = claimedResource.location.lat;
    let currentLng = claimedResource.location.lng;
    const targetLat = updatedIncident.location.lat;
    const targetLng = updatedIncident.location.lng;

    // Immediately update registry and MQTT with start position (so they start from station!)
    await axios.post(`${REGISTRY_URL}/responders/${resourceId}/update`, {
      status: 'Dispatched',
      location: { lat: currentLat, lng: currentLng }
    });

    const simInterval = setInterval(async () => {
      const deltaLat = targetLat - currentLat;
      const deltaLng = targetLng - currentLng;
      const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng);

      if (distance < 0.005) {
        clearInterval(simInterval);
        console.log(`[Dispatch Service] Responder ${resourceId} arrived at Incident ${incidentId}`);
        await axios.post(`${REGISTRY_URL}/responders/${resourceId}/update`, {
          status: 'On Scene',
          location: { lat: targetLat, lng: targetLng }
        });
        if (mqttClient && mqttClient.connected) {
          mqttClient.publish(`responders/${resourceId}/location`, JSON.stringify({
            id: resourceId,
            location: { lat: targetLat, lng: targetLng },
            status: 'On Scene',
            timestamp: new Date().toISOString()
          }));
          mqttClient.publish(`responders/${resourceId}/status`, JSON.stringify({
            id: resourceId,
            status: 'On Scene',
            timestamp: new Date().toISOString()
          }));
        }
      } else {
        const step = distance > 1 ? distance * 0.15 : 0.005;
        currentLat += Math.sign(deltaLat) * Math.min(Math.abs(deltaLat), step);
        currentLng += Math.sign(deltaLng) * Math.min(Math.abs(deltaLng), step);

        console.log(`[Dispatch Service] Simulating responder ${resourceId} movement: ${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`);
        
        await axios.post(`${REGISTRY_URL}/responders/${resourceId}/update`, {
          status: 'En Route',
          location: { lat: currentLat, lng: currentLng }
        });

        if (mqttClient && mqttClient.connected) {
          mqttClient.publish(`responders/${resourceId}/location`, JSON.stringify({
            id: resourceId,
            location: { lat: currentLat, lng: currentLng },
            status: 'En Route',
            timestamp: new Date().toISOString()
          }));
        }
      }
    }, 1000);

    // 5. Broadcast assignment over Message Broker
    if (mqttClient && mqttClient.connected) {
      const payload = {
        incident: updatedIncident,
        responderId: resourceId,
        dispatchedAt: new Date()
      };
      
      // Publish to direct responder topic and general channel
      mqttClient.publish(`responders/${resourceId}/assignment`, JSON.stringify(payload), { qos: 1 });
      mqttClient.publish(`dispatches/new`, JSON.stringify(payload), { qos: 1 });
      console.log(`[Dispatch Service] Broadcasted assignment payload for ${resourceId}`);
    } else {
      console.warn('[Dispatch Service] MQTT disconnected, assignment message could not be broadcasted.');
    }

    res.json({
      success: true,
      message: `Resource ${resourceId} successfully assigned to incident ${incidentId}`,
      incident: updatedIncident,
      resource: claimedResource
    });

  } catch (err) {
    console.error('[Dispatch Service] Error executing assignment transaction:', err.message);
    res.status(500).json({ error: `Assignment failed: ${err.message}` });
  }
});

// Start service
app.listen(PORT, async () => {
  connectMQTT();
  console.log(`Dispatch Service running on port ${PORT}`);

  // Dynamic Self-Registration in Naming Registry
  const registerWithRetry = async () => {
    try {
      await axios.post(`${REGISTRY_URL}/register`, {
        type: 'service',
        name: 'dispatch-service',
        url: process.env.SERVICE_URL || `http://localhost:${PORT}`
      });
      console.log('[Dispatch Service] Self-registered with Naming Registry successfully');
    } catch (err) {
      console.error('[Dispatch Service] Self-registration with Registry failed:', err.message, '- Retrying in 5s...');
      setTimeout(registerWithRetry, 5000);
    }
  };
  registerWithRetry();
});
