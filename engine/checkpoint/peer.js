export class Peer {
  constructor(sock, engine) {
    this.sock = sock;
    this.engine = engine;
    this.role = '?';
    this.pid = 0;
    this.buf = Buffer.alloc(0);
    this.pendingHeader = null; // { kind, id, len }
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.#drain();
    });
    sock.on('error', () => {});
  }

  send(line) {
    try { this.sock.write(line); } catch { /* peer gone */ }
  }

  sendRaw(buf) {
    try { this.sock.write(buf); } catch { /* peer gone */ }
  }

  #drain() {
    while (true) {
      if (this.pendingHeader) {
        const { kind, id, len } = this.pendingHeader;
        if (this.buf.length < len) return;
        const payload = this.buf.subarray(0, len).toString('utf8');
        this.buf = this.buf.subarray(len);
        this.pendingHeader = null;
        let json = null;
        try {
          json = JSON.parse(payload);
        } catch (err) {
          this.engine.diagnostics.push(`bad ${kind} payload from pid ${this.pid}: ${err.message}`);
        }
        if (json) this.engine._onMessage(this, { kind, id, json });
        continue;
      }
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString('utf8').trim();
      this.buf = this.buf.subarray(nl + 1);
      if (!line) continue;
      const parts = line.split(/\s+/);
      switch (parts[0]) {
        case 'HELLO':
          this.engine._onMessage(this, {
            kind: 'HELLO',
            role: parts[1],
            idx: Number(parts[2]),
            pid: Number(parts[3]),
          });
          break;
        case 'GEO':
          this.pendingHeader = { kind: 'GEO', id: null, len: Number(parts[1]) };
          break;
        case 'TWIN':
          this.pendingHeader = { kind: 'TWIN', id: null, len: Number(parts[1]) };
          break;
        case 'GALLEY':
          this.pendingHeader = { kind: 'GALLEY', id: parts[1], len: Number(parts[2]) };
          break;
        case 'CKPT':
          this.engine._onMessage(this, { kind: 'CKPT', idx: Number(parts[1]), pid: Number(parts[2]) });
          break;
        case 'DONE':
          this.engine._onMessage(this, { kind: 'DONE', id: parts[1] });
          break;
        case 'FORKED':
          this.engine._onMessage(this, { kind: 'FORKED', id: parts[1], pid: Number(parts[2]) });
          break;
        case 'PONG':
          break;
        default:
          break;
      }
    }
  }
}
