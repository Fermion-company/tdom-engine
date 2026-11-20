// \subfile{dir/chapter} (subfiles.sty) reads a chapter that is also a
// document of its own. In the main document only the text between the
// chapter's \begin{document} and \end{document} is typeset, inside a group,
// with the chapter's folder first on the input and graphics paths (the
// package does this with \subimport). The engine expands the chapter into
// ordinary blocks; the first and last block carry the group and the paths.

/** Offsets of the chapter body: after the first \begin{document}, before the
 * last \end{document}. A commented-out line never counts; a complete
 * document printed inside the chapter as an example lies between the two. */
export function documentBodyRange(text) {
  const begin = /^[^%\n]*?\\begin\s*\{document\}/m.exec(text);
  if (!begin) return null;
  const start = begin.index + begin[0].length;
  let end = -1;
  for (const match of text.matchAll(/^([^%\n]*?)\\end\s*\{document\}/gm)) {
    const at = match.index + match[1].length;
    if (at >= start) end = at;
  }
  return end >= start ? { start, end } : { start, end: text.length };
}

// A folder name TeX would misread goes without the path entry: the group
// still opens and closes, and files are found through the project root.
const texSafe = (dir) => typeof dir === 'string' && dir !== '' && !/[\\%#{}~^&$\s]/.test(dir);

/** The paths \subimport sets for the body of a chapter in `dir`. */
export function importPathTeX(dir) {
  if (!texSafe(dir)) return '';
  return '\\makeatletter' +
    `\\protected@xdef\\import@path{${dir}}` +
    '\\protected@edef\\input@path{{\\import@path}\\@ifundefined{input@path}{}{\\input@path}}' +
    '\\protected@edef\\Ginput@path{{\\import@path}\\@ifundefined{Ginput@path}{}{\\Ginput@path}}' +
    '\\makeatother ';
}

/** \subfile's \begingroup and the paths of a chapter in `dir`. */
export function subfileGroupOpen(dir) {
  return '\\begingroup\\makeatletter\\ifdefined\\import@path\\let\\tdom@sf@old\\import@path' +
    '\\else\\let\\tdom@sf@old\\@empty\\let\\import@path\\@empty\\fi\\makeatother ' +
    importPathTeX(dir);
}

/** Restore the global path and close the chapter's group. */
export function subfileGroupClose() {
  return '\\makeatletter\\global\\let\\import@path\\tdom@sf@old\\makeatother\\endgroup ';
}

/** Before the chapter's first block (block-flag form). */
export function subfileOpenTeX(block) {
  return block?.subfileStart ? subfileGroupOpen(block.importDir) : '';
}

/** After the chapter's last block: restore the global path, close the group. */
export function subfileCloseTeX(block) {
  return block?.subfileEnd ? '\n' + subfileGroupClose() : '';
}
