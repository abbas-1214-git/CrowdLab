# CrowdLab

**Predict. Measure. Prove.** CrowdLab is a Twitch-connected experiment dashboard. Chat viewers submit a numeric temperature prediction with `!predict 85`; the streamer locks the round, records the measured temperature, and the dashboard ranks predictions by absolute error.

## Implemented

- Twitch user OAuth authorization-code flow handled entirely by the Node server.
- Twitch user-token validation, hourly revalidation, and in-memory refresh-token renewal.
- EventSub WebSocket `channel.chat.message` subscription and Twitch-requested session migration.
- Numeric `!predict` parsing with case-insensitive command, decimal support, inclusive configurable bounds, and one accepted submission per Twitch user ID.
- Server-to-browser WebSocket updates and a full state snapshot for new/reconnected browsers.
- Explicit Twitch, disconnected, reconnecting, error, and local-test status. Simulated predictions are marked as local test.
- Responsive React/Vite dashboard, empty/loading/error states, and automated parser/store/WebSocket tests.
- Backend-authoritative round states: Ready → Open → Locked → Completed. A 60-second server timer closes the round automatically; the streamer can lock it earlier.
- Locked-only actual measurement entry, server-calculated absolute errors, ranked results with equal ranks for ties, and completed-round history retained for the current server session.
- Live Experiment Insights summarize accepted predictions, the unrounded crowd mean, and post-result crowd/individual errors from the current server state.
- Transparent stream overlay at `/overlay` for the countdown, lock state and measured result/podium, driven by the same backend state feed as the dashboard.
- Local dashboard controls restricted to loopback requests and the allowed local frontend origins; hiding controls in React is not the authorization check.

## Not implemented

No configurable experiment editor, adjustable timer, database, persistent token or round storage, chat replies, production hosting, or multi-channel control authorization. The current experiment configuration is fixed to the temperature example. Completed results and tokens are in memory and are cleared when the server stops.

## Requirements and structure

- Node.js 20 or newer (developed with Node 24.19.0)
- npm (developed with npm 11.17.0)
- A Twitch account and a Twitch developer application for real chat; no paid service is required.

```text
client/src/       React interface and responsive styles
server/src/       Express API, OAuth/EventSub, game state machine, scoring, and WebSocket state bridge
index.html        Vite entry document
package.json      Dependencies and commands
.env.example      Placeholder configuration only
```

## Twitch developer application setup

This local setup treats the broadcaster account as an **Installed Chatbot**. The user who authorizes CrowdLab must own the channel being watched, and the same login must be set as `TWITCH_CHANNEL_LOGIN`. It requests only the `user:read:chat` permission. Supporting a separate bot account or another broadcaster requires a different consent arrangement and is outside this Phase 1 path.

