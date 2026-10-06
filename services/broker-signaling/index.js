const net = require('net');
const http = require('http');
const express = require('express');
const cors = require('cors');
const aedes = require('aedes')();
const ws = require('websocket-stream');
const { Server } = require('socket.io');
const axios = require('axios');
const LamportClock = require('./lamport');
const BullyElection = require('./election');
const BeaconProtocol = require('./beacon');

// ─── Chapter 3: Lamport Clock ─────────────────────────────────────────────────
const SERVICE_ID = process.env.SERVICE_ID || 'broker-1';
const SERVICE_PRIORITY = parseInt(process.env.SERVICE_PRIORITY || '10', 10);
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:5000';

const lamport = new LamportClock(SERVICE_ID);

// ─── 1. Initialize Aedes MQTT Broker ─────────────────────────────────────────
const tcpServer = net.createServer(aedes.handle);
const MQTT_TCP_PORT = 1883;

tcpServer.listen(MQTT_TCP_PORT, () => {
  console.log(`[MQTT Broker] TCP server running on port ${MQTT_TCP_PORT}`);
});

// Start WebSocket Server on Port 9001 (for browser clients)
const wsHttpServer = http.createServer();
const MQTT_WS_PORT = 9001;
ws.createServer({ server: wsHttpServer }, aedes.handle);

wsHttpServer.listen(MQTT_WS_PORT, () => {
  console.log(`[MQTT Broker] WebSocket server running on port ${MQTT_WS_PORT}`);
});

// Monitor broker clients and messages (with Lamport timestamps)
aedes.on('client', (client) => {
  const ts = lamport.tick();
  console.log(`[MQTT Broker | L:${ts}] Client Connected: ${client ? client.id : 'unknown'}`);
});

aedes.on('clientDisconnect', (client) => {
  const ts = lamport.tick();
  console.log(`[MQTT Broker | L:${ts}] Client Disconnected: ${client ? client.id : 'unknown'}`);
});

aedes.on('subscribe', (subscriptions, client) => {
  const ts = lamport.tick();
  console.log(`[MQTT Broker | L:${ts}] Client ${client ? client.id : 'unknown'} subscribed to: ${subscriptions.map(s => s.topic).join(', ')}`);
});

aedes.on('publish', (packet, client) => {
  if (packet.topic.startsWith('$SYS')) return;
  const ts = lamport.tick();
  console.log(`[MQTT Broker | L:${ts}] Publish from ${client ? client.id : 'Broker'}: topic="${packet.topic}"`);
});


// ─── 2. Initialize Socket.IO Signaling Server ─────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const signalingHttpServer = http.createServer(app);
const SIGNALING_PORT = 5004;

