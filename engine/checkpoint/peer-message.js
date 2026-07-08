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
      engine.checkpoints.set(msg.idx, peer);
      engine._fulfill('ckpt:' + msg.idx, peer);
      break;
    case 'DONE':
      engine._fulfill('render:' + msg.id, true);
      break;
    case 'FORKED':
      if (engine.currentJob && engine.currentJob.galleyKey === 'galley:' + msg.id) {
        engine.currentJob.pid = msg.pid;
      }
      // render children announce the same way — remember the pid so a
      // timed-out render (deep-lineage luahbtex spin) can be SIGKILLed
      // instead of burning a core forever
      if (engine.renderPids?.has(msg.id)) engine.renderPids.set(msg.id, msg.pid);
      break;
  }
}
