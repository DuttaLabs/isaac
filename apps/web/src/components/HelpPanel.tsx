import { useEffect, useRef, useState } from 'react';

import type { EditPreview } from '../lib/help-actions.ts';
import { askIsaac, type Exchange, type HelpAction, type ProposedEdit } from '../lib/help.ts';
import { Panel, type PanelChoice } from './Panel.tsx';

/** What performing an action came to, in the app's own words. */
export type ActionOutcome = { ok: true } | { ok: false; error: string };

/**
 * Isaac's help, as a panel like any other.
 *
 * A panel rather than a floating widget because everything else here is one:
 * it tiles, it splits, it can sit beside the lens grid while a question is
 * being asked about the lens grid, and it can be closed by the same gesture as
 * everything else. A help bubble hovering over the corner would be the one
 * thing in Isaac that does not obey the workspace.
 *
 * **The conversation is component state, not a pane setting.** By the rule in
 * `panel-settings.ts` a setting is something worth reopening with, and a
 * conversation is not: it belongs to a question somebody had once, it would
 * bloat the stored layout, and two Help panels open at once should plainly be
 * able to hold different conversations rather than mirror one.
 *
 * **Actions divide in two, and the division is the whole safety story.** The
 * ones that change nothing, or that one undo puts back, are performed the
 * moment the answer lands — anything else would put a button in front of
 * "I've highlighted surface 3", which is absurd. A proposal to edit the
 * prescription is not performed at all: it is drawn as a before-and-after and
 * waits for a person.
 */
