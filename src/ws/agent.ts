/**
 * Agent desk WebSocket server (port 3212).
 * Subscriptions are tenant-scoped: each connected human agent subscribes to their tenant
 * and receives `session_created` / `message_received` events for live updates.
 */

import { WebSocketServer, WebSocket } from 'ws';

// tenant_id → connected agent client sockets
const subs = new Map<string, Set<WebSocket>>();

export type AgentEventType =
  | 'session_created'    // a new human-handoff session just opened
  | 'message_received'   // a new user message arrived in an existing session
  | 'session_updated';   // status / assignment changed

export function initAgentWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ port: 3212 });

  wss.on('connection', (ws: WebSocket) => {
    let myTenant: string | null = null;

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; tenant_id?: string };
        if (msg.type === 'subscribe' && msg.tenant_id) {
          myTenant = msg.tenant_id;
          if (!subs.has(myTenant)) subs.set(myTenant, new Set());
          subs.get(myTenant)!.add(ws);
          ws.send(JSON.stringify({ type: 'subscribed', tenant_id: myTenant }));
        }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch { /* ignore malformed */ }
    });

    ws.on('close', () => {
      if (myTenant) subs.get(myTenant)?.delete(ws);
    });
  });

  console.log('[WS] Agent desk WebSocket server on :3212');
  return wss;
}

export function pushAgentEvent(
  tenantId: string,
  type:     AgentEventType,
  data:     Record<string, unknown>,
): void {
  const set = subs.get(tenantId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ type, tenant_id: tenantId, data, ts: Date.now() });
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}
