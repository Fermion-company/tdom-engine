// Rules as the daemon sends them in a galley.
//
// LuaTeX-ja puts an empty rule between every two characters of a Japanese
// line, and every one carries the raw evidence it is certified by
// (run-semantics.js RuleRunV2): 60 % of the bytes of such a paragraph's
// galley, alike but for where they stand and for one attribute. The daemon
// writes a rule that differs from a whole rule earlier in its run list in
// nothing but `x` as `{"rq": [j, x]}`, j counting the whole rules of that
// list from 0 (daemon.lua "rules on the wire"). Here, as the message is read
// and before anything else sees it, the whole rule is put back: the same
// fields in the same order, so every hash, witness and proof built on the
// runs is what it would be had the rule been sent whole.

const MARK = '{"rq":';

/** Whether a payload as received holds a rule in its short form. */
export function holdsPackedRules(payloadText) {
  return payloadText.includes(MARK);
}

function unpackRuns(runs) {
  const whole = []; // the rules of this list that came whole, in order
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run || typeof run !== 'object') continue;
    if (run.rule === true) whole.push(run);
    else if (Array.isArray(run.rq)) {
      // (a short form that names no whole rule is left as it is: nothing
      // certifies it, and the block falls back to exact pixels)
      const proto = whole[run.rq[0]];
      if (proto && typeof run.rq[1] === 'number') runs[i] = { ...proto, x: run.rq[1] };
    }
  }
}

/** Put the whole rule back for every short form in `value`'s run lists, in place. */
export function unpackRuleRuns(value) {
  if (Array.isArray(value)) {
    for (const item of value) if (item && typeof item === 'object') unpackRuleRuns(item);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  for (const key in value) {
    const child = value[key];
    if (!child || typeof child !== 'object') continue;
    if (key === 'runs' && Array.isArray(child)) unpackRuns(child); // (runs hold no run lists of their own)
    else unpackRuleRuns(child);
  }
  return value;
}
