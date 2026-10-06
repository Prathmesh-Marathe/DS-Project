/**
 * Bully Election Algorithm
 * ========================
 * Chapter 3 - Election Algorithms
 *
 * The Bully Algorithm (Garcia-Molina, 1982):
 *  - Each node has a unique priority (higher = "bullies" lower nodes)
 *  - When a node detects the coordinator is down (beacon timeout), it initiates an election
 *  - It sends ELECTION messages to all higher-priority nodes
 *  - If no higher-priority node responds: THIS node declares itself coordinator (VICTORY)
 *  - If a higher-priority node responds: that node takes over the election
 *
 * Use in DERRCS:
 *  - Services elect a "Coordinator" which is responsible for orchestrating global snapshots.
 *  - The coordinator is the service with the highest SERVICE_ID (numeric priority).
 *  - If the coordinator crashes and beacon times out, a new election is triggered.
 *
 * Implementation notes:
 *  - This module runs INSIDE the broker-signaling service (it's the dedicated
 *    coordination layer). It coordinates the election via Socket.IO events AND
 *    HTTP calls to the registry /beacon/alive endpoint.
 *  - Messages use Lamport timestamps for ordering.
 */

class BullyElection {
  constructor({ serviceId, priority, registryUrl, lamportClock, io }) {
    this.serviceId = serviceId;
    this.priority = priority;        // Numeric priority — higher wins
    this.registryUrl = registryUrl;
    this.lamportClock = lamportClock;
    this.io = io;                    // Socket.IO instance for real-time signaling

    this.coordinatorId = null;       // Current known coordinator
    this.electionInProgress = false;
    this.electionTimeout = null;
    this.coordinatorTimeout = null;

    this.log = [];
  }

  _log(event, data = {}) {
    const ts = this.lamportClock.tick();
    const entry = { event, lamportTs: ts, serviceId: this.serviceId, ...data, at: new Date().toISOString() };
    this.log.push(entry);
    console.log(`[Election | L:${ts}] [${this.serviceId}] ${event}`, data);
    return entry;
  }

  /**
   * Start an election — called when coordinator is suspected dead.
   * Step 1: Send ELECTION to all higher-priority alive nodes.
   */
  async startElection() {
    if (this.electionInProgress) {
      console.log(`[Election] Election already in progress on ${this.serviceId} — skipping duplicate`);
      return;
    }

    this.electionInProgress = true;
    this._log('ELECTION_STARTED', { reason: 'Coordinator suspected dead or no coordinator known' });

    // Broadcast ELECTION message via Socket.IO to all connected services
    const ts = this.lamportClock.send();
    this.io.emit('election-message', {
      type: 'ELECTION',
      from: this.serviceId,
      fromPriority: this.priority,
      lamportTs: ts.ts
    });

    // Wait for an OK from a higher-priority node (2 seconds timeout)
    this.electionTimeout = setTimeout(() => {
      if (this.electionInProgress) {
        // No higher node answered — declare ourselves coordinator
        this._declareVictory();
      }
    }, 2000);
  }

  /**
   * Receive an ELECTION message from a lower-priority node.
   * If we have higher priority: send OK back, and start our own election.
   */
  receiveElectionMessage({ from, fromPriority, lamportTs }) {
    this.lamportClock.receive(lamportTs);
    this._log('ELECTION_RECEIVED', { from, fromPriority });

    if (this.priority > fromPriority) {
      // We bully the sender — send OK
      const ts = this.lamportClock.send();
      this.io.emit('election-ok', {
        type: 'OK',
        to: from,
        from: this.serviceId,
        lamportTs: ts.ts
      });
      this._log('OK_SENT', { to: from });

      // Now start our own election (unless already in progress)
      if (!this.electionInProgress) {
        this.startElection();
      }
    }
  }

  /**
   * Receive an OK message — a higher-priority node is alive.
   * Cancel our election: they will win.
   */
  receiveOk({ from, lamportTs }) {
    this.lamportClock.receive(lamportTs);
    this._log('OK_RECEIVED', { from });
    this.electionInProgress = false;
    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
      this.electionTimeout = null;
    }
  }

  /**
   * Declare victory — become coordinator.
   * Send COORDINATOR (VICTORY) message to all nodes.
   */
  _declareVictory() {
    this.electionInProgress = false;
    this.coordinatorId = this.serviceId;
    const ts = this.lamportClock.send();
    this._log('VICTORY_DECLARED', { newCoordinator: this.serviceId });

    this.io.emit('election-coordinator', {
      type: 'COORDINATOR',
      coordinatorId: this.serviceId,
      coordinatorPriority: this.priority,
      lamportTs: ts.ts
    });

    console.log(`[Election] 👑 ${this.serviceId} is the new COORDINATOR`);
  }

  /**
   * Receive a COORDINATOR (VICTORY) message.
   * Accept the new coordinator.
   */
  receiveCoordinator({ coordinatorId, coordinatorPriority, lamportTs }) {
    this.lamportClock.receive(lamportTs);
    this.coordinatorId = coordinatorId;
    this.electionInProgress = false;
    if (this.electionTimeout) clearTimeout(this.electionTimeout);
    this._log('COORDINATOR_ACCEPTED', { coordinatorId, coordinatorPriority });
    console.log(`[Election] Accepted coordinator: ${coordinatorId} (priority: ${coordinatorPriority})`);
  }

  /**
   * Get election state for inspection.
   */
  getState() {
    return {
      serviceId: this.serviceId,
      priority: this.priority,
      coordinatorId: this.coordinatorId,
      isCoordinator: this.coordinatorId === this.serviceId,
      electionInProgress: this.electionInProgress,
      recentLog: this.log.slice(-15)
    };
  }
}

module.exports = BullyElection;
