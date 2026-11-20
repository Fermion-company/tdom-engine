// A line with a formula in it, shown before its own exact pixels exist.
//
// A keystroke in a paragraph that holds inline math (or a font the browser
// cannot be given) changes the paragraph's galley, and the paragraph's exact
// picture with it. Until the new picture lands the page used to show the
// paragraph from the previous galley (stream.js `held`, #103): the typed
// character appeared with the picture, a tenth of a second or more later,
// and during a burst not at all. But the keystroke rarely touches the
// formula. Its glyph runs are in the new galley exactly as they are in the
// galley the picture in hand was made for: the same characters of the same
// font at the same size, raised or lowered by the same amount. Those pixels
// can be cut out of the picture in hand and set down where the run stands
// now, while the browser draws the text around them as it draws any safe
// line. Each run is cut out on its own, because the glue inside a formula
// stretches with its line: after a keystroke the runs of `a + b` stand
// further apart or closer together, and each is still the same ink.
//
// Nothing is guessed. A line is composed only when every run of it that
// needs exact pixels has such a twin in the painted galley; one run without
// a twin (the keystroke was inside the formula) and the block is shown as
// before.

const r3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

/** What makes two runs the same ink wherever they stand. */
export function exactRunKey(run) {
  if (run.rule) {
    return ['rule', run.rv, run.rs, run.rw, run.rh, run.rd, run.ri, run.rl, run.rr, run.rdir, run.ra,
      r3(run.dy), r3(run.w), r3(run.h), run.c ?? ''].join('\u0001');
  }
  return [run.t, run.f, r3(run.s), run.c ?? '', run.m ? 1 : 0, r3(run.dy), r3(run.w), r3(run.gh), r3(run.gd)].join('\u0001');
}

// The box a run's ink is cut out by, from the baseline of its line: a glyph
// run by its glyphs' height and depth, a rule by its own (dy is its top).
const inkTop = (run) => (run.rule ? run.dy ?? 0 : (run.dy ?? 0) - run.gh);
const inkHeight = (run) => (run.rule ? run.h : run.gh + run.gd);

/**
 * For every exact line of `galley`: the runs the glyph layer draws and, for
 * each run that needs exact pixels, where its ink is in the picture of
 * `painted`. Map of item index -> { runs, parts }, or null when some exact
 * line cannot be shown this way.
 *
 * A part: `x`, `w` of the run on its line; `top` (above the baseline is
 * negative) and `h` of its glyph box; `sx` the run's left edge on its
 * painted line; `sy` the top of its glyph box below the top of the painted
 * galley. The display list adds the bleed and the picture's padding.
 */
export function composeExactLines(galley, fidelity, painted, paintedFidelity, why = null) {
  const lines = new Map();
  const wanted = [];
  const items = galley?.items ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.k !== 'box' || !((fidelity?.itemFlags?.[i] ?? 0) & 1)) continue;
    const exact = fidelity.exactRuns?.[i];
    if (!Array.isArray(exact) || item.chunk) {
      why?.push(`line ${i} cannot be split`);
      return null;
    }
    wanted.push([i, item, exact]);
  }
  if (!wanted.length) {
    why?.push('no exact line');
    return null;
  }

  // the painted galley's exact runs, in reading order
  const order = [];
  const byKey = new Map();
  let y = 0;
  const paintedItems = painted?.items ?? [];
  for (let i = 0; i < paintedItems.length; i++) {
    const item = paintedItems[i];
    if (item.k === 'glue' || item.k === 'kern') y += item.a ?? 0;
    if (item.k !== 'box') continue;
    const exact = paintedFidelity?.exactRuns?.[i];
    if (Array.isArray(exact)) {
      for (const k of exact) {
        const run = item.runs[k];
        const entry = { key: exactRunKey(run), run, baseline: y + (item.h ?? 0), used: false, at: order.length };
        order.push(entry);
        if (!byKey.has(entry.key)) byKey.set(entry.key, []);
        byKey.get(entry.key).push(entry);
      }
    }
    y += (item.h ?? 0) + (item.d ?? 0);
  }

  // A formula the keystroke left alone is found run after run where it was:
  // the twin right after the last one found is taken first, so each run
  // comes with the neighbours it has now. Otherwise any twin not yet taken,
  // and one taken already when the same ink is wanted twice.
  let next = 0;
  for (const [i, item, exact] of wanted) {
    const parts = [];
    for (const k of exact) {
      const run = item.runs[k];
      const key = exactRunKey(run);
      const twins = byKey.get(key);
      if (!twins) {
        why?.push(`line ${i} run ${k} ${JSON.stringify(run.rule ? { rule: run.rs, w: run.w, h: run.h } : run.t)} has no twin among ${order.length}`);
        return null;
      }
      const twin = order[next]?.key === key && !order[next].used ? order[next]
        : twins.find((entry) => !entry.used) ?? twins[0];
      twin.used = true;
      next = twin.at + 1;
      parts.push({
        x: run.x, w: run.w, top: inkTop(run), h: inkHeight(run),
        sx: twin.run.x, sy: twin.baseline + inkTop(twin.run),
      });
    }
    const taken = new Set(exact);
    lines.set(i, { runs: item.runs.filter((_, k) => !taken.has(k)), parts });
  }
  return lines;
}