1. In the [Twitch Developer Console](https://dev.twitch.tv/console/apps), register a new application. Set OAuth Redirect URL to exactly `http://localhost:3001/auth/twitch/callback` and choose the category that fits the app.
2. Copy the Client ID and generate a Client Secret. Keep both in the server-side `.env`; never put them in `VITE_*` variables or source control.
3. Copy `.env.example` to `.env` and fill in the values:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_REDIRECT_URI`, and `TWITCH_CHANNEL_LOGIN`. The login must be the Twitch account that will authorize the app and owns the test channel. Keep `LOCAL_TEST_MODE=false` for a Twitch run.

4. Install dependencies and start CrowdLab:

   ```powershell
   npm.cmd ci
   npm.cmd run dev
   ```

5. Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and choose **Connect Twitch account**. Sign into the Twitch account for the configured channel and grant the requested chat-read permission. Twitch returns to the local callback; the dashboard status changes to **TWITCH LIVE** only after EventSub's subscription is accepted.
6. In that Twitch channel, send `!predict 85` from a chat account. A valid first prediction appears in the CrowdLab dashboard. The same Twitch user ID can submit only once per server run/round. A non-number or out-of-range value is ignored; a repeat is not inserted.

Official Twitch references used for this implementation:

- [Chat authentication and EventSub](https://dev.twitch.tv/docs/chat/authenticating/)
- [Receiving chat messages](https://dev.twitch.tv/docs/chat/send-receive-messages/)
- [EventSub WebSocket handling and reconnect protocol](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)
- [Authorization-code OAuth flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Validating OAuth tokens](https://dev.twitch.tv/docs/authentication/validate-tokens/)
- [Registering an application](https://dev.twitch.tv/docs/authentication/register-app/)

The code follows Twitch's documented local installed-chatbot model: a user access token with `user:read:chat`, `/oauth2/validate`, a `channel.chat.message` version 1 EventSub subscription using the welcome session ID, and the provided reconnect URL for session migration. For a dropped connection it reconnects and subscribes to the new session again. OAuth code and refresh tokens are held in memory only.

## Built with Codex

Codex was used as a development assistant to implement and review CrowdLab's Twitch OAuth and EventSub connection, server-authoritative prediction and scoring flow, dashboard, stream overlay, and Live Experiment Insights. Codex also helped add focused automated regression tests and review the local prototype's reliability and security boundaries. CrowdLab's runtime does not call an AI API; predictions, rankings, and Insights are calculated from the server's game state.

## Commands

```powershell
npm.cmd ci               # install the locked dependencies
npm run dev              # API on 127.0.0.1:3001 and Vite on 127.0.0.1:5173
npm.cmd run dev:server    # API only (useful when running the dashboard separately)
npm.cmd run dev:client    # dashboard only; VITE_PORT is strict and will fail if occupied
npm.cmd test              # automated Vitest checks
npm.cmd run typecheck     # TypeScript checks for client and server
npm.cmd run build         # typecheck plus Vite production client build
npm start                # start the API only (tsx; intended for local development)
```

### Startup and health check (PowerShell)

Before starting, check the ports and leave any existing listeners alone:

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object LocalPort -in 3001,5173,3101,5181 |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

When the configured ports `3001` and `5173` are free, run `npm.cmd run dev` and open `http://127.0.0.1:5173`. The backend binds to `127.0.0.1:3001`; the Vite server binds to `127.0.0.1:5173` and fails instead of silently choosing another port. Verify both services from the same PowerShell session:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3001/api/health -TimeoutSec 5
Invoke-WebRequest -Uri http://127.0.0.1:5173/ -TimeoutSec 5 -UseBasicParsing |
  Select-Object StatusCode,RawContentLength
```

The health route is `GET /api/health`; it returns only `{"ok":true}`. It reports HTTP service health separately from Twitch. Check Twitch in the dashboard: only `TWITCH LIVE` means EventSub accepted the chat subscription.

If those ports are occupied, do not stop the owning processes. Check that `3101` and `5181` are free, update the Twitch Developer Console redirect URL to `http://localhost:3101/auth/twitch/callback`, then start CrowdLab in a PowerShell session with these temporary overrides:

```powershell
$env:SERVER_PORT = '3101'
$env:CLIENT_ORIGIN = 'http://127.0.0.1:5181'
$env:VITE_PORT = '5181'
$env:VITE_SERVER_URL = 'http://127.0.0.1:3101'
$env:TWITCH_REDIRECT_URI = 'http://localhost:3101/auth/twitch/callback'
npm.cmd run dev
```

Open `http://127.0.0.1:5181`; verify with `Invoke-RestMethod -Uri http://127.0.0.1:3101/api/health -TimeoutSec 5` and `Invoke-WebRequest -Uri http://127.0.0.1:5181/ -TimeoutSec 5 -UseBasicParsing`. These values apply only to that PowerShell session and keep the API, dashboard origin, and OAuth callback aligned. Use the matching callback URL in the Twitch Developer Console. Do not publish the backend on a non-loopback interface.

The default development ports are `3001` (API) and `5173` (dashboard). Both services bind to loopback. Vite uses a strict port so it cannot silently move the dashboard to a different port while the API still expects the old origin. If either default is occupied, set matching values in `.env` and the Twitch Developer Console before starting, for example:

```dotenv
SERVER_PORT=3101
CLIENT_ORIGIN=http://127.0.0.1:5181
VITE_PORT=5181
VITE_SERVER_URL=http://127.0.0.1:3101
TWITCH_REDIRECT_URI=http://localhost:3101/auth/twitch/callback
```

Update the Twitch application's redirect URL to the same `3101` callback. Then run `npm.cmd run dev` from the repository root and open `http://127.0.0.1:5181`. If only one port is occupied, choose another free port for that service and keep `CLIENT_ORIGIN`, `VITE_PORT`, `VITE_SERVER_URL`, `SERVER_PORT`, and the OAuth redirect URI consistent as shown. The port check is local to the developer machine; it does not reserve ports between the check and startup.

To try the clearly labeled simulator without Twitch credentials, set `LOCAL_TEST_MODE=true` in `.env`, restart `npm run dev`, and use the local dashboard controls:

1. Click **Start 60-second round**.
2. Submit one or more sample messages in the Local Simulator panel. Each is visibly marked `LOCAL TEST`.
3. Click **Lock predictions now** or wait for the server countdown to finish.
4. Enter the actual test measurement you want to use and finalize the round. The leaderboard is calculated from that value.
5. Click **Start next 60-second round** to confirm a new round opens and the prior result remains in session history.

This proves local game logic and browser updates only; it is not Twitch verification. Change `LOCAL_TEST_MODE` back to `false` and restart for a real integration run.

## Stream overlay

Open `http://127.0.0.1:5173/overlay` while CrowdLab is running, or use the configured Vite port. The dashboard's **Open stream overlay** link opens this page separately. It has a transparent page background outside its card, so it can be added to OBS as a Browser Source (start with 560 × 500 pixels). The overlay follows the current round through the backend WebSocket: it shows the countdown while predictions are open, a locked/waiting scene after intake closes, and the measured result plus the server-ranked top three after the round is completed. The podium uses the backend's `actualValue`, ranks and absolute errors; the browser does not calculate winners. Local-test mode is visibly labeled simulated. No API key or additional service is required.

## Live Experiment Insights

The dashboard summarizes the current round's accepted prediction count and mean. Once the server marks the round complete with an in-range measured value, it also shows the crowd mean's absolute error and signed difference, plus every viewer tied at server rank 1. Empty, locked and unavailable-result states are labeled explicitly. Local-test data is marked simulated. These are descriptive per-round metrics; they do not claim that the crowd is more accurate than an individual or another baseline.

## Test and verify

Automated checks cover the parser and store, game loop, authoritative deadline handling, decimal scoring ties, repeated/invalid control requests, allowed local control origins, reconnect snapshots/state broadcasts, Insights precision and empty-result states, and the overlay's deadline and result-state model. They do not call Twitch or exercise a live Twitch reconnect. Chat text and usernames are rendered as React text nodes. EventSub notifications are checked against the configured broadcaster and deduplicated by Twitch message ID before entering the game state machine.

For manual end-to-end verification:

1. Complete the Twitch application and `.env` setup above.
2. Run `npm run dev`, open the dashboard, and authorize the configured channel owner.
3. Wait for **TWITCH LIVE** and the message `Receiving Twitch chat from #...`.
4. Start the round. Send `!predict 85` in the real Twitch channel from a chat account and observe the prediction appear without entering it in CrowdLab.
5. Send an invalid value and a second valid command from the same viewer; neither should add a prediction.
6. Lock manually or wait for the countdown. Confirm later chat messages do not change the prediction list.
7. Enter the experiment's observed temperature and finalize. Confirm the displayed actual result, original guesses, absolute errors, and ranking. Equal errors should have equal rank.
8. Start the next round and confirm its predictions reset while the completed result remains visible in session history.
9. Open or reload a second dashboard tab and confirm it receives current state. Stop the backend briefly and confirm its connection status leaves live. Restarting clears in-memory rounds and requires Twitch authorization again.

The project handoff states that a real Twitch message was previously observed. No new Twitch authorization or message is performed by these automated and local simulator checks; they do not re-verify the live connection.

## Troubleshooting

- **Redirect mismatch / OAuth error:** The redirect URL must exactly match `http://localhost:3001/auth/twitch/callback` in both `.env` and the Twitch Developer Console. Restart the server after editing `.env`.
- **Authorized account mismatch:** `TWITCH_CHANNEL_LOGIN` must match the account that authorized CrowdLab and owns the target channel. This initial installed-chatbot setup listens to that account's own channel.
- **Missing scope:** Disconnect the app in Twitch account connections if needed, then click Connect again and grant `user:read:chat`.
- **Subscription rejected / 401:** Verify the Client ID and secret belong to the registered app, consent is still valid, the channel login is correct, and the account has the requested permission. Server logs intentionally do not print credentials.
- **WebSocket not updating:** Check the server terminal and browser connection. Twitch status is separate from the frontend-to-backend live-feed connection.
- **Unexpected disconnect:** CrowdLab retries the EventSub WebSocket. A normal Twitch `session_reconnect` migrates to Twitch's supplied URL; a lost session opens a new socket and subscribes again.
- **Control action returns 403:** Start/lock/finalize controls require a loopback connection and an allowed local dashboard `Origin`. Open the app at the documented local URL instead of a remote hostname.

## Security and limitations

- Client secret, OAuth access token and refresh token stay on the server; no credential is exposed to Vite or browser code.
- `.env` is ignored by Git. `.env.example` contains placeholders only.
- Local OAuth state expires after ten minutes and is single-use. Tokens are validated at authorization and every hour; the refresh token renews access in memory.
- This is a localhost development app. It has no persistent storage, production cookie/session model, deployment hardening, rate limiting, or multi-channel authorization flow.
- The only implemented experiment is the temperature round with default inclusive bounds −273.15°C to 1000°C; `PREDICTION_MIN` and `PREDICTION_MAX` change them.
- No Twitch-connected state is claimed before both user-token validation and a successful enabled subscription response.
- Round controls are local-only for this prototype. There is no streamer login/role model for remote control panels.
