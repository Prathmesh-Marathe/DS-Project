const express = require('express');
const cors = require('cors');
const axios = require('axios');
const LamportClock = require('./lamport');
const VectorClock = require('./vectorClock');

const app = express();
const PORT = process.env.PORT || 5000;
const SERVICE_ID = process.env.SERVICE_ID || 'registry-1'; // Used in Election & Clocks

app.use(cors());
app.use(express.json());

// ─── Chapter 3: Logical Clocks ──────────────────────────────────────────────
// Lamport clock for this node — used to totally-order all registry events
const lamport = new LamportClock(SERVICE_ID);

// Vector clock — used to track causality in responder location update streams
const vectorClock = new VectorClock(SERVICE_ID);

// ─── Chapter 3: Clock Synchronization (Cristian's Algorithm / Berkeley) ─────
// Each service will call POST /clock-sync and we measure the round-trip offset.
const clockOffsets = {}; // nodeId -> { offset, lastSyncedAt }

// ─── In-memory registry tables ───────────────────────────────────────────────
const services = {};    // name -> { url, lastUpdated, lamportTs }
const responders = {};  // id   -> { name, type, location, status, lastUpdated, vectorTs }

// ─── Chapter 3: Global State / Chandy-Lamport Snapshot ───────────────────────
// We store the last taken snapshot here.
let latestSnapshot = null;

// Middleware to log requests with Lamport timestamp
app.use((req, res, next) => {
  const ts = lamport.tick();
  req.lamportTs = ts;
  console.log(`[Registry | L:${ts}] ${req.method} ${req.url} - ${JSON.stringify(req.body)}`);
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'registry-service',
    serviceId: SERVICE_ID,
    lamportClock: lamport.getState(),
    vectorClock: vectorClock.snapshot()
  });
});

// ─── Service Registration ─────────────────────────────────────────────────────
app.post('/register', (req, res) => {
  const { type, name, url, id, location, status, lamportTs } = req.body;

  // Lamport: receive event — advance our clock
  if (lamportTs !== undefined) lamport.receive(lamportTs);

  if (type === 'service') {
    if (!name || !url) {
      return res.status(400).json({ error: 'Service name and url are required' });
    }
    const sendTs = lamport.send();
    services[name] = { url, lastUpdated: new Date(), lamportTs: sendTs.ts };
    console.log(`[Registry | L:${sendTs.ts}] Registered service: ${name} -> ${url}`);
    return res.json({ message: `Service ${name} registered successfully`, lamportTs: sendTs.ts });
  }

  if (type === 'responder') {
    if (!id || !name) {
      return res.status(400).json({ error: 'Responder id and name are required' });
    }
    const sendTs = lamport.send();
    responders[id] = {
      id,
      name,
      type: req.body.responderType || 'ambulance',
      location: location || { lat: 12.9716, lng: 77.5946 },
      status: status || 'Available',
      lastUpdated: new Date(),
      lamportTs: sendTs.ts
    };
    console.log(`[Registry | L:${sendTs.ts}] Registered responder: ${id} (${responders[id].type})`);
    return res.json({ message: `Responder ${id} registered successfully`, lamportTs: sendTs.ts });
  }

  res.status(400).json({ error: 'Invalid type. Must be "service" or "responder"' });
});

// ─── Lookup service URL ───────────────────────────────────────────────────────
app.get('/lookup/:name', (req, res) => {
  const { name } = req.params;
  const service = services[name];
  if (!service) {
    return res.status(404).json({ error: `Service ${name} not found in registry` });
  }
  const sendTs = lamport.send();
  res.json({ name, url: service.url, lamportTs: sendTs.ts });
});

// ─── Get all services ─────────────────────────────────────────────────────────
app.get('/services', (req, res) => {
  res.json(services);
});

// ─── Get all responders ───────────────────────────────────────────────────────
app.get('/responders', (req, res) => {
  res.json(Object.values(responders));
});

// ─── Get specific responder ───────────────────────────────────────────────────
app.get('/responders/:id', (req, res) => {
  const responder = responders[req.params.id];
  if (!responder) {
    return res.status(404).json({ error: 'Responder not found' });
  }
  res.json(responder);
});

