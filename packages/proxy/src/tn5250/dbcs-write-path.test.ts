import { describe, it, expect, beforeAll, vi } from 'vitest';
import { TN5250Handler } from '../protocols/tn5250-handler.js';
import { TN5250Parser } from './parser.js';
import { TN5250Encoder } from './encoder.js';
import { ScreenBuffer, FieldDef } from './screen.js';
import { CMD } from './constants.js';
import {
  SI, SO, decodeDbcsPair, encodeDbcsPair, isDbcsGlyph,
} from '../encoding/ebcdic-jp.js';
import { registerBuiltinDbcsTable } from '../encoding/ebcdic-jp-builtin.js';

// F6 — the DBCS WRITE path. The parser has always read SO/SI-bracketed
// byte pairs into glyph + continuation cells; this suite pins the reverse
// direction: typed DBCS text must reach the wire as SO + byte pairs + SI,
// with total bytes === cell count, and host-painted DBCS field content
// must re-encode byte-identically (the SO/SI cells used to be stored as
// plain spaces, so every round trip silently sent 0x40s).
//
// Closure standard (no Japanese host available): wire-level round-trip —
// encoder output re-parsed by the package's own parser.

beforeAll(() => registerBuiltinDbcsTable());

const HIRA_A = 'あ'; // あ
const HIRA_I = 'い'; // い
const KATA_A = 'ア'; // ア

function ideographicField(
  row: number, col: number, length: number,
  kind: 'open' | 'either' | 'only' | 'data' | 'none' = 'open',
): FieldDef {
  const f: FieldDef = {
    row, col, length,
    ffw1: 0, ffw2: 0, fcw1: 0, fcw2: 0,
    attribute: 0x24, rawAttrByte: 0x24, modified: false,
  };
  if (kind === 'open') f.ideographicOpen = true;
  if (kind === 'either') f.ideographicEither = true;
  if (kind === 'only') f.ideographicOnly = true;
  if (kind === 'data') f.ideographicData = true;
  return f;
}

function handlerWithField(field: FieldDef) {
  const handler = new TN5250Handler();
  vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});
  handler.screen.fields.push(field);
  handler.screen.cursorRow = field.row;
  handler.screen.cursorCol = field.col;
  return handler;
}

/** Cells of a field as [char, cont, shift] triples for readable asserts. */
function cellsOf(screen: ScreenBuffer, field: FieldDef) {
  const start = screen.offset(field.row, field.col);
  const out: [string, boolean, number][] = [];
  for (let i = 0; i < field.length; i++) {
    out.push([screen.buffer[start + i], screen.dbcsCont[start + i], screen.dbcsShift[start + i]]);
  }
  return out;
}

describe('encodeDbcsPair — mirror of decode', () => {
  it('round-trips every builtin glyph: decode(encode(ch)) === ch', () => {
    for (const ch of [HIRA_A, HIRA_I, KATA_A, '、', 'ー']) {
      const pair = encodeDbcsPair(ch);
      expect(pair, `no pair for ${ch}`).not.toBeNull();
      const [b1, b2] = pair as [number, number];
      expect(decodeDbcsPair(b1, b2)).toBe(ch);
    }
  });

  it('full-width space is fixed at 0x4040', () => {
    expect(encodeDbcsPair('　')).toEqual([0x40, 0x40]);
    expect(isDbcsGlyph('　')).toBe(true);
  });

  it('SBCS characters have no pair', () => {
    expect(encodeDbcsPair('A')).toBeNull();
    expect(isDbcsGlyph('A')).toBe(false);
  });
});

