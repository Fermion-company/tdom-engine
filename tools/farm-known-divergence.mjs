export function matchesKnownDivergence(expected, actual) {
  // Preserve the original manifest contract for existing broad baselines.
  if (expected === true) return true;
  if (!expected || typeof expected !== 'object') return false;
  if (!Number.isInteger(expected.issue) || expected.issue <= 0) return false;
  if (!['kind', 'enginePages', 'realPages', 'matched', 'lines']
    .every((key) => Object.hasOwn(expected, key))) return false;
  if (!['kind', 'enginePages', 'realPages', 'lines']
    .every((key) => actual[key] === expected[key])) return false;
  const matched = expected.matched;
  return Array.isArray(matched)
    ? matched.length > 0 && matched.every(Number.isInteger) && matched.includes(actual.matched)
    : actual.matched === matched;
}
