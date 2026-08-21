(function installOpaqueEditorCoordinator(root) {
  const MATH_PRINT_ALIASES = new Map([
    ['√', '\\sqrt'], ['∞', '\\infty'], ['∫', '\\int'], ['∑', '\\sum'], ['∏', '\\prod'],
    ['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'],
    ['θ', '\\theta'], ['λ', '\\lambda'], ['μ', '\\mu'], ['π', '\\pi'], ['σ', '\\sigma'],
    ['φ', '\\phi'], ['ω', '\\omega'], ['Γ', '\\Gamma'], ['Δ', '\\Delta'],
    ['Θ', '\\Theta'], ['Λ', '\\Lambda'], ['Π', '\\Pi'], ['Σ', '\\Sigma'],
    ['Φ', '\\Phi'], ['Ω', '\\Omega'], ['≤', '\\le'], ['≥', '\\ge'],
    ['≠', '\\ne'], ['×', '\\times'], ['±', '\\pm'], ['∂', '\\partial'],
  ]);

  const normalizedPrintedToken = (value) =>
    String(value ?? '').normalize('NFKC').replace(/\s+/gu, '');

  function sourceTokenOccurrences(source, token) {
    const hits = [];
    const controlWord = /^\\[A-Za-z]+$/.test(token);
    const plainLetters = /^[A-Za-z]+$/.test(token);
    for (let at = source.indexOf(token); at >= 0;
      at = source.indexOf(token, at + Math.max(1, token.length))) {
      if (controlWord && /[A-Za-z]/.test(source[at + token.length] ?? '')) continue;
      if (plainLetters) {
        let wordStart = at;
        while (wordStart > 0 && /[A-Za-z]/.test(source[wordStart - 1])) wordStart--;
        let slashRun = 0;
        while (source[wordStart - slashRun - 1] === '\\') slashRun++;
        if (slashRun % 2 === 1) continue;
      }
      hits.push(at);
    }
    return hits;
  }

  function samePrintedWord(left, right) {
    return normalizedPrintedToken(left?.text) === normalizedPrintedToken(right?.text) &&
      Math.abs(Number(left?.left) - Number(right?.left)) < 0.05 &&
      Math.abs(Number(left?.top) - Number(right?.top)) < 0.05 &&
      Math.abs(Number(left?.right) - Number(right?.right)) < 0.05 &&
      Math.abs(Number(left?.bottom) - Number(right?.bottom)) < 0.05;
  }

  function hasUnescapedScriptOperator(source, start, end) {
    for (let index = start; index < end; index++) {
      if (source[index] !== '^' && source[index] !== '_') continue;
      let slashRun = 0;
      while (source[index - slashRun - 1] === '\\') slashRun++;
      if (slashRun % 2 === 0) return true;
    }
    return false;
  }

  function geometricReadingRows(words) {
    const pending = words.map((word, sourceIndex) => ({ word, sourceIndex }))
      .filter(({ word }) => [word?.left, word?.top, word?.right, word?.bottom]
        .map(Number).every(Number.isFinite))
      .sort((a, b) => {
        const ay = (Number(a.word.top) + Number(a.word.bottom)) / 2;
        const by = (Number(b.word.top) + Number(b.word.bottom)) / 2;
        return ay - by || Number(a.word.left) - Number(b.word.left) || a.sourceIndex - b.sourceIndex;
      });
    const rows = [];
    for (const item of pending) {
      const center = (Number(item.word.top) + Number(item.word.bottom)) / 2;
      const height = Math.max(1, Number(item.word.bottom) - Number(item.word.top));
      const row = rows.at(-1);
      const tolerance = row ? Math.max(1, Math.min(row.height, height) * 0.6) : 0;
      if (!row || Math.abs(center - row.center) > tolerance) {
        rows.push({ center, height, items: [item] });
      } else {
        row.items.push(item);
        const count = row.items.length;
        row.center = (row.center * (count - 1) + center) / count;
        row.height = Math.min(row.height, height);
      }
    }
    return rows.map((row) => row.items.sort((a, b) =>
      Number(a.word.left) - Number(b.word.left) ||
      Number(a.word.top) - Number(b.word.top) || a.sourceIndex - b.sourceIndex
    ).map(({ word }) => word));
  }

  function finiteSourcePosition(position) {
    const line = Number(position?.line);
    const column = Number(position?.column);
    return Number.isInteger(line) && line > 0 && Number.isInteger(column) && column > 0;
  }

  function finitePrintedBox(value) {
    const page = Number(value?.page);
    const box = value?.box ?? value;
    const left = Number(box?.left);
    const top = Number(box?.top);
    const right = Number(box?.right);
    const bottom = Number(box?.bottom);
    if (!Number.isInteger(page) || page < 1 ||
        ![left, top, right, bottom].every(Number.isFinite) ||
        !(right > left) || !(bottom > top)) return null;
    return { page, left, top, right, bottom };
  }

  function pointBoxDistance(box, point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (![x, y].every(Number.isFinite)) return Infinity;
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    return dx * dx + dy * dy;
  }

  class OpaqueEditorCoordinator {
    static planGenerationBarrier({
      pageNumber,
      pageConnected,
      targetSrc,
      wantedSrc = null,
      expectedSrc = null,
      expectedReady = false,
      presentedSrc = null,
      presentedId = null,
      presentedRev = null,
      generationId = null,
      generationRev = null,
    } = {}) {
      const page = Number(pageNumber);
      if (!Number.isInteger(page) || page < 1 || pageConnected !== true || !targetSrc) {
        return { action: 'close' };
      }

      const id = Number(generationId);
      const rev = Number(generationRev);
      if (expectedSrc === targetSrc) {
        return {
          action: expectedReady === true ? 'ready' : 'wait',
          pageNumber: page,
          targetSrc,
        };
      }
      const alreadyPresented = presentedSrc === targetSrc && wantedSrc === targetSrc &&
        Number.isFinite(id) && Number(presentedId) === id &&
        Number.isFinite(rev) && Number(presentedRev) === rev;
      if (alreadyPresented) return { action: 'register', pageNumber: page, targetSrc };
      return { action: 'stage', pageNumber: page, targetSrc };
    }

    static sourceProbeLocations(region, maxInteriorProbes = 48) {
      const source = region?.source;
      if (!source?.file || !finiteSourcePosition(source.start) || !finiteSourcePosition(source.end)) {
        return [];
      }
      const locations = [];
      const seen = new Set();
      const add = (position) => {
        if (!finiteSourcePosition(position)) return;
        const location = {
          file: source.file,
          line: Number(position.line),
          column: Number(position.column),
        };
        const key = `${location.line}:${location.column}`;
        if (seen.has(key)) return;
        seen.add(key);
        locations.push(location);
      };
      add(source.start);

      // Math environments expose content spans whose first/last source
      // positions are commonly the newline after `\\begin{...}` and the
      // `\\end{...}` line. SyncTeX maps those structural boundaries to the
      // preceding paragraph or the whole column, not to the printed formula.
      // Probe actual non-blank content lines as well. The cap keeps a huge
      // align/table environment from producing an unbounded request while an
      // even sample still covers its full vertical extent.
      const sourceValue = String(region.sourceValue ?? region.value ?? '');
      const interior = sourceValue.split(/\r?\n/).flatMap((lineText, index) => {
        const first = lineText.search(/\S/u);
        if (first < 0) return [];
        return [{
          file: source.file,
          line: Number(source.start.line) + index,
          column: (index === 0 ? Number(source.start.column) : 1) + first,
        }];
      });
      const limit = Math.max(1, Math.floor(Number(maxInteriorProbes) || 48));
      if (interior.length <= limit) {
        for (const position of interior) add(position);
      } else {
        for (let index = 0; index < limit; index++) {
          add(interior[Math.round((index * (interior.length - 1)) / (limit - 1 || 1))]);
        }
      }
      add(source.end);
      return locations;
    }

    static selectSourceBounds({ results = [], pageNumber = null, near = null } = {}) {
      const unique = new Map();
      for (const result of results) {
        const box = finitePrintedBox(result);
        if (!box) continue;
        const key = [box.page, box.left, box.top, box.right, box.bottom]
          .map((value) => Number(value).toFixed(3)).join(':');
        if (!unique.has(key)) unique.set(key, box);
      }
      const boxes = [...unique.values()];
      const requestedPage = Number.isInteger(Number(pageNumber))
        ? Number(pageNumber)
        : Number.isInteger(Number(near?.page)) ? Number(near.page) : null;
      const onPage = requestedPage == null ? boxes : boxes.filter((box) => box.page === requestedPage);
      const available = onPage.length ? onPage : Number.isInteger(Number(pageNumber)) ? [] : boxes;
      if (!available.length) return null;

      if (Number.isFinite(Number(near?.x)) && Number.isFinite(Number(near?.y))) {
        const containing = available.filter((box) => pointBoxDistance(box, near) === 0)
          .sort((a, b) => {
            const aa = (a.right - a.left) * (a.bottom - a.top);
            const ba = (b.right - b.left) * (b.bottom - b.top);
            return aa - ba;
          });
        if (containing.length) {
          // SyncTeX normally gives a hierarchy (glyph/row/formula/column).
          // The lower median keeps a useful formula/row extent while rejecting
          // both a single-glyph sliver and the unrelated whole-column box.
          return containing[Math.floor((containing.length - 1) / 2)];
        }
        return available.sort((a, b) => {
          const distance = pointBoxDistance(a, near) - pointBoxDistance(b, near);
          if (distance) return distance;
          return (a.right - a.left) * (a.bottom - a.top) -
            (b.right - b.left) * (b.bottom - b.top);
        })[0];
      }
      return available.sort((a, b) =>
        (a.right - a.left) * (a.bottom - a.top) -
        (b.right - b.left) * (b.bottom - b.top)
      )[0];
    }

    static mathSourceOffset({ value, clickedWord, words = [], bounds = null, point = null } = {}) {
      const source = String(value ?? '');
      if (!source) return 0;
      const printed = normalizedPrintedToken(clickedWord?.text);
      if (!printed) return null;
      const alias = MATH_PRINT_ALIASES.get(printed);
      // A PDF "word" can contain several proportional glyphs but exposes no
      // internal advances. Only a single printed glyph (or a known one-glyph
      // TeX command) has an exact before/after source boundary.
      if (!alias && [...printed].length !== 1) return null;
      const token = alias ?? printed;
      const hits = sourceTokenOccurrences(source, token);
      if (!hits.length) return null;

      let hitIndex = 0;
      if (hits.length > 1) {
        if (!bounds || !Array.isArray(words)) return null;
        if (hasUnescapedScriptOperator(source, hits[0], hits.at(-1) + token.length)) return null;
        const boundedWords = words.filter((word) => {
          const x = (Number(word.left) + Number(word.right)) / 2;
          const y = (Number(word.top) + Number(word.bottom)) / 2;
          return [x, y].every(Number.isFinite) &&
            x >= Number(bounds.left) - 1 && x <= Number(bounds.right) + 1 &&
            y >= Number(bounds.top) - 1 && y <= Number(bounds.bottom) + 1;
        });
        const readingRows = geometricReadingRows(boundedWords);
        const matchingWords = readingRows.flat()
          .filter((word) => normalizedPrintedToken(word?.text) === printed);
        const matchingRowCount = readingRows.filter((row) =>
          row.some((word) => normalizedPrintedToken(word?.text) === printed)
        ).length;
        if (matchingRowCount > 1) {
          const simpleFraction = /^\s*\\(?:dfrac|tfrac|frac)\s*\{[^{}]*\}\s*\{[^{}]*\}\s*$/.test(source);
          const rowStructured = /\\begin\{(?:[pbBvV]?matrix|smallmatrix|array|cases|aligned|alignedat|gathered|split)\}/.test(source) ||
            source.includes('\\\\');
          const unsafeVerticalNesting = /\\(?:dfrac|tfrac|frac|binom|overset|underset|substack)\b/.test(source);
          if (!simpleFraction && (!rowStructured || unsafeVerticalNesting)) return null;
        }
        // PDF extraction commonly emits matrices in column order. Rebuild a
        // deterministic visual row order, then require a one-to-one source
        // occurrence mapping. Scripts are rejected above because their
        // visual vertical order is not their TeX lexical order.
        if (matchingWords.length !== hits.length) return null;
        hitIndex = matchingWords.findIndex((word) => word === clickedWord || samePrintedWord(word, clickedWord));
        if (hitIndex < 0) return null;
      }

      const at = hits[hitIndex];
      const wordBox = clickedWord &&
        Number.isFinite(Number(clickedWord.left)) && Number.isFinite(Number(clickedWord.right))
        ? clickedWord
        : bounds;
      if (!wordBox || !Number.isFinite(Number(point?.x))) return null;
      return Number(point.x) < (Number(wordBox.left) + Number(wordBox.right)) / 2
        ? at
        : at + token.length;
    }

    static paperPoint({ clientX, clientY, pageRect, paper } = {}) {
      const x = Number(clientX);
      const y = Number(clientY);
      const left = Number(pageRect?.left);
      const top = Number(pageRect?.top);
      const width = Number(pageRect?.width);
      const height = Number(pageRect?.height);
      const paperWidth = Number(paper?.width ?? paper?.w);
      const paperHeight = Number(paper?.height ?? paper?.h);
      if (![x, y, left, top].every(Number.isFinite) ||
          !(width > 0 && height > 0 && paperWidth > 0 && paperHeight > 0)) return null;
      return {
        x: ((x - left) / width) * paperWidth,
        y: ((y - top) / height) * paperHeight,
      };
    }

    static clientBounds({ bounds, pageRect, paper } = {}) {
      const left = Number(pageRect?.left);
      const top = Number(pageRect?.top);
      const width = Number(pageRect?.width);
      const height = Number(pageRect?.height);
      const paperWidth = Number(paper?.width ?? paper?.w);
      const paperHeight = Number(paper?.height ?? paper?.h);
      const box = ['left', 'top', 'right', 'bottom'].map((key) => Number(bounds?.[key]));
      if (![left, top, ...box].every(Number.isFinite) ||
          !(width > 0 && height > 0 && paperWidth > 0 && paperHeight > 0)) return null;
      return {
        left: left + (box[0] / paperWidth) * width,
        top: top + (box[1] / paperHeight) * height,
        right: left + (box[2] / paperWidth) * width,
        bottom: top + (box[3] / paperHeight) * height,
      };
    }

    static caretAnchorRatio(bounds, point) {
      const width = Number(bounds?.right) - Number(bounds?.left);
      const height = Number(bounds?.bottom) - Number(bounds?.top);
      if (!(width > 0 && height > 0) ||
          !Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) return null;
      return {
        x: Math.max(0, Math.min(1, (Number(point.x) - Number(bounds.left)) / width)),
        y: Math.max(0, Math.min(1, (Number(point.y) - Number(bounds.top)) / height)),
      };
    }

    static caretAnchorPoint(bounds, ratio) {
      const width = Number(bounds?.right) - Number(bounds?.left);
      const height = Number(bounds?.bottom) - Number(bounds?.top);
      if (!(width > 0 && height > 0) ||
          !Number.isFinite(Number(ratio?.x)) || !Number.isFinite(Number(ratio?.y))) return null;
      return {
        x: Number(bounds.left) + Math.max(0, Math.min(1, Number(ratio.x))) * width,
        y: Number(bounds.top) + Math.max(0, Math.min(1, Number(ratio.y))) * height,
      };
    }

    static overlayOffset({
      pageRect,
      shellLeft = 0,
      shellTop = 0,
      anchor,
      gap = 0,
      panelRect = null,
      viewportRect = null,
      margin = 8,
    } = {}) {
      const pageLeft = Number(pageRect?.left);
      const pageTop = Number(pageRect?.top);
      const x = Number(anchor?.x);
      const y = Number(anchor?.y);
      const left = Number(shellLeft);
      const top = Number(shellTop);
      const spacing = Number(gap);
      if (![pageLeft, pageTop, x, y, left, top, spacing].every(Number.isFinite)) return null;
      let clientLeft = x;
      let clientTop = y + spacing;
      const panelWidth = Number(panelRect?.width);
      const panelHeight = Number(panelRect?.height);
      const inset = Number.isFinite(Number(margin)) ? Math.max(0, Number(margin)) : 0;
      const pageRight = Number(pageRect?.right);
      const pageBottom = Number(pageRect?.bottom);
      const viewportLeft = Number(viewportRect?.left);
      const viewportTop = Number(viewportRect?.top);
      const viewportRight = Number(viewportRect?.right);
      const viewportBottom = Number(viewportRect?.bottom);
      const clipLeft = Math.max(
        pageLeft,
        Number.isFinite(viewportLeft) ? viewportLeft : pageLeft
      ) + inset;
      const clipTop = Math.max(
        pageTop,
        Number.isFinite(viewportTop) ? viewportTop : pageTop
      ) + inset;
      const clipRight = Math.min(
        Number.isFinite(pageRight) ? pageRight : Infinity,
        Number.isFinite(viewportRight) ? viewportRight : Infinity
      ) - inset;
      const clipBottom = Math.min(
        Number.isFinite(pageBottom) ? pageBottom : Infinity,
        Number.isFinite(viewportBottom) ? viewportBottom : Infinity
      ) - inset;
      if (panelWidth > 0 && Number.isFinite(clipRight) && clipRight >= clipLeft) {
        clientLeft = Math.max(clipLeft, Math.min(clientLeft, Math.max(clipLeft, clipRight - panelWidth)));
      }
      if (panelHeight > 0 && Number.isFinite(clipBottom) && clipBottom >= clipTop) {
        if (clientTop + panelHeight > clipBottom) {
          const above = y - spacing - panelHeight;
          clientTop = above >= clipTop
            ? above
            : Math.max(clipTop, Math.min(clientTop, Math.max(clipTop, clipBottom - panelHeight)));
        }
      }
      return {
        left: clientLeft - pageLeft - left,
        top: clientTop - pageTop - top,
      };
    }
  }

  root.TdomOpaqueEditorCoordinator = OpaqueEditorCoordinator;
})(typeof window === 'undefined' ? globalThis : window);
