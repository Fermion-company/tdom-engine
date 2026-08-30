import { makeChunkMap } from './constructor-state.js';

export function resetOpenState(engine, text, file) {
  engine.shipDocumentEpoch = (engine.shipDocumentEpoch ?? 0) + 1;
  if (engine.shipRetry) {
    Object.assign(engine.shipRetry, {
      state: 'idle',
      activeAttemptId: null,
      activeChainId: null,
      consecutiveFailures: 0,
      lastOutcome: 'document-reset',
      lastFailureClass: null,
      lastFailureFingerprint: null,
      cooldownUntil: 0,
      lastCertifiedSnapshot: null,
      desiredSnapshot: null,
      recoveryReason: 'document-reset',
    });
  }
  engine.shipBootTries = 0;
  engine.shipBootedFor = null;
  engine.shipDesiredCanonicalId = null;
  engine.shipDesiredCanonicalHash = null;
  engine.shipStale = false;
  engine.shipDisabledFor = null;
  engine.file = file;
  engine.store.open(file, text);
  engine.blocks = [];
  engine.checkpointKeepCache = null;
  engine.checkpointHotFloorMs = 1;
  engine.labelTable = new Map();
  engine.hrefTable = new Map();
  engine.blockLabelIdx = new Map();
  engine.blockRefIdx = new Map();
  engine.labelCount = new Map();
  engine.refIndex = new Map();
  engine.vanishedLabels = new Set();
  engine._pageRun = null;
  engine.pages = [];
  // a fresh document gets a fresh chance at the structured layer
  engine.mode = 'structured';
  engine.modeReasons = [];
  engine.previewPolicy = 'structured';
  engine.previewReasons = [];
  engine.opaqueStickyPre = null;
  engine.verifyState = null;
  engine.pendingChain = null;
  engine.editHold = [];
  // per-document caches and verdicts: the old reset kept all of these, so
  // every /open stacked the previous document's SVG chunks, poison marks
  // and file watchers into the process for its whole lifetime
  engine.chunks = makeChunkMap();
  engine.unsafeBodyBlocks = new Map();
  engine.preGate = null;
  engine.poisoned = new Map();
  engine.fidelityDemoted = new Map();
  engine.isoCache = new Map();
  engine.isoFailCache = new Map();
  engine.isoForkBroken = new Set();
  engine.renderWant = new Map();
  engine.renderStats = { captureHits: 0, captureMisses: 0, retypesets: 0 };
  engine.renderHold = new Map();
  engine.rescueQueue = new Map();
  engine.tocHash = null;
  engine.hf = new Map();
  engine.hfSig = null;
  engine.hfPending = null;
  engine.hfQueued = null;
  engine.hfQueuedSig = null;
  engine.diagnostics.length = 0;
  engine.includes.clear();
  for (const w of engine.watchers.values()) {
    try {
      w.close();
    } catch {
      /* already closed */
    }
  }
  engine.watchers.clear();
}
