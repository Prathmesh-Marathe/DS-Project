const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mqtt = require('mqtt');
const LamportClock = require('./lamport');
const TokenRingMutex = require('./mutex');

const app = express();
const PORT = process.env.PORT || 5002;
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:5000';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const SERVICE_ID = process.env.SERVICE_ID || 'dispatch-1';

// ─── Unit 4: Serverless Architecture (AWS Lambda via API Gateway) ─────────────
// Every successful dispatch triggers a stateless serverless function.
// The Lambda function is event-driven, pay-per-execution, and auto-scales.
const LAMBDA_ENDPOINT = process.env.LAMBDA_DISPATCH_URL || 'https://13d0ylm0a8.execute-api.ap-south-1.amazonaws.com/prod/dispatch-log';

app.use(cors());
app.use(express.json());

// ─── Chapter 3: Lamport Clock + Token-Ring Mutex ─────────────────────────────
const lamport = new LamportClock(SERVICE_ID);

// Token-ring mutex for mutual exclusion on dispatch (critical section).
// Prevents two concurrent dispatch requests from double-claiming the same resource.
// Implements Lodha-Kshemkalyani fairness: FIFO by Lamport timestamp.
const dispatchMutex = new TokenRingMutex(SERVICE_ID, lamport);
// This node starts with the token (single-node setup).
// In a multi-node deployment, token is passed after a Bully election determines the leader.
dispatchMutex.receiveToken('init');

// ─── Chapter 3: Beacon (Cristian Clock Sync) ─────────────────────────────────
// Dispatch service periodically syncs its clock with the registry (Cristian's Algorithm)
let clockOffset = 0;
const syncClock = async () => {
  try {
    const T1 = Date.now();
    const ts = lamport.send();
    const resp = await axios.post(`${REGISTRY_URL}/clock-sync`, {
      nodeId: SERVICE_ID,
      clientTime: T1,
      localClock: ts.ts
    }, { timeout: 3000 });
    const T3 = Date.now();
    const T2 = resp.data.serverTime;
    const RTT = T3 - T1;
    clockOffset = T2 - T1 - RTT / 2;
    if (resp.data.lamportTs !== undefined) lamport.receive(resp.data.lamportTs);
    console.log(`[Dispatch | Clock Sync] RTT: ${RTT}ms | Offset: ${clockOffset.toFixed(1)}ms`);
  } catch (err) {
    console.warn(`[Dispatch | Clock Sync] Failed: ${err.message}`);
  }
};

// ─── Connect to MQTT Broker ───────────────────────────────────────────────────
let mqttClient = null;
const connectMQTT = () => {
  console.log(`[Dispatch Service] Connecting to MQTT broker at ${MQTT_URL}...`);
  mqttClient = mqtt.connect(MQTT_URL, { connectTimeout: 4000 });

  mqttClient.on('connect', () => {
    const ts = lamport.tick();
    console.log(`[Dispatch Service | L:${ts}] Connected to MQTT Message Broker`);
  });

  mqttClient.on('error', (err) => {
    console.error('[Dispatch Service] MQTT connection error:', err.message);
  });
};

// Helper: Dynamic service address lookup (Location Transparency)
const resolveService = async (serviceName) => {
  try {
    const response = await axios.get(`${REGISTRY_URL}/lookup/${serviceName}`);
    if (response.data.lamportTs !== undefined) lamport.receive(response.data.lamportTs);
    return response.data.url;
  } catch (err) {
    console.error(`[Dispatch Service] Service resolution failed for ${serviceName}:`, err.message);
    throw new Error(`Cannot resolve service: ${serviceName}`);
  }
};

// ─── API Endpoints ────────────────────────────────────────────────────────────

// Check service health
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'dispatch-service',
    serviceId: SERVICE_ID,
    lamportClock: lamport.getState(),
    mutexState: dispatchMutex.getState(),
    clockOffset_ms: clockOffset
  });
});

// ─── Chapter 3: Snapshot state endpoint (Chandy-Lamport participant) ──────────
app.get('/snapshot-state', (req, res) => {
  res.json({
    nodeId: SERVICE_ID,
    lamportClock: lamport.getState(),
    mutexState: dispatchMutex.getState(),
    clockOffset_ms: clockOffset,
    recordedAt: new Date().toISOString()
  });
});

// ─── Chapter 3: Mutex state endpoint ─────────────────────────────────────────
app.get('/mutex/state', (req, res) => {
  res.json(dispatchMutex.getState());
});

