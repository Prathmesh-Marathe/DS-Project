import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import mqtt from 'mqtt';
import { 
  ShieldAlert, 
  MapPin, 
  Video, 
  PhoneOff, 
  Wifi, 
  WifiOff, 
  Send, 
  Truck, 
  Activity, 
  RefreshCw, 
  CheckCircle,
  Database,
  Users
} from 'lucide-react';

// Endpoints
const REGISTRY_URL = 'http://localhost:5000';
const INCIDENT_URL = 'http://localhost:5001';
const DISPATCH_URL = 'http://localhost:5002';
const RESOURCE_URL = 'http://localhost:5003';
const SIGNALING_URL = 'http://localhost:5004';
const MQTT_WS_URL = 'ws://localhost:9001';

// Coords mapping for SVG Map
const MAP_LAT_MIN = 12.90;
const MAP_LAT_MAX = 13.05;
const MAP_LNG_MIN = 77.50;
const MAP_LNG_MAX = 77.65;

const latToY = (lat) => 450 - ((lat - MAP_LAT_MIN) / (MAP_LAT_MAX - MAP_LAT_MIN)) * 400;
const lngToX = (lng) => 50 + ((lng - MAP_LNG_MIN) / (MAP_LNG_MAX - MAP_LNG_MIN)) * 700;

