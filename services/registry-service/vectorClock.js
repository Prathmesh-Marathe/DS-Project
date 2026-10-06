/**
 * Vector Clock
 * ============
 * Chapter 3 - Vector Clock Algorithm (Fidge/Mattern, 1988)
 *
 * Extends Lamport clocks to track CAUSALITY between events across nodes.
 * A vector clock is a dictionary { nodeId -> counter } for N nodes.
 *
 * Rules:
 *   1. Internal event:    increment own counter only
 *   2. Send event:        increment own counter, attach full vector
 *   3. Receive event:     for each entry: take max(local[k], received[k]), then increment own
 *
 * Comparison:
 *   VC_a < VC_b  (a happened-before b) if:
 *     ALL entries in a <= corresponding entries in b  AND  at least one is strictly less
 *   VC_a || VC_b (concurrent) if neither a <= b nor b <= a
 */

class VectorClock {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this.vector = {};        // { nodeId: integer }
    this.vector[nodeId] = 0; // Initialize own counter
  }

  /**
   * Tick for an internal event — only own counter increments.
   */
  tick() {
    this.vector[this.nodeId] = (this.vector[this.nodeId] || 0) + 1;
    return this.snapshot();
  }

  /**
   * Prepare a send event — increment own counter, return a copy to attach.
   */
  send() {
    this.vector[this.nodeId] = (this.vector[this.nodeId] || 0) + 1;
    return { vector: this.snapshot(), nodeId: this.nodeId };
  }

  /**
   * Process a received vector — merge (take max per component) then tick own.
   * @param {Object} receivedVector - The vector clock from the message
   */
  receive(receivedVector) {
    // Merge: take max of each component
    for (const [nodeId, ts] of Object.entries(receivedVector)) {
      this.vector[nodeId] = Math.max(this.vector[nodeId] || 0, ts);
    }
    // Increment own counter
    this.vector[this.nodeId] = (this.vector[this.nodeId] || 0) + 1;
    return this.snapshot();
  }

  /**
   * Returns a deep copy of the current vector.
   */
  snapshot() {
    return { ...this.vector };
  }

  /**
   * Compare two vector clocks.
   * Returns:
   *   'before'     if a < b  (a causally precedes b)
   *   'after'      if a > b  (a causally follows b)
   *   'concurrent' if neither dominates (happened concurrently)
   *   'equal'      if both are identical
   *
   * @param {Object} va - Vector clock snapshot A
   * @param {Object} vb - Vector clock snapshot B
   */
  static compare(va, vb) {
    const allKeys = new Set([...Object.keys(va), ...Object.keys(vb)]);
    let aLessOrEqual = true;
    let bLessOrEqual = true;

    for (const k of allKeys) {
      const a = va[k] || 0;
      const b = vb[k] || 0;
      if (a > b) bLessOrEqual = false;
      if (b > a) aLessOrEqual = false;
    }

    if (aLessOrEqual && bLessOrEqual) return 'equal';
    if (aLessOrEqual) return 'before';
    if (bLessOrEqual) return 'after';
    return 'concurrent';
  }
}

module.exports = VectorClock;
