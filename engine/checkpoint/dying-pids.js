export async function reapDyingPids(dyingPids, maxDying = 8) {
  const sweep = () => {
    for (const pid of [...dyingPids]) {
      try {
        process.kill(pid, 0);
      } catch {
        dyingPids.delete(pid);
      }
    }
  };
  sweep();
  const t0 = Date.now();
  while (dyingPids.size > maxDying) {
    if (Date.now() - t0 > 2000) {
      for (const pid of [...dyingPids]) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        dyingPids.delete(pid);
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
    sweep();
  }
}
