# AGENTS.md — working guide for coding agents in this repo

TDOM is a real-time LaTeX preview engine: a resident, fork-checkpointed
`lualatex` answers keystrokes in milliseconds (the "provisional" layer) while
a full `lualatex` compile is the authority (the "canonical" layer). Read
`docs/00-first-read.md` then `docs/02-overview.md`, `docs/03-checkpoint-engine.md`,
`docs/10-edit-hot-path.md` before changing engine code.

## Machine safety — NOT optional

Development happens on a **16GB machine shared with other apps**. The engine
forks resident `lualatex` processes; running it carelessly has OOM-killed
this machine to unusability several times.

- **Always** `export TDOM_MAX_CHECKPOINTS=8` before running anything that
  boots the engine.
- **NEVER** run `npm test` (full suite), `npm run fuzz`, `npm run bench`, or
  start the server (`node server.js`) locally, and never boot more than one
  engine at once — they OOM the box. The deep nets run on GitHub Actions
  (`.github/workflows/audit.yml`) after you push; let CI do them.
- Local verification is ONLY these two (both stay bounded ~1.5GB):
  ```
  TDOM_MAX_CHECKPOINTS=8 node --test tests/hot-path.test.js   # expect 11/11
  TDOM_MAX_CHECKPOINTS=8 npm run farm                         # expect 298/298
  ```
- If `ps aux | grep -c '[l]ualatex'` climbs past ~30, STOP and
  `pkill -9 lualatex`.

## Workflow

- One logical change per commit; run the two local checks above after each;
  commit only when both are green; push and confirm CI (`audit.yml`) stays
  green before the next risky step.
- `docs/` is an IMPLEMENTATION MAP only — describe what the code does now,
  never put plans/roadmaps/targets there. Planning lives in the maintainer's
  notes, not the repo.
- Match existing comment density and style. Comments state constraints the
  code can't show, not narration.

## The hot-path core — do NOT restructure

These methods in `engine/checkpoint/engine-v3.js` form the edit hot-path and
its single-async-lock discipline. Behavior depends on exact ordering and
shared mutable state. Do not move, reorder, or "clean up" them:
`#locked`, `#update`, `#updateInner` (the bounded foreground walk), the
checkpoint-rekey block, `bgAbort` preemption, `#jobBlock`, `#typesetBlock`,
`#adoptGalley`, `#runChainPass`, `#chainAfterPass`, `#enforceCheckpointCap`,
`#reapDying`, `#retireOffGrid`, `#nearestCheckpoint`, `#retypesetChain`, the
iso/rescue subsystem (`#isoCompile` execution, `#rescueBlock`,
`#pumpRescues`, `#asyncRescueOne`), the RENDER tier, and the canonical
crop/verify passes.

---

## CURRENT TASK (2026-07-08): split the monolith by function

`engine/checkpoint/engine-v3.js` is ~5000 lines. Split it into per-function
modules so an LLM can work on one concern at a time. This is **pure code
motion — do not change runtime behavior at all.** The two local checks above
(hot-path 11/11, farm 298/298) must pass identically after EVERY commit; if
either regresses, the commit is wrong — revert and take a smaller step.

Extract in this order, ONE module per commit. STOP at the marked line.

1. **Pure top-level helper functions** (no `this`) → `engine/checkpoint/util/`:
   - `util/svg.js`: `cropSvg`, `cropSvgAt`, `r2`
   - `util/tex.js`: `luaStr`, `braceImbalance`, `labelDefBody`, `extractBraced`,
     `startsVertical`, `startsAddvspace`, `scanCounterDefs`, `formatFolio`,
     `texErrorFrom`
   - `util/galley.js`: `walkItemRuns`, `parseVec`, `vecCountersEqual`,
     `vecLocalsEqual`, `sameUnitSeq`, `push2`, `resolvedInGalley`,
     `stableFontKey`
   - `util/fs.js`: `waitForPdf`, `resolveFont`
   Move verbatim, import back, keep signatures identical. One commit each.

2. **`Peer` and `Timer` classes** → `engine/checkpoint/peer.js`,
   `engine/checkpoint/timer.js`. Self-contained (`Peer(sock, engine)`).
   One commit each.

3. **Display-list stream builder**: `buildStream(block, chunks)` + `miniUnits`
   → `engine/checkpoint/stream.js` (pure given their args). One commit.

4. **TeX source templates** → `engine/checkpoint/tex-templates.js`: extract the
   STRING BUILDING (not the process exec/adopt) from `#driverSource`,
   `#stateJobBody`, `#volatilePrelude`, and the `.tex`-assembly part of
   `#isoCompile` as pure functions taking every `this.x` they read as an
   explicit param. The class methods become thin wrappers. Snapshot one
   generated string before/after to confirm byte-identical output.
   One commit per builder.

### ===== STOP HERE — do not go past step 4 without maintainer approval =====

Everything below step 4 (the hot-path core listed above) is off-limits. The
goal is to shrink the file by pulling out stateless leaves and the two helper
classes, NOT to re-architect the core.

**Done when:** `engine-v3.js` is materially smaller, every commit kept
hot-path 11/11 and farm 298/298, CI is green, and no hot-path/lock-discipline
line changed behavior. Report the before/after line count and the new module
list.
