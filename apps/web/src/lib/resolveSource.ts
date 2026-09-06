import type { FlatFile } from "@micracode/shared";

/**
 * Map a clicked preview element back to its source `file:line`, WITHOUT any
 * build-time stamping.
 *
 * Why not a Babel/SWC plugin (the usual `data-*` source-attr approach)? Verified
 * dead ends in this stack: Next 14 dev with SWC does not populate the React
 * fiber's `_debugSource`, and adding a `.babelrc` disables SWC — which breaks
 * `next/font` (the starter's Inter) and slows every generated app's dev build,
 * just to power a dev-only picker. So instead we search the project source the
 * host already holds in memory for the element the bridge described.
 *
 * The strong signal is the element's exact rendered Tailwind class string: for
 * static `className="…"` (what the codegen model overwhelmingly emits) the DOM
 * classList reproduces the source substring verbatim, pinning the element. Falls
 * back to visible-text anchoring, then to `undefined` (caller keeps today's
 * text-only prompt) when nothing matches confidently.
 *
 * ponytail: string search, not an AST. Ceiling — identical class string AND
 * identical text repeated across elements resolves to the first; upgrade to a
 * JSX-aware match only if repeated-component mis-picks show up in practice.
 */

export type SourceLoc = { path: string; line: number; column: number };
export type DomHint = { tag: string; classes: string[]; text: string };

const JSX_FILE = /\.[jt]sx$/;

/** 1-based line and 0-based column of a byte offset in `content`. */
function lineColAt(content: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

export function resolveSource(dom: DomHint, files: FlatFile[]): SourceLoc | undefined {
  const classStr = dom.classes.join(" ").trim();
  const text = dom.text.trim();
  const jsx = files.filter((f) => JSX_FILE.test(f.path));

  let best: { path: string; offset: number; score: number } | undefined;
  const consider = (path: string, offset: number, score: number) => {
    if (!best || score > best.score) best = { path, offset, score };
  };

  // Primary: the exact rendered class string appears verbatim in source.
  if (classStr) {
    for (const f of jsx) {
      let from = 0;
      let idx: number;
      while ((idx = f.content.indexOf(classStr, from)) !== -1) {
        // Break ties between repeated identical class strings by how closely the
        // element's own text follows the tag — the nearer, the more likely this
        // is the clicked element rather than a sibling with the same classes.
        const t = text ? f.content.indexOf(text, idx) : -1;
        consider(f.path, idx, 100 + (t !== -1 ? 100 / (1 + (t - idx)) : 0));
        from = idx + classStr.length;
      }
    }
  }

  // Secondary: dynamic classes (cn()/conditionals) — anchor on unique text.
  if (!best && text) {
    for (const f of jsx) {
      const idx = f.content.indexOf(text);
      if (idx !== -1) {
        consider(f.path, idx, 40);
        break;
      }
    }
  }

  if (!best) return undefined;

  const f = jsx.find((x) => x.path === best!.path)!;
  // Back up to the opening "<" on the same line so the location points at the
  // tag, not the className value.
  let i = best.offset;
  while (i > 0 && f.content[i] !== "<" && f.content[i - 1] !== "\n") i--;
  const at = f.content[i] === "<" ? i : best.offset;
  const { line, column } = lineColAt(f.content, at);
  return { path: best.path, line, column };
}
