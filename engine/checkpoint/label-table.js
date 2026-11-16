/**
 * The labels of the resident document: key -> value, as blocks define them
 * (`\label`, `\bibitem`). It also remembers every key it has ever held.
 *
 * A JOB clears a reference whose label is gone from the table, because the
 * lineage it forks may still carry the definition a deleted `\label` left
 * behind (job-body.js). A key the table never held is not such a leftover:
 * the document defines it by other means, and clearing it turned every such
 * reference into ?? whenever its paragraph was typeset again. Those means
 * are xr's \externaldocument, \newlabel lines read from a file, and the
 * chapter window of a long document, whose other chapters are empty and
 * whose labels come from the last Build.
 */
export class LabelTable extends Map {
  constructor(entries) {
    super();
    this.ever = new Set();
    for (const [key, value] of entries ?? []) this.set(key, value);
  }

  set(key, value) {
    this.ever.add(key);
    return super.set(key, value);
  }
}