describe('insertText — DBCS run creation and append', () => {
  it('first glyph in an open field creates the 4-cell SO+glyph+cont+SI run', () => {
    const f = ideographicField(4, 10, 8, 'open');
    const handler = handlerWithField(f);
    expect(handler.sendText(HIRA_A)).toBe(true);
    expect(cellsOf(handler.screen, f).slice(0, 4)).toEqual([
      [' ', false, 1],       // SO
      [HIRA_A, false, 0],    // glyph
      ['', true, 0],         // continuation
      [' ', false, 2],       // SI
    ]);
  });

  it('second glyph appends before the SI — one contiguous run, not two', () => {
    const f = ideographicField(4, 10, 8, 'open');
    const handler = handlerWithField(f);
    handler.sendText(HIRA_A + HIRA_I);
    expect(cellsOf(handler.screen, f).slice(0, 6)).toEqual([
      [' ', false, 1],
      [HIRA_A, false, 0],
      ['', true, 0],
      [HIRA_I, false, 0],
      ['', true, 0],
      [' ', false, 2],
    ]);
  });

  it('ideographic-only fields hold bare pairs, no SO/SI cells', () => {
    const f = ideographicField(4, 10, 6, 'only');
    const handler = handlerWithField(f);
    handler.sendText(HIRA_A + HIRA_I);
    expect(cellsOf(handler.screen, f).slice(0, 4)).toEqual([
      [HIRA_A, false, 0],
      ['', true, 0],
      [HIRA_I, false, 0],
      ['', true, 0],
    ]);
  });

  it('an SBCS char after the run lands after the SI, not on it', () => {
    const f = ideographicField(4, 10, 8, 'either');
    const handler = handlerWithField(f);
    handler.sendText(HIRA_A + 'X');
    const cells = cellsOf(handler.screen, f);
    expect(cells[3]).toEqual([' ', false, 2]); // SI intact
    expect(cells[4]).toEqual(['X', false, 0]);
  });

  it('a glyph that cannot fit (run would exceed the field) is dropped, not split', () => {
    const f = ideographicField(4, 10, 5, 'open'); // 4-cell run fits, appending 2 more cannot
    const handler = handlerWithField(f);
    handler.sendText(HIRA_A + HIRA_I);
    const cells = cellsOf(handler.screen, f);
    expect(cells.slice(0, 4)).toEqual([
      [' ', false, 1], [HIRA_A, false, 0], ['', true, 0], [' ', false, 2],
    ]);
    expect(cells[4][1]).toBe(false); // no orphan continuation
  });
});

describe('encodeSingleField — cell walk with wire identity', () => {
  it('typed DBCS reaches the wire as SO + pairs + SI, bytes === cells', () => {
    const f = ideographicField(4, 10, 8, 'open');
    const handler = handlerWithField(f);
    handler.sendText(HIRA_A + HIRA_I);
    const response = (handler as any).encoder.buildAidResponse('Enter');
    expect(response).not.toBeNull();
    const bytes = Array.from(response as Buffer);
    const pairA = encodeDbcsPair(HIRA_A) as [number, number];
    const pairI = encodeDbcsPair(HIRA_I) as [number, number];
    const expected = [SO, ...pairA, ...pairI, SI];
    const idx = bytes.join(',').indexOf(expected.join(','));
    expect(idx, `wire ${bytes.map(b => b.toString(16)).join(' ')}`).toBeGreaterThanOrEqual(0);
  });

  it('SBCS fields stay byte-identical to the string walk (regression)', () => {
    const f = ideographicField(4, 10, 5, 'none');
    const handler = handlerWithField(f);
    handler.sendText('AB7');
    const response = (handler as any).encoder.buildAidResponse('Enter');
    expect(Array.from(response as Buffer).join(',')).toContain('193,194,247');
  });
});

