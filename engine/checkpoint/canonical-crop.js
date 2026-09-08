import { certifyCanonicalBlock, galleyLineWitnesses } from './canonical-paint-index.js';

const CROP_GEOMETRY_EPSILON_BP = 0.1;

export function canonicalCropMetrics(geo) {
  return {
    top: 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0),
    left: 72 + (geo.oddsidemargin ?? 0),
  };
}

export function canonicalBlockBands(pages, topOffset) {
  // block -> its vertical band, only when the block sits on ONE page
  // (page-spanning galleys cannot be one chunk box)
  const bands = new Map();
  for (const page of pages) {
    for (const d of page.draw ?? []) {
      const bid = d.u?.blockId;
      if (!bid) continue;
      const top = topOffset + d.y - (d.u.ln?.boxH ?? d.u.h ?? 0);
      const cur = bands.get(bid);
      if (!cur) bands.set(bid, { page: page.number, top });
      else if (cur.page !== page.number) cur.split = true;
      else cur.top = Math.min(cur.top, top);
    }
  }
  return bands;
}

export function leadingGalleySkip(galley) {
  // chunk coordinates start at the galley TOP (leading glue included in
  // the shipped vpack) — rewind the first drawn box by the leading skips
  let lead = 0;
  for (const it of galley.items ?? []) {
    if (it.k === 'box') break;
    if (it.k === 'glue' || it.k === 'kern') lead += it.a ?? 0;
  }
  return lead;
}

/** A crop is a reusable galley only when every painted line has a witness.
 * Graphics, math and commands with unharvested paint keep their own resident
 * or isolated render; paragraph-level text containment is not a crop proof. */
export function canonicalCropWitness(block) {
  const galley = block?.galley;
  if (!galley || block.gfx || block.rescued || galley.gfx || galley.tdomFrozen || galley.tdomDeferred ||
      block.fidelity?.canonicalOnly || /[\\$%{}&#^_~]/u.test(String(block.text ?? '')) ||
      ['floats', 'events', 'labels', 'refs', 'toclines'].some(key => galley[key]?.length)) return null;
  const witnesses = galleyLineWitnesses(galley);
  if (!witnesses?.length) return null;
  const baselines = [];
  let offset = 0;
  for (const item of galley.items ?? []) {
    if (item.k === 'box') {
      if (item.x || item.xb || item.chunk || item.runs?.some(run => run.m)) return null;
      offset += Number(item.h);
      baselines.push(offset);
      offset += Number(item.d ?? 0);
    } else if (item.k === 'glue' || item.k === 'kern') {
      const amount = Number(item.a ?? 0);
      if (!Number.isFinite(amount) || amount < 0) return null;
      offset += amount;
    } else if (item.k !== 'pen') return null;
  }
  const width = Number(galley.w), height = Number(galley.h) + Number(galley.d ?? 0);
  if (!(width > 0) || !(height > 0) || !near(offset, height) ||
      baselines.length !== witnesses.length || witnesses.some(line => !near(line.lineWidth, width))) return null;
  return { witnesses, baselines, width, height };
}

/** Prove the entire galley translates onto this physical PDF band. The
 * source-scoped SyncTeX candidates and immutable PDF paint must uniquely
 * match every line, including line spacing and the proposed crop origin. */
export function certifiedCanonicalCrop({ witness, band, left, lead, candidates, paintPages }) {
  if (!witness || !band || band.split) return null;
  const pagePaint = paintPages?.find(record => Number(record.page) === band.page);
  if (pagePaint?.cropSafe !== true) return null;
  const matching = certifyCanonicalBlock({ witnesses: witness.witnesses, candidates, paintPages });
  if (!matching || matching.length !== witness.baselines.length) return null;
  const page = Number(matching[0].candidate.page);
  const x = Number(matching[0].candidate.box.left);
  const y = Number(matching[0].candidate.y) - witness.baselines[0];
  if (!Number.isInteger(page) || page !== band.page || !near(x, left) || !near(y, band.top - lead)) return null;
  for (let index = 0; index < matching.length; index++) {
    const candidate = matching[index].candidate;
    if (candidate.page !== page || !near(candidate.box.left, x) ||
        !near(candidate.box.right, x + witness.width) ||
        !near(candidate.y, y + witness.baselines[index])) return null;
  }
  // A neighboring line inside a glue interval is not owned by this galley.
  // Never copy it into the reusable chunk even if all our own lines matched.
  if ((pagePaint?.items ?? []).some(item => item.right > x && item.left < x + witness.width &&
      item.baseline >= y && item.baseline <= y + witness.height &&
      (!item.safe || !matching.some(({ candidate }) => near(item.baseline, candidate.y))))) return null;
  return { page, left: x, top: y, width: witness.width, height: witness.height };
}

function near(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= CROP_GEOMETRY_EPSILON_BP;
}
