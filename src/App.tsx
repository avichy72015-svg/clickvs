import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const PLAYER_ID_KEY = "clickvs.playerId";
const PLAYER_NAME_KEY = "clickvs.playerName";
const ROUND_MS = 60_000;

export default function App() {
  const [roomCode, setRoomCode] = useState(() => getRoomCodeFromUrl());
  const [playerId] = useState(() => getOrCreatePlayerId());
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(PLAYER_NAME_KEY) ?? "");

  useEffect(() => {
    const onPopState = () => setRoomCode(getRoomCodeFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const savePlayerName = useCallback((name: string) => {
    setPlayerName(name);
    localStorage.setItem(PLAYER_NAME_KEY, name);
  }, []);

  return (
    <main className="app-shell" dir="rtl">
      <div className="arena-grid" aria-hidden="true" />
      <section className="game-surface">
        <TopBar onNewGame={() => navigateToRoom(null, setRoomCode)} />
        {roomCode === null ? (
          <StartScreen
            playerId={playerId}
            playerName={playerName}
            onNameChange={savePlayerName}
            onRoomCreated={setRoomCode}
          />
        ) : (
          <GameRoom
            code={roomCode}
            playerId={playerId}
            playerName={playerName}
            onNameChange={savePlayerName}
            onNewGame={() => navigateToRoom(null, setRoomCode)}
          />
        )}
      </section>
    </main>
  );
}

function TopBar({ onNewGame }: { onNewGame: () => void }) {
  return (
    <header className="top-bar">
      <button className="brand-button" onClick={onNewGame} type="button">
        <span className="brand-mark" aria-hidden="true">
          VS
        </span>
        <span>
          <strong>קליק VS</strong>
          <small>קרב לחיצות של דקה</small>
        </span>
      </button>
      <div className="status-chip">חי בזמן אמת</div>
    </header>
  );
}

function StartScreen({
  playerId,
  playerName,
  onNameChange,
  onRoomCreated,
}: {
  playerId: string;
  playerName: string;
  onNameChange: (name: string) => void;
  onRoomCreated: (code: string) => void;
}) {
  const createGame = useMutation(api.games.createGame);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreateGame() {
    setIsCreating(true);
    setError(null);
    try {
      const code = createInviteCode();
      await createGame({
        code,
        hostPlayerId: playerId,
        hostName: playerName,
      });
      navigateToRoom(code, (nextCode) => {
        if (nextCode !== null) {
          onRoomCreated(nextCode);
        }
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "לא הצלחנו ליצור משחק.");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="start-layout">
      <section className="intro-panel">
        <p className="eyebrow">דקה אחת. שתי ידיים. הרבה רעש.</p>
        <h1>מי לוחץ מהר יותר?</h1>
        <p className="intro-copy">
          צור קישור חד-פעמי, שלח לחבר, וברגע שהוא נכנס מתחיל קרב של 60 שניות.
          אם אף אחד לא מצטרף תוך דקה, בוט נכנס מולך ומופיע בגלוי כבוט.
        </p>
        <div className="rule-strip" aria-label="חוקי המשחק">
          <span>קישור חד-פעמי</span>
          <span>60 שניות משחק</span>
          <span>בוט אחרי דקה המתנה</span>
        </div>
      </section>

      <section className="control-panel" aria-label="יצירת משחק">
        <ClickBurst />
        <label className="field-label" htmlFor="playerName">
          איך קוראים לך?
        </label>
        <input
          id="playerName"
          className="text-input"
          maxLength={24}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="שם קצר ומאיים"
          value={playerName}
        />
        <button
          className="primary-action"
          disabled={isCreating}
          onClick={() => void handleCreateGame()}
          type="button"
        >
          {isCreating ? "יוצר קישור..." : "צור קרב חדש"}
        </button>
        {error !== null ? <p className="error-message">{error}</p> : null}
      </section>
    </div>
  );
}

function GameRoom({
  code,
  playerId,
  playerName,
  onNameChange,
  onNewGame,
}: {
  code: string;
  playerId: string;
  playerName: string;
  onNameChange: (name: string) => void;
  onNewGame: () => void;
}) {
  const game = useQuery(api.games.getByCode, { code, viewerPlayerId: playerId });
  const joinGame = useMutation(api.games.joinGame);
  const recordClicks = useMutation(api.games.recordClicks);
  const now = useNow(100);
  const [pendingClicks, setPendingClicks] = useState(0);
  const pendingClicksRef = useRef(0);
  const [joinError, setJoinError] = useState<string | null>(null);

  const viewer = useMemo(
    () => game?.players.find((player) => player.playerId === playerId) ?? null,
    [game?.players, playerId],
  );
  const isActive = game?.phase === "active";
  const canClick = isActive && viewer !== null && !viewer.isBot;

  const flushClicks = useCallback(async () => {
    if (game === undefined || game === null || viewer === null) {
      return;
    }

    const amount = pendingClicksRef.current;
    if (amount <= 0) {
      return;
    }

    pendingClicksRef.current = 0;
    setPendingClicks((current) => Math.max(0, current - amount));

    try {
      await recordClicks({
        gameId: game.id,
        playerId,
        amount,
      });
    } catch {
      pendingClicksRef.current += amount;
      setPendingClicks((current) => current + amount);
    }
  }, [game, playerId, recordClicks, viewer]);

  useEffect(() => {
    if (!canClick) {
      void flushClicks();
      return;
    }

    const intervalId = window.setInterval(() => {
      void flushClicks();
    }, 180);

    return () => {
      window.clearInterval(intervalId);
      void flushClicks();
    };
  }, [canClick, flushClicks]);

  function handleClick() {
    if (!canClick) {
      return;
    }
    pendingClicksRef.current += 1;
    setPendingClicks((current) => current + 1);
  }

  async function handleJoin() {
    setJoinError(null);
    try {
      await joinGame({
        code,
        playerId,
        playerName,
      });
    } catch (caught) {
      setJoinError(caught instanceof Error ? caught.message : "לא הצלחנו להצטרף.");
    }
  }

  if (game === undefined) {
    return <LoadingState />;
  }

  if (game === null) {
    return (
      <section className="empty-state">
        <h1>הקרב לא נמצא</h1>
        <p>יכול להיות שהקישור הועתק לא נכון.</p>
        <button className="secondary-action" onClick={onNewGame} type="button">
          צור משחק חדש
        </button>
      </section>
    );
  }

  const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${game.code}`;
  const viewerScore = viewer?.score ?? 0;
  const displayedScore = viewerScore + pendingClicks;
  const timeLeft =
    game.endsAt === null ? ROUND_MS : Math.max(0, Math.min(ROUND_MS, game.endsAt - now));
  const lobbyLeft = Math.max(0, game.lobbyExpiresAt - now);
  const countdownLeft = game.startsAt === null ? 0 : Math.max(0, game.startsAt - now);
  const winner = getWinner(game.players);
  const isSpectator = viewer === null && !game.canJoin;

  return (
    <div className="room-layout">
      <section className="scoreboard" aria-label="לוח תוצאות">
        {game.players.map((player) => (
          <PlayerScore
            key={player.playerId}
            isViewer={player.playerId === playerId}
            player={player}
            score={player.playerId === playerId ? displayedScore : player.score}
          />
        ))}
        {game.players.length === 1 ? <WaitingOpponentSlot /> : null}
      </section>

      <section className="battle-panel">
        {game.phase === "waiting" ? (
          <LobbyPanel inviteUrl={inviteUrl} lobbyLeft={lobbyLeft} />
        ) : null}

        {game.phase === "countdown" ? (
          <div className="countdown-stage">
            <span>מתחילים בעוד</span>
            <strong>{Math.ceil(countdownLeft / 1000)}</strong>
          </div>
        ) : null}

        {game.phase === "active" || game.phase === "finished" ? (
          <>
            <div className="round-meter" aria-label="זמן שנותר">
              <div style={{ inlineSize: `${(timeLeft / ROUND_MS) * 100}%` }} />
            </div>
            <button
              className="click-button"
              disabled={!canClick}
              onClick={handleClick}
              type="button"
            >
              <span>{game.phase === "finished" ? "נגמר!" : "לחץ!"}</span>
              <strong>{displayedScore}</strong>
              <small>{formatTime(timeLeft)}</small>
            </button>
          </>
        ) : null}

        {game.canJoin ? (
          <JoinPanel
            joinError={joinError}
            onJoin={() => void handleJoin()}
            onNameChange={onNameChange}
            playerName={playerName}
          />
        ) : null}

        {isSpectator ? (
          <div className="notice-panel">
            <strong>הקישור כבר נתפס</strong>
            <span>אפשר לצפות בתוצאה, אבל הקרב הזה חד-פעמי.</span>
          </div>
        ) : null}

        {game.phase === "finished" ? (
          <div className="result-panel">
            <span>תוצאה סופית</span>
            <strong>{winner === null ? "תיקו מטורף" : `${winner.name} ניצח/ה`}</strong>
            <button className="secondary-action" onClick={onNewGame} type="button">
              קרב חדש
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function LobbyPanel({ inviteUrl, lobbyLeft }: { inviteUrl: string; lobbyLeft: number }) {
  const [copied, setCopied] = useState(false);

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="lobby-panel">
      <span className="panel-kicker">הקישור מוכן</span>
      <h1>שלח לחבר והקרב מתחיל כשהוא נכנס</h1>
      <div className="invite-row">
        <input className="invite-input" readOnly value={inviteUrl} />
        <button className="copy-button" onClick={() => void copyInvite()} type="button">
          {copied ? "הועתק" : "העתק"}
        </button>
      </div>
      <p>
        אם אף אחד לא מצטרף תוך <strong>{formatTime(lobbyLeft)}</strong>, הבוט נכנס
        אוטומטית ומסומן כבוט.
      </p>
    </div>
  );
}

function JoinPanel({
  joinError,
  onJoin,
  onNameChange,
  playerName,
}: {
  joinError: string | null;
  onJoin: () => void;
  onNameChange: (name: string) => void;
  playerName: string;
}) {
  return (
    <div className="join-panel">
      <span className="panel-kicker">הוזמנת לקרב</span>
      <label className="field-label" htmlFor="joinName">
        שם השחקן שלך
      </label>
      <input
        id="joinName"
        className="text-input"
        maxLength={24}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder="שם קצר ומפחיד"
        value={playerName}
      />
      <button className="primary-action" onClick={onJoin} type="button">
        הצטרף והתחל
      </button>
      {joinError !== null ? <p className="error-message">{joinError}</p> : null}
    </div>
  );
}

function PlayerScore({
  isViewer,
  player,
  score,
}: {
  isViewer: boolean;
  player: PlayerView;
  score: number;
}) {
  return (
    <article className={`player-card ${player.color}`}>
      <div>
        <span>{player.role === "host" ? "מארח" : "יריב"}</span>
        <h2>{player.name}</h2>
      </div>
      <strong>{score}</strong>
      <small>
        {player.isBot ? "בוט" : isViewer ? "את/ה" : "שחקן אנושי"}
      </small>
    </article>
  );
}

function WaitingOpponentSlot() {
  return (
    <article className="player-card empty">
      <div>
        <span>יריב</span>
        <h2>מחכים לשחקן...</h2>
      </div>
      <strong>0</strong>
      <small>או בוט בעוד רגע</small>
    </article>
  );
}

function LoadingState() {
  return (
    <div className="loading-state">
      <div className="loader" />
      <span>טוען קרב...</span>
    </div>
  );
}

function ClickBurst() {
  return (
    <svg className="click-burst" viewBox="0 0 240 180" role="img" aria-label="איור לחיצה מהירה">
      <path
        d="M118 24 132 74 184 50 158 99 216 108 160 130 188 164 126 145 88 170 86 124 28 140 72 102 38 62 94 76Z"
        fill="#f7d35f"
      />
      <circle cx="119" cy="105" fill="#0f172a" r="52" />
      <circle cx="119" cy="105" fill="#5eead4" r="36" />
      <path d="M108 76h24v58h-24zM90 99h58v24H90z" fill="#0f172a" />
    </svg>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(intervalId);
  }, [intervalMs]);

  return now;
}

function getWinner(players: PlayerView[]) {
  if (players.length < 2) {
    return null;
  }
  const [first, second] = [...players].sort((left, right) => right.score - left.score);
  if (first.score === second.score) {
    return null;
  }
  return first;
}

function getRoomCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  return room === null ? null : room.toUpperCase();
}

function navigateToRoom(code: string | null, onRoomChanged: (code: string | null) => void) {
  const url = new URL(window.location.href);
  if (code === null) {
    url.searchParams.delete("room");
  } else {
    url.searchParams.set("room", code);
  }
  window.history.pushState({}, "", url);
  onRoomChanged(code);
}

function getOrCreatePlayerId() {
  const existingId = localStorage.getItem(PLAYER_ID_KEY);
  if (existingId !== null) {
    return existingId;
  }
  const id = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}

function createInviteCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 10)
    .toUpperCase();
}

function formatTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

type PlayerView = {
  id: string;
  playerId: string;
  name: string;
  role: "host" | "opponent";
  isBot: boolean;
  color: "cyan" | "coral";
  score: number;
  botTargetScore: number | null;
};
