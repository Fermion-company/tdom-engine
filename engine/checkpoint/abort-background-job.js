const DEFAULT_CANCEL_TTL_MS = 15_000;

/**
 * Pre-empt the resident-chain job that belongs to an obsolete source
 * generation. Killing the child is not sufficient: its two promises are
 * fulfilled over the daemon socket and can otherwise keep the next edit
 * behind the chain lock until the socket close/timeout arrives.
 */
export function abortBackgroundJob(
  engine,
  reason = 'background pass pre-empted by a newer edit',
  { killProcess = process.kill, setTimer = setTimeout } = {}
) {
  engine.bgAbort = true;
  if (!engine.bgActive) return false;
  const job = engine.currentJob;
  if (!job) return false;

  const err = new Error(reason);
  err.tdomAborted = true;
  const pid = job.pid;
  if (pid && pid > 0) {
    try { killProcess(pid, 'SIGKILL'); } catch { /* already gone */ }
  } else {
    // FORKED can be queued behind this edit. Remember the request id so the
    // late announcement is killed before it can become an untracked spinner.
    const jobId = job.galleyKey?.startsWith('galley:')
      ? job.galleyKey.slice('galley:'.length)
      : null;
    if (jobId) {
      engine.cancelledJobIds ??= new Set();
      engine.cancelledJobIds.add(jobId);
      const timer = setTimer(() => engine.cancelledJobIds?.delete(jobId), DEFAULT_CANCEL_TTL_MS);
      timer?.unref?.();
    }
  }

  // Release Promise.all/#jobBlock synchronously. Its catch path observes
  // bgAbort+bgActive and therefore does not poison, rescue, or adopt the
  // cancelled block; pendingChain simply retries from the same boundary.
  engine._reject(job.galleyKey, err);
  engine._reject(job.ckptKey, err);
  return true;
}
