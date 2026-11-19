// A text as a change of the text before it.

/** `after` as a change of `before`: [where, how many characters go, what comes]. */
export function textSplice(before, after) {
  const limit = Math.min(before.length, after.length);
  let head = 0;
  // (equal stretches are compared by the engine's own string comparison)
  for (let step = 1 << 16; step >= 1; step >>= 1) {
    while (head + step <= limit && before.startsWith(after.slice(head, head + step), head)) head += step;
  }
  let tail = 0;
  for (let step = 1 << 16; step >= 1; step >>= 1) {
    while (tail + step <= limit - head &&
        before.endsWith(after.slice(after.length - tail - step, after.length - tail), before.length - tail)) tail += step;
  }
  return [head, before.length - head - tail, after.slice(head, after.length - tail)];
}
