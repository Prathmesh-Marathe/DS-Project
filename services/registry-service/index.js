const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// In-memory registry tables
const services = {};   // name -> { url, lastUpdated }
const responders = {}; // id -> { name, type, location, status, lastUpdated }

// Middleware to log requests (illustrates monitoring distributed requests)
app.use((req, res, next) => {
  console.log(`[Registry] ${req.method} ${req.url} - ${JSON.stringify(req.body)}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'UP', service: 'registry-service' });
});

// Register a service or responder
app.post('/register', (req, res) => {
  const { type, name, url, id, location, status } = req.body;

  if (type === 'service') {
    if (!name || !url) {
      return res.status(400).json({ error: 'Service name and url are required' });
    }
    services[name] = { url, lastUpdated: new Date() };
    console.log(`[Registry] Registered service: ${name} -> ${url}`);
    return res.json({ message: `Service ${name} registered successfully` });
  } 
  
  if (type === 'responder') {
    if (!id || !name) {
      return res.status(400).json({ error: 'Responder id and name are required' });
    }
    responders[id] = {
      id,
      name,
      type: req.body.responderType || 'ambulance',
      location: location || { lat: 12.9716, lng: 77.5946 },
      status: status || 'Available',
      lastUpdated: new Date()
    };
    console.log(`[Registry] Registered responder: ${id} (${responders[id].type})`);
    return res.json({ message: `Responder ${id} registered successfully` });
  }

  res.status(400).json({ error: 'Invalid type. Must be "service" or "responder"' });
});

// Lookup service URL
app.get('/lookup/:name', (req, res) => {
  const { name } = req.params;
  const service = services[name];
  if (!service) {
    return res.status(404).json({ error: `Service ${name} not found in registry` });
  }
  res.json({ name, url: service.url });
});

// Get all services
app.get('/services', (req, res) => {
  res.json(services);
});

// Get all responders
app.get('/responders', (req, res) => {
  res.json(Object.values(responders));
});

// Get specific responder
app.get('/responders/:id', (req, res) => {
  const responder = responders[req.params.id];
  if (!responder) {
    return res.status(404).json({ error: 'Responder not found' });
  }
  res.json(responder);
});

// Update responder status or coordinates dynamically
app.post('/responders/:id/update', (req, res) => {
  const { id } = req.params;
  const { location, status } = req.body;
  
  if (!responders[id]) {
    responders[id] = { id, name: id, type: 'ambulance', lastUpdated: new Date() };
  }

  if (location) responders[id].location = location;
  if (status) responders[id].status = status;
  responders[id].lastUpdated = new Date();

  console.log(`[Registry] Updated responder ${id}: status=${status}, location=${JSON.stringify(location)}`);
  res.json({ message: `Responder ${id} updated`, data: responders[id] });
});

app.listen(PORT, () => {
  console.log(`Registry Service running on port ${PORT}`);
});
