import { describe, it, expect, vi } from 'vitest';
import { TN5250Handler } from '../protocols/tn5250-handler.js';
import { FieldDef } from './screen.js';

// 5250 field-exit semantics: FFW2's ADJUST bits (per the 5250 Functions
// Reference, and per this package's own wire projection in screen.ts) are
//   101 (0x05) = right-adjust + ZERO fill   (DDS CHECK(RZ))
//   110 (0x06) = right-adjust + BLANK fill  (DDS CHECK(RB))
//   111 (0x07) = mandatory fill             (NOT an adjust instruction)
// fieldExit() previously decoded 1|3 as zero-fill and 2|5 as blank-fill, so a
// real CHECK(RZ) field was BLANK-padded on Field Exit. The bug survived because
// the only right-adjust field on any live fixture was CHECK(RB), whose correct
// output happens to equal the buggy branch's output.
//
// The signed-numeric tests pin the wire convention integrators must follow:
// a signed_num field reserves its LAST position for the sign; the encoder
// drops that position and zone-shifts the final digit to 0xDx when the sign
// position holds '-'. A LEADING minus is silently corrupting (the last real
// digit is eaten as if it were the sign) — type digits + trailing '-' instead.

const FFW2_RIGHT_ZERO = 0x05;
const FFW2_RIGHT_BLANK = 0x06;
const FFW2_MANDATORY_FILL = 0x07;
const FFW1_SIGNED_NUM = 0x07;

function field(row: number, col: number, length: number, ffw1 = 0, ffw2 = 0): FieldDef {
  return {
    row, col, length,
    ffw1, ffw2, fcw1: 0, fcw2: 0, // ffw1 bit 0x20 clear ⇒ input field
    attribute: 0x24, rawAttrByte: 0x24, modified: false,
  };
}

/** Handler with one input field at (4, 10) and a stubbed wire. */
function oneFieldHandler(length: number, ffw1 = 0, ffw2 = 0) {
  const handler = new TN5250Handler();
  vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});
  const f = field(4, 10, length, ffw1, ffw2);
  handler.screen.fields.push(f);
  handler.screen.cursorRow = 4;
  handler.screen.cursorCol = 10;
  return { handler, f };
}

describe('FieldExit adjust semantics (FFW2 ADJUST bits)', () => {
  it('right-adjust ZERO-fills a CHECK(RZ) field (0x05)', () => {
    const { handler, f } = oneFieldHandler(5, 0, FFW2_RIGHT_ZERO);
    handler.sendText('7');
    handler.sendKey('FieldExit');
    expect(handler.screen.getFieldValue(f)).toBe('00007');
  });

  it('right-adjust BLANK-fills a CHECK(RB) field (0x06)', () => {
    const { handler, f } = oneFieldHandler(5, 0, FFW2_RIGHT_BLANK);
    handler.sendText('7');
    handler.sendKey('FieldExit');
    expect(handler.screen.getFieldValue(f)).toBe('    7');
  });

  it('does NOT treat mandatory-fill (0x07) as an adjust instruction', () => {
    const { handler, f } = oneFieldHandler(5, 0, FFW2_MANDATORY_FILL);
    handler.sendText('7');
    handler.sendKey('FieldExit');
    // Mandatory fill means "every position must be typed" — padding it for
    // the operator would defeat the host's own validation. Leave as typed.
    expect(handler.screen.getFieldValue(f).trimEnd()).toBe('7');
  });

  it('leaves a no-adjust field untouched', () => {
    const { handler, f } = oneFieldHandler(5, 0, 0);
    handler.sendText('AB');
    handler.sendKey('FieldExit');
    expect(handler.screen.getFieldValue(f).trimEnd()).toBe('AB');
  });
});

describe('signed_num wire encoding (Read MDT Fields)', () => {
  const EBCDIC = { '0': 0xf0, '7': 0xf7, MINUS: 0x60, NEG7: 0xd7 };

  function wireBytes(value: string): number[] {
    const { handler } = oneFieldHandler(5, FFW1_SIGNED_NUM, 0);
    handler.sendText(value);
    const packet = handler.encoder.buildAidResponse('Enter');
    expect(packet).not.toBeNull();
    return Array.from(packet!);
  }

  function containsSeq(haystack: number[], needle: number[]): boolean {
    return haystack.some((_, i) => needle.every((b, j) => haystack[i + j] === b));
  }

  it('digits + trailing "-" ship zone-shifted (0007- → F0 F0 F0 D7)', () => {
    const bytes = wireBytes('0007-');
    expect(containsSeq(bytes, [EBCDIC['0'], EBCDIC['0'], EBCDIC['0'], EBCDIC.NEG7])).toBe(true);
  });

  it('a LEADING minus is corrupted — the last digit is eaten as the sign position', () => {
    // Characterization of the trap, not desired usage: "-0007" ships as "-000"
    // (EBCDIC 60 F0 F0 F0) with the 7 dropped and no negative zone. Integrators
    // MUST use the trailing-sign convention above.
    const bytes = wireBytes('-0007');
    expect(containsSeq(bytes, [EBCDIC.MINUS, EBCDIC['0'], EBCDIC['0'], EBCDIC['0']])).toBe(true);
    expect(bytes).not.toContain(EBCDIC['7']);
    expect(bytes).not.toContain(EBCDIC.NEG7);
  });

  it('positive value ships digits with the sign position dropped (0007  → F0 F0 F0 F7)', () => {
    const bytes = wireBytes('0007');
    expect(containsSeq(bytes, [EBCDIC['0'], EBCDIC['0'], EBCDIC['0'], EBCDIC['7']])).toBe(true);
  });
});

describe('FER + DUP-enable wire exposure', () => {
  it('surfaces field_exit_required (FFW2 0x40) and dup_enable (FFW1 0x10)', () => {
    const { handler } = oneFieldHandler(5, 0x10, 0x40);
    const wire = handler.getScreenData();
    const f = wire.fields.find(w => w.row === 4 && w.col === 10)!;
    expect(f.field_exit_required).toBe(true);
    expect(f.dup_enable).toBe(true);
  });

  it('stays absent when the bits are clear (wire stays minimal)', () => {
    const { handler } = oneFieldHandler(5, 0, 0);
    const wire = handler.getScreenData();
    const f = wire.fields.find(w => w.row === 4 && w.col === 10)!;
    expect(f.field_exit_required).toBeUndefined();
    expect(f.dup_enable).toBeUndefined();
  });
});
