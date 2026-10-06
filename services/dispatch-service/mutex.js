/**
 * Distributed Mutual Exclusion — Token Ring Algorithm
 * ====================================================
 * Chapter 3 - Mutual Exclusion
 *
 * Problem: When multiple dispatches happen simultaneously, two dispatchers
 * could claim the same resource (race condition). We solve this with a
 * logical token ring so only the token-holder can enter the critical section.
 *
 * Token Ring Overview:
 *  - Nodes are arranged in a logical ring ordered by SERVICE_ID.
 *  - A single TOKEN circulates the ring continuously.
 *  - A node that WANTS to enter the critical section waits until it holds the token.
 *  - After completing the CS, the node passes the token to the next node.
 *
 * In this in-process simulation:
 *  - Since dispatch-service is a single Node.js process (event loop is single-threaded),
 *    the true concurrency risk is from multiple concurrent async HTTP requests.
 *  - The token is a simple in-memory promise queue that serializes access.
 *  - In a multi-node scenario, the token would be passed via MQTT/HTTP between nodes.
 *
 * Lodha-Kshemkalyani Fair Mutual Exclusion:
 *  - Extension: we track request timestamps (Lamport) to ensure FIFO fairness.
 *  - Requests are queued in Lamport timestamp order — earliest request gets CS next.
 */

class TokenRingMutex {
  constructor(nodeId, lamportClock) {
    this.nodeId = nodeId;
    this.lamportClock = lamportClock;

    // Token state
    this.hasToken = false;         // Does THIS node currently hold the token?
    this.inCriticalSection = false; // Is THIS node currently executing the CS?

    // Request queue — entries: { requestId, lamportTs, resolve, reject }
    // Sorted by lamportTs for Lodha-Kshemkalyani fairness (FIFO by logical time)
    this.requestQueue = [];

    // Token log (for inspection/debugging)
    this.log = [];
  }

  /**
   * Grant the token to this node (called on startup for the "leader" node,
   * or when the token is received from the previous node in the ring).
   */
  receiveToken(fromNode) {
    this.hasToken = true;
    const ts = this.lamportClock.tick();
    const entry = { event: 'TOKEN_RECEIVED', from: fromNode || 'init', lamportTs: ts, at: new Date().toISOString() };
    this.log.push(entry);
    console.log(`[Mutex | L:${ts}] Token received from ${fromNode || 'init'}. Queue depth: ${this.requestQueue.length}`);
    this._tryProcessQueue();
  }

  /**
   * Request entry to the critical section.
   * Returns a Promise that resolves with a `release` function.
   * 
   * Fairness (Lodha-Kshemkalyani): Requests are served in Lamport timestamp order.
   * The node with the smallest (ts, nodeId) pair goes first.
   *
   * Usage:
   *   const release = await mutex.acquire();
   *   try { ... critical section ... } finally { release(); }
   */
  acquire() {
    const requestTs = this.lamportClock.tick();
    const requestId = `req-${this.nodeId}-${requestTs}`;

    console.log(`[Mutex | L:${requestTs}] Requesting CS entry (requestId: ${requestId})`);

    return new Promise((resolve, reject) => {
      const entry = {
        requestId,
        lamportTs: requestTs,
        nodeId: this.nodeId,
        resolve,
        reject,
        enqueuedAt: new Date().toISOString()
      };

      // Insert in Lamport-timestamp order (Lodha-Kshemkalyani fairness: FIFO by logical time)
      let insertIdx = this.requestQueue.findIndex(r => {
        if (r.lamportTs > entry.lamportTs) return true;
        if (r.lamportTs === entry.lamportTs && r.nodeId > entry.nodeId) return true;
        return false;
      });
      if (insertIdx === -1) insertIdx = this.requestQueue.length;
      this.requestQueue.splice(insertIdx, 0, entry);

      const logEntry = { event: 'CS_REQUESTED', requestId, lamportTs: requestTs, at: entry.enqueuedAt };
      this.log.push(logEntry);

      // If token is available now, try to process
      if (this.hasToken && !this.inCriticalSection) {
        this._tryProcessQueue();
      }
    });
  }

  /**
   * Internal: Process the next item in the queue if we have the token.
   */
  _tryProcessQueue() {
    if (!this.hasToken || this.inCriticalSection || this.requestQueue.length === 0) {
      return;
    }

    const next = this.requestQueue.shift();
    this.inCriticalSection = true;

    const enterTs = this.lamportClock.tick();
    console.log(`[Mutex | L:${enterTs}] ENTERING Critical Section (requestId: ${next.requestId}, lamportTs: ${next.lamportTs})`);
    this.log.push({ event: 'CS_ENTER', requestId: next.requestId, lamportTs: enterTs, at: new Date().toISOString() });

    // Provide a release function to the caller
    const release = () => {
      const exitTs = this.lamportClock.tick();
      this.inCriticalSection = false;
      console.log(`[Mutex | L:${exitTs}] EXITING Critical Section (requestId: ${next.requestId})`);
      this.log.push({ event: 'CS_EXIT', requestId: next.requestId, lamportTs: exitTs, at: new Date().toISOString() });

      // If more requests wait, serve them (token stays with us)
      if (this.requestQueue.length > 0) {
        this._tryProcessQueue();
      } else {
        // No more local requests — release token (pass to next in ring)
        // In a real multi-node ring: this.passToken(nextNodeUrl)
        // Here, we simply mark token as available for future local requests
        this.log.push({ event: 'TOKEN_IDLE', lamportTs: this.lamportClock.tick(), at: new Date().toISOString() });
        console.log(`[Mutex] Token idle — no pending requests. Token stays with ${this.nodeId}.`);
      }
    };

    next.resolve(release);
  }

  /**
   * Get the current state of the mutex (for inspection/snapshot).
   */
  getState() {
    return {
      nodeId: this.nodeId,
      hasToken: this.hasToken,
      inCriticalSection: this.inCriticalSection,
      queueDepth: this.requestQueue.length,
      queue: this.requestQueue.map(r => ({ requestId: r.requestId, lamportTs: r.lamportTs, nodeId: r.nodeId })),
      recentLog: this.log.slice(-10)
    };
  }
}

module.exports = TokenRingMutex;
