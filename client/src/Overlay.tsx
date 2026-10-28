import { useEffect, useRef, useState } from 'react';
import { getOverlayScene, type OverlaySnapshot } from './overlayModel';
import './overlay.css';

const API = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';
const socketUrl = API.replace(/^http/, 'ws') + '/ws';

export default function Overlay() {
  const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState(false);
  const [feedConnected, setFeedConnected] = useState(false);
  const [localNow, setLocalNow] = useState(Date.now());
  const serverOffset = useRef(0);
  const hasSnapshot = useRef(false);

  const applySnapshot = (next: OverlaySnapshot) => {
    serverOffset.current = next.state.serverNow - Date.now();
    hasSnapshot.current = true;
    setSnapshot(next);
    setApiError(false);
  };

  useEffect(() => {
    let active = true;
    let retry = 0;
    let socketHasSnapshot = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

    const loadState = async () => {
      try {
        const response = await fetch(`${API}/api/state`, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error('API unavailable');
        const data = await response.json() as OverlaySnapshot;
        if (active && !socketHasSnapshot) applySnapshot(data);
      } catch {
        if (active && !hasSnapshot.current) setApiError(true);
      } finally {
        if (active) setLoading(false);
      }
    };

    const connect = () => {
      if (!active) return;
      socket = new WebSocket(socketUrl);
      socket.onopen = () => { retry = 0; setFeedConnected(true); };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as { type?: string; data?: OverlaySnapshot };
          if (message.type === 'state' && message.data) {
            socketHasSnapshot = true;
            applySnapshot(message.data);
          }
        } catch { setApiError(true); }
      };
      socket.onerror = () => setFeedConnected(false);
      socket.onclose = () => {
        setFeedConnected(false);
        if (active) reconnectTimer = setTimeout(connect, Math.min(10_000, 750 * 2 ** retry++));
      };
    };

    void loadState();
    connect();
    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setLocalNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  if (loading && !snapshot) return <main className="broadcast-viewport"><section className="broadcast-card"><p className="broadcast-kicker">CROWDLAB · LIVE EXPERIMENT</p><div className="broadcast-loading">Connecting to the experiment…</div></section></main>;
  if (!snapshot) return <main className="broadcast-viewport"><section className="broadcast-card broadcast-offline"><p className="broadcast-kicker">CROWDLAB · EXPERIMENT OFFLINE</p><h1>Waiting for CrowdLab</h1><p>Start the local dashboard and keep the API running to show this scene.</p></section></main>;

  const estimatedServerNow = localNow + serverOffset.current;
  const scene = getOverlayScene(snapshot, estimatedServerNow);
  const connectionLabel = snapshot.connection.mode === 'local-test'
    ? 'SIMULATED CHAT'
    : snapshot.connection.status === 'subscribed'
      ? `TWITCH LIVE${snapshot.connection.channel ? ` · #${snapshot.connection.channel}` : ''}`
      : snapshot.connection.status === 'reconnecting'
        ? 'TWITCH RECONNECTING'
        : snapshot.connection.status === 'error'
          ? 'TWITCH NEEDS ATTENTION'
          : snapshot.connection.status === 'connecting' || snapshot.connection.status === 'authenticated'
            ? 'TWITCH CONNECTING'
            : 'TWITCH DISCONNECTED';
  const completed = scene.phase === 'completed';
  const waitingForLock = scene.phase === 'open' && scene.secondsLeft === 0;

  return <main className="broadcast-viewport">
    <section className={`broadcast-card scene-${scene.phase}`} aria-label="CrowdLab stream overlay">
      <header className="broadcast-header">
        <span className="broadcast-brand"><i className="broadcast-mark">C</i><span>CrowdLab</span></span>
        <span className={`broadcast-connection ${snapshot.connection.status === 'subscribed' ? 'is-live' : snapshot.connection.mode === 'local-test' ? 'is-simulated' : ''}`}><i />{connectionLabel}</span>
      </header>

      <div className="broadcast-roundline"><span>ROUND {String(scene.roundNumber).padStart(2, '0')}</span><span>{feedConnected ? 'LIVE FEED' : 'FEED RECONNECTING'}</span></div>
      <h1>{snapshot.state.experiment.title}</h1>

      {scene.phase === 'ready' && <div className="broadcast-state"><span className="broadcast-eyebrow">EXPERIMENT STATUS</span><strong>Ready to begin</strong><p>The crowd is waiting for the next round.</p></div>}

      {scene.phase === 'open' && <div className="broadcast-state broadcast-open">
        <span className="broadcast-eyebrow">{waitingForLock ? 'ROUND DEADLINE' : 'PREDICTIONS OPEN'}</span>
        <strong className="broadcast-timer">{waitingForLock ? '00:00' : `${String(Math.floor(scene.secondsLeft / 60)).padStart(2, '0')}:${String(scene.secondsLeft % 60).padStart(2, '0')}`}</strong>
        <p>{waitingForLock ? 'The server is confirming the lock.' : <>Send <code>{snapshot.state.experiment.command} 85</code> in Twitch chat.</>}</p>
        <div className="broadcast-count"><strong>{scene.predictionCount.toString().padStart(2, '0')}</strong><span>ACCEPTED PREDICTIONS</span></div>
      </div>}

      {scene.phase === 'locked' && <div className="broadcast-state broadcast-locked">
        <span className="broadcast-eyebrow">PREDICTIONS LOCKED</span>
        <strong>Measurement time</strong>
        <p>{scene.predictionCount} accepted {scene.predictionCount === 1 ? 'prediction' : 'predictions'} · waiting for the observed result</p>
      </div>}

      {completed && <div className="broadcast-result">
        <span className="broadcast-eyebrow">MEASURED RESULT</span>
        <strong className="broadcast-actual">{scene.actualValue ?? '—'}<i> {snapshot.state.experiment.unit}</i></strong>
        {scene.podium.length > 0 ? <div className="broadcast-podium">
          <div className="broadcast-podium-heading"><span>RANK · VIEWER</span><span>PREDICTION</span><span>ERROR</span></div>
          {scene.podium.map((entry) => <div className="broadcast-podium-row" key={entry.prediction.userId}>
            <strong className="broadcast-rank">#{entry.rank}</strong>
            <span className="broadcast-viewer">{entry.prediction.username}</span>
            <strong className="broadcast-value">{entry.prediction.value} <span>{snapshot.state.experiment.unit}</span></strong>
            <span className="broadcast-error">{entry.absoluteError.toFixed(2)} <span>{snapshot.state.experiment.unit}</span></span>
          </div>)}
        </div> : <div className="broadcast-no-guesses">No accepted predictions this round.</div>}
      </div>}

      <footer className="broadcast-footer"><span>{snapshot.connection.mode === 'local-test' ? 'SIMULATION · NOT TWITCH ACTIVITY' : 'PREDICT · MEASURE · PROVE'}</span><span>{snapshot.state.experiment.unit}</span></footer>
      {apiError && <p className="broadcast-warning" role="status">Live state is reconnecting. Showing the last received state.</p>}
    </section>
  </main>;
}
