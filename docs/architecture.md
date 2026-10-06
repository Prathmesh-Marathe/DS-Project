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

---

## 5. Chapter 3 — Synchronization

### 5.1 Clock Synchronization (Cristian's Algorithm)
- **Where**: All services (`incident-service`, `resource-service`, `dispatch-service`, `broker-signaling`) periodically call `POST /clock-sync` on the registry.
- **How**: Each service records `T1` (send time), receives `T2` (server time), records `T3` (receive time). Offset = `T2 - T1 - RTT/2`.
- **Effect**: All services converge toward the registry's wall-clock time, compensating for clock drift.

### 5.2 Lamport's Logical Clocks (Total Ordering)
- **Where**: Every service (`registry`, `incident`, `dispatch`, `resource`, `broker`) maintains a `LamportClock` instance (`lamport.js`).
- **Rules**:
  - **Internal event**: `clock += 1`
  - **Send**: `clock += 1`, attach `lamportTs` to the HTTP body / MQTT payload
  - **Receive**: `clock = max(local, received) + 1`
- **Effect**: All events (incident create, dispatch, resource claim, MQTT publish) carry a Lamport timestamp enabling total ordering of distributed events.

### 5.3 Vector Clocks (Causal Ordering)
- **Where**: Registry Service tracks **responder location updates** with vector clocks (`vectorClock.js`).
- **Rules**: Each update carries a `vectorTs` dictionary `{ nodeId: counter }`. On receive: `for each k: local[k] = max(local[k], received[k])`, then increment own.
- **Effect**: The registry detects **stale** (already-superseded) location updates and rejects them. **Concurrent** updates are resolved via last-writer-wins.
- **Comparison**: `VectorClock.compare(va, vb)` returns `'before' | 'after' | 'concurrent' | 'equal'`.

### 5.4 Global State Snapshot (Chandy-Lamport Algorithm)
- **Where**: Registry Service (`POST /snapshot`).
- **Algorithm**:
  1. Registry (initiator) records its own local state (services table, responders table, clocks).
  2. Registry sends `GET /snapshot-state` to all registered services (marker messages).
  3. Each service returns its current in-memory state.
  4. Registry assembles the **consistent global cut**.
- **Trigger**: Automatically triggered by the elected coordinator via broker-signaling.

### 5.5 Election Algorithm (Bully Algorithm)
- **Where**: Broker-Signaling Service (`election.js`).
- **Priority Order**: `registry-1(100) > broker-1(90) > dispatch-1(50) > incident-1(40) > resource-1(30) > auth-1(20)`.
- **Algorithm**:
  1. Node detects coordinator is dead (beacon timeout).
  2. Sends `ELECTION` message to all higher-priority nodes.
  3. If no response in 2s → declares itself coordinator (`VICTORY`).
  4. Higher-priority node responds with `OK` and starts its own election.
- **Messages**: Relayed via Socket.IO events (`election-message`, `election-ok`, `election-coordinator`).
- **REST**: `POST /election/start` to manually trigger, `GET /election/state` to inspect.

### 5.6 Mutual Exclusion — Token Ring Algorithm
- **Where**: Dispatch Service (`mutex.js`).
- **Problem solved**: Two simultaneous dispatch requests could double-claim the same resource.
- **Algorithm**: A single **token** circulates the logical ring. Only the token-holder can enter the critical section (resource claim + incident status update).
- **Fairness (Lodha-Kshemkalyani)**: Requests are queued in **Lamport timestamp order** (earliest logical timestamp gets served first), ensuring FIFO fairness even across concurrent arrivals.
- **Deadlock prevention**: Mutex is always released in `finally {}` even on errors.

### 5.7 Beacon Protocol (Heartbeat / Failure Detector)
- **Where**: `broker-signaling/beacon.js` (client) + `registry/index.js` `/beacon` and `/beacon/alive` endpoints (server).
- **Mechanism**: Each service sends a heartbeat `POST /beacon` every 5 seconds.
- **Failure detection**: If no beacon received within `15s` → service declared dead → election triggered.
- **Clock sync piggybacked**: Each beacon also performs Cristian's clock sync (measures RTT and computes offset).
