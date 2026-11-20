// One update builds the display lists of the pages nearest the edit; the
// other pages it moved are owed, and are built and sent a few at a time
// afterwards (page-patches.js EAGER_PAGES, engine-v3.js #pumpOwedPages).
// A keystroke that makes a paragraph a line longer moves a line across every
// page break after it; sent as one event, the pages of a long single flow
// were more than the event stream may hold back, and the viewer was dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPagePatches, pagesOwed, EAGER_PAGES } from '../engine/checkpoint/page-patches.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain } from '../tools/harness.mjs';

// a page whose content is `content`; its list is built by `list`
const page = (number, content) => ({ number, content });
const builder = () => {
  const built = [];
  const list = (p) => { built.push(p.number); return { page: p.number, hash: `h:${p.content}`, hfSig: 'hf', commands: [p.content] }; };
  return { built, list };
};
const sent = (result) => result.patches.filter((patch) => patch.type === 'replace-page').map((patch) => patch.page);

test('with a limit, the pages nearest the focus are built and the others are owed until a later call', () => {
  const { built, list } = builder();
  // ten pages shown, each with its list
  let pages = Array.from({ length: 10 }, (_, i) => page(i + 1, `a${i + 1}`));
  let result = buildPagePatches(pages, [], 'hf', list);
  assert.deepEqual(sent(result), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'no limit: every page, as before');
  assert.equal(result.later, 0);
  assert.equal(pagesOwed(pages), false);

  // an edit on page 3 moves every page from there on: new page objects without a list
  built.length = 0;
  let next = pages.map((p) => (p.number < 3 ? p : page(p.number, `b${p.number}`)));
  result = buildPagePatches(next, pages, 'hf', list, { limit: 3 });
  assert.deepEqual(built, [3, 4, 5], 'the first pages that need a list');
  assert.deepEqual(sent(result), [3, 4, 5]);
  assert.deepEqual(result.dirtyPages, [3, 4, 5]);
  assert.equal(result.later, 5);
  assert.equal(pagesOwed(next), true);
  assert.deepEqual(next.filter((p) => p.owed).map((p) => p.number), [6, 7, 8, 9, 10]);
  assert.equal(next[5].owed.hash, 'h:a6', 'an owed page remembers what the viewers show of its number');
  assert.equal(next[5].dl, undefined);
  pages = next;

  // the next keystroke changes page 3 alone: it builds page 3, not the pages still owed
  built.length = 0;
  next = pages.map((p) => (p.number === 3 ? page(3, 'c3') : p));
  result = buildPagePatches(next, pages, 'hf', list, { limit: 3 });
  assert.deepEqual(built, [3]);
  assert.deepEqual(sent(result), [3]);
  assert.equal(result.later, 5, 'the owed pages are still owed');
  pages = next;

  // the pump: the owed pages, a few at a time, nearest the focus first
  built.length = 0;
  result = buildPagePatches(pages, pages, 'hf', list, { limit: 2, focus: 8, owedToo: true });
  assert.deepEqual(built, [7, 8], 'the two nearest page 8 (built in page order)');
  assert.deepEqual(sent(result), [7, 8]);
  assert.equal(result.later, 3);
  result = buildPagePatches(pages, pages, 'hf', list, { limit: 2, focus: 8, owedToo: true });
  assert.deepEqual(sent(result), [6, 9]);
  result = buildPagePatches(pages, pages, 'hf', list, { limit: 2, focus: 8, owedToo: true });
  assert.deepEqual(sent(result), [10]);
  assert.equal(result.later, 0);
  assert.equal(pagesOwed(pages), false);
  // nothing owed, nothing stale: nothing built, nothing sent
  built.length = 0;
  result = buildPagePatches(pages, pages, 'hf', list, { limit: 2, owedToo: true });
  assert.deepEqual([built, sent(result), result.later], [[], [], 0]);
});

