import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { ExperimentGame } from './game.js';

export type ConnectionStatus = {
  status: 'disconnected' | 'connecting' | 'authenticated' | 'subscribed' | 'reconnecting' | 'error';
  mode: 'twitch' | 'local-test' | 'unconfigured';
  message: string;
  channel?: string;
};

type TwitchConfig = { clientId: string; clientSecret: string; redirectUri: string; channelLogin: string; configured: boolean; localTestMode: boolean };
type OAuthTokens = { access_token: string; refresh_token: string; expires_in: number };
type SocketEnvelope = { metadata?: { message_id?: string; message_type?: string; subscription_type?: string }; payload?: any };
type TargetChatEvent = { broadcaster_user_id: string; broadcaster_user_login: string; chatter_user_id: string; chatter_user_name: string; message: { text: string } };

export function isTargetChatEvent(event: unknown, broadcasterId: string, channelLogin: string): event is TargetChatEvent {
  if (!event || typeof event !== 'object') return false;
  const candidate = event as Partial<TargetChatEvent>;
  return candidate.broadcaster_user_id === broadcasterId &&
    typeof candidate.broadcaster_user_login === 'string' && candidate.broadcaster_user_login.toLowerCase() === channelLogin &&
    typeof candidate.chatter_user_id === 'string' && typeof candidate.chatter_user_name === 'string' &&
    typeof candidate.message?.text === 'string';
}

export class EventMessageDeduplicator {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity = 2_000) {}
  hasSeen(id: string): boolean {
    if (!id || this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.capacity) this.ids.delete(this.ids.values().next().value!);
    return false;
  }
}

export class TwitchChat {
  private readonly pendingStates = new Map<string, number>();
  private accessToken = '';
  private refreshToken = '';
  private userId = '';
  private tokenExpiry = 0;
  private eventSocket?: WebSocket;
  private refreshTimer?: NodeJS.Timeout;
  private validationTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private retryCount = 0;
  private readonly seenMessageIds = new EventMessageDeduplicator();
  private stopped = false;
  private status: ConnectionStatus;

  constructor(private readonly config: TwitchConfig, private readonly store: ExperimentGame, private readonly onChange: () => void) {
    this.status = {
      status: 'disconnected',
      mode: config.localTestMode ? 'local-test' : config.configured ? 'twitch' : 'unconfigured',
      message: config.localTestMode ? 'Local-test mode is enabled. Twitch messages are not being received.' : config.configured ? 'Connect a Twitch account to begin.' : 'Add Twitch app settings to .env to enable connection.',
      ...(config.channelLogin ? { channel: config.channelLogin } : {}),
    };
  }

  getStatus(): ConnectionStatus { return { ...this.status }; }

  newAuthorization(): { url: string; state: string } {
    if (!this.config.configured || this.config.localTestMode) throw new Error('Twitch authentication is not configured for this run.');
    const state = randomBytes(24).toString('hex');
    this.pendingStates.set(state, Date.now() + 10 * 60_000);
    for (const [key, expires] of this.pendingStates) if (expires < Date.now()) this.pendingStates.delete(key);
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code', scope: 'user:read:chat', state }).toString();
    return { url: url.toString(), state };
  }

