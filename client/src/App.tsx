import { useEffect, useMemo, useRef, useState } from 'react';
import './game.css';
import { getLiveInsights } from './insightModel';

type Prediction = { experimentId: string; userId: string; username: string; value: number; unit: '°C'; submittedAt: string; source: 'twitch' | 'local-test'; acceptanceStatus: 'accepted' };
type Connection = { status: 'disconnected' | 'connecting' | 'authenticated' | 'subscribed' | 'reconnecting' | 'error'; mode: 'twitch' | 'local-test' | 'unconfigured'; message: string; channel?: string };
type RankedPrediction = { rank: number; prediction: Prediction; absoluteError: number; unit: '°C' };
type Snapshot = { state: { serverNow: number; experiment: { id: string; title: string; unit: string; command: string; min: number; max: number }; round: { number: number; status: 'ready' | 'open' | 'locked' | 'completed'; openedAt: number | null; deadlineAt: number | null; lockedAt: number | null; actualValue: number | null; completedAt: number | null }; predictions: Prediction[]; leaderboard: RankedPrediction[]; completedRounds: unknown[] }; connection: Connection };

const API = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';
const socketUrl = API.replace(/^http/, 'ws') + '/ws';
const formatValue = (value: number | null) => value === null ? '—' : value.toFixed(1);
const formatDifference = (value: number | null, unit: string) => value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)} ${unit}`;

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState('');
  const [socketConnected, setSocketConnected] = useState(false);
  const [testName, setTestName] = useState('Test viewer');
  const [testId, setTestId] = useState('local-viewer-1');
  const [testText, setTestText] = useState('!predict 85');
  const [testNotice, setTestNotice] = useState('');
  const [actualValue, setActualValue] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now());
  const serverClockOffset = useRef(0);

  const applySnapshot = (next: Snapshot) => {
    serverClockOffset.current = next.state.serverNow - Date.now();
    setSnapshot(next);
  };

  useEffect(() => {
    let active = true;
    let retry = 0;
    let receivedSocketSnapshot = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    const loadState = async () => {
      try {
        const response = await fetch(`${API}/api/state`);
        if (!response.ok) throw new Error('CrowdLab server did not return its current state.');
        const data = await response.json() as Snapshot;
        if (active) { if (!receivedSocketSnapshot) applySnapshot(data); setApiError(''); }
      } catch (error) { if (active) setApiError(error instanceof Error ? error.message : 'CrowdLab server is unavailable.'); }
      finally { if (active) setLoading(false); }
    };
    void loadState();
    const connect = () => {
      if (!active) return;
      socket = new WebSocket(socketUrl);
      socket.onopen = () => { retry = 0; setSocketConnected(true); setApiError(''); };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as { type?: string; data?: Snapshot; message?: string };
          if (message.type === 'state' && message.data) { receivedSocketSnapshot = true; applySnapshot(message.data); }
          if (message.type === 'error') setApiError(message.message ?? 'Live connection reported an error.');
        } catch { setApiError('Received an unreadable update from CrowdLab.'); }
      };
      socket.onerror = () => setSocketConnected(false);
      socket.onclose = () => {
        setSocketConnected(false);
        if (active) timer = setTimeout(connect, Math.min(10_000, 750 * 2 ** retry++));
      };
    };
    connect();
    return () => { active = false; if (timer) clearTimeout(timer); socket?.close(); };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const participants = useMemo(() => new Set(snapshot?.state.predictions.map((prediction) => prediction.userId) ?? []).size, [snapshot]);
  const insights = useMemo(() => snapshot ? getLiveInsights(snapshot.state) : null, [snapshot]);
  const connection = snapshot?.connection;
  const round = snapshot?.state.round;
  const secondsLeft = round?.status === 'open' && round.deadlineAt !== null ? Math.max(0, Math.ceil((round.deadlineAt - (clockNow + serverClockOffset.current)) / 1000)) : null;
  const countdown = secondsLeft === null ? '' : `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const isCompleted = round?.status === 'completed';
  const tone = connection?.status === 'subscribed' ? 'live' : connection?.status === 'connecting' || connection?.status === 'authenticated' || connection?.status === 'reconnecting' ? 'pending' : connection?.status === 'error' ? 'danger' : connection?.mode === 'local-test' ? 'test' : 'quiet';

  const submitLocal = async (event: React.FormEvent) => {
    event.preventDefault(); setTestNotice('');
    try {
      const response = await fetch(`${API}/api/local-test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: testName, userId: testId, text: testText }), signal: AbortSignal.timeout(10_000) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The test prediction was rejected.');
      setTestNotice('Local test prediction accepted. It is labeled as simulated.');
    } catch (error) { setTestNotice(error instanceof Error ? error.message : 'Local test could not be submitted.'); }
  };

  const sendRoundAction = async (path: string, body?: { actualValue: string }) => {
    setActionError(''); setActionBusy(true);
    try {
      const response = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as { state?: Snapshot['state']; error?: string };
      if (!response.ok || !result.state) throw new Error(result.error ?? 'Round action failed.');
      if (snapshot) applySnapshot({ ...snapshot, state: result.state });
      if (path.endsWith('/result')) setActualValue('');
    } catch (error) { setActionError(error instanceof DOMException && error.name === 'TimeoutError' ? 'The round action timed out. Check CrowdLab and its current round state.' : error instanceof Error ? error.message : 'Round action failed.'); }
    finally { setActionBusy(false); }
  };

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="#home" aria-label="CrowdLab home"><span className="brand-mark"><i /><i /><i /></span><span>CrowdLab</span></a>
      <div className="topbar-right"><span className="tagline">PREDICT. MEASURE. PROVE.</span><a className="overlay-link" href="/overlay" target="_blank" rel="noreferrer">Open stream overlay <span aria-hidden="true">↗</span></a><div className={`connection-pill ${tone}`}><span className="status-dot" />{connection?.mode === 'local-test' ? 'LOCAL TEST MODE' : connection?.status === 'subscribed' ? 'TWITCH LIVE' : connection?.status === 'reconnecting' ? 'RECONNECTING' : connection?.status === 'connecting' || connection?.status === 'authenticated' ? 'CONNECTING' : connection?.status === 'error' ? 'CONNECTION ERROR' : 'DISCONNECTED'}</div></div>
    </header>

    <section className="hero" id="home">
      <div className="hero-copy"><p className="eyebrow"><span className="eyebrow-line" /> TEMPERATURE EXPERIMENT · ROUND {String(round?.number ?? 1).padStart(2, '0')}</p><h1>Make a guess.<br /><span>See what happens.</span></h1><p className="hero-lead">A real-world experiment, powered by the people watching. Send a prediction in chat and see it land here.</p></div>
      <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><div className="thermo"><span className="thermo-liquid"/><span className="thermo-bulb"/><span className="thermo-tick tick-a"/><span className="thermo-tick tick-b"/><span className="thermo-tick tick-c"/></div><span className="degree degree-top">100°</span><span className="degree degree-bottom">0°</span><span className="spark spark-a">✳</span><span className="spark spark-b">✳</span></div>
    </section>

    {apiError && <div className="alert" role="alert"><span className="alert-icon">!</span><span>{apiError}</span><span className="alert-state">{socketConnected ? 'Live updates connected' : 'Retrying live updates'}</span></div>}

    <section className="main-grid" aria-label="Experiment and live predictions">
      <article className="experiment-card panel">
        <div className="panel-kicker"><span className="kicker-number">01</span><span>THE EXPERIMENT</span><span className={`live-indicator round-${round?.status ?? 'ready'}`}><i /> {(round?.status ?? 'ready').toUpperCase()}</span></div>
        <h2>Predict the<br />final temperature<span className="title-period">.</span></h2>
        <p className="experiment-description">One prediction per viewer. The round opens for 60 seconds, then the closest guess to the measured result wins.</p>
        <div className="measurement"><div><span className="measure-label">MEASUREMENT</span><strong>Temperature</strong></div><span className="unit-badge">°C</span></div>
        <div className="command-box"><div className="command-top"><span>IN TWITCH CHAT</span><span>NUMERICAL GUESS</span></div><code><span className="command-prompt">›</span> !predict <b>85</b></code><div className="range-note">Accepted range: {snapshot?.state.experiment.min ?? '−273.15'} to {snapshot?.state.experiment.max ?? '1000'} °C</div></div>
        {connection?.mode === 'twitch' && connection.status !== 'subscribed' && <a className="connect-link" href={`${API}/auth/twitch`}>Connect Twitch account <span aria-hidden="true">↗</span></a>}
        <div className="connection-detail"><span className={`detail-dot ${tone}`} /><div><strong>{connection?.status === 'subscribed' ? `Listening to #${connection.channel ?? 'Twitch channel'}` : connection?.mode === 'local-test' ? 'Simulated chat only' : connection?.status === 'error' ? 'Needs attention' : connection?.status === 'reconnecting' ? 'Restoring Twitch connection' : connection?.status === 'connecting' || connection?.status === 'authenticated' ? 'Connecting to Twitch' : 'Twitch is not connected'}</strong><span>{connection?.message ?? (loading ? 'Checking CrowdLab server…' : 'CrowdLab server is unavailable.')}</span></div></div>

        <div className="round-control">
          <div className="control-heading"><span className="measure-label">STREAMER CONTROLS</span>{round?.status === 'open' && <strong className="countdown" aria-label={`${secondsLeft} seconds remaining`}>{countdown}</strong>}</div>
          {round?.status === 'ready' && <><p>Start when the experiment is ready. Predictions will be accepted for one minute.</p><button className="primary-action" type="button" onClick={() => void sendRoundAction('/api/round/start')} disabled={actionBusy}>Start 60-second round <span aria-hidden="true">↗</span></button></>}
          {round?.status === 'open' && <><p>{secondsLeft === 0 ? 'The deadline has passed. The server is confirming the lock.' : 'Chat is open for predictions. The server locks the round when the countdown ends.'}</p><button className="secondary-action" type="button" onClick={() => void sendRoundAction('/api/round/lock')} disabled={actionBusy}>Lock predictions now</button></>}
          {round?.status === 'locked' && <><p className="locked-note"><span /> Predictions are locked. Enter the temperature you measured.</p><form className="result-form" onSubmit={(event) => { event.preventDefault(); void sendRoundAction('/api/round/result', { actualValue }); }}><label htmlFor="actual-result">Actual measured result <span>°C</span></label><div className="result-input-row"><input id="actual-result" value={actualValue} onChange={(event) => setActualValue(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="Enter observed temperature" required /><button className="primary-action" type="submit" disabled={actionBusy}>Finalize round <span aria-hidden="true">↗</span></button></div><small>Allowed range: {snapshot?.state.experiment.min ?? -273.15} to {snapshot?.state.experiment.max ?? 1000} °C</small></form></>}
          {round?.status === 'completed' && <><div className="actual-result"><span>MEASURED RESULT</span><strong>{round.actualValue} <i>°C</i></strong></div><p className="completed-note">Round {String(round.number).padStart(2, '0')} complete · {snapshot?.state.completedRounds.length} result{snapshot?.state.completedRounds.length === 1 ? '' : 's'} saved this session.</p><button className="primary-action" type="button" onClick={() => void sendRoundAction('/api/round/start')} disabled={actionBusy}>Start next 60-second round <span aria-hidden="true">↗</span></button></>}
          {actionError && <p className="action-error" role="alert">{actionError}</p>}
          <small className="control-security">Controls accept requests only from this local dashboard.</small>
        </div>
      </article>

      <article className="predictions-card panel">
        <div className="predictions-heading"><div><div className="panel-kicker"><span className="kicker-number">02</span><span>THE CROWD</span></div><h2>Predictions<span className="title-period">.</span></h2></div><span className={`feed-label ${socketConnected ? 'feed-on' : ''}`}><i /> LIVE FEED</span></div>
        <div className="stat-row"><div><strong>{participants.toString().padStart(2, '0')}</strong><span>PARTICIPANTS</span></div><div className="stat-separator"/><div><strong>{snapshot?.state.predictions.length.toString().padStart(2, '0') ?? '—'}</strong><span>ACCEPTED GUESSES</span></div></div>
        <div className={`list-header ${isCompleted ? 'ranked-header' : ''}`}><span>{isCompleted ? 'RANK · VIEWER' : 'VIEWER'}</span><span>PREDICTION</span><span>{isCompleted ? 'ABS. ERROR' : round?.status === 'locked' ? 'LOCKED' : 'STATUS'}</span></div>
        <div className="prediction-list" aria-live="polite" aria-label="Accepted viewer predictions">
          {loading ? <div className="list-message"><span className="loading-mark"/>Loading the current round…</div> : !snapshot ? <div className="list-message error-text">Could not load the current experiment. Check the server.</div> : isCompleted && snapshot.state.leaderboard.length > 0 ? snapshot.state.leaderboard.map((entry) => <div className="prediction-row ranked-row" key={entry.prediction.userId}><div className="viewer-cell"><span className="rank-chip">{entry.rank}</span><span className={`avatar avatar-${entry.prediction.username.charCodeAt(0) % 4}`}>{entry.prediction.username.slice(0, 1).toUpperCase()}</span><span className="viewer-name">{entry.prediction.username}</span></div><strong className="guess">{entry.prediction.value}<span> °C</span></strong><strong className="error-value">{entry.absoluteError.toFixed(2)}<span> °C</span></strong></div>) : snapshot.state.predictions.length === 0 ? <div className="empty-state"><div className="empty-icon">⌁</div><strong>{round?.status === 'ready' ? 'Ready for the first round' : round?.status === 'completed' ? 'No predictions in this round' : 'No predictions yet'}</strong><span>{round?.status === 'open' ? 'The first guess from chat will show up here.' : round?.status === 'locked' ? 'No guesses arrived before the round was locked.' : round?.status === 'completed' ? 'This round finished without accepted guesses.' : 'Predictions will appear here once the round opens.'}</span><small>{round?.status === 'open' ? <>Round closes in <b>{countdown}</b></> : round?.status === 'locked' ? 'Round locked' : round?.status === 'completed' ? 'No predictions were submitted' : 'Waiting for streamer to start'}<span className="wait-dots">···</span></small></div> : snapshot.state.predictions.map((prediction) => <div className="prediction-row" key={prediction.userId}><div className="viewer-cell"><span className={`avatar avatar-${prediction.username.charCodeAt(0) % 4}`}>{prediction.username.slice(0, 1).toUpperCase()}</span><span className="viewer-name">{prediction.username}</span></div><strong className="guess">{prediction.value}<span> °C</span></strong><span className={`accepted ${prediction.source === 'local-test' ? 'simulated' : ''}`}><i />{prediction.source === 'twitch' ? round?.status === 'locked' ? 'LOCKED' : 'ACCEPTED' : 'LOCAL TEST'}</span></div>)}
        </div>
        <div className="feed-foot"><span><i className={socketConnected ? 'foot-live' : ''}/>{socketConnected ? 'UPDATING IN REAL TIME' : 'LIVE UPDATES RECONNECTING'}</span><span>ONE GUESS PER VIEWER</span></div>
      </article>
    </section>

    <section className="insights-panel panel" aria-labelledby="insights-title">
      <div className="insights-heading">
        <div>
          <div className="panel-kicker"><span className="kicker-number">03</span><span>THE SIGNAL</span></div>
          <h2 id="insights-title">Live Experiment Insights<span className="title-period">.</span></h2>
          <p>What the accepted predictions say about this round.</p>
        </div>
        {connection?.mode === 'local-test' && <span className="insights-mode">SIMULATED · NOT TWITCH</span>}
      </div>

      <div className="insights-grid" aria-live="polite">
        <article className="insight-card"><span className="insight-label">VALID PREDICTIONS</span><strong>{insights?.predictionCount ?? '—'}</strong><small>{insights?.predictionCount ? 'Accepted for this round' : round?.status === 'ready' ? 'Round has not opened yet' : 'No valid predictions yet'}</small></article>
        <article className="insight-card"><span className="insight-label">MEAN CROWD PREDICTION</span><strong>{formatValue(insights?.meanPrediction ?? null)}{insights?.meanPrediction !== null && insights?.meanPrediction !== undefined && <i> {snapshot?.state.experiment.unit}</i>}</strong><small>{insights?.predictionCount ? `Average of ${insights.predictionCount} valid ${insights.predictionCount === 1 ? 'prediction' : 'predictions'}` : 'Available when valid predictions arrive'}</small></article>
        <article className="insight-card"><span className="insight-label">ACTUAL MEASUREMENT</span><strong>{insights?.resultStatus === 'valid' ? <>{formatValue(insights.actualValue)}<i> {snapshot?.state.experiment.unit}</i></> : insights?.resultStatus === 'invalid' ? 'Unavailable' : 'Pending'}</strong><small>{insights?.resultStatus === 'valid' ? 'Measured result for this round' : insights?.resultStatus === 'invalid' ? 'Missing or outside the accepted range' : round?.status === 'locked' ? 'Waiting for the measured result' : 'Shown after the round is completed'}</small></article>
        <article className="insight-card"><span className="insight-label">CROWD ABSOLUTE ERROR</span><strong>{insights?.crowdAbsoluteError === null || insights?.crowdAbsoluteError === undefined ? '—' : <>{formatValue(insights.crowdAbsoluteError)}<i> {snapshot?.state.experiment.unit}</i></>}</strong><small>{insights?.resultStatus === 'invalid' ? 'Unavailable without a valid measurement' : insights?.resultStatus !== 'valid' ? 'Available after a valid result is entered' : insights.predictionCount === 0 ? 'No crowd estimate to compare' : 'Distance from the mean to the result'}</small></article>
        <article className="insight-card"><span className="insight-label">DIFFERENCE · CROWD − ACTUAL</span><strong>{formatDifference(insights?.crowdDifference ?? null, snapshot?.state.experiment.unit ?? '°C')}</strong><small>{insights?.resultStatus !== 'valid' ? insights?.resultStatus === 'invalid' ? 'Unavailable without a valid measurement' : 'Available after a valid result is entered' : insights.predictionCount === 0 ? 'No crowd estimate to compare' : 'Positive means the crowd mean was higher'}</small></article>
        <article className="insight-card insight-closest"><span className="insight-label">CLOSEST INDIVIDUAL GUESS</span>
          {insights?.closestStatus === 'available' ? <div className="closest-list">{insights.closest.map((winner) => <div className="closest-person" key={winner.userId}><strong>{winner.username}</strong><span>{formatValue(winner.value)} {snapshot?.state.experiment.unit}<small> · {formatValue(winner.absoluteError)} error</small></span></div>)}</div> : <strong className="insight-placeholder">{insights?.closestStatus === 'empty' ? 'No predictions to score' : insights?.closestStatus === 'unavailable' ? 'Leaderboard unavailable' : insights?.resultStatus === 'invalid' ? 'Result unavailable' : 'Shown after scoring'}</strong>}
          <small>{insights?.closestStatus === 'available' ? `${insights.closest.length} viewer${insights.closest.length === 1 ? '' : 's'} tied for closest` : 'Uses the server-ranked result; ties are shown together'}</small>
        </article>
      </div>
    </section>

    {connection?.mode === 'local-test' && <section className="test-panel panel"><div><p className="eyebrow">LOCAL SIMULATOR</p><h2>Try a sample chat message</h2><p>These submissions are simulated and visibly marked. They never count as Twitch activity.</p></div><form onSubmit={submitLocal}><label>Display name<input value={testName} onChange={(event) => setTestName(event.target.value)} maxLength={50} required /></label><label>Test user ID<input value={testId} onChange={(event) => setTestId(event.target.value)} maxLength={80} required /></label><label>Chat message<input value={testText} onChange={(event) => setTestText(event.target.value)} maxLength={200} required /></label><button type="submit">Submit test message <span aria-hidden="true">↗</span></button>{testNotice && <p className="test-notice" role="status">{testNotice}</p>}</form></section>}

    <footer><span>© 2026 CROWDLAB</span><span>REAL EXPERIMENTS. REAL PEOPLE. REAL RESULTS.</span><span>PHASE 04 <i>●</i></span></footer>
  </main>;
}