test('an owed page is sent only if it differs from what the viewers show, whoever builds its list', () => {
  const { built, list } = builder();
  let pages = Array.from({ length: 6 }, (_, i) => page(i + 1, `a${i + 1}`));
  buildPagePatches(pages, [], 'hf', list);
  // every page gets a new object; pages 5 and 6 with the content they had
  let next = pages.map((p) => page(p.number, p.number >= 5 ? p.content : `b${p.number}`));
  let result = buildPagePatches(next, pages, 'hf', list, { limit: 2 });
  assert.deepEqual(sent(result), [1, 2]);
  pages = next;
  // a reader of every list (the document asked for whole) builds the owed lists without sending them
  for (const p of pages) if (!p.dl) p.dl = list(p);
  assert.equal(pagesOwed(pages), true, 'they are still owed to the viewers');
  built.length = 0;
  result = buildPagePatches(pages, pages, 'hf', list, { limit: 10, owedToo: true });
  assert.deepEqual(built, [], 'nothing is built twice');
  assert.deepEqual(sent(result), [3, 4], 'the pages that changed are sent; the two that came out the same are not');
  assert.equal(pagesOwed(pages), false);

  // a page copied to another number (a page count that changed) carries no claim about that number
  next = pages.map((p) => ({ ...p, number: p.number + 1, dl: undefined, owed: { number: p.number, hash: 'stale claim' } }));
  next.unshift(page(1, 'new first page'));
  result = buildPagePatches(next, pages, 'hf', list, { limit: 3, focus: 1 });
  assert.deepEqual(sent(result), [1, 2, 3]);
  assert.deepEqual(next.filter((p) => p.owed).map((p) => [p.number, p.owed.hash]),
    [[4, 'h:b4'], [5, 'h:a5'], [6, 'h:a6'], [7, null]], 'what the viewers show of each number; nothing of a page they do not have');
  // a shrink sends the surviving last page with its removal, limit or not
  pages = next;
  buildPagePatches(pages, pages, 'hf', list, { owedToo: true });
  next = pages.slice(0, 5).map((p) => page(p.number, `z${p.number}`));
  result = buildPagePatches(next, pages, 'hf', list, { limit: 1, focus: 1 });
  assert.deepEqual(sent(result), [1, 5]);
  assert.deepEqual(result.patches.at(-1), { type: 'remove-pages', from: 6 });
  assert.ok(next[4].dl, 'the last page has its list');
});

test('a list built under other headers is built again, within the limit', () => {
  const { built, list } = builder();
  const pages = Array.from({ length: 5 }, (_, i) => page(i + 1, `a${i + 1}`));
  buildPagePatches(pages, [], 'hf', list);
  built.length = 0;
  // every page's header changed
  const other = (p) => ({ page: p.number, hash: `h2:${p.content}`, hfSig: 'hf2', commands: [p.content] });
  let result = buildPagePatches(pages, pages, 'hf2', (p) => { built.push(p.number); return other(p); }, { limit: 2, focus: 4 });
  assert.deepEqual(built, [3, 4], 'the two nearest page 4');
  assert.deepEqual(sent(result), [3, 4]);
  assert.equal(result.later, 3);
  assert.equal(pages[0].dl.hfSig, 'hf', 'an owed page keeps the list the viewers show');
  assert.equal(pages[0].owed.hash, 'h:a1');
  result = buildPagePatches(pages, pages, 'hf2', (p) => { built.push(p.number); return other(p); }, { limit: 10, owedToo: true });
  assert.deepEqual(sent(result), [1, 2, 5]);
});

const texReady = spawnSync('lualatex', ['--version']).status === 0;

const PARAGRAPHS = 90;
const SOURCE = [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  ...Array.from({ length: PARAGRAPHS }, (_, i) =>
    `Paragraph ${i + 1} marker${i + 1}x. ${'These are ordinary words that fill a few lines of the page so that the document runs over several pages. '.repeat(3)}\n`),
  String.raw`\end{document}`,
  '',
].join('\n');
const lines = (list) => list.commands.filter((c) => c.op === 'glyphs').map((c) => `${c.x},${c.y},${c.text}`).join('|');

