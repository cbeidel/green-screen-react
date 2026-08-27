import { describe, it, expect, vi } from 'vitest';
import { TN5250Handler } from '../protocols/tn5250-handler.js';
import { FieldDef } from './screen.js';
import { charToEbcdic } from '../encoding/ebcdic.js';

// The inbound (client → host) field encode must use the SESSION code page.
// Decode always honored `screen.codePage`, but `encodeSingleField` called
// `charToEbcdic(ch)` with the default 'cp37' table — so on a cp290 (Japan
// katakana) session every typed katakana character round-tripped to 0x40
// (the unmapped-char space fallback) on the wire while looking correct on
// screen. Mirrors tn3270/encoder.ts, which has always passed the code page.

function field(row: number, col: number, length: number): FieldDef {
  return {
    row, col, length,
    ffw1: 0, ffw2: 0, fcw1: 0, fcw2: 0, // input field
    attribute: 0x24, rawAttrByte: 0x24, modified: false,
  };
}

function oneFieldHandler(codePage: 'cp37' | 'cp290', length = 5) {
  const handler = new TN5250Handler();
  vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});
  (handler.screen as any).codePage = codePage;
  const f = field(4, 10, length);
  handler.screen.fields.push(f);
  handler.screen.cursorRow = 4;
  handler.screen.cursorCol = 10;
  return { handler, f };
}

describe('inbound field encode uses the session code page', () => {
  it('cp290: a typed half-width katakana reaches the wire as its CP290 byte', () => {
    const { handler } = oneFieldHandler('cp290');
    const kana = 'ｱ'; // U+FF71, CP290 0x58
    const expected = charToEbcdic(kana, 'cp290');
    expect(expected).toBe(0x58);
    // Sanity: the CP37 table cannot express it (falls back to 0x40 space) —
    // exactly the corruption the missing codePage argument produced.
    expect(charToEbcdic(kana, 'cp37')).toBe(0x40);

    handler.sendText(kana);
    const response = (handler as any).encoder.buildAidResponse('Enter');
    expect(response).not.toBeNull();
    expect(Array.from(response as Buffer)).toContain(expected);
  });

  it('cp37 sessions are byte-identical to the previous behaviour', () => {
    const { handler } = oneFieldHandler('cp37');
    handler.sendText('AB7');
    const response = (handler as any).encoder.buildAidResponse('Enter');
    expect(response).not.toBeNull();
    const bytes = Array.from(response as Buffer);
    // 'A'→0xC1 'B'→0xC2 '7'→0xF7 in CP37.
    expect(bytes.join(',')).toContain('193,194,247');
  });
});
