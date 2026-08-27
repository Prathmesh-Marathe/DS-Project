const net = require('net');
const http = require('http');
const express = require('express');
const cors = require('cors');
const aedes = require('aedes')();
const ws = require('websocket-stream');
const { Server } = require('socket.io');

// --- 1. Initialize Aedes MQTT Broker ---
// Start TCP Server on Port 1883
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

// Monitor broker clients and messages
aedes.on('client', (client) => {
  console.log(`[MQTT Broker] Client Connected: ${client ? client.id : 'unknown'}`);
});

aedes.on('clientDisconnect', (client) => {
  console.log(`[MQTT Broker] Client Disconnected: ${client ? client.id : 'unknown'}`);
});

aedes.on('subscribe', (subscriptions, client) => {
  console.log(`[MQTT Broker] Client ${client ? client.id : 'unknown'} subscribed to: ${subscriptions.map(s => s.topic).join(', ')}`);
});

aedes.on('publish', (packet, client) => {
  if (packet.topic.startsWith('$SYS')) return; // ignore system topics
  console.log(`[MQTT Broker] Publish from ${client ? client.id : 'Broker'}: topic="${packet.topic}"`);
});


// --- 2. Initialize Socket.IO Signaling Server ---
const app = express();
app.use(cors());
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

io.on('connection', (socket) => {
  console.log(`[Signaling Server] Socket connected: ${socket.id}`);

  // Register identity
  socket.on('register-session', ({ role, userId }) => {
    connectedNodes[socket.id] = { role, userId };
    socket.join(role); // join role-based rooms (citizen, dispatcher, responder)
    if (userId) {
      socket.join(userId); // join direct user room for 1-to-1 messaging
      console.log(`[Signaling Server] Registered socket ${socket.id} to user ${userId} (${role})`);
    }
  });

  // Handle Room Joining (for WebRTC calls)
  socket.on('join-call-room', ({ roomId }) => {
    socket.join(roomId);
    console.log(`[Signaling Server] Socket ${socket.id} joined call room: ${roomId}`);
    // Notify other peers in room
    socket.to(roomId).emit('peer-joined', { socketId: socket.id });
  });

  // Relay WebRTC signals (Offers, Answers, ICE Candidates)
  socket.on('webrtc-signal', ({ roomId, signal, targetSocketId }) => {
    // If target is specific socket, send to them. Else broadcast to the room.
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc-signal', { signal, senderSocketId: socket.id });
    } else if (roomId) {
      socket.to(roomId).emit('webrtc-signal', { signal, senderSocketId: socket.id });
    }
  });

  // Simulate P2P Edge connection signals (offline relay initialization)
  socket.on('p2p-discover-peers', ({ region, responderId }) => {
    console.log(`[Signaling Server] Responder ${responderId} querying online peers in ${region}`);
    // In real system, dynamic registry or local bluetooth does this.
    // We simulate list of online peers in the same region.
    const peers = Object.entries(connectedNodes)
      .filter(([sid, node]) => node.role === 'responder' && node.userId !== responderId)
      .map(([sid, node]) => ({ socketId: sid, responderId: node.userId }));
    
    socket.emit('p2p-peers-list', peers);
  });

  // Handle Disconnection
  socket.on('disconnect', () => {
    const node = connectedNodes[socket.id];
    if (node) {
      console.log(`[Signaling Server] Socket disconnected: ${socket.id} (user: ${node.userId}, role: ${node.role})`);
      delete connectedNodes[socket.id];
    } else {
      console.log(`[Signaling Server] Socket disconnected: ${socket.id}`);
    }
  });
});

signalingHttpServer.listen(SIGNALING_PORT, () => {
  console.log(`[Signaling Server] Running on port ${SIGNALING_PORT}`);
});