// ─── Assign a resource to an incident (CRITICAL SECTION with Mutex) ───────────
app.post('/dispatch/assign', async (req, res) => {
  const { incidentId, resourceId, lamportTs: incomingTs } = req.body;

  // Lamport: receive event
  if (incomingTs !== undefined) lamport.receive(incomingTs);

  if (!incidentId || !resourceId) {
    return res.status(400).json({ error: 'Missing incidentId or resourceId' });
  }

  const requestTs = lamport.tick();
  console.log(`[Dispatch | L:${requestTs}] Attempting assignment: ${resourceId} -> Incident ${incidentId}`);

  // ─── MUTUAL EXCLUSION: Acquire token before entering critical section ─────
  // This prevents two simultaneous dispatch calls from claiming the same resource.
  // Fairness: Lodha-Kshemkalyani — earlier Lamport timestamp gets priority.
  let release;
  try {
    release = await dispatchMutex.acquire();
  } catch (err) {
    return res.status(503).json({ error: 'Could not acquire dispatch mutex', details: err.message });
  }

  try {
    // ─── CRITICAL SECTION START ──────────────────────────────────────────────
    const csTs = lamport.tick();
    console.log(`[Dispatch | L:${csTs}] === CRITICAL SECTION: Claiming resource ${resourceId} for incident ${incidentId} ===`);

    // 1. Dynamic Naming Resolution
    const resourceServiceUrl = await resolveService('resource-service');
    const incidentServiceUrl = await resolveService('incident-service');

    console.log(`[Dispatch] Resolved endpoints: resource-service -> ${resourceServiceUrl}, incident-service -> ${incidentServiceUrl}`);

    // 2. Perform Atomic Capacity Claim
    console.log(`[Dispatch] Claiming capacity on resource ${resourceId}...`);
    let claimRes;
    try {
      claimRes = await axios.post(`${resourceServiceUrl}/resources/claim`, {
        resourceId,
        lamportTs: lamport.send().ts
      });
      if (claimRes.data.lamportTs !== undefined) lamport.receive(claimRes.data.lamportTs);
    } catch (claimErr) {
      if (claimErr.response && claimErr.response.status === 409) {
        return res.status(409).json({ error: 'Selected resource has no available capacity' });
      }
      throw claimErr;
    }

    const claimedResource = claimRes.data.resource;
    console.log(`[Dispatch] Claim successful for resource: ${claimedResource.name}`);

    // 3. Update Incident status to 'Dispatched'
    console.log(`[Dispatch] Updating incident status...`);
    const incidentRes = await axios.patch(`${incidentServiceUrl}/incidents/${incidentId}/status`, {
      status: 'Dispatched',
      assignedResourceId: resourceId,
      lamportTs: lamport.send().ts
    });
    if (incidentRes.data.lamportTs !== undefined) lamport.receive(incidentRes.data.lamportTs);

    const updatedIncident = incidentRes.data;

    // ─── CRITICAL SECTION END (resource claimed, incident updated) ───────────
    const exitTs = lamport.tick();
    console.log(`[Dispatch | L:${exitTs}] === CRITICAL SECTION EXIT: Assignment secured ===`);

    // 4. Update Responder status in Naming Registry and start movement simulation
    let currentLat = claimedResource.location.lat;
    let currentLng = claimedResource.location.lng;
    const targetLat = updatedIncident.location.lat;
    const targetLng = updatedIncident.location.lng;

    // Immediately update registry with start position
    await axios.post(`${REGISTRY_URL}/responders/${resourceId}/update`, {
      status: 'Dispatched',
      location: { lat: currentLat, lng: currentLng },
      lamportTs: lamport.send().ts
    });

    const simInterval = setInterval(async () => {
      const deltaLat = targetLat - currentLat;
      const deltaLng = targetLng - currentLng;
      const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng);

      const simTs = lamport.tick();
      if (distance < 0.005) {
        clearInterval(simInterval);
        console.log(`[Dispatch | L:${simTs}] Responder ${resourceId} arrived at Incident ${incidentId}`);
        await axios.post(`${REGISTRY_URL}/responders/${resourceId}/update`, {
          status: 'On Scene',
          location: { lat: targetLat, lng: targetLng },
          lamportTs: lamport.send().ts
        });
        if (mqttClient && mqttClient.connected) {
          mqttClient.publish(`responders/${resourceId}/location`, JSON.stringify({
            id: resourceId,
            location: { lat: targetLat, lng: targetLng },
            status: 'On Scene',
            timestamp: new Date().toISOString(),
            lamportTs: simTs
          }));
          mqttClient.publish(`responders/${resourceId}/status`, JSON.stringify({
            id: resourceId,
            status: 'On Scene',
            timestamp: new Date().toISOString(),
            lamportTs: simTs
          }));
        }
      } else {
        const step = distance > 1 ? distance * 0.15 : 0.005;
        currentLat += Math.sign(deltaLat) * Math.min(Math.abs(deltaLat), step);
        currentLng += Math.sign(deltaLng) * Math.min(Math.abs(deltaLng), step);

        console.log(`[Dispatch | L:${simTs}] Simulating responder ${resourceId} movement: ${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`);

        await axios.post(`${REGISTRY_URL}/responders/${resourceId}/update`, {
          status: 'En Route',
          location: { lat: currentLat, lng: currentLng },
          lamportTs: lamport.send().ts
        });

        if (mqttClient && mqttClient.connected) {
          mqttClient.publish(`responders/${resourceId}/location`, JSON.stringify({
            id: resourceId,
            location: { lat: currentLat, lng: currentLng },
            status: 'En Route',
            timestamp: new Date().toISOString(),
            lamportTs: simTs
          }));
        }
      }
    }, 1000);

    // 5. Broadcast assignment over Message Broker
    if (mqttClient && mqttClient.connected) {
      const broadcastTs = lamport.send();
      const payload = {
        incident: updatedIncident,
        responderId: resourceId,
        dispatchedAt: new Date(),
        lamportTs: broadcastTs.ts  // Lamport timestamp on MQTT message
      };

      mqttClient.publish(`responders/${resourceId}/assignment`, JSON.stringify(payload), { qos: 1 });
      mqttClient.publish(`dispatches/new`, JSON.stringify(payload), { qos: 1 });
      console.log(`[Dispatch | L:${broadcastTs.ts}] Broadcasted assignment payload for ${resourceId}`);
    } else {
      console.warn('[Dispatch Service] MQTT disconnected, assignment message could not be broadcasted.');
    }

    res.json({
      success: true,
      message: `Resource ${resourceId} successfully assigned to incident ${incidentId}`,
      incident: updatedIncident,
      resource: claimedResource,
      lamportTs: lamport.send().ts
    });

    // ─── Unit 4: Serverless — Fire-and-forget Lambda call (async, non-blocking) ──
    // After the response is sent, we asynchronously notify the serverless
    // dispatch logger. This is fire-and-forget: Lambda is stateless and
    // event-driven — it logs to CloudWatch without affecting the dispatch flow.
    const lambdaPayload = {
      incidentId,
      resourceId,
      resourceName: claimedResource.name,
      incidentType: updatedIncident.type,
      location: updatedIncident.location,
      dispatchedAt: new Date().toISOString(),
      lamportTs: lamport.send().ts,
      dispatchServiceId: SERVICE_ID
    };
    axios.post(LAMBDA_ENDPOINT, lambdaPayload, { timeout: 5000 })
      .then(r => console.log(`[Dispatch | Serverless] Lambda logged dispatch event. CloudWatch status: ${r.status}`))
      .catch(e => console.warn(`[Dispatch | Serverless] Lambda call failed (non-critical): ${e.message}`));

  } catch (err) {
    console.error('[Dispatch Service] Error executing assignment transaction:', err.message);
    res.status(500).json({ error: `Assignment failed: ${err.message}` });
  } finally {
    // Always release the mutex — even on error — to avoid deadlock
    release();
  }
});

