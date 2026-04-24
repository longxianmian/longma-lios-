import { WebSocketServer, WebSocket } from 'ws';

// trace_id → connected clients
const subscriptions = new Map<string, Set<WebSocket>>();

export type ProgressStage =
  | 'analyzing_intent'
  | 'searching_kb'
  | 'intent_parsed'
  | 'running_kernel'
  | 'kernel_decided'
  | 'generating_reply'
  | 'reply_ready'
  | 'ledger_closed'
  | 'error';

export function initWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ port: 3211 });

  wss.on('connection', (ws: WebSocket) => {
    let myTrace: string | null = null;

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; trace_id?: string };
        if (msg.type === 'subscribe' && msg.trace_id) {
          myTrace = msg.trace_id;
          if (!subscriptions.has(myTrace)) subscriptions.set(myTrace, new Set());
          subscriptions.get(myTrace)!.add(ws);
          ws.send(JSON.stringify({ type: 'subscribed', trace_id: myTrace }));
        }
      } catch { /* ignore malformed messages */ }
    });

    ws.on('close', () => {
      if (!myTrace) return;
      const clients = subscriptions.get(myTrace);
      clients?.delete(ws);
      if (!clients?.size) subscriptions.delete(myTrace);
    });

    ws.on('error', () => ws.terminate());
  });

  console.log('[WS] WebSocket server listening on :3211');
  return wss;
}

export function pushProgress(
  traceId: string,
  stage:   ProgressStage,
  data:    Record<string, unknown> = {},
): void {
  const clients = subscriptions.get(traceId);
  if (!clients?.size) return;

  const payload = JSON.stringify({ type: 'progress', trace_id: traceId, stage, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

export function cleanupTrace(traceId: string, delayMs = 60_000): void {
  setTimeout(() => subscriptions.delete(traceId), delayMs);
}
