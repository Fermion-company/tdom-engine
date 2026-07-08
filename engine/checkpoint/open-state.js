export function resetOpenState(engine, text, file) {
  engine.file = file;
  engine.store.open(file, text);
  engine.blocks = [];
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
  engine.opaqueStickyPre = null;
  engine.verifyState = null;
  engine.pendingChain = null;
  engine.editHold = [];
}