// ─── Update responder status / location (with Vector Clock) ───────────────────
// Chapter 3: Each location update carries a vector clock so the registry can
// detect out-of-order / concurrent updates and keep only the causally latest one.
app.post('/responders/:id/update', (req, res) => {
  const { id } = req.params;
  const { location, status, vectorTs, lamportTs: incomingLamport } = req.body;

  // Lamport receive
  if (incomingLamport !== undefined) lamport.receive(incomingLamport);

  if (!responders[id]) {
    responders[id] = {
      id,
      name: id,
      type: 'ambulance',
      location: { lat: 12.9716, lng: 77.5946 },
      lastUpdated: new Date()
    };
  }

  // ── Vector clock logic ────────────────────────────────────────────────────
  const existingVt = responders[id].vectorTs || {};
  const incomingVt = vectorTs || {};

  if (Object.keys(existingVt).length > 0 && Object.keys(incomingVt).length > 0) {
    const order = VectorClock.compare(incomingVt, existingVt);
    if (order === 'before') {
      // Stale update — reject silently (causal ordering enforcement)
      console.log(`[Registry] Rejected STALE location update for ${id} (vector order: ${order})`);
      return res.json({
        message: `Stale update rejected (causal ordering)`,
        data: responders[id],
        vectorOrder: order
      });
    }
    if (order === 'concurrent') {
      // Concurrent updates — last-writer-wins by wall clock
      console.log(`[Registry] Concurrent location update for ${id} — applying last-write-wins`);
    }
  }
  // ── Apply update ──────────────────────────────────────────────────────────
  if (location) responders[id].location = location;
  if (status) responders[id].status = status;
  responders[id].lastUpdated = new Date();
  if (Object.keys(incomingVt).length > 0) {
    responders[id].vectorTs = incomingVt; // Store the incoming vector clock
  }

  const sendTs = lamport.send();
  console.log(`[Registry | L:${sendTs.ts}] Updated responder ${id}: status=${status}, location=${JSON.stringify(location)}`);
  res.json({ message: `Responder ${id} updated`, data: responders[id], lamportTs: sendTs.ts });
});

// ─── Chapter 3: Clock Synchronization (Cristian's / Berkeley-lite) ────────────
// Services POST here to synchronize clocks.
// The registry acts as the "time server" for the simplified Cristian algorithm.
// Each service measures: offset = (serverTime - clientTime) - (RTT/2)
//
// Endpoint also supports the Berkeley master role:
// services report their local time, registry computes and broadcasts average offset.
app.post('/clock-sync', (req, res) => {
  const { nodeId, clientTime, localClock } = req.body;
  const serverTime = Date.now();

  // Lamport advance
  if (localClock !== undefined) lamport.receive(localClock);

  // Cristian's: the reply T2 (server time). Client calculates offset as:
  //   offset = T2 - T1 - (RTT/2)  [RTT measured client-side]
  const sendTs = lamport.send();
  const response = {
    serverTime,
    lamportTs: sendTs.ts,
    nodeId: SERVICE_ID,
    // Berkeley hint: if multiple clients report, registry can broadcast correction
    offsetHint: serverTime - (clientTime || serverTime)
  };

  if (nodeId) {
    clockOffsets[nodeId] = {
      reportedLocalTime: clientTime,
      serverTimeAtSync: serverTime,
      offsetHint: response.offsetHint,
      lastSyncedAt: new Date().toISOString()
    };
    console.log(`[Registry | Clock Sync] Node ${nodeId} synced. Client time diff: ${response.offsetHint}ms`);
  }

  res.json(response);
});

// ─── Chapter 3: Get all clock offsets (Berkeley master view) ─────────────────
app.get('/clock-sync/offsets', (req, res) => {
  res.json({
    masterNodeId: SERVICE_ID,
    masterClock: lamport.getState(),
    peerOffsets: clockOffsets
  });
});

