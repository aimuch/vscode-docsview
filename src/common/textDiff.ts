// Pure, zero-dependency LCS line & word diff engine used by:
// - AI Assistant inline Before/After diff preview
// - Word (.docx) & PowerPoint (.pptx) version diff viewer

export interface DiffSpan {
  kind: 'same' | 'add' | 'del';
  text: string;
}

function lcsDiff<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is): { kind: 'same' | 'add' | 'del'; value: T }[] {
  // Trim common prefix & suffix first for O(1) memory on largely unchanged texts.
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && eq(a[start], b[start])) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }

  const out: { kind: 'same' | 'add' | 'del'; value: T }[] = [];
  for (let i = 0; i < start; i++) {
    out.push({ kind: 'same', value: a[i] });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  // Guard against O(N*M) blowup on gigantic completely different inputs.
  if (n * m > 400_000) {
    for (const v of midA) out.push({ kind: 'del', value: v });
    for (const v of midB) out.push({ kind: 'add', value: v });
  } else if (n > 0 && m > 0) {
    const dp = new Int32Array((n + 1) * (m + 1));
    const stride = m + 1;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (eq(midA[i], midB[j])) {
          dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * stride + j];
          const right = dp[i * stride + (j + 1)];
          dp[i * stride + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (eq(midA[i], midB[j])) {
        out.push({ kind: 'same', value: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
        out.push({ kind: 'del', value: midA[i] });
        i++;
      } else {
        out.push({ kind: 'add', value: midB[j] });
        j++;
      }
    }
    while (i < n) out.push({ kind: 'del', value: midA[i++] });
    while (j < m) out.push({ kind: 'add', value: midB[j++] });
  } else {
    for (const v of midA) out.push({ kind: 'del', value: v });
    for (const v of midB) out.push({ kind: 'add', value: v });
  }

  for (let i = endA; i < a.length; i++) {
    out.push({ kind: 'same', value: a[i] });
  }
  return out;
}

function tokenizeForInlineDiff(text: string): string[] {
  // Split into CJK single chars, Latin/number words, whitespace runs, or punctuation.
  const tokens: string[] = [];
  const re = /[\u3400-\u9fff\uf900-\ufaff]|[A-Za-z0-9_'-]+|\s+|[^\sA-Za-z0-9_'\-\u3400-\u9fff\uf900-\ufaff]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

function mergeSpans(raw: { kind: 'same' | 'add' | 'del'; value: string }[]): DiffSpan[] {
  const out: DiffSpan[] = [];
  for (const item of raw) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === item.kind) {
      prev.text += item.value;
    } else {
      out.push({ kind: item.kind, text: item.value });
    }
  }
  return out;
}

/** Inline word/character diff suitable for highlighting AI text rewrites. */
export function diffInlineText(before: string, after: string): DiffSpan[] {
  if (before === after) {
    return before ? [{ kind: 'same', text: before }] : [];
  }
  const tokA = tokenizeForInlineDiff(before);
  const tokB = tokenizeForInlineDiff(after);
  return mergeSpans(lcsDiff(tokA, tokB));
}

export interface LineDiffItem {
  kind: 'same' | 'add' | 'del';
  text: string;
  oldIndex?: number;
  newIndex?: number;
}

/** Line/paragraph diff suitable for comparing versions of DOCX / PPTX / Markdown documents. */
export function diffLineArrays(before: readonly string[], after: readonly string[]): LineDiffItem[] {
  const raw = lcsDiff(before, after);
  let oldIdx = 1;
  let newIdx = 1;
  return raw.map((item) => {
    if (item.kind === 'same') {
      return { kind: 'same', text: item.value, oldIndex: oldIdx++, newIndex: newIdx++ };
    }
    if (item.kind === 'del') {
      return { kind: 'del', text: item.value, oldIndex: oldIdx++ };
    }
    return { kind: 'add', text: item.value, newIndex: newIdx++ };
  });
}
