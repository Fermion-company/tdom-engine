import { normalizeHeaderFooterPayload } from './header-footer.js';
import { fnv1a } from '../hash.js';
import { shippingPriorityQuietMs } from './interactive-priority.js';

export function scheduleHeaders(
  engine,
  helpers
) {
  const { pageSpecs } = helpers;
  const pages = engine.pages;
  if (!pages?.length) return;
  const specs = pageSpecs(pages);
  const sig = fnv1a(JSON.stringify(specs));
  if (sig === engine.hfSig || sig === engine.hfPending || sig === engine.hfQueuedSig) return;
  if (engine.hfPending) {
    // ONE job in flight, ever: two concurrent RENDER __hf jobs share the
    // daemon's single 'galley:__hf' waiter key, and the second used to
    // overwrite the first's waiter — the first reply (built from layout A)
    // then fulfilled it and was stored as the map for layout B, i.e.
    // wrong headers marked correct. Remember the newest layout instead
    // and run it when the in-flight job lands (latest wins).
    engine.hfQueued = { specs, sig };
    engine.hfQueuedSig = sig;
    return;
  }
  runHeaderJob(engine, helpers, specs, sig);
}

function runHeaderJob(engine, helpers, specs, sig) {
  const { hfJobBody, awaitGalley, registerFont, asyncRepaginate } = helpers;
  const ck = engine.checkpoints.get(0);
  if (!ck) return;
  engine.hfPending = sig;
  engine.hfTask = (async () => {
    // A complete root replay already contains the authoritative headers.
    // Let it reach the atomic preview switch before this replaceable
    // resident render is allowed to consume a core.
    for (;;) {
      if (engine.closed) return;
      const remaining =
        shippingPriorityQuietMs(engine, 0) - (Date.now() - (engine.lastEditAt ?? 0));
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }
    // A later edit queued a newer page-state signature while this job was
    // waiting for the foreground lease. Skip the obsolete TeX work; the
    // finally block below immediately starts the latest queued signature.
    if (engine.hfQueuedSig && engine.hfQueuedSig !== sig) return;
    const body = Buffer.from(hfJobBody(specs), 'utf8');
    const done = awaitGalley('galley:__hf', 60_000);
    done.catch(() => {});
    // workDir percent-encoded (spaces in macOS paths shear the line)
    ck.send(`RENDER __hf ${encodeURIComponent(engine.workDir)} ${body.length}\n`);
    ck.sendRaw(body);
    const payload = await done;
    // The job may already have been in TeX when a newer edit arrived. Its
    // pixels are now stale even though the protocol reply is valid.
    if (engine.hfQueuedSig && engine.hfQueuedSig !== sig) return;
    const map = normalizeHeaderFooterPayload(payload, registerFont);
    // apply only between updates — never mid-#update (see this.updating)
    await new Promise((resolve) => {
      const apply = () => {
        if (engine.closed) {
          resolve();
          return;
        }
        if (engine.updating) {
          setTimeout(apply, 10);
          return;
        }
        engine.hf = map;
        engine.hfSig = sig;
        asyncRepaginate();
        resolve();
      };
      apply();
    });
  })()
    .catch((err) => {
      engine.diagnostics.push('header job failed: ' + (err?.message ?? err));
    })
    .finally(() => {
      if (engine.hfPending === sig) engine.hfPending = null;
      const next = engine.hfQueued;
      engine.hfQueued = null;
      engine.hfQueuedSig = null;
      if (next && !engine.closed && next.sig !== engine.hfSig) {
        runHeaderJob(engine, helpers, next.specs, next.sig);
      }
    });
}
