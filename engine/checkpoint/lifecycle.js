import { rejectWaiter } from './waiters.js';

export async function closeEngine(engine) {
  engine.closed = true;
  engine.bgAbort = true;
  // cancel every outstanding protocol wait (galley/ckpt/render/__hf …):
  // their timers — the header job's is 60s, and failures re-arm queued
  // successors — would otherwise keep the host process alive long after
  // the resident tree is gone
  for (const key of [...engine.waiters.keys()]) {
    const err = new Error('engine closed');
    err.tdomInfra = true;
    rejectWaiter(engine.waiters, key, err);
  }
  engine.canonical.dispose();
  clearTimeout(engine.shipBootTimer);
  if (engine.shipping) await engine.shipping.close().catch(() => {});
  engine.rescueQueue.clear();
  engine.renderWant.clear();
  engine.isoRenderPending?.clear();
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
  for (const pid of engine.dyingPids ?? []) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (engine.root) {
    try { engine.root.kill('SIGKILL'); } catch { /* gone */ }
    // the root runs in its own process group (boot-root spawns it detached);
    // group-kill reaps every fork that never connected or was mid-retirement,
    // releasing the shared stdout pipe that would otherwise pin the host
    // process alive until the last orphan exits
    if (engine.root.pid) {
      try { process.kill(-engine.root.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  if (engine.server) engine.server.close();
  engine.checkpoints.clear();
  engine.peers.clear();
}
