export function teardownResidentTree(engine) {
  for (const peer of engine.peers) {
    peer.send('DIE\n');
    if (peer.pid) {
      try { process.kill(peer.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  engine.checkpoints.clear();
  if (engine.root) {
    try { engine.root.kill('SIGKILL'); } catch { /* gone */ }
    engine.root = null;
  }
  engine.rescueQueue.clear();
  engine.renderWant.clear();
  engine.renderHold.clear();
  engine.pendingChain = null;
  engine.editHold = [];
  clearTimeout(engine.shipBootTimer);
  engine.shipBootTimer = null;
  engine.shipBootedFor = null;
  if (engine.shipping) engine.shipping.close().catch(() => {});
  for (const child of engine.isoChildren) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  engine.preHash = null; // a later promotion must reboot from scratch
  engine.pages = [];
  engine._pageRun = null;
}
