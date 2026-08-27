# DERRCS Incident Lifecycle Sequence Diagram

This document models the asynchronous message-passing flow of an incident lifecycle from citizen report to dispatch and resolution.

## Mermaid Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Citizen
    participant Gateway as API Gateway (Proxy)
    participant Registry as Registry Service
    participant Incident as Incident Service
    participant Dispatch as Dispatch Service
    participant Resource as Resource Service
    participant Broker as MQTT Message Broker
    participant Responder as Responder Client

    %% Citizen reports incident
    Citizen->>Gateway: POST /incidents (report incident)
    Gateway->>Registry: Lookup endpoint for "incident-service"
    Registry-->>Gateway: Return http://incident-service:5001
    Gateway->>Incident: Forward POST /incidents
    Incident->>Broker: Publish topic: incidents/new/region-north (incident payload)
    Incident-->>Citizen: HTTP 201 Created (Incident ID: inc-101)

    %% Dispatcher receives notification and queries resources
    Note over Dispatch: Listening to incidents/new/+
    Broker->>Dispatch: Deliver new incident: inc-101
    Dispatch->>Gateway: GET /resources/nearest?type=ambulance (search)
    Gateway->>Registry: Lookup endpoint for "resource-service"
    Registry-->>Gateway: Return http://resource-service:5003
    Gateway->>Resource: Forward GET /resources/nearest
    Resource-->>Dispatch: List of nearest resources (Hospital-A, Amb-1)

    %% Dispatcher assigns resource (atomic claim)
    Dispatch->>Resource: POST /resources/claim (Amb-1)
    alt Resource is available
        Resource->>Resource: Atomic decrement availableCount
        Resource-->>Dispatch: HTTP 200 OK (Claim Success)
        Dispatch->>Gateway: PATCH /responders/Amb-1/status (status: "Dispatched", incidentId: inc-101)
        Gateway->>Registry: Lookup endpoint for "responder-Amb-1"
        Registry-->>Gateway: Return MQTT Client ID / Socket ID
        Gateway->>Broker: Publish topic: responders/Amb-1/assignment (incident details)
        Broker->>Responder: Deliver incident assignment
        Responder-->>Dispatch: Acknowledge assignment
    else Resource is already claimed (Race condition)
        Resource-->>Dispatch: HTTP 409 Conflict (Already Claimed)
        Note over Dispatch: Dispatcher selects next nearest resource
    end

    %% Responder updates progress
    loop Status & Location Updates
        Responder->>Broker: Publish topic: responders/Amb-1/location (GPS coordinates)
        Broker->>Dispatch: Live dashboard map updates
        Responder->>Broker: Publish topic: responders/Amb-1/status (status: "On Scene")
        Broker->>Dispatch: Update incident board
    end

    %% Citizen ↔ Dispatcher Video Call
    Citizen->>Broker: WebSocket: initiate-call (SDP Offer)
    Broker->>Dispatch: WebSocket: incoming-call (SDP Offer)
    Dispatch->>Broker: WebSocket: answer-call (SDP Answer)
    Broker->>Citizen: WebSocket: deliver SDP Answer
    Note over Citizen, Dispatch: WebRTC Media Channel established (Peer-to-Peer Video/Audio)