export default function App() {
  const [activeTab, setActiveTab] = useState('citizen');
  
  // Real-time states
  const [incidents, setIncidents] = useState([]);
  const [resources, setResources] = useState([]);
  const [responders, setResponders] = useState([]);
  
  // Socket.IO & MQTT Clients
  const [socket, setSocket] = useState(null);
  const [mqttClient, setMqttClient] = useState(null);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);

  // Citizen Panel State
  const [citizenName, setCitizenName] = useState('John Doe');
  const [citizenLat, setCitizenLat] = useState(12.9716);
  const [citizenLng, setCitizenLng] = useState(77.5946);
  const [incidentType, setIncidentType] = useState('medical');
  const [citizenCallState, setCitizenCallState] = useState('idle'); // idle, calling, connected
  const [callRoomId, setCallRoomId] = useState(null);
  
  // Dispatch Panel State
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  const [nearestResources, setNearestResources] = useState([]);
  const [dispatchCallState, setDispatchCallState] = useState('idle'); // idle, incoming, connected
  
  // Responder Panel State
  const [currentResponderId, setCurrentResponderId] = useState('station-1'); // matches initialized resources
  const [responderStatus, setResponderStatus] = useState('Available');
  const [isOffline, setIsOffline] = useState(false);
  const [offlineQueue, setOfflineQueue] = useState([]);
  const [responderLat, setResponderLat] = useState(12.9716);
  const [responderLng, setResponderLng] = useState(77.5946);
  const [assignedIncident, setAssignedIncident] = useState(null);
  const [peerRelayTarget, setPeerRelayTarget] = useState('');

  // Video streams refs for WebRTC
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const dispatcherLocalVideoRef = useRef(null);
  const dispatcherRemoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);

  // Fetch initial data
  const refreshData = async () => {
    try {
      const incRes = await fetch(`${INCIDENT_URL}/incidents`).then(r => r.json());
      setIncidents(incRes);
    } catch (e) {
      console.warn('Failed to load incidents REST endpoint', e);
    }

    try {
      const resRes = await fetch(`${RESOURCE_URL}/resources`).then(r => r.json());
      setResources(resRes);
    } catch (e) {
      console.warn('Failed to load resources REST endpoint', e);
    }

    try {
      const respRes = await fetch(`${REGISTRY_URL}/responders`).then(r => r.json());
      setResponders(respRes);
    } catch (e) {
      console.warn('Failed to load responders registry endpoint', e);
    }
  };

  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, 5000);
    return () => clearInterval(interval);
  }, []);

  // Initialize Socket.IO connection
  useEffect(() => {
    const s = io(SIGNALING_URL);
    setSocket(s);

    s.on('connect', () => {
      setSocketConnected(true);
      s.emit('register-session', { role: 'dispatcher', userId: 'dispatcher-1' });
    });

    s.on('disconnect', () => {
      setSocketConnected(false);
    });

    // Handle WebRTC signal relay
    s.on('webrtc-signal', async ({ signal, senderSocketId }) => {
      if (pcRef.current) {
        try {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal.sdp || signal));
          if (signal.type === 'offer') {
            const answer = await pcRef.current.createAnswer();
            await pcRef.current.setLocalDescription(answer);
            s.emit('webrtc-signal', { targetSocketId: senderSocketId, signal: answer });
            setDispatchCallState('connected');
          }
        } catch (err) {
          console.error('Error handling WebRTC signal:', err);
        }
      }
    });

    return () => {
      s.disconnect();
    };
  }, []);

  // Initialize MQTT Client over Websockets
  useEffect(() => {
    if (isOffline) {
      if (mqttClient) {
        mqttClient.end();
        setMqttClient(null);
        setMqttConnected(false);
      }
      return;
    }

    console.log('Connecting to MQTT over Websockets:', MQTT_WS_URL);
    const client = mqtt.connect(MQTT_WS_URL, { clientId: 'frontend-dashboard-' + Math.random().toString(16).substr(2, 8) });
    setMqttClient(client);

    client.on('connect', () => {
      setMqttConnected(true);
      console.log('MQTT Connected via Websockets');
      // Subscribe to incident broadcasts and location updates
      client.subscribe('incidents/new/+');
      client.subscribe('incidents/update/+');
      client.subscribe('responders/+/location');
      client.subscribe('responders/+/assignment');
      client.subscribe('resources/+/capacity');
    });

    client.on('message', (topic, message) => {
      const payload = JSON.parse(message.toString());
      console.log(`[MQTT Receive] ${topic}:`, payload);

      if (topic.startsWith('incidents/new/')) {
        setIncidents(prev => {
          if (prev.some(i => i.id === payload.id)) return prev;
          return [payload, ...prev];
        });
      } else if (topic.startsWith('incidents/update/')) {
        setIncidents(prev => prev.map(i => i.id === payload.id ? payload : i));
      } else if (topic.startsWith('responders/') && topic.endsWith('/location')) {
        setResponders(prev => {
          const idx = prev.findIndex(r => r.id === payload.id);
          if (idx === -1) return [...prev, payload];
          return prev.map(r => r.id === payload.id ? { ...r, location: payload.location, lastUpdated: new Date() } : r);
        });
      } else if (topic.startsWith('responders/') && topic.endsWith('/assignment')) {
        if (payload.responderId === currentResponderId) {
          setAssignedIncident(payload.incident);
          setResponderStatus('Dispatched');
        }
      }
    });

    client.on('close', () => {
      setMqttConnected(false);
    });

    return () => {
      client.end();
    };
  }, [isOffline, currentResponderId]);

  // Handle Dispatch Selection lookup for Nearest Resources
  useEffect(() => {
    if (!selectedIncidentId) return;
    const selected = incidents.find(i => i.id === selectedIncidentId);
    if (!selected) return;

    fetch(`${RESOURCE_URL}/resources/nearest?type=${selected.type}&lat=${selected.location.lat}&lng=${selected.location.lng}`)
      .then(r => r.json())
      .then(data => setNearestResources(data))
      .catch(e => console.error('Error loading nearest resources', e));
  }, [selectedIncidentId, incidents]);

  // Citizen: Create Canvas Mock Video Stream to guarantee WebRTC call visual
  const createMockMediaStream = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    
    // Draw loop
    let angle = 0;
    const timer = setInterval(() => {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 640, 480);
      
      // Moving radar circle
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(320, 240, 100 + Math.sin(angle) * 30, 0, Math.PI * 2);
      ctx.stroke();
      
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(320, 240, 10, 0, Math.PI * 2);
      ctx.fill();

      // Text status
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText('LIVE EMERGENCY FEED', 180, 80);
      ctx.font = '16px sans-serif';
      ctx.fillText(`GPS: ${citizenLat.toFixed(4)}, ${citizenLng.toFixed(4)}`, 230, 400);
      ctx.fillText(new Date().toLocaleTimeString(), 270, 430);
      angle += 0.1;
    }, 100);

    const stream = canvas.captureStream(30);
    // attach interval reference to stream so we can clear it on stop
    stream.stopTimer = () => clearInterval(timer);
    return stream;
  };

  // WebRTC Initiate Video Call (Citizen -> Dispatcher)
  const startCall = async () => {
    setCitizenCallState('calling');
    const roomId = `call-${Date.now()}`;
    setCallRoomId(roomId);
    
    // 1. Join room on signaling server
    socket.emit('join-call-room', { roomId });

    // 2. Setup RTCPeerConnection
    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    // Get track/media (use mock canvas stream)
    const stream = createMockMediaStream();
    localStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    // Handle candidates (simulated loopback/relay)
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-signal', { roomId, signal: { candidate: event.candidate } });
      }
    };

    // 3. Create Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    // Send offer via signaling server
    socket.emit('webrtc-signal', { roomId, signal: offer });
    setCitizenCallState('connected');
    
    // Also notify dispatcher of incoming call
    socket.emit('webrtc-signal', { roomId, signal: { type: 'incoming-call-alert', roomId } });
  };

  // End call helper
  const endCall = () => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      if (localStreamRef.current.stopTimer) {
        localStreamRef.current.stopTimer();
      }
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    setCitizenCallState('idle');
    setDispatchCallState('idle');
    setCallRoomId(null);
  };

  // Citizen: Report Incident REST call
  const reportIncident = async (e) => {
    e.preventDefault();
    const payload = {
      type: incidentType,
      location: { lat: citizenLat, lng: citizenLng },
      reportedBy: citizenName,
      region: 'region-north'
    };

    try {
      const res = await fetch(`${INCIDENT_URL}/incidents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(r => r.json());

      console.log('Incident reported via REST API:', res);
      refreshData();
      alert(`Incident reported! ID: ${res.id}`);
    } catch (err) {
      console.error('Failed to post incident via REST:', err);
      alert('Error connecting to incident-service');
    }
  };

  // Dispatcher: Assign Resource REST call
  const assignResource = async (resourceId) => {
    if (!selectedIncidentId) return;

    try {
      const res = await fetch(`${DISPATCH_URL}/dispatch/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId: selectedIncidentId,
          resourceId
        })
      });

      const data = await res.json();
      if (res.ok) {
        alert('Resource successfully assigned!');
        refreshData();
      } else {
        alert(`Failed to assign: ${data.error}`);
      }
    } catch (err) {
      console.error('Dispatch assignment failed:', err);
      alert('Network error connecting to dispatch-service');
    }
  };

  // Responder: Handle simulated coordinate movements
  const simulateMovement = () => {
    // Determine target location (assigned incident coordinates or random)
    let targetLat = 12.9716;
    let targetLng = 77.5946;

    if (assignedIncident) {
      targetLat = assignedIncident.location.lat;
      targetLng = assignedIncident.location.lng;
    }

    // Step towards target
    const step = 0.005;
    const deltaLat = targetLat - responderLat;
    const deltaLng = targetLng - responderLng;

    const newLat = responderLat + Math.sign(deltaLat) * Math.min(Math.abs(deltaLat), step);
    const newLng = responderLng + Math.sign(deltaLng) * Math.min(Math.abs(deltaLng), step);

    setResponderLat(newLat);
    setResponderLng(newLng);

    const updateEvent = {
      id: currentResponderId,
      location: { lat: newLat, lng: newLng },
      status: responderStatus,
      timestamp: new Date().toISOString()
    };

    if (isOffline) {
      // Offline mode: Queue events locally (Fault Tolerance)
      setOfflineQueue(prev => [...prev, { ...updateEvent, type: 'location-update' }]);
      console.log('[Responder Queue] Network offline. Queued location update:', updateEvent);
    } else {
      // Online mode: Stream via MQTT Broker
      if (mqttClient && mqttClient.connected) {
        mqttClient.publish(`responders/${currentResponderId}/location`, JSON.stringify(updateEvent));
      }
      // Also update Registry database
      fetch(`${REGISTRY_URL}/responders/${currentResponderId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: { lat: newLat, lng: newLng } })
      });
    }
  };

  // Responder: Update Status (Available, En Route, On Scene)
  const updateResponderStatus = (newStatus) => {
    setResponderStatus(newStatus);
    const updateEvent = {
      id: currentResponderId,
      status: newStatus,
      timestamp: new Date().toISOString()
    };

    if (isOffline) {
      setOfflineQueue(prev => [...prev, { ...updateEvent, type: 'status-update' }]);
      console.log('[Responder Queue] Network offline. Queued status update:', updateEvent);
    } else {
      if (mqttClient && mqttClient.connected) {
        mqttClient.publish(`responders/${currentResponderId}/status`, JSON.stringify(updateEvent));
      }
      fetch(`${REGISTRY_URL}/responders/${currentResponderId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
    }
  };

  // Responder: Handle Offline simulation toggle
  const toggleOffline = () => {
    if (isOffline) {
      // Coming back online (Reconnection sync)
      setIsOffline(false);
      console.log('[Responder Reconnect] Reconnecting to distributed system. Flushing queue:', offlineQueue);
      
      // Flash sync events (Fault Tolerance / Write-Ahead Syncing)
      offlineQueue.forEach(async (evt) => {
        if (evt.type === 'location-update') {
          fetch(`${REGISTRY_URL}/responders/${currentResponderId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: evt.location })
          });
        } else if (evt.type === 'status-update') {
          fetch(`${REGISTRY_URL}/responders/${currentResponderId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: evt.status })
          });
        }
      });
      setOfflineQueue([]);
      alert('System reconnected. Write-ahead queue flushed and synced successfully!');
    } else {
      setIsOffline(true);
      alert('Network drop simulated. Device now operating in offline stand-alone mode.');
    }
  };

  // Responder: Simulate P2P Edge Relay (Unit 2 P2P messaging)
  const triggerP2PRelay = () => {
    if (offlineQueue.length === 0) {
      alert('Write-ahead queue is empty. Nothing to relay.');
      return;
    }
    if (!peerRelayTarget) {
      alert('Please specify a nearby online Responder ID to relay through.');
      return;
    }

    // Simulate WebRTC data channel transfer
    alert(`Transferring ${offlineQueue.length} queued events to neighboring node: ${peerRelayTarget} via P2P relay...`);
    
    // Simulate target node forwarding the queue on our behalf
    offlineQueue.forEach((evt) => {
      // Target node makes database updates or publishes on our behalf
      if (evt.type === 'location-update') {
        fetch(`${REGISTRY_URL}/responders/${currentResponderId}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location: evt.location })
        });
      } else if (evt.type === 'status-update') {
        fetch(`${REGISTRY_URL}/responders/${currentResponderId}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: evt.status })
        });
      }
    });

    setOfflineQueue([]);
    alert('Relay complete! Local queue cleared.');
  };

  // Stations: Simulating manual station capacity changes
  const adjustCapacity = async (stationId, val) => {
    const station = resources.find(r => r.id === stationId);
    if (!station) return;
    
    const targetUrl = val > 0 ? '/resources/release' : '/resources/claim';
    
    try {
      await fetch(`${RESOURCE_URL}${targetUrl}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: stationId })
      });
      refreshData();
    } catch (e) {
      alert('Error updating capacity endpoint');
    }
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div className="logo-section">
          <div className="logo-icon">
            <ShieldAlert size={22} color="white" />
          </div>
          <div className="logo-text">
            <h1>DERRCS Console</h1>
            <p>Distributed Emergency Response & Resource Coordination System</p>
          </div>
        </div>

        {/* Network Status indicators */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
            <Database size={14} color={socketConnected ? '#10b981' : '#ef4444'} />
            <span style={{ color: socketConnected ? '#10b981' : '#ef4444' }}>
              Signaling: {socketConnected ? 'Online' : 'Offline'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
            <Activity size={14} color={mqttConnected ? '#10b981' : '#ef4444'} />
            <span style={{ color: mqttConnected ? '#10b981' : '#ef4444' }}>
              Broker: {mqttConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          <button className="tab-btn btn-secondary" onClick={refreshData} style={{ padding: '6px 10px' }}>
            <RefreshCw size={14} />
          </button>
        </div>

        {/* Actor tabs */}
        <nav className="navigation-tabs">
          <button className={`tab-btn ${activeTab === 'citizen' ? 'active' : ''}`} onClick={() => setActiveTab('citizen')}>
            <Users size={16} /> Citizen
          </button>
          <button className={`tab-btn ${activeTab === 'dispatch' ? 'active' : ''}`} onClick={() => setActiveTab('dispatch')}>
            <ShieldAlert size={16} /> Dispatch Center
          </button>
          <button className={`tab-btn ${activeTab === 'responder' ? 'active' : ''}`} onClick={() => setActiveTab('responder')}>
            <Truck size={16} /> Field Responder
          </button>
          <button className={`tab-btn ${activeTab === 'stations' ? 'active' : ''}`} onClick={() => setActiveTab('stations')}>
            <Database size={16} /> Resource Stations
          </button>
        </nav>
      </header>

      {/* Main Grid View depending on tab selection */}
      <main className="main-content">
        {activeTab === 'citizen' && (
          <div className="view-grid-citizen">
            <div className="glass-panel">
              <h2>Report Incident</h2>
              <form onSubmit={reportIncident}>
                <div className="form-group">
                  <label>Reporter Name</label>
                  <input type="text" className="form-control" value={citizenName} onChange={e => setCitizenName(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label>Emergency Type</label>
                  <select className="form-control" value={incidentType} onChange={e => setIncidentType(e.target.value)}>
                    <option value="medical">Medical Incident (Ambulance)</option>
                    <option value="fire">Fire Incident (Fire Truck)</option>
                    <option value="police">Police Emergency</option>
                  </select>
                </div>
                <div className="form-group" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div>
                    <label>Latitude</label>
                    <input type="number" step="0.001" className="form-control" value={citizenLat} onChange={e => setCitizenLat(parseFloat(e.target.value))} />
                  </div>
                  <div>
                    <label>Longitude</label>
                    <input type="number" step="0.001" className="form-control" value={citizenLng} onChange={e => setCitizenLng(parseFloat(e.target.value))} />
                  </div>
                </div>
                <button type="submit" className="btn" style={{ marginBottom: '12px' }}>
                  <Send size={16} /> Report Emergency (REST)
                </button>
              </form>

              <h2 style={{ marginTop: '24px' }}>Video / Audio Link</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  Establish a real-time WebRTC media connection directly with the Dispatch Room signaling server.
                </p>
                {citizenCallState === 'idle' ? (
                  <button className="btn btn-danger" onClick={startCall}>
                    <Video size={16} /> Start WebRTC Video Call
                  </button>
                ) : (
                  <button className="btn btn-secondary" onClick={endCall}>
                    <PhoneOff size={16} /> End Video Call
                  </button>
                )}
                {citizenCallState !== 'idle' && (
                  <div className="video-call-box">
                    <video className="video-element" ref={localVideoRef} autoPlay playsInline muted />
                    <div className="call-overlay-text">Local WebRTC Stream</div>
                  </div>
                )}
              </div>
            </div>

            {/* Map Preview */}
            <div className="glass-panel">
              <h2>Incident Coordinates Location Map</h2>
              <div className="map-canvas-container">
                <svg className="map-svg" viewBox="0 0 800 500">
                  {/* Grid Lines */}
                  {Array.from({ length: 16 }).map((_, i) => (
                    <line key={i} x1={50 + i * 50} y1={0} x2={50 + i * 50} y2={500} className="grid-line" />
                  ))}
                  {Array.from({ length: 10 }).map((_, i) => (
                    <line key={i} x1={0} y1={50 + i * 50} x2={800} y2={50 + i * 50} className="grid-line" />
                  ))}
                  
                  {/* Citizen coordinates marker */}
                  <circle cx={lngToX(citizenLng)} cy={latToY(citizenLat)} r={10} fill="rgba(239,68,68,0.3)" />
                  <circle cx={lngToX(citizenLng)} cy={latToY(citizenLat)} r={4} fill="#ef4444" className="blinker" />
                  <text x={lngToX(citizenLng) + 12} y={latToY(citizenLat) + 4} fill="#ef4444" fontSize="11" fontWeight="bold">Report Marker</text>
                </svg>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'dispatch' && (
          <div className="view-grid-dispatch">
            {/* Left: Incidents list */}
            <div className="glass-panel scrollable">
              <h2>Incidents Board</h2>
              {incidents.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No active incidents reported.</p>
              ) : (
                incidents.map(inc => (
                  <div 
                    key={inc.id} 
                    className={`incident-card ${inc.type} ${selectedIncidentId === inc.id ? 'selected' : ''}`}
                    onClick={() => setSelectedIncidentId(inc.id)}
                  >
                    <div className="incident-card-header">
                      <span style={{ fontWeight: '700', fontSize: '13px' }}>{inc.id}</span>
                      <span className={`badge badge-${inc.status.toLowerCase()}`}>{inc.status}</span>
                    </div>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Type: {inc.type}</p>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Location: {inc.location.lat.toFixed(4)}, {inc.location.lng.toFixed(4)}</p>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Reporter: {inc.reportedBy}</p>
                  </div>
                ))
              )}
            </div>

            {/* Center: Live Map */}
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
              <h2>Regional Incident Tracking Map</h2>
              <div className="map-canvas-container" style={{ flex: 1 }}>
                <svg className="map-svg" viewBox="0 0 800 500">
                  {/* Grid background */}
                  {Array.from({ length: 16 }).map((_, i) => (
                    <line key={i} x1={50 + i * 50} y1={0} x2={50 + i * 50} y2={500} className="grid-line" />
                  ))}
                  {Array.from({ length: 10 }).map((_, i) => (
                    <line key={i} x1={0} y1={50 + i * 50} x2={800} y2={50 + i * 50} className="grid-line" />
                  ))}

                  {/* Resource stations */}
                  {resources.map(res => (
                    <g key={res.id}>
                      <rect x={lngToX(res.location.lng) - 10} y={latToY(res.location.lat) - 10} width={20} height={20} fill="#3b82f6" rx={3} />
                      <text x={lngToX(res.location.lng) - 20} y={latToY(res.location.lat) - 14} fill="#3b82f6" fontSize="9" fontWeight="bold">{res.name}</text>
                      <text x={lngToX(res.location.lng) - 8} y={latToY(res.location.lat) + 4} fill="#fff" fontSize="8" fontWeight="bold">{res.availableCount}</text>
                    </g>
                  ))}

                  {/* Active incidents */}
                  {incidents.filter(inc => inc.status !== 'Resolved').map(inc => (
                    <g key={inc.id}>
                      <circle cx={lngToX(inc.location.lng)} cy={latToY(inc.location.lat)} r={12} fill="rgba(239, 68, 68, 0.2)" className="blinker" />
                      <circle cx={lngToX(inc.location.lng)} cy={latToY(inc.location.lat)} r={5} fill="#ef4444" />
                      <text x={lngToX(inc.location.lng) + 10} y={latToY(inc.location.lat) + 4} fill="#ef4444" fontSize="9" fontWeight="bold">{inc.id}</text>
                    </g>
                  ))}

                  {/* Responder GPS coordinates updates */}
                  {responders.map(resp => (
                    <g key={resp.id}>
                      <circle cx={lngToX(resp.location.lat)} cy={latToY(resp.location.lng)} r={7} fill="#10b981" />
                      <circle cx={lngToX(resp.location.lat)} cy={latToY(resp.location.lng)} r={3} fill="#fff" />
                      <text x={lngToX(resp.location.lat) + 10} y={latToY(resp.location.lng) + 4} fill="#10b981" fontSize="9" fontWeight="bold">
                        {resp.id} ({resp.status})
                      </text>
                    </g>
                  ))}
                </svg>
              </div>
            </div>

            {/* Right: Dispatch allocation & Video Feed */}
            <div className="glass-panel scrollable">
              <h2>Dispatch Allocation</h2>
              {selectedIncidentId ? (
                <div>
                  <h3 style={{ marginBottom: '12px' }}>Selected Incident: {selectedIncidentId}</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '6px' }}>
                      <p style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                        System queries nearest available resource stations from <code>resource-service</code>.
                      </p>
                    </div>
                    {nearestResources.length === 0 ? (
                      <p style={{ color: 'var(--text-muted)', fontSize: '12px' }}>No available stations with capacity.</p>
                    ) : (
                      nearestResources.map(r => (
                        <div key={r.id} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <p style={{ fontSize: '12px', fontWeight: '600' }}>{r.name}</p>
                            <p style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Dist: {r.distance ? r.distance.toFixed(2) : 0} km | Cap: {r.availableCount}/{r.capacity}</p>
                          </div>
                          <button className="btn" style={{ padding: '6px 12px', width: 'auto', fontSize: '11px' }} onClick={() => assignResource(r.id)}>
                            Dispatch
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Select an incident from the board to assign resources.</p>
              )}

              <h2 style={{ marginTop: '24px' }}>Citizen Video Feeds</h2>
              {citizenCallState !== 'idle' ? (
                <div>
                  <div className="video-call-box">
                    <video className="video-element" ref={dispatcherRemoteVideoRef} autoPlay playsInline muted />
                    <div className="call-overlay-text">Incoming WebRTC Stream</div>
                  </div>
                  <button className="btn btn-secondary" style={{ marginTop: '8px' }} onClick={endCall}>
                    <PhoneOff size={16} /> Hang Up Call
                  </button>
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No active video streams incoming.</p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'responder' && (
          <div className="view-grid-responder">
            <div className="glass-panel">
              <h2>Responder Terminal</h2>
              
              {/* Identity Select */}
              <div className="form-group">
                <label>Select Responder Node ID</label>
                <select className="form-control" value={currentResponderId} onChange={e => {
                  setCurrentResponderId(e.target.value);
                  setAssignedIncident(null);
                  setResponderStatus('Available');
                }}>
                  <option value="station-1">Ambulance Station-1 (Hospital Alpha)</option>
                  <option value="station-2">Ambulance Station-2 (City Medical)</option>
                  <option value="station-3">Fire Rescue Unit 3</option>
                  <option value="station-4">Police Patrol Unit 4</option>
                </select>
              </div>

              {/* Offline Toggle Simulation */}
              <div className={isOffline ? 'offline-banner' : ''} style={{ border: '1px solid var(--border-color)', borderRadius: '6px', padding: '12px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '13px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {isOffline ? <WifiOff size={16} /> : <Wifi size={16} color="#10b981" />}
                    Network Connection
                  </span>
                  <button className={`btn ${isOffline ? 'btn-success' : 'btn-danger'}`} style={{ width: 'auto', padding: '4px 10px', fontSize: '12px' }} onClick={toggleOffline}>
                    {isOffline ? 'Go Online' : 'Drop Connection'}
                  </button>
                </div>
                {isOffline && (
                  <p style={{ fontSize: '11px', color: 'var(--text-danger)', marginTop: '8px' }}>
                    Writes are queued locally in a write-ahead table. Unsent queue count: <span className="queue-badge">{offlineQueue.length}</span>
                  </p>
                )}
              </div>

              {/* Status Update Controls */}
              <div style={{ marginBottom: '20px' }}>
                <h3>Update Status</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginTop: '6px' }}>
                  <button className={`btn btn-secondary ${responderStatus === 'Available' ? 'active' : ''}`} style={{ fontSize: '11px', padding: '8px 4px' }} onClick={() => updateResponderStatus('Available')}>
                    Available
                  </button>
                  <button className={`btn btn-secondary ${responderStatus === 'En Route' ? 'active' : ''}`} style={{ fontSize: '11px', padding: '8px 4px' }} onClick={() => updateResponderStatus('En Route')}>
                    En Route
                  </button>
                  <button className={`btn btn-secondary ${responderStatus === 'On Scene' ? 'active' : ''}`} style={{ fontSize: '11px', padding: '8px 4px' }} onClick={() => updateResponderStatus('On Scene')}>
                    On Scene
                  </button>
                </div>
              </div>

              {/* Simulated GPS Coordinate Movement */}
              <div style={{ marginBottom: '20px' }}>
                <h3>Simulated Location Stream</h3>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>GPS: {responderLat.toFixed(4)}, {responderLng.toFixed(4)}</p>
                <button className="btn btn-secondary" style={{ marginTop: '8px' }} onClick={simulateMovement}>
                  Move closer to Target Incident (+GPS step)
                </button>
              </div>

              {/* Peer to Peer Relay section */}
              {isOffline && (
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed var(--border-color)', padding: '12px', borderRadius: '8px', marginTop: '16px' }}>
                  <h3 style={{ color: 'var(--color-warning)' }}>Simulate P2P Peer Relay</h3>
                  <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                    Relay your offline write-ahead queue to another online responder in range via WebRTC DataChannel simulation.
                  </p>
                  <div className="form-group">
                    <label>Target Peer ID</label>
                    <select className="form-control" value={peerRelayTarget} onChange={e => setPeerRelayTarget(e.target.value)}>
                      <option value="">-- Select nearby responder --</option>
                      <option value="station-1">station-1 (Ambulance)</option>
                      <option value="station-2">station-2 (Ambulance)</option>
                      <option value="station-3">station-3 (Fire)</option>
                      <option value="station-4">station-4 (Police)</option>
                    </select>
                  </div>
                  <button className="btn btn-secondary" onClick={triggerP2PRelay} style={{ borderColor: 'var(--color-warning)', color: 'var(--color-warning)' }}>
                    Transmit Queue via P2P
                  </button>
                </div>
              )}
            </div>

            {/* Incident Details Card */}
            <div className="glass-panel">
              <h2>Assigned Incident Task</h2>
              {assignedIncident ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '16px', borderRadius: '8px' }}>
                    <p style={{ color: 'var(--color-danger)', fontWeight: '700', fontSize: '15px' }}>EMERGENCY BROADCAST ALERT</p>
                    <h3 style={{ fontSize: '16px', marginTop: '8px', color: '#fff' }}>Incident ID: {assignedIncident.id}</h3>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>Type: {assignedIncident.type}</p>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Reporter: {assignedIncident.reportedBy}</p>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>Coordinates: {assignedIncident.location.lat.toFixed(4)}, {assignedIncident.location.lng.toFixed(4)}</p>
                  </div>
                  <button className="btn btn-success" onClick={() => {
                    alert('Incident resolved!');
                    // Call API to resolve incident
                    fetch(`${INCIDENT_URL}/incidents/${assignedIncident.id}/status`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ status: 'Resolved' })
                    }).then(() => {
                      setAssignedIncident(null);
                      setResponderStatus('Available');
                      refreshData();
                    });
                  }}>
                    <CheckCircle size={16} /> Mark Incident as Resolved
                  </button>
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Waiting for dispatch assignments...</p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'stations' && (
          <div className="view-grid-station">
            <div className="glass-panel">
              <h2>Resource Stations Capacity Monitor</h2>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                Resource stations manage live capacities (e.g. beds, fire engines). Dispatches trigger automatic decrement via the <code>resource-service</code> REST API. Local adjustments are broadcasted dynamically.
              </p>
              <div className="resource-grid">
                {resources.map(res => {
                  const percent = (res.availableCount / res.capacity) * 100;
                  const status = percent > 50 ? 'success' : percent > 20 ? 'warning' : 'danger';
                  
                  return (
                    <div key={res.id} className="resource-card">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: '700', fontSize: '14px' }}>{res.name}</span>
                        <span className="badge badge-resolved">{res.type}</span>
                      </div>
                      <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Location: {res.location.lat}, {res.location.lng}</p>
                      
                      <div style={{ marginTop: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                          <span>Capacity Allocation</span>
                          <span style={{ fontWeight: 'bold' }}>{res.availableCount} / {res.capacity} Available</span>
                        </div>
                        <div className="capacity-bar-container">
                          <div 
                            className={`capacity-bar-fill ${status}`} 
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                      </div>

                      {/* Manual adjust buttons (simulate station local updates) */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '12px' }}>
                        <button className="btn btn-secondary" style={{ padding: '4px 6px', fontSize: '11px' }} onClick={() => adjustCapacity(res.id, -1)}>
                          Admit Patient (-1)
                        </button>
                        <button className="btn btn-secondary" style={{ padding: '4px 6px', fontSize: '11px' }} onClick={() => adjustCapacity(res.id, 1)}>
                          Release Bed (+1)
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
