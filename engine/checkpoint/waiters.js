export function awaitWaiter(waiters, key, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(key);
      reject(new Error(`timeout waiting for ${key}`));
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
