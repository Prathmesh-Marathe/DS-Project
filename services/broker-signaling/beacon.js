/**
 * Beacon Protocol (Heartbeat)
 * ===========================
 * Chapter 3 - Beacon Protocol / Liveness Detection
 *
 * Purpose:
 *  - Each service periodically broadcasts a BEACON (heartbeat) to the registry.
 *  - The registry tracks the last-seen timestamp for each service.
 *  - If no beacon is received within the timeout window → service is declared DEAD.
 *  - Dead service detection triggers the Election Algorithm.
 *
 * This is the CLIENT side — used by each service to send beacons TO the registry.
 * The server side (beacon registry + /beacon/alive endpoint) lives in registry-service.
 *
 * Related to:
 *  - Cristian's Failure Detector (unreliable failure detection via timeout)
 *  - The beacon also piggybacks a clock-sync request (Cristian's Algorithm)
 */

const axios = require('axios');

class BeaconProtocol {
  constructor({ serviceId, registryUrl, priority, lamportClock, intervalMs = 5000, onCoordinatorDead }) {
    this.serviceId = serviceId;
    this.registryUrl = registryUrl;
    this.priority = priority;
    this.lamportClock = lamportClock;
    this.intervalMs = intervalMs;
    this.onCoordinatorDead = onCoordinatorDead; // Callback to trigger election

    this.intervalHandle = null;
    this.lastKnownCoordinator = null;
    this.log = [];

    // Clock synchronization state (Cristian's Algorithm)
    this.clockOffset = 0; // Estimated offset from server time in ms
  }

  /**
   * Start broadcasting beacons at the configured interval.
   */
  start() {
    console.log(`[Beacon | ${this.serviceId}] Starting beacon protocol (interval: ${this.intervalMs}ms)`);
    this._sendBeacon(); // Send immediately on start
    this.intervalHandle = setInterval(() => this._sendBeacon(), this.intervalMs);
  }

  /**
   * Stop sending beacons.
   */
  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log(`[Beacon | ${this.serviceId}] Beacon protocol stopped`);
    }
  }

  /**
   * Send a single beacon to the registry and perform clock sync.
   * This implements Cristian's Clock Synchronization:
   *   1. Record T1 (client send time)
   *   2. Send beacon to registry (which records T2 = server time)
   *   3. Record T3 (client receive time)
   *   4. RTT = T3 - T1
   *   5. Estimated offset = T2 - T1 - RTT/2
   */
  async _sendBeacon() {
    const T1 = Date.now();
    const lamportSnapshot = this.lamportClock.send();

    try {
      // POST beacon (also serves as clock-sync request)
      const beaconResp = await axios.post(`${this.registryUrl}/beacon`, {
        serviceId: this.serviceId,
        priority: this.priority,
        lamportTs: lamportSnapshot.ts,
        localClock: T1
      }, { timeout: 3000 });

      const T3 = Date.now();
      const T2 = beaconResp.data.serverTime;

      // Cristian's Algorithm: offset = T2 - T1 - RTT/2
      const RTT = T3 - T1;
      const offset = T2 - T1 - RTT / 2;
      this.clockOffset = offset;

      // Advance our Lamport clock on receive
      if (beaconResp.data.lamportTs !== undefined) {
        this.lamportClock.receive(beaconResp.data.lamportTs);
      }

      const logEntry = {
        event: 'BEACON_SENT',
        lamportTs: lamportSnapshot.ts,
        RTT_ms: RTT,
        clockOffset_ms: offset,
        at: new Date().toISOString()
      };
      this.log.push(logEntry);
      if (this.log.length > 50) this.log.shift(); // Keep last 50

      console.log(`[Beacon | ${this.serviceId}] ♥ Beacon ACK | RTT: ${RTT}ms | Clock offset: ${offset.toFixed(1)}ms`);

      // Also check alive nodes for election trigger
      await this._checkForDeadCoordinator();

    } catch (err) {
      console.warn(`[Beacon | ${this.serviceId}] Beacon FAILED: ${err.message} (registry may be down)`);
      this.log.push({ event: 'BEACON_FAILED', error: err.message, at: new Date().toISOString() });
    }
  }

  /**
   * Poll the registry for alive nodes and detect if the coordinator is dead.
   * If coordinator is missing from alive list → trigger election callback.
   */
  async _checkForDeadCoordinator() {
    try {
      const resp = await axios.get(`${this.registryUrl}/beacon/alive`, { timeout: 2000 });
      const aliveNodes = resp.data.alive || [];

      // Update known coordinator (the alive node with highest priority)
      const topNode = aliveNodes.reduce((best, node) => {
        return (!best || node.priority > best.priority) ? node : best;
      }, null);

      if (topNode) {
        if (this.lastKnownCoordinator && this.lastKnownCoordinator !== topNode.serviceId) {
          console.log(`[Beacon | ${this.serviceId}] Coordinator changed: ${this.lastKnownCoordinator} → ${topNode.serviceId}`);
        }
        this.lastKnownCoordinator = topNode.serviceId;
      } else if (this.lastKnownCoordinator) {
        // All nodes gone — trigger election
        console.log(`[Beacon | ${this.serviceId}] No alive nodes detected! Triggering election...`);
        if (this.onCoordinatorDead) this.onCoordinatorDead();
        this.lastKnownCoordinator = null;
      }
    } catch (err) {
      // Registry unreachable — also a sign to trigger election
      console.warn(`[Beacon | ${this.serviceId}] Cannot check alive nodes: ${err.message}`);
    }
  }

  /**
   * Get current corrected time (local time adjusted by estimated offset).
   * Cristian's Algorithm result.
   */
  getCorrectedTime() {
    return Date.now() + this.clockOffset;
  }

  /**
   * Get beacon state for inspection.
   */
  getState() {
    return {
      serviceId: this.serviceId,
      priority: this.priority,
      lastKnownCoordinator: this.lastKnownCoordinator,
      clockOffset_ms: this.clockOffset,
      correctedTime: new Date(this.getCorrectedTime()).toISOString(),
      recentLog: this.log.slice(-10)
    };
  }
}

module.exports = BeaconProtocol;
