import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  findMatches,
  highlightZmxLine,
  languageOf,
  linesOf,
  stepMatch,
  type TextDocument,
  type TextSpan,
} from '../lib/text-documents.ts';
import {
  loadRecents,
  readHandle,
  recallHandle,
  rememberHandle,
  saveRecents,
  withRecent,
  type RecentFile,
} from '../lib/recent-files.ts';
import type { TextEditorSettings } from '../lib/panel-settings.ts';
import { saveTextToFile } from '../lib/save-file.ts';
import { ErrorNote, Panel, type PanelChoice } from './Panel.tsx';

/**
 * A text panel: the file the design came from, the file it would be saved as,
 * and any other text file worth having open beside them.
 *
 * It reads rather than edits, and that is the point. A `.zmx` on screen next to
 * the lens grid answers the question the grid cannot — *what does the file
 * actually say* — and the highlighting is the answer to a second one: a token
 * colored as prescription is one `zemax-io` interprets, and a muted one is a
 * record it skips. Those colors come from the reader itself (`zmxTokenRole`), so
 * they cannot drift from what the import really does.
 *
 * Files opened as plain text are editable, because nothing behind them would
 * contradict the edit. A `.zmx` is read-only: the design is the model, and a
 * change typed here would be a second, contradictory copy of it.
 */

interface Props {
  settings: TextEditorSettings;
  onSettings: (next: TextEditorSettings) => void;
  /** The documents Isaac supplies: the opened file, and the live export. */
  supplied: readonly TextDocument[];
  choice: PanelChoice;
}

