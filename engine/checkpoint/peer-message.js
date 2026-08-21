export function handlePeerMessage(engine, peer, msg) {
  switch (msg.kind) {
    case 'HELLO':
      peer.role = msg.role;
      peer.pid = msg.pid;
      peer.idxAnnounced = msg.idx;
      if (msg.role === 'ckpt' && msg.idx === 0) {
        engine.checkpoints.set(0, peer);
        engine._fulfill('ckpt:0', peer);
      }
      break;
    case 'GEO':
      engine.geometry = msg.json;
      engine._fulfill('geo', msg.json);
      break;
    case 'TWIN':
      engine.twinMetrics = msg.json; // unicode -> [height, depth] bp at 10pt
      break;
    case 'GALLEY':
      engine._fulfill('galley:' + msg.id, msg.json);
      break;
    case 'CKPT':
      // accept only ANNOUNCED checkpoints someone is waiting for: a late
      // CKPT from a timed-out lineage (the SIGKILL lost the race) would
      // otherwise overwrite the slot with a peer whose TeX state predates
      // the rescue/retry that replaced it, and future jobs would fork
      // from the wrong state
      if (engine.waiters.has('ckpt:' + msg.idx)) {
        // A preserved suffix can already occupy this boundary.  The new
        // child is the checkpoint produced by re-typesetting the edited
        // block, so it replaces that suffix snapshot.  Retire the old peer
        // explicitly before overwriting the Map entry; otherwise every
        // keystroke leaks one resident lualatex process even though the
        // advertised checkpoint count stays constant.
        const replaced = engine.checkpoints.get(msg.idx);
        if (replaced && replaced !== peer) {
          replaced.send('DIE\n');
          if (replaced.pid) {
            engine.dyingPids ??= new Set();
            engine.dyingPids.add(replaced.pid);
          }
        }
        engine.checkpoints.set(msg.idx, peer);
        engine._fulfill('ckpt:' + msg.idx, peer);
      } else {
        peer.send('DIE\n');
        if (peer.pid) {
          engine.dyingPids ??= new Set();
          engine.dyingPids.add(peer.pid);
        }
      }
      break;
    case 'DONE':
      engine._fulfill('render:' + msg.id, true);
      break;
    case 'FORKED':
      // pid must be a real child: a bogus non-positive pid stored here would
      // reach process.kill() on timeout, and kill(-1) signals EVERYTHING
      // the user owns
      if (!Number.isFinite(msg.pid) || msg.pid <= 0) break;
      if (engine.currentJob && engine.currentJob.galleyKey === 'galley:' + msg.id) {
        engine.currentJob.pid = msg.pid;
      }
      // render children announce the same way — remember the pid so a
      // timed-out render (deep-lineage luahbtex spin) can be SIGKILLed
      // instead of burning a core forever
      if (engine.renderPids?.has(msg.id)) engine.renderPids.set(msg.id, msg.pid);
      break;
    case 'FORKFAIL': {
      // the daemon's fork() failed (EAGAIN/ENOMEM — the system is out of
      // processes or memory): nothing will ever answer this job. Fail the
      // waiters NOW instead of letting them burn the full job timeout.
      const err = new Error(`daemon fork failed for ${msg.id} (process/memory pressure)`);
      err.tdomInfra = true;
      engine.diagnostics.push(`daemon fork failed for ${msg.id} (pid ${peer.pid})`);
      engine._reject('galley:' + msg.id, err);
      engine._reject('render:' + msg.id, err);
      break;
    }
  }
}
