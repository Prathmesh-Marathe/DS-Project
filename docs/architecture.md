# DERRCS Architecture Documentation

This document describes the architectural design of the Distributed Emergency Response and Resource Coordination System (DERRCS).

## 1. System Classification

DERRCS is a **hybrid distributed system** combining characteristics of:
1. **Distributed Information Systems**: Services interact synchronously via REST RPCs to process incidents, register assets, and allocate resources, using a centralized persistent state store (MongoDB).
2. **Pervasive Distributed Systems**: Mobile or web responder clients operating in remote environments communicate asynchronously via MQTT. In degraded network scenarios, they switch to an ad-hoc peer-to-peer (P2P) mode using WebRTC data channels to relay data hop-by-hop.

---

## 2. Core Service Topology

The system is split into multiple independent service nodes, each running in its own container or process boundary to simulate physical distribution:

```
                                  +-------------------+
                                  |  Registry Service |
                                  |    (Port 5000)    |
                                  +---------+---------+
                                            ^
                                            | Service / Client Lookup
                                            v
+-------------------+             +---------+---------+             +-------------------+
|  Incident Service |<---REST---->|  Dispatch Service |<---REST---->|  Resource Service |
|    (Port 5001)    |             |    (Port 5002)    |             |    (Port 5003)    |
+---------+---------+             +---------+---------+             +---------+---------+
          |                                 |                                 |
          v                                 v                                 v
   +------+---------------------------------+---------------------------------+------+
   |                                 MIDDLEWARE LAYER                                 |
   |  - MQTT Broker (Aedes / TCP 1883 & WebSocket 9001): Pub-Sub messaging            |
   |  - Signaling Server (Socket.IO / Port 5004): WebRTC and Real-Time Push           |
   +----------------------------------------+-----------------------------------------+
                                            ^
                                            | WebSockets / MQTT / WebRTC
                                            v
                                  +---------+---------+
                                  |  React Frontend   |
                                  |    (Port 5173)    |
                                  +-------------------+
```

### Services Breakdown:
1. **Registry Service (Port 5000)**: Serves as a naming service (`id -> endpoint` and `service_name -> url`). Enables location transparency; services look up each other dynamically rather than hardcoding hosts.
2. **Incident Service (Port 5001)**: Manages incident lifecycle (Active, Dispatched, Resolved). When a citizen reports an incident, the service stores it and publishes a message to MQTT.
3. **Dispatch Service (Port 5002)**: The coordination brain. It listens for incidents, queries the resource service for matching resource capacities (nearest ambulance, fire trucks), and handles assignments.
4. **Resource Service (Port 5003)**: Manages capacity data for Resource Stations (hospitals, fire stations). Exposes endpoints to reserve capacity atomically.
5. **Broker-Signaling Service (Ports 1883, 9001, 5004)**: 
   - **MQTT (TCP 1883 / WS 9001)**: Handles asynchronous location streaming (`responders/{id}/location`) and capacity broadcasts (`resources/{stationId}/capacity`).
   - **Signaling (WS 5004)**: Coordinates WebRTC negotiations between Citizens and Dispatchers for live video calls and sets up peer-to-peer connections between Responders.

---

## 3. Communication Protocols

The system uses three communication types defined in Unit 2:

1. **RPC (Request-Response)**:
   - Synchronous, blocking calls using HTTP/REST APIs.
   - Used for transactions requiring immediate consistency (e.g., reserving a bed in a hospital before dispatching an ambulance).
2. **Message-Oriented (Pub-Sub)**:
   - Asynchronous, non-blocking calls using MQTT.
   - Ideal for low-bandwidth, unreliable connections typical of field responders.
3. **Stream-Oriented**:
   - WebRTC for live audio/video streaming from Citizen to Dispatcher (highly sensitive to jitter, low latency requirement).
   - Continuous GPS streams (MQTT over WebSocket) from Responder to Dispatcher Map (reconciled using timestamps).

---

## 4. Edge Layer P2P Mode

When a responder's connectivity is lost:
1. Messages (location updates, status changes) are written to a local **Write-Ahead Queue** in the client (LocalStorage/IndexedDB).
2. The responder client scans for neighboring responders over WebRTC data channels (established when both were online, or simulated locally).
3. If a neighbor has an active connection, the offline responder relays its queued updates to the neighbor, who forwards them to the broker.
4. Upon reconnection, the responder flushes any remaining items in its queue to the broker. Idempotency keys prevent duplicate processing.