const io = new Server(signalingHttpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Naming registry lookup for online signaling clients
const connectedNodes = {}; // socket.id -> { role, userId }

// ─── Chapter 3: Bully Election Algorithm ─────────────────────────────────────
const election = new BullyElection({
  serviceId: SERVICE_ID,
  priority: SERVICE_PRIORITY,
  registryUrl: REGISTRY_URL,
  lamportClock: lamport,
  io,
  onVictory: () => {
    console.log(`[Election] 👑 ${SERVICE_ID} is now the COORDINATOR — initiating global snapshot`);
    // Coordinator automatically triggers a global snapshot
    triggerGlobalSnapshot();
  }
});

// ─── Chapter 3: Beacon Protocol ───────────────────────────────────────────────
const beacon = new BeaconProtocol({
  serviceId: SERVICE_ID,
  registryUrl: REGISTRY_URL,
  priority: SERVICE_PRIORITY,
  lamportClock: lamport,
  intervalMs: 5000,
  onCoordinatorDead: () => {
    console.log(`[Beacon] Coordinator heartbeat lost — starting Bully Election`);
    election.startElection();
  }
});

// ─── Chapter 3: Global Snapshot trigger ──────────────────────────────────────
async function triggerGlobalSnapshot() {
  try {
    const resp = await axios.post(`${REGISTRY_URL}/snapshot`, {}, { timeout: 10000 });
    const ts = lamport.tick();
    console.log(`[Coordinator | L:${ts}] Global snapshot completed: ${resp.data.snapshotId}`);
    // Broadcast snapshot completion to all connected clients
    io.emit('global-snapshot-complete', {
      snapshotId: resp.data.snapshotId,
      completedAt: resp.data.completedAt,
      lamportTs: ts
    });
  } catch (err) {
    console.error(`[Coordinator] Failed to trigger global snapshot: ${err.message}`);
  }
}

// ─── Socket.IO Event Handlers ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  const ts = lamport.tick();
  console.log(`[Signaling Server | L:${ts}] Socket connected: ${socket.id}`);

  // Register identity
  socket.on('register-session', ({ role, userId }) => {
    connectedNodes[socket.id] = { role, userId };
    socket.join(role);
    if (userId) {
      socket.join(userId);
      const regTs = lamport.tick();
      console.log(`[Signaling Server | L:${regTs}] Registered socket ${socket.id} to user ${userId} (${role})`);
    }
  });

  // Handle Room Joining (for WebRTC calls)
  socket.on('join-call-room', ({ roomId }) => {
    socket.join(roomId);
    const joinTs = lamport.tick();
    console.log(`[Signaling Server | L:${joinTs}] Socket ${socket.id} joined call room: ${roomId}`);
    socket.to(roomId).emit('peer-joined', { socketId: socket.id });
  });

  // Relay WebRTC signals (Offers, Answers, ICE Candidates)
  socket.on('webrtc-signal', ({ roomId, signal, targetSocketId }) => {
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc-signal', { signal, senderSocketId: socket.id });
    } else if (roomId) {
      socket.to(roomId).emit('webrtc-signal', { signal, senderSocketId: socket.id });
    }
  });

  // Simulate P2P Edge connection signals (offline relay initialization)
  socket.on('p2p-discover-peers', ({ region, responderId }) => {
    const discTs = lamport.tick();
    console.log(`[Signaling Server | L:${discTs}] Responder ${responderId} querying online peers in ${region}`);
    const peers = Object.entries(connectedNodes)
      .filter(([sid, node]) => node.role === 'responder' && node.userId !== responderId)
      .map(([sid, node]) => ({ socketId: sid, responderId: node.userId }));
    socket.emit('p2p-peers-list', peers);
  });

  // ─── Chapter 3: Election message relay via Socket.IO ─────────────────────
  socket.on('election-message', (data) => {
    const { lamportTs } = data;
    if (lamportTs !== undefined) lamport.receive(lamportTs);
    // If message is for US (higher priority node):
    if (data.fromPriority !== undefined) {
      election.receiveElectionMessage(data);
    }
  });

  socket.on('election-ok', (data) => {
    const { to, lamportTs } = data;
    if (lamportTs !== undefined) lamport.receive(lamportTs);
    if (to === SERVICE_ID) {
      election.receiveOk(data);
    }
  });

  socket.on('election-coordinator', (data) => {
    const { lamportTs } = data;
    if (lamportTs !== undefined) lamport.receive(lamportTs);
    election.receiveCoordinator(data);
  });

  // ─── Client requesting election state ────────────────────────────────────
  socket.on('get-election-state', () => {
    socket.emit('election-state', election.getState());
  });

  // ─── Client requesting beacon state ──────────────────────────────────────
  socket.on('get-beacon-state', () => {
    socket.emit('beacon-state', beacon.getState());
  });

  // Handle Disconnection
  socket.on('disconnect', () => {
    const node = connectedNodes[socket.id];
    if (node) {
      const discTs = lamport.tick();
      console.log(`[Signaling Server | L:${discTs}] Socket disconnected: ${socket.id} (user: ${node.userId}, role: ${node.role})`);
      delete connectedNodes[socket.id];
    } else {
      console.log(`[Signaling Server] Socket disconnected: ${socket.id}`);
    }
  });
});

// ─── REST Endpoints ───────────────────────────────────────────────────────────

// Health check with Chapter 3 state
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'broker-signaling',
    serviceId: SERVICE_ID,
    lamportClock: lamport.getState(),
    election: election.getState(),
    beacon: beacon.getState()
  });
});

// Snapshot state (called by registry during global snapshot)
app.get('/snapshot-state', (req, res) => {
  const ts = lamport.tick();
  res.json({
    nodeId: SERVICE_ID,
    lamportClock: lamport.getState(),
    electionState: election.getState(),
    beaconState: beacon.getState(),
    connectedSocketCount: Object.keys(connectedNodes).length,
    connectedRoles: Object.values(connectedNodes).reduce((acc, n) => {
      acc[n.role] = (acc[n.role] || 0) + 1;
      return acc;
    }, {}),
    recordedAt: new Date().toISOString(),
    lamportTs: ts
  });
});

// Manually trigger election (for demo/testing)
app.post('/election/start', (req, res) => {
  election.startElection();
  res.json({ message: 'Election started', serviceId: SERVICE_ID, priority: SERVICE_PRIORITY });
});

// Get election state
app.get('/election/state', (req, res) => {
  res.json(election.getState());
});

// Get beacon state
app.get('/beacon/state', (req, res) => {
  res.json(beacon.getState());
});

// ─── Start Signaling Server ───────────────────────────────────────────────────
signalingHttpServer.listen(SIGNALING_PORT, () => {
  console.log(`[Signaling Server | ${SERVICE_ID}] Running on port ${SIGNALING_PORT}`);
  console.log(`[Broker-Signaling] Chapter 3 features enabled:`);
  console.log(`[Broker-Signaling]   ✓ Lamport Logical Clocks (all events timestamped)`);
  console.log(`[Broker-Signaling]   ✓ Bully Election Algorithm (coordinator election)`);
  console.log(`[Broker-Signaling]   ✓ Beacon Protocol (heartbeat + Cristian's clock sync)`);

  // Start beacon protocol after short delay (allow registry to start first)
  setTimeout(() => {
    beacon.start();
    // The node with highest priority starts as initial coordinator
    // (In a real system all nodes would race — here we let the election happen naturally)
    election.startElection();
  }, 8000);
});
