export function awaitWaiter(waiters, key, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(key);
      const err = new Error(`timeout waiting for ${key}`);
      // protocol timeout, not a content verdict — lets the typeset ladder
      // tell "this block's TeX is broken" apart from "nothing answered"
      err.tdomTimeout = true;
      reject(err);
    }, timeout);
    waiters.set(key, { resolve, reject, timer });
  });
}

export function fulfillWaiter(waiters, key, value) {
  const w = waiters.get(key);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(key);
    w.resolve(value);
  }
}

export function rejectWaiter(waiters, key, err) {
  const w = waiters.get(key);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(key);
    w.reject(err);
  }
}
