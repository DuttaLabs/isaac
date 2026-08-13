import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decodeZmx,
  detectEncoding,
  findRecords,
  firstValue,
  hasRecord,
  parseZmxDocument,
} from '../src/index.ts';

const DOUBLET = readFileSync(fileURLToPath(new URL('./fixtures/doublet.zmx', import.meta.url)), 'utf8');

test('a document splits into header, surface blocks, and trailer', () => {
  const document = parseZmxDocument(DOUBLET);

  assert.equal(firstValue(document.header, 'MODE'), 'SEQ');
  assert.equal(firstValue(document.header, 'ENPD'), '2.0E+1');
  assert.equal(document.surfaces.length, 5);
  assert.deepEqual(
    document.surfaces.map((block) => block.number),
    [0, 1, 2, 3, 4],
  );

  // Indented records belong to their surface; flush-left metadata is trailer.
  const stop = document.surfaces[1]!;
  assert.equal(hasRecord(stop.records, 'STOP'), true);
  assert.equal(firstValue(stop.records, 'DISZ'), '6.0');
  assert.equal(firstValue(stop.records, 'GLAS'), 'BK7');
  assert.deepEqual(
    document.trailer.map((record) => record.token),
    ['TOL', 'MNUM', 'MOFF'],
  );
});

test('records keep their values verbatim, with line numbers', () => {
  const document = parseZmxDocument(DOUBLET);
  const curv = findRecords(document.surfaces[1]!.records, 'CURV')[0]!;

  assert.equal(curv.token, 'CURV');
  assert.equal(curv.values[0], '1.077039960779000100E-002');
  assert.equal(curv.values[1], '1'); // trailing flags are preserved, not dropped
  assert.ok(curv.line > 0);

  // Padded wavelength lists survive; interpreting them is the importer's job.
  assert.equal(findRecords(document.header, 'WAVM').length, 5);
});

test('parsing tolerates blank lines, CRLF, and a leading BOM', () => {
  const text = '﻿MODE SEQ\r\n\r\nSURF 0\r\n  DISZ INFINITY\r\nSURF 1\r\n  DISZ 0\r\n';
  const document = parseZmxDocument(text);

  assert.equal(firstValue(document.header, 'MODE'), 'SEQ');
  assert.equal(document.surfaces.length, 2);
  assert.equal(firstValue(document.surfaces[0]!.records, 'DISZ'), 'INFINITY');
});

test('a malformed SURF number is rejected', () => {
  assert.throws(() => parseZmxDocument('SURF x\n  DISZ 0\n'), /integer surface number/);
});

test('UTF-16 files are decoded, with or without a byte-order mark', () => {
  const text = 'MODE SEQ\nSURF 0\n';

  const withBom = utf16le(text, true);
  assert.equal(detectEncoding(withBom), 'utf-16le');
  assert.equal(decodeZmx(withBom), text);

  // OpticStudio normally writes the BOM; without one the zero-byte pattern gives it away.
  const withoutBom = utf16le(text, false);
  assert.equal(detectEncoding(withoutBom), 'utf-16le');
  assert.equal(decodeZmx(withoutBom), text);

  const utf8 = new TextEncoder().encode(text);
  assert.equal(detectEncoding(utf8), 'utf-8');
  assert.equal(decodeZmx(utf8), text);
});

function utf16le(text: string, bom: boolean): Uint8Array {
  const source = bom ? `﻿${text}` : text;
  const bytes = new Uint8Array(source.length * 2);
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  return bytes;
}
