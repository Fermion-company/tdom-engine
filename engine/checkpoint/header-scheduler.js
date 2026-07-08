import { normalizeHeaderFooterPayload } from './header-footer.js';
import { fnv1a } from '../hash.js';

export function scheduleHeaders(
  engine,
  { pageSpecs, hfJobBody, awaitGalley, registerFont, asyncRepaginate }
) {
  const pages = engine.pages;
  if (!pages?.length) return;
  const specs = pageSpecs(pages);
  const sig = fnv1a(JSON.stringify(specs));
  if (sig === engine.hfSig || sig === engine.hfPending) return;
  const ck = engine.checkpoints.get(0);
  if (!ck) return;
  engine.hfPending = sig;
  engine.hfTask = (async () => {
    const body = Buffer.from(hfJobBody(specs), 'utf8');
    const done = awaitGalley('galley:__hf', 60_000);
    done.catch(() => {});
    ck.send(`RENDER __hf ${engine.workDir} ${body.length}\n`);
    ck.sendRaw(body);
    const payload = await done;
    const map = normalizeHeaderFooterPayload(payload, registerFont);
    // apply only between updates — never mid-#update (see this.updating)
    await new Promise((resolve) => {
      const apply = () => {
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
      engine.diagnostics.push('header job failed: ' + err.message);
    })
    .finally(() => {
      if (engine.hfPending === sig) engine.hfPending = null;
    });
}
