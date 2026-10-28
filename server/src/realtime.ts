import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ExperimentState } from './predictions.js';
import type { ConnectionStatus } from './twitch.js';

export type PublicState = { state: ExperimentState; connection: ConnectionStatus };

export function createRealtimeServer(server: Server, getState: () => PublicState): { broadcast: () => void; close: () => void } {
  const sockets = new WebSocketServer({ server, path: '/ws' });
  const sendState = (socket: WebSocket) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify({ type: 'state', data: getState() })); }
    catch { socket.close(1011, 'Could not send current CrowdLab state'); }
  };
  sockets.on('connection', (socket) => {
    socket.on('error', () => socket.close());
    socket.on('message', () => socket.send(JSON.stringify({ type: 'error', message: 'Client messages are not accepted.' })));
    sendState(socket);
  });
  return {
    broadcast: () => { for (const socket of sockets.clients) sendState(socket); },
    close: () => {
      for (const socket of sockets.clients) socket.close(1001, 'CrowdLab shutting down');
      sockets.close();
    },
  };
}
