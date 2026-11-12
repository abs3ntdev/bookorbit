import { parseChapterDocument } from '../position-converter/position-converter.core';
import { VisibleTextMap } from './crosspoint-visible-text';

const XHTML =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ignored</title><style>p{}</style></head><body><p>Hello <em>brave</em> new world.</p><p>Caf\u00e9 \u{1F600} end</p></body></html>';

describe('VisibleTextMap', () => {
  const map = new VisibleTextMap(parseChapterDocument(XHTML).root);

  it('counts body code points and skips non-visible elements', () => {
    expect(map.text(0, map.length)).toBe('Hello brave new world.Caf\u00e9 \u{1F600} end');
    expect(map.length).toBe(Array.from('Hello brave new world.Caf\u00e9 \u{1F600} end').length);
  });

  it('round-trips offsets through DOM points across inline elements', () => {
    const start = map.pointAt(6, false)!;
    const end = map.pointAt(11, true)!;
    expect(start.node.data).toBe('brave');
    expect(start.offset).toBe(0);
    expect(end.node).toBe(start.node);
    expect(end.offset).toBe(5);
    expect(map.offsetOf(start.node, start.offset)).toBe(6);
    expect(map.offsetOf(end.node, end.offset)).toBe(11);
  });

  it('maps code points after an astral character to the right UTF-16 offset', () => {
    const point = map.pointAt(29, false)!;
    expect(point.node.data!.slice(point.offset)).toBe('end');
    expect(map.offsetOf(point.node, point.offset)).toBe(29);
  });

  it('finds a quote with collapsed whitespace', () => {
    expect(map.find('brave  new\nworld')).toEqual({ start: 6, end: 21 });
    expect(map.find('missing')).toBeNull();
  });
});
