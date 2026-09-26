/**
 * Build owns the machine's heavy TeX capacity. Resident edits keep using the
 * already-live checkpoint tree, but replaceable preview jobs wait until the
 * Build lease is released. Claiming is synchronous after the wait so an
 * acquire request cannot slip between the final gate check and registration.
 */
export async function claimReplaceablePreviewJob(engine, kind) {
  for (;;) {
    if (engine.closed) return null;
    await engine.canonical.waitForBuildLease();
    if (engine.closed) return null;
    if (engine.canonical.buildLease) continue;
    const job = Object.freeze({ kind, startedAt: Date.now() });
    engine.buildLeasePreviewJobs.add(job);
    let finished = false;
    return {
      finish() {
        if (finished) return false;
        finished = true;
        return engine.buildLeasePreviewJobs.delete(job);
      },
    };
  }
}

export async function withReplaceablePreviewJob(engine, kind, action) {
  const claim = await claimReplaceablePreviewJob(engine, kind);
  if (!claim) return undefined;
  try {
    return await action();
  } finally {
    claim.finish();
  }
}

export function buildLeasePreviewSettlement(acquired, activeJobs) {
  const jobs = activeJobs instanceof Set ? [...activeJobs] : [];
  const count = jobs.length || Math.max(0, Number(activeJobs) || 0);
  if (!acquired?.acquired || count === 0) return null;
  const now = Date.now();
  return {
    ok: false,
    acquired: false,
    reason: 'preview-work-settling',
    retryAfterMs: 100,
    activePreviewJobs: count,
    activePreviewWork: jobs.map((job) => ({
      kind: job?.kind ?? 'unknown',
      activeMs: Math.max(0, now - (Number(job?.startedAt) || now)),
    })),
    requestId: acquired.requestId,
    token: acquired.token,
    expiresAt: acquired.expiresAt,
  };
}
