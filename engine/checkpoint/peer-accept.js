import { Peer } from './peer.js';

export function acceptPeer(engine, sock) {
  const peer = new Peer(sock, engine);
  engine.peers.add(peer);
  sock.on('close', () => {
    engine.peers.delete(peer);
    if (peer.pid) engine.dyingPids?.delete(peer.pid);
    for (const [idx, p] of engine.checkpoints) {
      if (p === peer) engine.checkpoints.delete(idx);
    }
    // fail fast: if the process carrying the in-flight job dies (TeX
    // emergency stop on a broken block, missing file, ...), reject its
    // waiters immediately instead of running out the 30s timeout
    const job = engine.currentJob;
    if (job && (peer === job.parent || (job.pid && peer.pid === job.pid))) {
      const err = new Error('typesetting process died (TeX error in this block?)');
      engine._reject(job.galleyKey, err);
      engine._reject(job.ckptKey, err);
    }
  });
}
