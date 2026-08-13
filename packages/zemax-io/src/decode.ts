/**
 * ZMX files come in several encodings: recent OpticStudio writes UTF-16 (with a
 * byte-order mark), older Zemax wrote plain ASCII/Latin-1, and some tools emit
 * UTF-8. Callers that already have text can skip this entirely.
 */

const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** Decodes raw .zmx bytes to text, detecting the encoding from a BOM or byte pattern. */
export function decodeZmx(data: Uint8Array): string {
  const encoding = detectEncoding(data);
  const text = new TextDecoder(encoding).decode(data);
  // TextDecoder keeps a UTF-8 BOM as U+FEFF; drop any leading one.
  return text.replace(/^﻿/, '');
}

/** The encoding {@link decodeZmx} would use, exposed for diagnostics. */
export function detectEncoding(data: Uint8Array): 'utf-16le' | 'utf-16be' | 'utf-8' {
  if (startsWith(data, UTF16_LE_BOM)) {
    return 'utf-16le';
  }
  if (startsWith(data, UTF16_BE_BOM)) {
    return 'utf-16be';
  }
  if (startsWith(data, UTF8_BOM)) {
    return 'utf-8';
  }
  return sniffUtf16(data) ?? 'utf-8';
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte);
}

/**
 * Without a BOM, UTF-16 still gives itself away: ZMX content is ASCII, so every
 * other byte is zero. Which half is zero tells us the byte order.
 */
function sniffUtf16(data: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  const sample = Math.min(data.length, 512);
  if (sample < 4) {
    return undefined;
  }
  let zerosAtOdd = 0;
  let zerosAtEven = 0;
  for (let i = 0; i < sample; i += 2) {
    if (data[i] === 0) {
      zerosAtEven += 1;
    }
    if (data[i + 1] === 0) {
      zerosAtOdd += 1;
    }
  }
  const pairs = Math.floor(sample / 2);
  if (zerosAtOdd > pairs * 0.6) {
    return 'utf-16le';
  }
  if (zerosAtEven > pairs * 0.6) {
    return 'utf-16be';
  }
  return undefined;
}
