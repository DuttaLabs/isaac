import { useEffect, useRef, useState } from 'react';

import { askIsaac, type Exchange } from '../lib/help.ts';
import { Panel, type PanelChoice } from './Panel.tsx';

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
 * able to hold different conversations rather than mirror one. So it lives here
 * and goes when the panel does — the same call as the 3-D view's Reset signal.
 */
export function HelpPanel({
  context,
  choice,
}: {
  /** The design as the assistant will see it, or undefined to ask without one. */
  context?: string;
  choice?: PanelChoice;
}) {
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [showContext, setShowContext] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);

  // Follow the conversation down as it grows. Behavior 'auto' rather than
  // 'smooth': an answer arriving while somebody is reading the one above it
  // should not animate the page out from under them.
  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [exchanges, asking]);

  const ask = async (): Promise<void> => {
    const asked = question.trim();
    if (asked === '' || asking) return;
    setAsking(true);
    setProblem(undefined);
    // Cleared now rather than on success: the question is in the transcript the
    // moment it is asked, and leaving it in the box invites asking it twice.
    setQuestion('');
    const result = await askIsaac(asked, context, exchanges);
    if (result.ok) {
      setExchanges((before) => [...before, { question: asked, answer: result.value }]);
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
          {exchanges.length === 0 && !asking ? (
            <div className="help-opening">
              <p className="hint">
                Ask about Isaac, or about the design you have open. It can see your surfaces,
                glasses, fields and first-order numbers.
              </p>
              <ul className="help-suggestions">
                {[
                  'Why are my rays blocked?',
                  'What does the Aperture column mean?',
                  'Explain my first-order numbers.',
                  'How do I make surface 4 a mirror?',
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
              {/* Paragraphs split on blank lines, and nothing else is
                  interpreted. Rendering the model's output as markup would let
                  an answer put arbitrary HTML on the page. */}
              <div className="help-answer">
                {exchange.answer.split(/\n{2,}/).map((paragraph, at) => (
                  <p key={at}>{paragraph}</p>
                ))}
              </div>
            </div>
          ))}

          {asking ? <p className="help-thinking">Thinking…</p> : null}
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
