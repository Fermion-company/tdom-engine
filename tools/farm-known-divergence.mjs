export function matchesKnownDivergence(expected, actual) {
  // Preserve the original manifest contract for existing broad baselines.
  if (expected === true) return true;
  if (!expected || typeof expected !== 'object') return false;
  if (!Number.isInteger(expected.issue) || expected.issue <= 0) return false;
  return ['kind', 'enginePages', 'realPages', 'matched', 'lines']
    .every((key) => Object.hasOwn(expected, key) && actual[key] === expected[key]);
}
