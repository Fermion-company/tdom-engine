import path from 'node:path';

/**
 * Whether every input an update changes is another file than the one holding
 * the block a background walk (caret warm, cold walk, grid fill) is heading
 * for (docs/10 §10.4a). Such a walk does nothing for the edit, so the edit
 * need not wait for its in-flight block. Unknown inputs count as the same
 * file; blocks of the root file carry no `file`.
 */
export function editElsewhereThanWalk({ blocks, target, rootFile, editContext = null, projectInputChanges = null }) {
  if (!Number.isInteger(target) || !blocks?.[target]) return false;
  if (projectInputChanges?.unknown === true) return false;
  const walkFile = blocks[target].file ?? rootFile;
  const files = [
    ...(editContext?.file ? [editContext.file] : []),
    ...(projectInputChanges?.changed ?? []),
    ...(projectInputChanges?.removed ?? []),
  ];
  if (!walkFile || !files.length) return false;
  const walkPath = path.resolve(walkFile);
  return files.every((file) => path.resolve(file) !== walkPath);
}

/**
 * Whether killing a background walk's in-flight step saves the waiting edit
 * more than the walk loses (docs/10 §10.4a). What is lost is the replay since
 * the walk's last retained boundary, which a later walk must repeat: under
 * `minMs` a kill is always cheap (a caret warm's step reopens fonts and runs
 * far past the block's intrinsic cost, so its remaining time is not
 * estimable). Otherwise the step's expected remaining time must outweigh it,
 * both at measured replay speed, about twice the intrinsic (minimum) cost.
 */
export function walkKillPaysOff({ blocks, jobIdx, jobElapsedMs, retainedIdx, minMs = 150 }) {
  const replayMs = (k) => 2 * (Number(blocks?.[k]?.typesetCostMs) || 0);
  if (!Number.isInteger(jobIdx) || jobIdx < 0 || !Number.isFinite(jobElapsedMs)) return false;
  let lost = Math.max(0, jobElapsedMs);
  for (let k = Math.max(0, Number.isInteger(retainedIdx) ? retainedIdx : jobIdx); k < jobIdx; k++) lost += replayMs(k);
  if (lost < minMs) return true;
  const remaining = replayMs(jobIdx) - jobElapsedMs;
  return remaining > minMs && remaining > lost;
}

