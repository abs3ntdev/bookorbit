import { CfiNode, getDocumentElement, isElementNode, isTextNode, RangePoint } from '../position-converter/cfi.utils';

// Mirrors CrossPoint's VisibleTextUtils::isNonVisibleElement.
const NON_VISIBLE = new Set(['head', 'style', 'script', 'title', 'rp']);

interface VisibleTextNode {
  node: CfiNode;
  start: number;
  length: number;
}

/**
 * CrossPoint's chapter-visible offsets: Unicode code points of every character in the body,
 * whitespace included, outside non-visible elements. Maps them to DOM points and back.
 */
export class VisibleTextMap {
  private readonly nodes: VisibleTextNode[] = [];
  readonly length: number;

  constructor(root: CfiNode) {
    const documentElement = getDocumentElement(root);
    const body = (documentElement?.children ?? []).find((child) => isElementNode(child) && child.name?.toLowerCase() === 'body');
    let total = 0;
    const walk = (node: CfiNode) => {
      for (const child of node.children ?? []) {
        if (isTextNode(child)) {
          const length = Array.from(child.data ?? '').length;
          if (length > 0) this.nodes.push({ node: child, start: total, length });
          total += length;
        } else if (isElementNode(child) && !NON_VISIBLE.has((child.name ?? '').toLowerCase())) {
          walk(child);
        }
      }
    };
    if (body) walk(body);
    this.length = total;
  }

  /** DOM point for a code point offset; `end` resolves a boundary to the preceding node. */
  pointAt(offset: number, end: boolean): RangePoint | null {
    if (offset < 0 || offset > this.length) return null;
    const entry = end
      ? this.nodes.find((n) => offset > n.start && offset <= n.start + n.length)
      : this.nodes.find((n) => offset >= n.start && offset < n.start + n.length);
    if (!entry) return null;
    const prefix = Array.from(entry.node.data ?? '')
      .slice(0, offset - entry.start)
      .join('');
    return { node: entry.node, offset: prefix.length };
  }

  offsetOf(node: CfiNode, utf16Offset: number): number | null {
    const entry = this.nodes.find((n) => n.node === node);
    if (!entry) return null;
    return entry.start + Array.from((entry.node.data ?? '').slice(0, utf16Offset)).length;
  }

  text(start: number, end: number): string {
    let out = '';
    for (const entry of this.nodes) {
      if (entry.start + entry.length <= start || entry.start >= end) continue;
      const chars = Array.from(entry.node.data ?? '');
      out += chars.slice(Math.max(0, start - entry.start), end - entry.start).join('');
    }
    return out;
  }

  /** First occurrence of the text, compared with whitespace collapsed on both sides. */
  find(quote: string): { start: number; end: number } | null {
    const target = quote.replace(/\s+/g, ' ').trim();
    if (!target) return null;
    const chars: string[] = [];
    const offsets: number[] = [];
    let lastSpace = true;
    for (const entry of this.nodes) {
      Array.from(entry.node.data ?? '').forEach((ch, i) => {
        const space = /\s/.test(ch);
        if (space && lastSpace) return;
        chars.push(space ? ' ' : ch);
        offsets.push(entry.start + i);
        lastSpace = space;
      });
    }
    const haystack = chars.join('');
    const index = haystack.indexOf(target);
    if (index < 0) return null;
    const startCp = Array.from(haystack.slice(0, index)).length;
    const endCp = startCp + Array.from(target).length;
    return { start: offsets[startCp], end: offsets[endCp - 1] + 1 };
  }
}
