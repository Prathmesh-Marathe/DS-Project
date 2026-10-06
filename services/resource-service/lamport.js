/**
 * Lamport Logical Clock
 * =====================
 * Chapter 3 - Logical Clocks Implementation
 *
 * Rules:
 *   1. Internal event:  clock = clock + 1
 *   2. Send event:      clock = clock + 1, attach clock to message
 *   3. Receive event:   clock = max(local_clock, received_clock) + 1
 *
 * This implements the algorithm described by Leslie Lamport in
 * "Time, Clocks, and the Ordering of Events in a Distributed System" (1978).
 */

class LamportClock {
  constructor(nodeId) {
    this.nodeId = nodeId;   // Unique ID of this service node
    this.clock = 0;         // Logical time counter
  }

  /**
   * Advance the clock for an internal event (local computation).
   */
  tick() {
    this.clock += 1;
    return this.clock;
  }

  /**
   * Advance the clock for a SEND event.
   * Returns the timestamp to attach to the outgoing message.
   */
  send() {
    this.clock += 1;
    return { ts: this.clock, nodeId: this.nodeId };
  }

  /**
   * Advance the clock upon RECEIVING a message with a remote timestamp.
   * Lamport rule: clock = max(local, received) + 1
   * @param {number} receivedTs - The timestamp from the received message
   */
  receive(receivedTs) {
    this.clock = Math.max(this.clock, receivedTs) + 1;
    return this.clock;
  }

  /**
   * Get current clock state (for inspection/debugging).
   */
  getState() {
    return { nodeId: this.nodeId, clock: this.clock };
  }
}

module.exports = LamportClock;
