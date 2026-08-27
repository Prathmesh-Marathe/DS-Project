# DERRCS Design Issues Documentation

This document describes how key distributed system design issues (from Unit 1) are addressed in the DERRCS implementation.

---

## 1. Transparency

The system aims to hide the distribution of services and resources from the end-users and other services:

| Transparency Type | How DERRCS Achieves It |
|---|---|
| **Access Transparency** | Clients (React web app, IoT location trackers, mobile simulators) access resource and incident data using standard REST and MQTT interfaces, regardless of how they are represented internally in Node.js or stored in MongoDB. |
| **Location Transparency** | The **Registry Service** dynamic naming table allows services and clients to query `id -> address` mapping. No service endpoint has a hardcoded hostname or IP address. |
| **Migration Transparency** | Resources (e.g., active responders/ambulances) move physically in the real world (changing coordinates) and dynamically update their endpoints, but their identifier (UUID) remains constant. |
| **Relocation Transparency** | If a service instance is moved to another port or server, it re-registers itself with the Registry Service. Other components look up the service name (`incident-service`, `resource-service`) dynamically. |
| **Replication Transparency** | Although a single database is simulated locally, the stateless design of the services means multiple instances can be run, with the load balancer (API Gateway) distributing requests invisibly. |
| **Failure Transparency** | When a responder goes offline, network timeout errors are caught by the client app. Instead of crashing, the app queues actions locally and silently retries in the background. |

---

## 2. Scalability

DERRCS addresses scalability across three dimensions:
1. **Size Scalability**:
   - The core microservices (Incident, Dispatch, Resource) are **completely stateless**. They store all persistent states in MongoDB. This allows scaling service containers horizontally.
   - MQTT brokers are lightweight and can process thousands of high-frequency location messages per second, offloading this traffic from HTTP REST services.
2. **Geographical Scalability**:
   - MQTT topics are structured hierarchically by region (e.g., `incidents/new/region-north`). Resource stations subscribe only to topics relevant to their local dispatch region, saving bandwidth.
3. **Administrative Scalability**:
   - By using open standards (MQTT, WebRTC, HTTP/REST), different agency networks (private ambulance companies, local police, state fire departments) can hook into the naming registry and exchange messages without administrative re-engineering.

---

## 3. Heterogeneity

The system operates across diverse platforms, programming languages, and networks:
- **Data Formats**: Standard JSON is used for all REST requests/responses, WebRTC signaling messages, and MQTT payloads.
- **Protocols**: Only standard, platform-independent protocols are used: HTTP/1.1 (REST), MQTT (v3.1.1), WebSockets, and WebRTC.
- **Networks**: Responders can connect via high-speed cellular, satellite, or local ad-hoc Wi-Fi/mesh (simulated via WebRTC P2P data channels).

---

## 4. Fault Tolerance

Under emergency conditions, edge nodes (responders) frequently lose connection.
- **Local Write-Ahead Queue**: Unsent messages are stored locally in the responder's storage. When a connection is restored, messages are flushed in chronological order.
- **Idempotency**: All status updates contain an event timestamp. The backend services process these updates using idempotent DB operations (`$set` values only if the update timestamp is newer than the stored record), preventing stale out-of-order updates from corrupting the state.

---

## 5. Concurrency

If two dispatchers assign the same resource (e.g., Ambulance A) to different incidents at the same time:
- **Atomic Allocation**: The Resource Service implements atomic "claim" operations. Using MongoDB's update query, it decrements the available count only if it is greater than zero:
  ```javascript
  db.resources.updateOne(
    { _id: resourceId, availableCount: { $gt: 0 } },
    { $inc: { availableCount: -1 } }
  )
  ```
- If the count is 0, the operation fails, and the Dispatch Service receives a conflict response, prompting the dispatcher to select another resource. This prevents double-dispatch race conditions.

---

## 6. Openness

- The registry uses well-defined interfaces.
- MQTT broker can accept any compliant MQTT client (from physical IoT hardware to web simulations).
- Video calls rely on standard WebRTC, meaning any modern web browser or mobile client can establish a direct media peer connection without special plugins.
