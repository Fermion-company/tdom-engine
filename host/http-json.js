// Minimal JSON client for the engine's local HTTP API. The engine is
// zero-dependency and so is anything that hosts it, so this stays on
// node:http rather than pulling in a request library.

import http from 'node:http';

export function requestJson(url, { method = 'GET', body, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            return reject(new Error(`tdom request failed (${res.statusCode}): ${text}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('tdom returned invalid JSON'));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('tdom request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