export function HelpPanel({
  context,
  perform,
  preview,
  applyEdits,
  choice,
}: {
  /** The design as the assistant will see it, or undefined to ask without one. */
  context?: string;
  /** Carries out an action that needs no permission. */
  perform: (action: HelpAction) => ActionOutcome;
  /** What a proposal would change, before it changes anything. */
  preview: (edits: readonly ProposedEdit[]) => readonly EditPreview[];
  applyEdits: (edits: readonly ProposedEdit[]) => ActionOutcome;
  choice?: PanelChoice;
}) {
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [streaming, setStreaming] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [showContext, setShowContext] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);

  // Follow the conversation down as it grows — including while text is still
  // arriving, which is most of the time now. Behavior 'auto' rather than
  // 'smooth': prose landing a few words at a time would animate continuously.
  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [exchanges, streaming]);

  const settle = (index: number, settled: Exchange['settled'], why?: string): void => {
    setExchanges((before) =>
      before.map((exchange, at) =>
        at === index ? { ...exchange, settled, ...(why !== undefined && { problem: why }) } : exchange,
      ),
    );
  };

  const ask = async (): Promise<void> => {
    const asked = question.trim();
    if (asked === '' || asking) return;
    setAsking(true);
    setProblem(undefined);
    setStreaming('');
    // Cleared now rather than on success: the question is in the transcript the
    // moment it is asked, and leaving it in the box invites asking it twice.
    setQuestion('');

    const result = await askIsaac(asked, context, exchanges, setStreaming);
    setStreaming(undefined);

    if (result.ok) {
      const { answer, action } = result.value;
      // Everything but a proposal happens now. A proposal is the one thing here
      // that changes numbers somebody is responsible for, so it waits.
      let settled: Exchange['settled'] | undefined;
      let why: string | undefined;
      if (action !== undefined && action.kind !== 'propose_edits') {
        const outcome = perform(action);
        if (!outcome.ok) {
          settled = 'refused';
          why = outcome.error;
        }
      }
      setExchanges((before) => [
        ...before,
        {
          question: asked,
          answer,
          ...(action !== undefined && { action }),
          ...(settled !== undefined && { settled }),
          ...(why !== undefined && { problem: why }),
        },
      ]);
    } else {
      // The question goes back in the box on a failure. It was not answered, so
      // it is still the thing the user wants to ask, and retyping it is a poor
      // way to be told the network was down.
      setQuestion(asked);
      setProblem(result.error);
    }
    setAsking(false);
  };

  return (
    <Panel
      title="Help"
      choice={choice}
      actions={
        exchanges.length > 0 ? (
          <button className="subtle" onClick={() => setExchanges([])} title="Start again">
            Clear
          </button>
        ) : undefined
      }
    >
      <div className="help">
        <div className="help-transcript" ref={transcript}>
          {exchanges.length === 0 && streaming === undefined ? (
            <div className="help-opening">
              <p className="hint">
                Ask about Isaac, or about the design you have open. It can see your surfaces,
                glasses, fields and first-order numbers — and it can show you where things are,
                start a design off, or propose a change for you to approve.
              </p>
              <ul className="help-suggestions">
                {[
                  'Why are my rays blocked?',
                  'Where is the stop?',
                  'Give me a Cooke triplet to start from.',
                  'Make surface 3 a mirror.',
                ].map((suggestion) => (
                  <li key={suggestion}>
                    <button className="subtle" onClick={() => setQuestion(suggestion)}>
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {exchanges.map((exchange, index) => (
            <div className="help-exchange" key={index}>
              <p className="help-question">{exchange.question}</p>
              <Prose text={proseOf(exchange)} />
              {exchange.action?.kind === 'propose_edits' ? (
                <Proposal
                  why={exchange.action.why}
                  rows={preview(exchange.action.edits)}
                  settled={exchange.settled}
                  problem={exchange.problem}
                  onApply={() => {
                    const outcome = applyEdits(
                      (exchange.action as { edits: readonly ProposedEdit[] }).edits,
                    );
                    settle(index, outcome.ok ? 'applied' : 'refused', outcome.ok ? undefined : outcome.error);
                  }}
                  onDiscard={() => settle(index, 'discarded')}
                />
              ) : exchange.problem !== undefined ? (
                <p className="help-problem">{exchange.problem}</p>
              ) : null}
            </div>
          ))}

          {/* The answer in progress. It is the same shape as a finished one, so
              nothing shifts on the page when it stops being in progress. */}
          {streaming !== undefined ? (
            <div className="help-exchange">
              {streaming === '' ? (
                <p className="help-thinking">Thinking…</p>
              ) : (
                <Prose text={streaming} streaming />
              )}
            </div>
          ) : null}
        </div>

        {problem !== undefined ? <p className="help-problem">{problem}</p> : null}

        <div className="help-ask">
          <textarea
            className="help-input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              // Enter asks, Shift-Enter makes a paragraph. A question is one
              // line far more often than it is several.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void ask();
              }
            }}
            placeholder="Ask about Isaac, or about this design…"
            rows={2}
            spellCheck
          />
          <button onClick={() => void ask()} disabled={asking || question.trim() === ''}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>

        {/* What is being sent, available rather than advertised. It is the
            user's design going to a server, so it must be inspectable — and it
            is also the fastest way to see why an answer was wrong. */}
        {context !== undefined ? (
          <div className="help-context">
            <button className="subtle" onClick={() => setShowContext((was) => !was)}>
              {showContext ? 'Hide' : 'Show'} what it can see about your design
            </button>
            {showContext ? <pre>{context}</pre> : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * What to show as the answer.
 *
 * A model calling a tool very often writes no prose at all — the call *is* the
 * answer, as far as it is concerned — and a blank space above a proposal reads
 * as something having gone wrong. So the tools that do something a person needs
 * explained carry their own sentence as a required field, and it stands in.
 * `propose_edits` is the exception: its `why` is rendered inside the proposal,
 * where it belongs, and repeating it here would say it twice.
 */
function proseOf(exchange: Exchange): string {
  if (exchange.answer !== '') return exchange.answer;
  switch (exchange.action?.kind) {
    case 'load_design':
      return exchange.action.note;
    case 'highlight_surface':
      return `Surface ${exchange.action.surface} — highlighted it in the grid.`;
    case 'open_panel':
      return 'Opened that panel for you.';
    default:
      return '';
  }
}

/**
 * The answer, as paragraphs.
 *
 * Split on blank lines and nothing else is interpreted — rendering a model's
 * output as markup would let an answer put arbitrary HTML on the page. While
 * text is still arriving the last paragraph carries a cursor, so a pause in the
 * middle of a sentence reads as thinking rather than as having finished.
 */
function Prose({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div className={streaming ? 'help-answer is-streaming' : 'help-answer'}>
      {paragraphs.map((paragraph, at) => (
        <p key={at}>
          {paragraph}
          {streaming && at === paragraphs.length - 1 ? <span className="help-cursor" /> : null}
        </p>
      ))}
    </div>
  );
}

/**
 * A proposed change to the design, before it is one.
 *
 * Two columns, because the question a reader has is not "what will it be" but
 * "what is it now, and what will it become" — a number on its own cannot be
 * judged. A row that cannot be applied says so in place rather than being
 * dropped, so the list can be checked against what the assistant said it would
 * do; and if any row is impossible, Apply is off, because these go on all
 * together or not at all.
 */
function Proposal({
  why,
  rows,
  settled,
  problem,
  onApply,
  onDiscard,
}: {
  /** The assistant's own sentence about what these do. */
  why: string;
  rows: readonly EditPreview[];
  settled?: Exchange['settled'];
  problem?: string;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const blocked = rows.some((row) => row.problem !== undefined);

  return (
    <div className={settled === undefined ? 'help-proposal' : 'help-proposal is-settled'}>
      {/* The model sometimes calls the tool and writes nothing around it, so
          this sentence is the only explanation there is. Shown above the rows
          rather than below: a reader wants to know what a change is *for*
          before reading which numbers move. */}
      {why !== '' ? <p className="help-proposal-why">{why}</p> : null}
      <table>
        <tbody>
          {rows.map((row, at) => (
            <tr key={at} className={row.problem !== undefined ? 'is-impossible' : undefined}>
              <td className="help-proposal-where">
                {row.surface}
                <span className="help-proposal-what">{row.label}</span>
              </td>
              <td className="help-proposal-before">{row.before}</td>
              <td className="help-proposal-arrow" aria-label="becomes">
                →
              </td>
              <td className="help-proposal-after">{row.after}</td>
              {row.problem !== undefined || row.note !== undefined ? (
                <td className={row.problem !== undefined ? 'help-proposal-problem' : 'help-proposal-note'}>
                  {row.problem ?? row.note}
                </td>
              ) : (
                <td />
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {settled === undefined ? (
        <div className="help-proposal-actions">
          <button onClick={onApply} disabled={blocked}>
            Apply
          </button>
          <button className="subtle" onClick={onDiscard}>
            Discard
          </button>
          {blocked ? (
            <span className="hint">Some of these cannot be made, so none are applied.</span>
          ) : (
            <span className="hint">Undo puts it back.</span>
          )}
        </div>
      ) : (
        <p className={settled === 'refused' ? 'help-problem' : 'hint'}>
          {settled === 'applied'
            ? 'Applied — Undo puts it back.'
            : settled === 'discarded'
              ? 'Discarded.'
              : (problem ?? 'That could not be applied.')}
        </p>
      )}
    </div>
  );
}