describe('host-paint round-trip — the dbcsShift mark preserves identity', () => {
  // Paint a WTD whose data is SO + あ + い + SI, then re-encode the same
  // cells. Before dbcsShift, the SO/SI cells re-encoded as 0x40 spaces.
  function paintDbcsScreen(): { screen: ScreenBuffer; fieldBytes: number[] } {
    const screen = new ScreenBuffer();
    const parser = new TN5250Parser(screen);
    const pairA = encodeDbcsPair(HIRA_A) as [number, number];
    const pairI = encodeDbcsPair(HIRA_I) as [number, number];
    const fieldBytes = [SO, ...pairA, ...pairI, SI];
    const wtd = Buffer.from([
      CMD.WRITE_TO_DISPLAY, 0x00, 0x00, // WTD + CC1 + CC2
      0x11, 5, 11,                      // SBA row 5 col 11 (1-based) → (4,10)
      ...fieldBytes,
    ]);
    parser.parseRecord(wtd);
    return { screen, fieldBytes };
  }

  function fieldOverPaint(len: number): FieldDef {
    const f = ideographicField(4, 10, len, 'open');
    f.modified = true;
    return f;
  }

  it('painted SO/SI cells re-encode as 0x0E/0x0F, glyphs as their pairs', () => {
    const { screen, fieldBytes } = paintDbcsScreen();
    const field = fieldOverPaint(fieldBytes.length);
    screen.fields.push(field);
    const encoder = new TN5250Encoder(screen);
    const encoded: Buffer = (encoder as any).encodeSingleField(field);
    expect(Array.from(encoded)).toEqual(fieldBytes);
  });

  it('the re-encoded bytes re-parse to the identical glyph cells (parser oracle)', () => {
    const { screen, fieldBytes } = paintDbcsScreen();
    const field = fieldOverPaint(fieldBytes.length);
    screen.fields.push(field);
    const encoder = new TN5250Encoder(screen);
    const encoded: Buffer = (encoder as any).encodeSingleField(field);

    // Feed the encoder output through a fresh parser at the same position.
    const screen2 = new ScreenBuffer();
    const parser2 = new TN5250Parser(screen2);
    parser2.parseRecord(Buffer.from([
      CMD.WRITE_TO_DISPLAY, 0x00, 0x00,
      0x11, 5, 11,
      ...Array.from(encoded),
    ]));
    const start = screen2.offset(4, 10);
    expect(screen2.dbcsShift[start]).toBe(1);
    expect(screen2.buffer[start + 1]).toBe(HIRA_A);
    expect(screen2.dbcsCont[start + 2]).toBe(true);
    expect(screen2.buffer[start + 3]).toBe(HIRA_I);
    expect(screen2.dbcsShift[start + 5]).toBe(2);
  });
});

describe('cell-honest accessors', () => {
  it('getFieldValue skips shift structure: SO+漢+cont+SI reads as the glyph alone', () => {
    const f = ideographicField(4, 10, 8, 'open');
    const handler = handlerWithField(f);
    handler.sendText(HIRA_A + HIRA_I);
    expect(handler.screen.getFieldValue(f)).toBe(HIRA_A + HIRA_I + '  ');
  });

  it('setFieldValue lays out shifted runs and truncates without splitting pairs', () => {
    const screen = new ScreenBuffer();
    const f = ideographicField(2, 0, 6, 'open');
    screen.fields.push(f);
    screen.setFieldValue(f, HIRA_A + HIRA_I + KATA_A); // needs 8 cells, has 6
    const start = screen.offset(2, 0);
    expect(screen.dbcsShift[start]).toBe(1);
    expect(screen.buffer[start + 1]).toBe(HIRA_A);
    expect(screen.dbcsCont[start + 2]).toBe(true);
    // ア dropped whole; SI closes the run inside the field.
    expect(screen.dbcsShift.slice(start, start + 6)).toContain(2);
    const encoder = new TN5250Encoder(screen);
    const encoded: Buffer = (encoder as any).encodeSingleField(f);
    expect(encoded.length).toBe(f.length); // bytes === cells, always
  });

  it('fieldExit never right-adjusts DBCS content (pairs would split)', () => {
    const f = ideographicField(4, 10, 8, 'open');
    f.ffw2 = 0x05; // right-adjust zero-fill
    const handler = handlerWithField(f);
    handler.sendText(HIRA_A);
    const before = cellsOf(handler.screen, f);
    expect((handler as any).encoder.fieldExit()).toBe(true);
    expect(cellsOf(handler.screen, f)).toEqual(before);
    expect(f.modified).toBe(true);
  });
});
