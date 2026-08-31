import { zmxTokenRole, type ZmxTokenRole } from '@isaac/zemax-io';

/**
 * The documents the text panel shows, and the two things it does to them:
 * breaking a line into colored spans, and finding a string.
 *
 * Kept out of the component because both are arithmetic with a right answer, and
 * both are the sort of thing that looks fine on screen while being subtly wrong
 * — a highlighter that drops the last token of a line, a search that reports
 * matches it cannot scroll to.
 */

/** What a document is, and where it came from. */
export interface TextDocument {
  /** Stable across re-renders; React's key and the tab's identity. */
  readonly key: string;
  /** What the tab says. A file name, or a name for a generated document. */
  readonly name: string;
  readonly text: string;
  /**
   * Read-only documents are the ones Isaac is *showing* rather than holding: a
   * `.zmx` opened for reading, and the live export of the current design. A file
   * opened as plain text is editable, because there is nothing behind it that an
   * edit would contradict.
   */
  readonly readOnly: boolean;
  /** Highlighting to apply. `undefined` is plain text. */
  readonly language: 'zmx' | undefined;
  /**
   * Rebuilt from the design on every render rather than held: the tab showing
   * what `Save` would write has to change when the design does, and a copy taken
   * once would quietly go stale.
   */
  readonly derived?: boolean;
}

/** A run of characters sharing one color. */
export interface TextSpan {
  readonly text: string;
  readonly role: SpanRole;
}

export type SpanRole = ZmxTokenRole | 'number' | 'string' | 'text';

const ZMX_EXTENSIONS = ['.zmx', '.zda', '.agf'];

/** Which highlighter a file name asks for. */
export function languageOf(name: string): 'zmx' | undefined {
  const lower = name.toLowerCase();
  return ZMX_EXTENSIONS.some((extension) => lower.endsWith(extension)) ? 'zmx' : undefined;
}

/**
 * One line of a `.zmx`, split into colored runs.
 *
 * A record is a token and its arguments, and the **token is what matters**: its
 * color says whether this reader interprets the line at all. That is asked of
 * `zemax-io` rather than answered from a list kept here, so a record that gains
 * a meaning in the reader gains its color in the same commit.
 *
 * Surface records are indented in files Zemax writes, and that indentation is
 * the only thing marking where a surface's block runs — so it is preserved
 * exactly rather than trimmed for tidiness.
 */
export function highlightZmxLine(line: string): TextSpan[] {
  const leading = line.length - line.trimStart().length;
  const indent = line.slice(0, leading);
  const rest = line.slice(leading);
  if (rest === '') {
    return indent === '' ? [] : [{ text: indent, role: 'text' }];
  }

  const spans: TextSpan[] = [];
  if (indent !== '') {
    spans.push({ text: indent, role: 'text' });
  }

  const tokenEnd = rest.search(/\s/);
  const token = tokenEnd === -1 ? rest : rest.slice(0, tokenEnd);
  spans.push({ text: token, role: zmxTokenRole(token) });
  if (tokenEnd === -1) {
    return spans;
  }

  // The arguments. `NOTE` and `COMM` are free text to the end of the line, so
  // they are not picked apart into numbers that happen to be words.
  const args = rest.slice(tokenEnd);
  const upper = token.toUpperCase();
  if (upper === 'NOTE' || upper === 'COMM' || upper === 'NAME') {
    spans.push({ text: args, role: 'string' });
    return spans;
  }
  for (const piece of args.split(/(\s+|"[^"]*")/).filter((part) => part !== '')) {
    spans.push({ text: piece, role: roleOfArgument(piece) });
  }
  return spans;
}

function roleOfArgument(piece: string): SpanRole {
  if (piece.startsWith('"')) {
    return 'string';
  }
  if (piece.trim() === '') {
    return 'text';
  }
  return Number.isFinite(Number(piece)) ? 'number' : 'text';
}

/** Where one match is: which line, and the character range within it. */
export interface SearchMatch {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Every match of `query` in `lines`, in reading order.
 *
 * Plain substring rather than a regular expression: a designer searching a lens
 * file types `GLAS N-BK7`, and the characters in a glass name and a file path
 * are exactly the ones a regex would read as syntax. Case-insensitive by
 * default, because `surf` and `SURF` are the same record.
 *
 * Overlapping matches are not reported twice — the search advances past each
 * hit — so a run of `aaa` searched for `aa` gives one match, which is what a
 * "next match" button has to agree with.
 */
export function findMatches(
  lines: readonly string[],
  query: string,
  matchCase = false,
): SearchMatch[] {
  if (query === '') {
    return [];
  }
  const needle = matchCase ? query : query.toLowerCase();
  const found: SearchMatch[] = [];
  for (const [line, raw] of lines.entries()) {
    const haystack = matchCase ? raw : raw.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) {
        break;
      }
      found.push({ line, start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  return found;
}

/**
 * The match a "next" or "previous" step lands on, wrapping at both ends.
 *
 * Wrapping rather than stopping, because a search that goes quiet at the last
 * match looks broken — and the count beside the box already says where you are.
 */
export function stepMatch(count: number, current: number, delta: number): number {
  return count === 0 ? 0 : (((current + delta) % count) + count) % count;
}

/** Splits text into lines without losing a trailing blank one. */
export function linesOf(text: string): string[] {
  return text.split('\n');
}