test('a keystroke that moves every page after it answers with the nearest pages; the others follow, and every page arrives',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    assert.ok(Number.isFinite(EAGER_PAGES), 'this test is about the default limit');
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-owed-pages-'));
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work') });
    engine.canonical.schedule = () => {};
    try {
      await engine.open(SOURCE);
      await drain(engine, 120_000);
      const pageCount = engine.pages.length;
      assert.ok(pageCount >= 9, `${pageCount} pages`);
      // what a viewer holds: the list last delivered for each page
      const held = new Map(engine.getDisplayLists().map((list) => [list.page, list]));
      const events = [];
      let lastRev = engine.rev;
      const take = (patches) => {
        for (const patch of patches) {
          if (patch.type === 'replace-page') held.set(patch.page, patch.displayList);
          else if (patch.type === 'remove-pages') for (const n of [...held.keys()]) if (n >= patch.from) held.delete(n);
        }
      };
      const sinceKey = []; // how long after the last keystroke each event came
      engine.onAsyncPatches = (partial) => {
        assert.ok(partial.rev > lastRev, 'revisions only rise');
        lastRev = partial.rev;
        events.push(partial.patches.filter((patch) => patch.type === 'replace-page').map((patch) => patch.page));
        sinceKey.push(Date.now() - engine.lastEditAt);
        take(partial.patches);
      };
      // (the first load leaves every block's closure verdict behind, so the first keystroke reads one)
      assert.ok(engine.closureMemo?.byText?.size >= PARAGRAPHS, `closure verdicts kept after opening: ${engine.closureMemo?.byText?.size}`);
      // a sentence added to a paragraph on the second page: several lines more, every page after it moves
      const at = engine.getSource().indexOf('marker12x') + 'marker12'.length;
      const report = await engine.edit(at, at, ` ${'and a sentence that makes this paragraph a good deal longer than it was '.repeat(3)}`);
      lastRev = Math.max(lastRev, report.rev);
      take(report.patches);
      const answered = report.patches.filter((patch) => patch.type === 'replace-page').map((patch) => patch.page);
      const moved = engine.pages.length - answered[0] + 1;
      assert.ok(moved > EAGER_PAGES, `the edit moved ${moved} pages`);
      assert.equal(answered.length, EAGER_PAGES, `the keystroke answered with pages ${answered.join(',')}`);
      assert.deepEqual(answered, Array.from({ length: EAGER_PAGES }, (_, i) => answered[0] + i), 'the page edited and the ones right after it');
      assert.equal(engine.owedPaging, true, 'the others are on their way');

      // a keystroke while pages are owed: its own page, nothing else
      const second = await engine.edit(at, at, 'Z');
      lastRev = Math.max(lastRev, second.rev);
      take(second.patches);
      assert.deepEqual(second.patches.filter((patch) => patch.type === 'replace-page').map((patch) => patch.page), [answered[0]]);

      await drain(engine, 120_000);
      assert.equal(engine.owedPaging, false);
      assert.ok(events.length >= 2, `${events.length} events brought the other pages`);
      // …once the typing had paused, not between the keys
      assert.ok(sinceKey.every((ms) => ms >= 250), `events came ${sinceKey.join(', ')} ms after the last keystroke`);
      assert.ok(events.every((pages) => pages.length <= EAGER_PAGES), JSON.stringify(events));
      const followed = new Set(events.flat());
      for (let n = answered.at(-1) + 1; n <= engine.pages.length; n++) assert.ok(followed.has(n), `page ${n} followed`);
      // every page as a viewer holds it is the page the engine has…
      const now = engine.getDisplayLists();
      assert.equal(held.size, now.length);
      for (const list of now) assert.equal(JSON.stringify(held.get(list.page)), JSON.stringify(list), `page ${list.page}`);
      // …and the page a fresh engine makes of the same text
      const source = engine.getSource();
      await engine.close();
      const fresh = new CheckpointEngine({ workDir: path.join(root, 'fresh') });
      fresh.canonical.schedule = () => {};
      try {
        await fresh.open(source);
        await drain(fresh, 120_000);
        const want = fresh.getDisplayLists();
        assert.equal(now.length, want.length);
        for (let i = 0; i < want.length; i++) assert.equal(lines(held.get(i + 1)), lines(want[i]), `the lines of page ${i + 1}`);
      } finally {
        await fresh.close();
      }
    } finally {
      await engine.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
