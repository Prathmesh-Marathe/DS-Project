import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
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
  Users,
  LogOut,
  Lock,
  Trash2
} from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, Circle, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default leaflet marker icon paths
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Custom icons
const incidentIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

const stationIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

const responderIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

// Endpoints
const REGISTRY_URL = 'http://localhost:5000';
const INCIDENT_URL = 'http://localhost:5001';
const DISPATCH_URL = 'http://localhost:5002';
const RESOURCE_URL = 'http://localhost:5003';
const SIGNALING_URL = 'http://localhost:5004';
const AUTH_URL = 'http://localhost:5005';
const MQTT_WS_URL = 'ws://localhost:9001';

// Component to dynamically pan/zoom Leaflet maps
function ChangeView({ center }) {
  const map = useMap();
  const prevCenterRef = useRef([null, null]);

  useEffect(() => {
    if (center && center[0] && center[1]) {
      const [lat, lng] = center;
      const [prevLat, prevLng] = prevCenterRef.current;
      if (lat !== prevLat || lng !== prevLng) {
        map.setView(center, map.getZoom());
        prevCenterRef.current = [lat, lng];
      }
    }
  }, [center, map]);
  return null;
}

// Click handler component for the Citizen Map
function MapClickHandler({ setLat, setLng }) {
  useMapEvents({
    click(e) {
      setLat(e.latlng.lat);
      setLng(e.latlng.lng);
    },
  });
  return null;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  
  // Auth state
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('user')) || null);
  const [loginError, setLoginError] = useState('');
  
  // Real-time states
  const [incidents, setIncidents] = useState([]);
  const [resources, setResources] = useState([]);
  const [responders, setResponders] = useState([]);
  
  // Socket & MQTT
  const [socket, setSocket] = useState(null);
  const [mqttClient, setMqttClient] = useState(null);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const mqttClientRef = useRef(null);
  const socketRef = useRef(null);
  const currentResponderIdRef = useRef('station-1');

  // Citizen Page State
  const [citizenName, setCitizenName] = useState(user?.role === 'citizen' ? user.name : 'Citizen Name');
  const [citizenLat, setCitizenLat] = useState(18.5204);
  const [citizenLng, setCitizenLng] = useState(73.8567);
  const [incidentType, setIncidentType] = useState('medical');
  const [citizenCallState, setCitizenCallState] = useState('idle'); // idle, calling, connected
  const [callRoomId, setCallRoomId] = useState(null);
  
  // Toast Notifications
  const [toasts, setToasts] = useState([]);
  const addToast = (message, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };
  
  // Dispatch Panel State
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  const [nearestResources, setNearestResources] = useState([]);
  const [dispatchCallState, setDispatchCallState] = useState('idle'); // idle, incoming, connected
  const [incomingOffer, setIncomingOffer] = useState(null);
  const [incomingCallSocketId, setIncomingCallSocketId] = useState(null);
  const [iceCandidateQueue, setIceCandidateQueue] = useState([]);
  
  // Responder Panel State
  const [currentResponderId, setCurrentResponderId] = useState('station-1');
  const [responderStatus, setResponderStatus] = useState('Available');
  useEffect(() => { currentResponderIdRef.current = currentResponderId; }, [currentResponderId]);
  const [isOffline, setIsOffline] = useState(false);
  const [offlineQueue, setOfflineQueue] = useState([]);
  const [responderLat, setResponderLat] = useState(18.5204);
  const [responderLng, setResponderLng] = useState(73.8567);
  const [assignedIncident, setAssignedIncident] = useState(null);
  const [peerRelayTarget, setPeerRelayTarget] = useState('');

  // Video streams refs for WebRTC
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const dispatcherRemoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);

  // Sync citizenName on user object loads
  useEffect(() => {
    if (user && user.role === 'citizen') {
      setCitizenName(user.name);
    }
  }, [user]);

  // Sync responder starting location to their station location when selected
  useEffect(() => {
    const station = resources.find(r => r.id === currentResponderId);
    if (station) {
      setResponderLat(station.location.lat);
      setResponderLng(station.location.lng);
    }
  }, [currentResponderId, resources]);

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
    if (socketRef.current) return;

    const s = io(SIGNALING_URL, { reconnection: true, reconnectionDelay: 1000 });
    socketRef.current = s;
    setSocket(s);

    s.on('connect', () => {
      setSocketConnected(true);
      console.log('[Socket] Connected to signaling server, socketId:', s.id);
      s.emit('register-session', { role: user?.role || 'anonymous', userId: user?.username || 'anonymous' });
    });

    s.on('disconnect', () => {
      setSocketConnected(false);
      console.log('[Socket] Disconnected from signaling server');
    });

    s.on('webrtc-signal', async ({ signal, senderSocketId }) => {
      console.log('[Socket] Received WebRTC signal:', signal.type || (signal.candidate ? 'candidate' : 'sdp'), 'from:', senderSocketId);
      if (signal.type === 'incoming-offer') {
        console.log('[Socket] Processing incoming offer, setting state');
        setDispatchCallState('incoming');
        setIncomingOffer(signal.offer);
        setCallRoomId(signal.roomId);
        setIncomingCallSocketId(senderSocketId);
        return;
      }

      if (signal.candidate) {
        if (pcRef.current) {
          try { 
            await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate)); 
            console.log('[WebRTC] Added ICE candidate');
          } catch(e){ console.error('[WebRTC] Failed to add candidate:', e); }
        } else {
          console.log('[WebRTC] Queued ICE candidate (PC not ready)');
          setIceCandidateQueue(prev => [...prev, signal.candidate]);
        }
      } else if (signal.type === 'answer' || signal.sdp) {
        if (pcRef.current) {
          try { 
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal.sdp || signal)); 
            console.log('[WebRTC] Remote description (answer) set successfully');
          } catch(e){ console.error('[WebRTC] Failed to set remote description:', e); }
        }
      }
    });

    return () => {};
  }, []);

  // Keep socket session registration in sync when user logs in/out
  useEffect(() => {
    if (socket && user) {
      console.log('[Socket] Emitting register-session for:', user.username, 'role:', user.role);
      socket.emit('register-session', { role: user.role, userId: user.username });
    }
  }, [socket, user]);

  // Initialize MQTT Client over Websockets
  useEffect(() => {
    if (isOffline) {
      if (mqttClientRef.current) {
        mqttClientRef.current.end(true);
        mqttClientRef.current = null;
        setMqttClient(null);
        setMqttConnected(false);
      }
      return;
    }

    if (mqttClientRef.current) return;

    const client = mqtt.connect(MQTT_WS_URL, {
      clientId: 'frontend-dashboard-' + Math.random().toString(16).substr(2, 8),
      reconnectPeriod: 2000,
      connectTimeout: 10000,
      keepalive: 30
    });
    mqttClientRef.current = client;
    setMqttClient(client);

    client.on('connect', () => {
      setMqttConnected(true);
      client.subscribe('incidents/new/+');
      client.subscribe('incidents/update/+');
      client.subscribe('responders/+/location');
      client.subscribe('responders/+/assignment');
      client.subscribe('resources/+/capacity');
    });

    client.on('message', (topic, message) => {
      let payload;
      try { payload = JSON.parse(message.toString()); } catch { return; }

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
        if (payload.responderId === currentResponderIdRef.current) {
          setAssignedIncident(payload.incident);
          setResponderStatus('Dispatched');
        }
      }
    });

    client.on('close', () => setMqttConnected(false));
    client.on('error', (err) => console.error('[MQTT] Error:', err.message));

    return () => {};
  }, [isOffline]);

  // Handle Dispatch Selection lookup for Nearest Resources
  useEffect(() => {
    if (!selectedIncidentId) return;
    const selected = incidents.find(i => i.id === selectedIncidentId);
    if (!selected) return;

    const resourceTypeMap = { medical: 'ambulance', fire: 'fire', police: 'police' };
    const resourceType = resourceTypeMap[selected.type] || selected.type;

    fetch(`${RESOURCE_URL}/resources/nearest?type=${resourceType}&lat=${selected.location.lat}&lng=${selected.location.lng}`)
      .then(r => r.json())
      .then(data => setNearestResources(data))
      .catch(e => console.error('Error loading nearest resources', e));
  }, [selectedIncidentId, incidents]);

  // WebRTC Initiate Video Call (Citizen -> Dispatcher) using Real getUserMedia
  const startCall = async () => {
    setCitizenCallState('calling');
    const roomId = `call-${Date.now()}`;
    setCallRoomId(roomId);
    
    socket.emit('join-call-room', { roomId });

    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
    } catch (e) {
      console.error('Failed to get user media. Falling back to mock stream.', e);
      addToast('Real camera access failed or blocked', 'error');
      
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'black';
      ctx.fillRect(0,0,640,480);
      const stream = canvas.captureStream(30);
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-signal', { roomId, signal: { candidate: event.candidate } });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    setCitizenCallState('connected');
    
    // Broadcast incoming-offer directly to the 'dispatch' room so operators see it and get the offer at the same time
    socket.emit('webrtc-signal', { roomId: 'dispatch', signal: { type: 'incoming-offer', offer: offer, roomId } });
  };

  const endCall = () => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    setCitizenCallState('idle');
    setDispatchCallState('idle');
    setCallRoomId(null);
    setIncomingOffer(null);
  };

  // Dispatcher: Accept Incoming Call
  const acceptCall = async () => {
    console.log('[AcceptCall] Starting accept call flow. incomingOffer:', incomingOffer, 'callRoomId:', callRoomId);
    if (!incomingOffer || !callRoomId) {
      console.warn('[AcceptCall] Aborting call acceptance. Missing offer or roomId.');
      return;
    }

    console.log('[AcceptCall] Emitting join-call-room for:', callRoomId);
    socket.emit('join-call-room', { roomId: callRoomId });

    console.log('[AcceptCall] Initializing new RTCPeerConnection');
    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    pc.ontrack = (event) => {
      console.log('[WebRTC] Received remote stream track!', event.streams);
      if (dispatcherRemoteVideoRef.current) {
        dispatcherRemoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[WebRTC] Dispatcher ICE candidate generated, emitting signal');
        socket.emit('webrtc-signal', { roomId: callRoomId, signal: { candidate: event.candidate } });
      }
    };

    try {
      console.log('[AcceptCall] Setting remote description...');
      await pc.setRemoteDescription(new RTCSessionDescription(incomingOffer));
      console.log('[AcceptCall] Remote description set successfully.');
      
      console.log('[AcceptCall] Processing queued ICE candidates:', iceCandidateQueue.length);
      iceCandidateQueue.forEach(async (candidate) => {
        try { 
          await pc.addIceCandidate(new RTCIceCandidate(candidate)); 
          console.log('[AcceptCall] Applied queued ICE candidate');
        } catch(e) { console.error('[AcceptCall] Failed to apply queued ICE candidate:', e); }
      });
      setIceCandidateQueue([]);

      console.log('[AcceptCall] Creating WebRTC answer...');
      const answer = await pc.createAnswer();
      console.log('[AcceptCall] Setting local description...');
      await pc.setLocalDescription(answer);
      console.log('[AcceptCall] Emitting answer WebRTC signal');
      socket.emit('webrtc-signal', { roomId: callRoomId, signal: answer });
      setDispatchCallState('connected');
      setIncomingOffer(null);
    } catch (err) {
      console.error('[AcceptCall] Failed to accept call:', err);
    }
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

      refreshData();
      addToast(`Incident reported! ID: ${res.id}`);
    } catch (err) {
      console.error('Failed to post incident via REST:', err);
      addToast('Error connecting to incident-service', 'error');
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
        addToast('Resource successfully assigned!');
        refreshData();
      } else {
        addToast(`Failed to assign: ${data.error}`, 'error');
      }
    } catch (err) {
      console.error('Dispatch assignment failed:', err);
      addToast('Network error connecting to dispatch-service', 'error');
    }
  };

  // Clear Board Handler
  const clearIncidents = async () => {
    try {
      await fetch(`${INCIDENT_URL}/incidents/clear`, { method: 'DELETE' });
      addToast('All incidents cleared!');
      refreshData();
      setSelectedIncidentId(null);
    } catch (e) {
      addToast('Failed to clear incidents', 'error');
    }
  };

  // Responder Simulation
  const simulateMovement = () => {
    let targetLat = 12.9716;
    let targetLng = 77.5946;

    if (assignedIncident) {
      targetLat = assignedIncident.location.lat;
      targetLng = assignedIncident.location.lng;
    }

    const deltaLat = targetLat - responderLat;
    const deltaLng = targetLng - responderLng;
    const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng);

    // If responder is very far away (e.g. Pune vs Bangalore), take bigger steps so they move quickly
    const step = distance > 1 ? distance * 0.15 : 0.005;

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
      setOfflineQueue(prev => [...prev, { ...updateEvent, type: 'location-update' }]);
    } else {
      if (mqttClient && mqttClient.connected) {
        mqttClient.publish(`responders/${currentResponderId}/location`, JSON.stringify(updateEvent));
      }
      fetch(`${REGISTRY_URL}/responders/${currentResponderId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: { lat: newLat, lng: newLng } })
      });
    }
  };

  const updateResponderStatus = (newStatus) => {
    setResponderStatus(newStatus);
    const updateEvent = {
      id: currentResponderId,
      status: newStatus,
      timestamp: new Date().toISOString()
    };

    if (isOffline) {
      setOfflineQueue(prev => [...prev, { ...updateEvent, type: 'status-update' }]);
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

  const toggleOffline = () => {
    if (isOffline) {
      setIsOffline(false);
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
      addToast('System reconnected. Flushed offline changes.');
    } else {
      setIsOffline(true);
      addToast('Offline simulation enabled.');
    }
  };

  const triggerP2PRelay = () => {
    if (offlineQueue.length === 0) {
      addToast('Write-ahead queue is empty.');
      return;
    }
    if (!peerRelayTarget) {
      addToast('Please select a target peer.');
      return;
    }

    addToast(`Relaying ${offlineQueue.length} items via peer ${peerRelayTarget}...`);
    offlineQueue.forEach((evt) => {
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
    addToast('P2P Queue Relay complete!');
  };

  const adjustCapacity = async (stationId, val) => {
    const targetUrl = val > 0 ? '/resources/release' : '/resources/claim';
    try {
      await fetch(`${RESOURCE_URL}${targetUrl}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: stationId })
      });
      refreshData();
    } catch (e) {
      addToast('Error updating capacity', 'error');
    }
  };

  const getResourceLabels = (type) => {
    switch (type) {
      case 'ambulance':
        return { unit: 'Ambulance', claimLabel: 'Deploy Unit', releaseLabel: 'Return Unit', capacityLabel: 'Available Units', icon: '🚑', color: '#8b5cf6' };
      case 'fire':
        return { unit: 'Fire Engine', claimLabel: 'Deploy Engine', releaseLabel: 'Return Engine', capacityLabel: 'Available Engines', icon: '🚒', color: '#ef4444' };
      case 'police':
        return { unit: 'Patrol Car', claimLabel: 'Deploy Patrol', releaseLabel: 'Return Patrol', capacityLabel: 'Available Patrols', icon: '🚓', color: '#3b82f6' };
      default:
        return { unit: 'Unit', claimLabel: 'Deploy', releaseLabel: 'Return', capacityLabel: 'Available', icon: '📦', color: '#10b981' };
    }
  };

  // Auth Functions
  const handleLogin = async (username, password) => {
    setLoginError('');
    try {
      const res = await fetch(`${AUTH_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        setToken(data.token);
        setUser(data.user);
        
        addToast(`Logged in successfully as ${data.user.name}`);
        if (data.user.role === 'citizen') navigate('/citizen');
        else if (data.user.role === 'dispatch') navigate('/dispatch');
        else if (data.user.role === 'responder') navigate('/responder');
        else navigate('/dispatch');
      } else {
        setLoginError(data.error || 'Authentication failed');
      }
    } catch (err) {
      setLoginError('Authentication service unreachable');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken('');
    setUser(null);
    navigate('/login');
    addToast('Logged out');
  };

  // Route protectors
  const RequireAuth = ({ children, allowedRoles }) => {
    if (!token || !user) {
      return <Navigate to="/login" replace state={{ from: location }} />;
    }
    if (allowedRoles && !allowedRoles.includes(user.role) && user.role !== 'admin') {
      return <Navigate to="/" replace />;
    }
    return children;
  };

  // Determine dispatcher map center dynamically based on selected incident
  const selectedIncident = incidents.find(i => i.id === selectedIncidentId);
  const dispatchMapCenter = selectedIncident?.location 
    ? [selectedIncident.location.lat, selectedIncident.location.lng] 
    : [18.5204, 73.8567];

  return (
    <div className="app-container">
      {/* Header */}
      {user && (
        <header className="header">
          <div className="header-top">
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
            <div className="status-indicators">
              <div className="status-chip">
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginRight: '8px' }}>
                  User: <strong>{user.name}</strong> ({user.role})
                </span>
              </div>
              <div className="status-chip">
                <div className={`status-dot ${socketConnected ? 'online' : 'offline'}`} />
                <span>Signaling</span>
              </div>
              <div className="status-chip">
                <div className={`status-dot ${mqttConnected ? 'online' : 'offline'}`} />
                <span>MQTT</span>
              </div>
              <button className="refresh-btn" onClick={refreshData} title="Refresh data">
                <RefreshCw size={14} />
              </button>
              <button className="btn btn-secondary" style={{ width: 'auto', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={handleLogout}>
                <LogOut size={14} /> Logout
              </button>
            </div>
          </div>

          {/* Actor Navigation Tabs (Enforce authorization view) */}
          <nav className="navigation-tabs">
            {(user.role === 'citizen' || user.role === 'admin') && (
              <Link to="/citizen" className={`tab-btn ${location.pathname === '/citizen' ? 'active' : ''}`}>
                <Users size={16} /> Citizen
              </Link>
            )}
            {(user.role === 'dispatch' || user.role === 'admin') && (
              <>
                <Link to="/dispatch" className={`tab-btn ${location.pathname === '/dispatch' ? 'active' : ''}`}>
                  <ShieldAlert size={16} /> Dispatch Center
                </Link>
                <Link to="/stations" className={`tab-btn ${location.pathname === '/stations' ? 'active' : ''}`}>
                  <Database size={16} /> Resource Stations
                </Link>
              </>
            )}
            {(user.role === 'responder' || user.role === 'admin') && (
              <Link to="/responder" className={`tab-btn ${location.pathname === '/responder' ? 'active' : ''}`}>
                <Truck size={16} /> Field Responder
              </Link>
            )}
          </nav>
        </header>
      )}

      {/* Main Grid View depending on route */}
      <main className="main-content">
        <Routes>
          <Route path="/login" element={<LoginPage handleLogin={handleLogin} error={loginError} />} />
          
          <Route path="/citizen" element={
            <RequireAuth allowedRoles={['citizen']}>
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
                        <input type="number" step="0.0001" className="form-control" value={citizenLat} onChange={e => setCitizenLat(parseFloat(e.target.value))} />
                      </div>
                      <div>
                        <label>Longitude</label>
                        <input type="number" step="0.0001" className="form-control" value={citizenLng} onChange={e => setCitizenLng(parseFloat(e.target.value))} />
                      </div>
                    </div>
                    <button type="submit" className="btn" style={{ marginBottom: '12px' }}>
                      <Send size={16} /> Report Emergency
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
                  <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                    Click anywhere on the map to set your location coordinates automatically.
                  </p>
                  <div className="map-canvas-container" style={{ minHeight: '400px' }}>
                    <MapContainer center={[citizenLat, citizenLng]} zoom={13} style={{ height: '400px', width: '100%', borderRadius: '8px', zIndex: 1 }}>
                      <ChangeView center={[citizenLat, citizenLng]} />
                      <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                      />
                      <Marker position={[citizenLat, citizenLng]} icon={incidentIcon}>
                        <Popup>Emergency Report Marker</Popup>
                      </Marker>
                      <MapClickHandler setLat={setCitizenLat} setLng={setCitizenLng} />
                    </MapContainer>
                  </div>
                </div>
              </div>
            </RequireAuth>
          } />

          <Route path="/dispatch" element={
            <RequireAuth allowedRoles={['dispatch']}>
              <div className="view-grid-dispatch">
                {/* Left: Incidents Board */}
                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h2>Incidents Board</h2>
                    <button className="btn btn-secondary" style={{ width: 'auto', padding: '6px 12px', fontSize: '11px', borderColor: 'var(--color-danger)', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={clearIncidents}>
                      <Trash2 size={13} /> Clear Board
                    </button>
                  </div>
                  <div className="scrollable" style={{ flex: 1, paddingRight: '4px' }}>
                    {incidents.length === 0 ? (
                      <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No active incidents reported.</p>
                    ) : (
                      incidents.slice().reverse().map(inc => (
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
                          <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Location: {inc.location?.lat?.toFixed(4) ?? 'N/A'}, {inc.location?.lng?.toFixed(4) ?? 'N/A'}</p>
                          <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Reporter: {inc.reportedBy}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Center: Live Map */}
                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
                  <h2>Regional Incident Tracking Map</h2>
                  <div className="map-canvas-container" style={{ flex: 1, minHeight: '400px' }}>
                    <MapContainer center={dispatchMapCenter} zoom={13} style={{ height: '100%', minHeight: '400px', width: '100%', borderRadius: '8px', zIndex: 1 }}>
                      <ChangeView center={dispatchMapCenter} />
                      <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                      />
                      
                      {/* Resource stations */}
                      {resources.map(res => (
                        <Marker key={res.id} position={[res.location.lat, res.location.lng]} icon={stationIcon}>
                          <Popup>
                            <strong>{res.name}</strong><br/>
                            Capacity: {res.availableCount} / {res.capacity}
                          </Popup>
                        </Marker>
                      ))}

                      {/* Active incidents */}
                      {incidents.filter(inc => inc.status !== 'Resolved').map(inc => {
                        if (!inc.location) return null;
                        return (
                          <Marker key={inc.id} position={[inc.location.lat, inc.location.lng]} icon={incidentIcon}>
                            <Popup>
                              <strong>Emergency: {inc.id}</strong><br/>
                              Type: {inc.type}<br/>
                              Status: {inc.status}
                            </Popup>
                          </Marker>
                        );
                      })}

                      {/* Responders */}
                      {responders.map(resp => {
                        if (!resp.location) return null;
                        return (
                          <Marker key={resp.id} position={[resp.location.lat, resp.location.lng]} icon={responderIcon}>
                            <Popup>
                              <strong>Responder: {resp.id}</strong><br/>
                              Status: {resp.status}
                            </Popup>
                          </Marker>
                        );
                      })}
                    </MapContainer>
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
                            Showing nearest available stations sorted by distance. Click Dispatch to assign.
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
                  {dispatchCallState === 'incoming' ? (
                    <div style={{ padding: '16px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', borderRadius: '8px' }}>
                      <p style={{ color: '#ef4444', fontWeight: 'bold', marginBottom: '8px' }}>Incoming Emergency Video Call!</p>
                      <button className="btn btn-danger" onClick={acceptCall}>
                        <Video size={16} /> Accept Call
                      </button>
                    </div>
                  ) : dispatchCallState === 'connected' ? (
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
            </RequireAuth>
          } />

          <Route path="/responder" element={
            <RequireAuth allowedRoles={['responder']}>
              <div className="view-grid-responder">
                <div className="glass-panel">
                  <h2>Responder Terminal</h2>
                  
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
                        Writes are queued locally. Unsent queue count: <span className="queue-badge">{offlineQueue.length}</span>
                      </p>
                    )}
                  </div>

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

                  <div style={{ marginBottom: '20px' }}>
                    <h3>Simulated Location Stream</h3>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>GPS: {responderLat.toFixed(4)}, {responderLng.toFixed(4)}</p>
                    <button className="btn btn-secondary" style={{ marginTop: '8px' }} onClick={simulateMovement}>
                      Move closer to Target Incident (+GPS step)
                    </button>
                  </div>

                  {isOffline && (
                    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed var(--border-color)', padding: '12px', borderRadius: '8px', marginTop: '16px' }}>
                      <h3 style={{ color: 'var(--color-warning)' }}>Simulate P2P Peer Relay</h3>
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
                        addToast('Incident resolved!');
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
            </RequireAuth>
          } />

          <Route path="/stations" element={
            <RequireAuth allowedRoles={['dispatch']}>
              <div className="view-grid-station" style={{ padding: '24px' }}>
                <div className="glass-panel">
                  <h2>Resource Stations — Live Capacity Monitor</h2>
                  <div className="resource-grid">
                    {resources.map(res => {
                      const percent = (res.availableCount / res.capacity) * 100;
                      const status = percent > 50 ? 'success' : percent > 20 ? 'warning' : 'danger';
                      const labels = getResourceLabels(res.type);
                      
                      return (
                        <div key={res.id} className="resource-card" style={{ borderLeft: `3px solid ${labels.color}` }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontSize: '18px' }}>{labels.icon}</span>
                              <span style={{ fontWeight: '700', fontSize: '14px' }}>{res.name}</span>
                            </div>
                            <span className={`badge badge-type-${res.type}`}>{res.type}</span>
                          </div>
                          <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>📍 {res.location.lat.toFixed(4)}, {res.location.lng.toFixed(4)}</p>
                          
                          <div style={{ marginTop: '8px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                              <span style={{ color: 'var(--text-secondary)' }}>{labels.capacityLabel}</span>
                              <span style={{ fontWeight: 'bold' }}>{res.availableCount} / {res.capacity}</span>
                            </div>
                            <div className="capacity-bar-container">
                              <div className={`capacity-bar-fill ${status}`} style={{ width: `${percent}%` }} />
                            </div>
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '12px' }}>
                            <button className="btn btn-secondary" style={{ padding: '6px 8px', fontSize: '11px' }} onClick={() => adjustCapacity(res.id, -1)} disabled={res.availableCount <= 0}>
                              {labels.claimLabel}
                            </button>
                            <button className="btn btn-secondary" style={{ padding: '6px 8px', fontSize: '11px' }} onClick={() => adjustCapacity(res.id, 1)} disabled={res.availableCount >= res.capacity}>
                              {labels.releaseLabel}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </RequireAuth>
          } />

          {/* Root redirect page depending on role */}
          <Route path="/" element={
            token ? (
              user?.role === 'citizen' ? <Navigate to="/citizen" replace /> :
              user?.role === 'dispatch' ? <Navigate to="/dispatch" replace /> :
              user?.role === 'responder' ? <Navigate to="/responder" replace /> :
              <Navigate to="/login" replace />
            ) : (
              <Navigate to="/login" replace />
            )
          } />
        </Routes>
      </main>

      {/* Toast Notification Container */}
      <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '12px', pointerEvents: 'none' }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            background: t.type === 'error' ? 'var(--color-danger)' : 'var(--color-success)',
            color: '#fff',
            padding: '14px 20px',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            fontSize: '14px',
            fontWeight: '600',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            pointerEvents: 'auto'
          }}>
            <ShieldAlert size={18} />
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

// Inner LoginPage Component for neatness
function LoginPage({ handleLogin, error }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const submit = (e) => {
    e.preventDefault();
    handleLogin(username, password);
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '70vh' }}>
      <div className="glass-panel" style={{ width: '100%', maxWidth: '400px', padding: '32px' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'inline-flex', padding: '12px', borderRadius: '50%', background: 'rgba(239, 68, 68, 0.1)', marginBottom: '16px' }}>
            <Lock size={32} color="#ef4444" />
          </div>
          <h2>System Portal Login</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Access DERRCS emergency response platform
          </p>
        </div>

        {error && (
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '6px', padding: '10px', fontSize: '13px', marginBottom: '16px', textAlign: 'center' }}>
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="form-group">
            <label>Username</label>
            <input type="text" className="form-control" placeholder="e.g. citizen1, dispatcher1" value={username} onChange={e => setUsername(e.target.value)} required />
          </div>
          <div className="form-group" style={{ marginBottom: '24px' }}>
            <label>Password</label>
            <input type="password" className="form-control" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required />
          </div>
          <button type="submit" className="btn">
            Login
          </button>
        </form>

        <div style={{ marginTop: '24px', borderTop: '1px solid var(--border-color)', paddingTop: '16px', fontSize: '11px', color: 'var(--text-muted)' }}>
          <p style={{ fontWeight: 'bold', marginBottom: '4px' }}>Default Accounts:</p>
          <ul style={{ paddingLeft: '16px' }}>
            <li>Citizen: <code>citizen1</code> / <code>password</code></li>
            <li>Dispatcher: <code>dispatcher1</code> / <code>password</code></li>
            <li>Responder: <code>responder1</code> / <code>password</code></li>
          </ul>
        </div>
      </div>
    </div>
  );
}
