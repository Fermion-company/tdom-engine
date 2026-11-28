import { rejectWaiter } from './waiters.js';
import { clearShipPacing } from './ship-pacing.js';
import { wakeRescues } from './rescue-scheduling.js';
import { releaseFurniture } from './canonical-arrival.js';
import { wakeFurnitureUpdates } from './header-scheduler.js';

export async function closeEngine(engine) {
  engine.closed = true;
  wakeFurnitureUpdates(engine);
  wakeRescues(engine);
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
  // (the document's exact-band bindings, cut queue and retry wake)
  releaseFurniture(engine);
  clearTimeout(engine.shipBootTimer);
  clearShipPacing(engine);
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
    // The connection is ours to end as well: one whose far side vanished
    // without a FIN (seen once after infra-escalation's wedged lineage, an
    // ESTABLISHED loopback socket with no remote end) otherwise keeps the
    // host process alive after close.
    try { peer.sock?.end(); peer.sock?.destroy(); } catch { /* already closed */ }
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
  engine.isoPageCache = null;
  // (the header job unwinds now: its waits end on `closed`; close returns
  // once its preview claim is released, at most 1 s)
  if (engine.hfTask) {
    await Promise.race([Promise.resolve(engine.hfTask).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000).unref?.())]);
  }
}
