import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const engine = fileURLToPath(new URL('..', import.meta.url));
const fixtures = ['t00-yoko-control.tex', 't01-ltjtarticle.tex'];
const baseline = process.env.TDOM_CLICK_PARITY_BASELINE;

async function withEngine(t, checkout, visit) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  const project = mkdtempSync(path.join(tmpdir(), 'tdom-click-parity-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: checkout, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), TDOM_WORKDIR: path.join(project, 'work'), TDOM_SAMPLE: 'demo-lua.tex' },
  });
  t.diagnostic('engine pid ' + child.pid);
  let output = '';
  const append = chunk => { output = (output + chunk).slice(-16_384); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const stopped = once(child, 'exit');
  const request = async (url, body) => {
    const response = await fetch('http://127.0.0.1:' + port + url, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    await until(() => {
      assert.equal(child.exitCode, null, output);
      return request('/status').catch(() => null);
    }, 'engine did not start');
    return await visit(project, request);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([stopped, sleep(5000, null, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid, 'SIGKILL');
        await stopped;
      }
    }
  }
}

async function until(read, description) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  assert.fail(description);
}

function clickPoints(boxes, papers) {
  let seed = 0x9152026;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const words = boxes.flatMap((page, index) => page.map(box => ({ box, page: index + 1 })));
  assert.ok(words.length);
  return Array.from({ length: 250 }, (_, index) => {
    if (index % 4 === 0) {
      const page = 1 + Math.floor(random() * papers.length);
      return { page, x: random() * papers[page - 1].w, y: random() * papers[page - 1].h };
    }
    const { page, box } = words[Math.floor(words.length * random())];
    return { page, x: box.left + (box.right - box.left) * random(), y: box.top + (box.bottom - box.top) * random() };
  });
}

async function collect(project, request, { expected, control }) {
  const all = [];
  for (const [index, fixture] of fixtures.entries()) {
    const filePath = path.join(project, fixture);
    const source = readFileSync(new URL('./fixtures/tate/' + fixture, import.meta.url), 'utf8');
    writeFileSync(filePath, source);
    const opened = await request('/open', { filePath, projectRoot: project, text: source });
    assert.equal(opened.status, 200);
    const canonical = await until(async () => {
      const { data } = await request('/status');
      assert.ok(!data.canonical?.error, data.canonical?.error);
      return data.canonical?.id && data.canonical.rev === data.srcRev && !data.busy && data.canonical;
    }, fixture + ' did not compile');
    const { data } = await request('/canonical/boxes?c=' + canonical.id);
    const points = expected?.[index].points ?? clickPoints(data.pages, canonical.papers);
    const reverse = async (point, displayed) => {
      const reply = await request('/synctex', { ...point, id: canonical.id,
        ...(displayed && { displayedSourceRev: canonical.rev }) });
      if (reply.data.file) reply.data.file = path.basename(reply.data.file);
      return reply;
    };
    const answers = [];
    for (let i = 0; i < points.length; i += 4) {
      const batch = points.slice(i, i + 4);
      answers.push(...await Promise.all(batch.map(async (point, j) => {
        const result = await reverse(point, true);
        const prior = expected?.[index].answers[i + j] ?? (control ? null : await reverse(point, false));
        if (prior) assert.deepEqual(result, prior, fixture + ' click ' + (i + j + 1));
        return result;
      })));
    }
    if (!control) {
      const ink = points[answers.findIndex(answer => answer.status === 200)];
      assert.ok(ink);
      for (const wrongPaper of [{ id: canonical.id + 1000 }, { documentEpoch: -1 }, { boot: 'previous-engine' }]) {
        const reply = await request('/synctex', {
          ...ink, id: canonical.id, displayedSourceRev: canonical.rev, ...wrongPaper,
        });
        assert.deepEqual(reply, { status: 404, data: { reason: 'paper-unavailable' } });
      }
    }
    all.push({ points, answers });
  }
  return all;
}

test('500 current-paper reverse clicks preserve the horizontal and vertical answers', { timeout: 180_000 }, async t => {
  const expected = baseline && await withEngine(t, baseline, (project, request) => collect(project, request, { control: true }));
  await withEngine(t, engine, (project, request) => collect(project, request, { expected, control: false }));
});