  async completeAuthorization(code: string, state: string): Promise<void> {
    const expiry = this.pendingStates.get(state);
    if (!expiry || expiry < Date.now()) throw new Error('Twitch authorization expired or could not be verified. Please connect again.');
    this.pendingStates.delete(state);
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, grant_type: 'authorization_code', redirect_uri: this.config.redirectUri }) });
      const body = await response.json() as OAuthTokens & { message?: string };
      if (!response.ok || !body.access_token || !body.refresh_token) throw new Error(body.message ?? `Token exchange failed (${response.status}).`);
      this.accessToken = body.access_token;
      this.refreshToken = body.refresh_token;
      await this.validateToken(true);
      if (!this.accessToken) throw new Error('The Twitch token did not include the required user:read:chat permission.');
      this.stopped = false;
      this.retryCount = 0;
      this.setStatus('authenticated', 'Twitch account authenticated. Starting the chat connection.');
      this.scheduleTokenRefresh(body.expires_in);
      this.validationTimer && clearInterval(this.validationTimer);
      this.validationTimer = setInterval(() => void this.validateToken(false).catch(() => this.fail('Twitch authorization expired. Reconnect your account.')), 60 * 60_000);
      this.connectEventSub('wss://eventsub.wss.twitch.tv/ws', false);
    } catch (error) {
      this.accessToken = '';
      this.refreshToken = '';
      this.setStatus('error', this.safeError(error, 'Twitch authentication failed. Check app credentials, redirect URI, and granted permission.'));
      throw error;
    }
  }

  private async validateToken(throwOnFailure: boolean): Promise<void> {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${this.accessToken}` } });
    if (!response.ok) {
      if (throwOnFailure) throw new Error('Twitch rejected the access token.');
      throw new Error('Twitch authorization expired.');
    }
    const body = await response.json() as { client_id: string; user_id: string; login: string; scopes: string[]; expires_in: number };
    if (body.client_id !== this.config.clientId || !body.user_id || !body.scopes.includes('user:read:chat')) throw new Error('Twitch token is missing the expected app identity or user:read:chat permission.');
    this.userId = body.user_id;
    if (body.login.toLowerCase() !== this.config.channelLogin) throw new Error(`Authorized account @${body.login} must match TWITCH_CHANNEL_LOGIN (${this.config.channelLogin}) for this local installed-chatbot setup.`);
    this.tokenExpiry = Date.now() + body.expires_in * 1000;
  }

  private scheduleTokenRefresh(expiresIn: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refreshAccessToken(), Math.max(30_000, (expiresIn - 120) * 1000));
    this.refreshTimer.unref();
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) return this.fail('The Twitch session cannot be refreshed. Reconnect your account.');
    try {
      const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, grant_type: 'refresh_token', refresh_token: this.refreshToken }) });
      const body = await response.json() as Partial<OAuthTokens> & { message?: string };
      if (!response.ok || !body.access_token || !body.refresh_token || !body.expires_in) throw new Error(body.message ?? `Token refresh failed (${response.status}).`);
      this.accessToken = body.access_token;
      this.refreshToken = body.refresh_token;
      await this.validateToken(true);
      this.scheduleTokenRefresh(body.expires_in);
    } catch (error) { this.fail(this.safeError(error, 'Twitch authorization could not be refreshed. Reconnect your account.')); }
  }

  private connectEventSub(url: string, inheritedSession: boolean): void {
    if (this.stopped) return;
    this.setStatus(inheritedSession ? 'reconnecting' : 'connecting', inheritedSession ? 'Moving the Twitch chat connection.' : 'Connecting to Twitch EventSub.');
    const socket = new WebSocket(url);
    const previousSocket = this.eventSocket;
    this.eventSocket = socket;
    socket.on('message', (raw) => {
      let message: SocketEnvelope;
      try { message = JSON.parse(raw.toString()) as SocketEnvelope; }
      catch { this.fail('Twitch sent an unreadable EventSub message.'); socket.close(); return; }
      const type = message.metadata?.message_type;
      if (type === 'session_welcome') {
        if (inheritedSession) {
          this.retryCount = 0;
          if (previousSocket && previousSocket !== socket) previousSocket.close(1000, 'Twitch session migrated');
          this.setStatus('subscribed', `Receiving Twitch chat from #${this.config.channelLogin}.`);
        } else {
          const sessionId = message.payload?.session?.id;
          if (typeof sessionId !== 'string' || !sessionId) { this.fail('Twitch EventSub welcome did not include a session ID.'); socket.close(); return; }
          void this.subscribe(sessionId);
        }
      } else if (type === 'notification' && message.metadata?.subscription_type === 'channel.chat.message') {
        const event = message.payload?.event;
        const messageId = message.metadata.message_id;
        if (!messageId || !isTargetChatEvent(event, this.userId, this.config.channelLogin) || this.seenMessageIds.hasSeen(messageId)) return;
        this.store.submit({ userId: event.chatter_user_id, username: event.chatter_user_name, text: event.message.text, source: 'twitch' });
      } else if (type === 'session_reconnect') {
        const reconnectUrl = message.payload?.session?.reconnect_url;
        if (typeof reconnectUrl === 'string' && reconnectUrl.startsWith('wss://')) this.connectEventSub(reconnectUrl, true);
        else { this.setStatus('reconnecting', 'Twitch provided an invalid reconnect address. Opening a new session.'); socket.close(); }
      } else if (type === 'revocation') {
        this.fail('Twitch revoked the chat subscription. Reconnect your account.');
      }
    });
    socket.on('error', () => {
      if (this.eventSocket === socket) this.setStatus('reconnecting', 'Twitch connection interrupted. Trying again.');
    });
    socket.on('close', () => {
      if (this.stopped || this.eventSocket !== socket) return;
      this.setStatus('reconnecting', 'Twitch disconnected. Reconnecting and restoring the chat subscription.');
      this.scheduleReconnect();
    });
  }

  private async subscribe(sessionId: string): Promise<void> {
    try {
      const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${this.accessToken}`, 'Client-Id': this.config.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: this.userId, user_id: this.userId }, transport: { method: 'websocket', session_id: sessionId } }),
      });
      const body = await response.json() as { data?: Array<{ id?: string; status?: string }>; message?: string; error?: string };
      if (response.status !== 202 || body.data?.[0]?.status !== 'enabled' || !body.data[0].id) throw new Error(body.message ?? body.error ?? `EventSub subscription failed (${response.status}).`);
      this.retryCount = 0;
      this.setStatus('subscribed', `Receiving Twitch chat from #${this.config.channelLogin}.`);
    } catch (error) {
      this.fail(this.safeError(error, 'Could not subscribe to channel.chat.message. Check Twitch authorization and channel settings.'));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retryCount++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.accessToken) return this.fail('Twitch authorization is missing. Reconnect your account.');
      this.connectEventSub('wss://eventsub.wss.twitch.tv/ws', false);
    }, delay);
    this.reconnectTimer.unref();
  }

  private safeError(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : '';
    return message && !/(token|secret|authorization:|bearer\s)/i.test(message) ? message : fallback;
  }

  private fail(message: string): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.validationTimer) clearInterval(this.validationTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.setStatus('error', message);
    this.eventSocket?.close();
  }

  private setStatus(status: ConnectionStatus['status'], message: string): void {
    this.status = { status, mode: 'twitch', message, channel: this.config.channelLogin };
    this.onChange();
  }

  shutdown(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.validationTimer) clearInterval(this.validationTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.eventSocket?.removeAllListeners();
    this.eventSocket?.close(1000, 'CrowdLab shutting down');
  }
}