// ─── Start service ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  connectMQTT();
  console.log(`[Dispatch | ${SERVICE_ID}] Dispatch Service running on port ${PORT}`);
  console.log(`[Dispatch] Chapter 3 features enabled:`);
  console.log(`[Dispatch]   ✓ Lamport Logical Clocks (all messages timestamped)`);
  console.log(`[Dispatch]   ✓ Token-Ring Mutual Exclusion (dispatch critical section)`);
  console.log(`[Dispatch]   ✓ Lodha-Kshemkalyani fairness (FIFO by Lamport timestamp)`);
  console.log(`[Dispatch]   ✓ Cristian's Clock Sync (periodic offset correction)`);

  // Dynamic Self-Registration in Naming Registry
  const registerWithRetry = async () => {
    try {
      const ts = lamport.send();
      await axios.post(`${REGISTRY_URL}/register`, {
        type: 'service',
        name: 'dispatch-service',
        url: process.env.SERVICE_URL || `http://localhost:${PORT}`,
        lamportTs: ts.ts
      });
      console.log('[Dispatch Service] Self-registered with Naming Registry successfully');

      // Start periodic clock sync (Cristian's Algorithm)
      syncClock();
      setInterval(syncClock, 30000);
    } catch (err) {
      console.error('[Dispatch Service] Self-registration with Registry failed:', err.message, '- Retrying in 5s...');
      setTimeout(registerWithRetry, 5000);
    }
  };
  registerWithRetry();
});