// ─── Chapter 3: Global State Snapshot (Chandy-Lamport Algorithm) ─────────────
// Initiates a consistent global snapshot. In a real system, marker messages
// would be sent on all channels. Here, the registry — as the naming backbone —
// collects state from all registered services (as the snapshot initiator).
//
// Algorithm steps (simplified for HTTP-based system):
//  1. Registry records its own local state.
//  2. Registry sends GET /snapshot-state to all registered services.
//  3. Each service replies with its current in-memory state.
//  4. Registry assembles the consistent cut.
app.post('/snapshot', async (req, res) => {
  const snapshotId = `snap-${Date.now()}`;
  const initiatedAt = lamport.tick();

  console.log(`[Registry | L:${initiatedAt}] === GLOBAL SNAPSHOT INITIATED (${snapshotId}) ===`);

  // Step 1: Record own state (registry local state)
  const registryState = {
    services: { ...services },
    responders: { ...responders },
    lamportClock: lamport.getState(),
    vectorClock: vectorClock.snapshot(),
    recordedAt: new Date().toISOString()
  };

  // Step 2: Collect state from all registered services (Chandy-Lamport markers)
  const serviceStates = {};
  const errors = [];

  await Promise.allSettled(
    Object.entries(services).map(async ([name, { url }]) => {
      try {
        const resp = await axios.get(`${url}/snapshot-state`, { timeout: 3000 });
        serviceStates[name] = resp.data;
        console.log(`[Registry | Snapshot] Collected state from ${name}`);
      } catch (err) {
        serviceStates[name] = { error: `Unreachable: ${err.message}` };
        errors.push(name);
        console.warn(`[Registry | Snapshot] Could not reach ${name}: ${err.message}`);
      }
    })
  );

  // Step 3: Assemble the consistent global cut
  latestSnapshot = {
    snapshotId,
    initiator: SERVICE_ID,
    initiatedAtLamport: initiatedAt,
    completedAt: new Date().toISOString(),
    registryState,
    serviceStates,
    unreachableServices: errors
  };

  console.log(`[Registry | L:${lamport.tick()}] === GLOBAL SNAPSHOT COMPLETE (${snapshotId}) ===`);
  res.json(latestSnapshot);
});

// ─── Get latest snapshot ──────────────────────────────────────────────────────
app.get('/snapshot', (req, res) => {
  if (!latestSnapshot) {
    return res.status(404).json({ message: 'No snapshot taken yet. POST /snapshot to initiate.' });
  }
  res.json(latestSnapshot);
});

// ─── Chapter 3: Beacon / Heartbeat Registration (for Election Algorithm) ───────
// Services POST here periodically to signal liveness. Used by the election
// algorithm to determine which nodes are alive.
const beaconRegistry = {}; // serviceId -> { url, priority, lastBeaconAt }
const BEACON_TIMEOUT_MS = 15000; // Consider dead after 15s with no beacon

app.post('/beacon', (req, res) => {
  const { serviceId, url, priority, lamportTs: incomingTs } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'serviceId required' });

  if (incomingTs !== undefined) lamport.receive(incomingTs);

  beaconRegistry[serviceId] = {
    serviceId,
    url: url || null,
    priority: priority || 0,
    lastBeaconAt: Date.now()
  };

  const sendTs = lamport.send();
  console.log(`[Registry | Beacon | L:${sendTs.ts}] Heartbeat from ${serviceId}`);
  res.json({ ack: true, lamportTs: sendTs.ts, serverTime: Date.now() });
});

// ─── Get alive peers (for election algorithm) ─────────────────────────────────
app.get('/beacon/alive', (req, res) => {
  const now = Date.now();
  const alive = Object.values(beaconRegistry).filter(
    b => (now - b.lastBeaconAt) < BEACON_TIMEOUT_MS
  );
  res.json({ alive, count: alive.length });
});

// ─── Snapshot state endpoint (called by other services during snapshot) ────────
// The registry's own state as a snapshot participant
app.get('/snapshot-state', (req, res) => {
  res.json({
    nodeId: SERVICE_ID,
    lamportClock: lamport.getState(),
    vectorClock: vectorClock.snapshot(),
    services: { ...services },
    responders: { ...responders },
    beaconRegistry: { ...beaconRegistry },
    recordedAt: new Date().toISOString()
  });
});

// ─── Start service ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Registry | ${SERVICE_ID}] Registry Service running on port ${PORT}`);
  console.log(`[Registry] Chapter 3 features enabled:`);
  console.log(`[Registry]   ✓ Lamport Logical Clocks`);
  console.log(`[Registry]   ✓ Vector Clocks (responder updates)`);
  console.log(`[Registry]   ✓ Clock Synchronization endpoint (Cristian's)`);
  console.log(`[Registry]   ✓ Global Snapshot (Chandy-Lamport, POST /snapshot)`);
  console.log(`[Registry]   ✓ Beacon/Heartbeat registry (for Election Algorithm)`);
});
