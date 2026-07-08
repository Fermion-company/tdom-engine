export async function closeEngine(engine) {
  engine.closed = true;
  engine.bgAbort = true;
  engine.canonical.dispose();
  clearTimeout(engine.shipBootTimer);
  if (engine.shipping) await engine.shipping.close().catch(() => {});
  engine.rescueQueue.clear();
  for (const child of engine.isoChildren) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  for (const w of engine.watchers.values()) {
    try { w.close(); } catch { /* already closed */ }
  }
  engine.watchers.clear();
  for (const peer of engine.peers) {
    peer.send('DIE\n');
    if (peer.pid) {
      try { process.kill(peer.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  if (engine.root) {
    try { engine.root.kill('SIGKILL'); } catch { /* gone */ }
  }
  if (engine.server) engine.server.close();
  engine.checkpoints.clear();
  engine.peers.clear();
}