const FONT_FAMILIES = [
  { id: 'mono', label: 'Monospace', css: 'var(--mono)' },
  { id: 'system', label: 'System', css: 'system-ui, -apple-system, sans-serif' },
  { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
] as const;

export function TextEditorPanel({ settings, onSettings, supplied, choice }: Props) {
  /** Files the user opened here, which live only as long as the session. */
  const [opened, setOpened] = useState<TextDocument[]>([]);
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const [recents, setRecents] = useState<RecentFile[]>(loadRecents);
  const [showRecents, setShowRecents] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Supplied documents first, in the order Isaac offers them, then whatever the
  // user opened. A tab's identity is its key, so a supplied document that
  // changes underneath — the live export — keeps its place and its scroll.
  const documents = useMemo(() => [...supplied, ...opened], [supplied, opened]);
  const active = documents.find((one) => one.key === activeKey) ?? documents[0];
  const lines = useMemo(() => (active === undefined ? [] : linesOf(active.text)), [active]);
  const matches = useMemo(
    () => (searching ? findMatches(lines, query) : []),
    [searching, lines, query],
  );
  const current = matches[Math.min(matchIndex, Math.max(matches.length - 1, 0))];

  const openFile = useCallback(
    async (file: File, handleKey?: string, handle?: unknown) => {
      try {
        const text = await file.text();
        const key = `opened:${file.name}:${Date.now()}`;
        setOpened((files) => [
          ...files.filter((one) => one.name !== file.name),
          {
            key,
            name: file.name,
            text,
            language: languageOf(file.name),
            // A .zmx opened here is a thing to read: Isaac's model is the design,
            // and an edit typed over the file would be a second copy of it.
            readOnly: languageOf(file.name) === 'zmx',
          },
        ]);
        setActiveKey(key);
        setError(undefined);

        const next = withRecent(recents, file.name, Date.now());
        setRecents(next);
        saveRecents(next);
        if (handle !== undefined) {
          void rememberHandle(handleKey ?? `file:${file.name}`, handle);
        }
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
      }
    },
    [recents],
  );

  /**
   * The picker where the browser has one, and a plain file input where it does
   * not. Only the first hands back a *handle*, which is what lets the recent
   * list reopen a file rather than merely name it.
   */
  const pickFile = useCallback(async () => {
    const withPicker = window as unknown as {
      showOpenFilePicker?: (options?: object) => Promise<FileSystemFileHandle[]>;
    };
    if (withPicker.showOpenFilePicker === undefined) {
      picker.current?.click();
      return;
    }
    try {
      const [handle] = await withPicker.showOpenFilePicker({ multiple: false });
      if (handle === undefined) {
        return;
      }
      await openFile(await handle.getFile(), `file:${handle.name}`, handle);
    } catch (problem) {
      // Closing the dialog is not failing, and reporting it would put a red
      // notice in front of someone who simply changed their mind.
      if (!(problem instanceof DOMException && problem.name === 'AbortError')) {
        setError(problem instanceof Error ? problem.message : String(problem));
      }
    }
  }, [openFile]);

  const reopen = useCallback(
    async (recent: RecentFile) => {
      const handle = await recallHandle(recent.key);
      if (handle === undefined) {
        setError(
          `${recent.name} was opened before, but this browser did not keep a handle for it. Open it again to add one.`,
        );
        return;
      }
      const file = await readHandle(handle);
      if (file === undefined) {
        setError(`${recent.name} could not be read — permission was refused, or it has moved.`);
        return;
      }
      await openFile(file, recent.key, handle);
      setShowRecents(false);
    },
    [openFile],
  );

  /**
   * Writes the open document out. Only the editable ones offer it: a `.zmx` on
   * screen here is Isaac's own view of the design, and the app bar's Save is
   * what writes that — offering a second Save that wrote the same file from a
   * different place would be two doors onto one thing.
   */
  const saveActive = useCallback(async () => {
    if (active === undefined || active.readOnly) {
      return;
    }
    try {
      const outcome = await saveTextToFile(active.text, {
        suggestedName: active.name,
        description: 'Text file',
        accept: { 'text/plain': ['.txt', '.md', '.csv', '.log'] },
        // The window this panel is in: a panel sent to the second window would
        // otherwise open the opener's dialog.
        target: scroller.current?.ownerDocument.defaultView ?? window,
      });
      setError(undefined);
      if (outcome.kind === 'canceled') {
        return;
      }
      setOpened((files) =>
        files.map((one) => (one.key === active.key ? { ...one, name: outcome.name } : one)),
      );
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, [active]);

  // Ctrl-F, and Escape to put the bar away. Bound to this panel's own subtree so
  // two text panels do not fight over the shortcut, and so it does not fire
  // while the lens grid has focus.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      setSearching(true);
      // After the bar exists: focus cannot move to an element that is not there.
      window.setTimeout(() => search.current?.select(), 0);
      return;
    }
    if (event.key === 'Escape' && searching) {
      event.preventDefault();
      setSearching(false);
    }
  };

  // Keep the current match on screen. The rows are a fixed height, so the line
  // to scroll to is arithmetic rather than a measurement of every row above it.
  useEffect(() => {
    const box = scroller.current;
    if (box === null || current === undefined) {
      return;
    }
    const rowHeight = settings.fontSize * 1.5;
    const top = current.line * rowHeight;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - rowHeight) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 2);
    }
  }, [current, settings.fontSize]);

  const font = FONT_FAMILIES.find((one) => one.id === settings.fontFamily) ?? FONT_FAMILIES[0];

  return (
    <Panel
      title="Text"
      choice={choice}
      actions={
        <>
          <button type="button" onClick={() => void pickFile()} title="Open a text file to read">
            Open
          </button>
          {active !== undefined && !active.readOnly ? (
            <button
              type="button"
              onClick={() => void saveActive()}
              title="Write this document out as a file"
            >
              Save
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setShowRecents((showing) => !showing)}
            aria-pressed={showRecents}
            disabled={recents.length === 0}
            title={
              recents.length === 0
                ? 'Files you open here will be listed'
                : 'Files opened here before'
            }
          >
            Recent
          </button>
          <label className="inline">
            <span className="hint">Font</span>
            <select
              value={settings.fontFamily}
              aria-label="Font family"
              onChange={(event) =>
                onSettings({
                  ...settings,
                  fontFamily: event.target.value as TextEditorSettings['fontFamily'],
                })
              }
            >
              {FONT_FAMILIES.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            <span className="hint">Size</span>
            <input
              type="number"
              className="numeric"
              style={{ width: 52 }}
              min={8}
              max={32}
              step={1}
              value={settings.fontSize}
              aria-label="Font size"
              onChange={(event) =>
                onSettings({
                  ...settings,
                  fontSize: clampSize(Number(event.target.value), settings.fontSize),
                })
              }
            />
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={settings.lineNumbers}
              onChange={(event) => onSettings({ ...settings, lineNumbers: event.target.checked })}
            />
            <span className="hint">Lines</span>
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={settings.wrap}
              onChange={(event) => onSettings({ ...settings, wrap: event.target.checked })}
            />
            <span className="hint">Wrap</span>
          </label>
        </>
      }
    >
      {/* The fallback for a browser with no file picker. Hidden, because the
          Open button above is the control; this is only how it gets a file. */}
      <input
        ref={picker}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void openFile(file);
          }
          event.target.value = '';
        }}
      />

      <div className="text-editor" onKeyDown={onKeyDown}>
        <div className="text-tabs" role="tablist" aria-label="Open documents">
          {documents.map((document) => (
            <button
              key={document.key}
              type="button"
              role="tab"
              aria-selected={document.key === active?.key}
              className={document.key === active?.key ? 'text-tab active' : 'text-tab'}
              title={document.readOnly ? `${document.name} — read-only` : document.name}
              onClick={() => setActiveKey(document.key)}
            >
              <span>{document.name}</span>
              {document.readOnly ? <span className="text-tab-lock">read-only</span> : null}
              {opened.some((one) => one.key === document.key) ? (
                <span
                  className="text-tab-close"
                  role="presentation"
                  title="Close this document"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpened((files) => files.filter((one) => one.key !== document.key));
                    if (activeKey === document.key) {
                      setActiveKey(undefined);
                    }
                  }}
                >
                  ×
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {showRecents ? (
          <ul className="text-recents">
            {recents.map((recent) => (
              <li key={recent.key}>
                <button type="button" onClick={() => void reopen(recent)}>
                  <span className="text-recent-name">{recent.name}</span>
                  <span className="hint">{new Date(recent.openedAt).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {searching ? (
          <div className="text-search">
            <input
              ref={search}
              className="text-input"
              value={query}
              placeholder="Find"
              aria-label="Find in document"
              onChange={(event) => {
                setQuery(event.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  setMatchIndex((index) =>
                    stepMatch(matches.length, index, event.shiftKey ? -1 : 1),
                  );
                }
              }}
            />
            <span className="hint">
              {query === ''
                ? ''
                : matches.length === 0
                  ? 'no matches'
                  : `${Math.min(matchIndex, matches.length - 1) + 1} of ${matches.length}`}
            </span>
            <button
              type="button"
              aria-label="Previous match"
              disabled={matches.length === 0}
              onClick={() => setMatchIndex((index) => stepMatch(matches.length, index, -1))}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Next match"
              disabled={matches.length === 0}
              onClick={() => setMatchIndex((index) => stepMatch(matches.length, index, 1))}
            >
              ›
            </button>
            <button type="button" aria-label="Close find" onClick={() => setSearching(false)}>
              ×
            </button>
          </div>
        ) : null}

        {error === undefined ? null : <ErrorNote message={error} />}

        {active === undefined ? (
          <p className="hint text-empty">Nothing open. Use Open to read a text file.</p>
        ) : (
          <div
            ref={scroller}
            className={settings.wrap ? 'text-body wrap' : 'text-body'}
            style={{
              fontFamily: font.css,
              fontSize: `${settings.fontSize}px`,
              lineHeight: 1.5,
            }}
            tabIndex={0}
          >
            {settings.lineNumbers ? (
              <div className="text-gutter" aria-hidden="true">
                {lines.map((_, index) => (
                  <div key={index}>{index + 1}</div>
                ))}
              </div>
            ) : null}
            {active.readOnly ? (
              <pre className="text-content">
                {lines.map((line, index) => (
                  <Line
                    key={index}
                    line={line}
                    zmx={active.language === 'zmx'}
                    matches={matches.filter((match) => match.line === index)}
                    currentMatch={current?.line === index ? current.start : undefined}
                  />
                ))}
              </pre>
            ) : (
              <textarea
                className="text-input-area"
                value={active.text}
                spellCheck={false}
                aria-label={`${active.name} contents`}
                // Sized to its content, so the box around it scrolls and the
                // gutter stays beside the right line.
                rows={Math.max(lines.length, 1)}
                onChange={(event) =>
                  setOpened((files) =>
                    files.map((one) =>
                      one.key === active.key ? { ...one, text: event.target.value } : one,
                    ),
                  )
                }
              />
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** A size the number box cannot be talked out of: a blank field is not a size. */
function clampSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 8 && value <= 32 ? Math.round(value) : fallback;
}

/**
 * One rendered line: colored runs, with the search hits marked on top.
 *
 * The two are separate passes because they answer different questions and cut
 * the line at different places — a match can start in the middle of a token, and
 * a token can hold several matches. Coloring first and marking second keeps
 * each simple, at the cost of splitting a span that a match runs into.
 */
function Line({
  line,
  zmx,
  matches,
  currentMatch,
}: {
  line: string;
  zmx: boolean;
  matches: readonly { start: number; end: number }[];
  currentMatch: number | undefined;
}) {
  const spans: TextSpan[] = zmx ? highlightZmxLine(line) : [{ text: line, role: 'text' }];
  if (matches.length === 0) {
    return (
      <div className="text-line">
        {spans.map((span, index) => (
          <span key={index} className={`zmx-${span.role}`}>
            {span.text}
          </span>
        ))}
        {'\n'}
      </div>
    );
  }

  // With matches present the line is rebuilt character-range by character-range,
  // so a hit is marked whether or not it falls on a token boundary.
  const pieces: { text: string; role: string; hit: boolean; current: boolean }[] = [];
  let at = 0;
  for (const span of spans) {
    const spanEnd = at + span.text.length;
    let cursor = at;
    for (const match of matches) {
      if (match.end <= cursor || match.start >= spanEnd) {
        continue;
      }
      const from = Math.max(match.start, cursor);
      const to = Math.min(match.end, spanEnd);
      if (from > cursor) {
        pieces.push({
          text: line.slice(cursor, from),
          role: span.role,
          hit: false,
          current: false,
        });
      }
      pieces.push({
        text: line.slice(from, to),
        role: span.role,
        hit: true,
        current: match.start === currentMatch,
      });
      cursor = to;
    }
    if (cursor < spanEnd) {
      pieces.push({
        text: line.slice(cursor, spanEnd),
        role: span.role,
        hit: false,
        current: false,
      });
    }
    at = spanEnd;
  }

  return (
    <div className="text-line">
      {pieces.map((piece, index) => (
        <span
          key={index}
          className={`zmx-${piece.role}${piece.hit ? (piece.current ? ' hit current' : ' hit') : ''}`}
        >
          {piece.text}
        </span>
      ))}
      {'\n'}
    </div>
  );
}
