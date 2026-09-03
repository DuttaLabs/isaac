import { useState } from 'react';

import type { Session } from '../lib/session.ts';
import { suggestRoomId } from '../lib/session.ts';
import { Panel, type PanelChoice } from './Panel.tsx';

/**
 * A view of the app's one session — never its owner. The connection lives in
 * `App` because this panel can be opened twice, and two copies each holding a
 * socket would put the same person in the room twice.
 *
 * So this is an *input* panel in the sense `panel-settings.ts` means: it keeps
 * no settings of its own, reads the session directly, and every copy agrees.
 */
/** The driver's name, or undefined if it is us or nobody yet. */
function driverName(session: Session): string | undefined {
  return session.members.find((member) => member.id === session.driver)?.name;
}

export function SessionPanel({ session, choice }: { session: Session; choice?: PanelChoice }) {
  const [room, setRoom] = useState(suggestRoomId);
  const [name, setName] = useState('');

  const joined = session.status === 'joined';
  const busy = session.status === 'connecting';

  return (
    <Panel title="Session" choice={choice}>
      <div className="session">
        {joined ? (
          <>
            <div className="session-room">
              <span className="session-label">Room</span>
              <code className="session-code">{session.room}</code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(session.room ?? '')}
                title="Copy the room name, to send to whoever you are meeting"
              >
                Copy
              </button>
            </div>

            <ul className="session-members">
              {/* The relay does not send you your own membership — you are the
                  one thing you already know about — so it is added here. The
                  driver is marked in the same list rather than named separately:
                  "who is here" and "who has the wheel" are one glance. */}
              <li className={session.driving ? 'session-you is-driving' : 'session-you'}>
                You{session.driving && ' · driving'}
              </li>
              {session.members.map((member) => (
                <li key={member.id} className={member.id === session.driver ? 'is-driving' : ''}>
                  {member.name}
                  {member.id === session.driver && ' · driving'}
                </li>
              ))}
            </ul>

            {session.members.length === 0 ? (
              <p className="hint">
                Nobody else yet. Send them the room name and they will see this design.
              </p>
            ) : session.driving ? (
              <p className="hint">
                Everyone is seeing your screen. Anyone can take over.
              </p>
            ) : (
              <>
                <button type="button" className="session-take" onClick={session.take}>
                  Take control
                </button>
                <p className="hint">
                  You are watching {driverName(session) ?? 'someone else'}. Take control to
                  change the design or move the view.
                </p>
              </>
            )}

            <button type="button" onClick={session.leave}>
              Leave
            </button>
          </>
        ) : (
          <>
            <label className="session-field">
              <span>Your name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ada"
                autoComplete="name"
              />
            </label>

            <label className="session-field">
              <span>Room</span>
              <input
                value={room}
                onChange={(event) => setRoom(event.target.value.toLowerCase())}
                spellCheck={false}
              />
            </label>

            <div className="session-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => session.join(room.trim(), name)}
              >
                {busy ? 'Joining…' : 'Join'}
              </button>
              <button type="button" onClick={() => setRoom(suggestRoomId())} disabled={busy}>
                New room
              </button>
            </div>

            <p className="hint">
              Everyone in a room sees the same design. Whoever arrives first brings theirs;
              after that, every change is shared.
            </p>
          </>
        )}

        {session.problem !== undefined && <p className="session-problem">{session.problem}</p>}
        <p className="hint session-server">{session.serverUrl}</p>
      </div>
    </Panel>
  );
}
