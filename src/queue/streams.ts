import { redis } from './redis';

export const QUEUES = {
  INTENT:   'lios:queue:intent',
  DECISION: 'lios:queue:decision',
  REPLY:    'lios:queue:reply',
  LEDGER:   'lios:queue:ledger',
} as const;

export const GROUPS = {
  INTENT:   'intent-workers',
  DECISION: 'decision-workers',
  REPLY:    'reply-workers',
  LEDGER:   'ledger-workers',
} as const;

export async function ensureGroups(): Promise<void> {
  for (const [key, queue] of Object.entries(QUEUES)) {
    const group = GROUPS[key as keyof typeof GROUPS];
    try {
      await redis.xgroup('CREATE', queue, group, '$', 'MKSTREAM');
    } catch (e: unknown) {
      if (!(e as Error).message?.includes('BUSYGROUP')) throw e;
    }
  }
}

export async function pushToQueue(queue: string, fields: Record<string, string>): Promise<void> {
  const flat: string[] = [];
  for (const [k, v] of Object.entries(fields)) flat.push(k, v);
  await redis.xadd(queue, '*', ...flat);
}

// Returns parsed messages from a consumer group.
// Uses 'BLOCK 2000' so the loop yields to the event loop when idle.
export async function consumeGroup(
  queue:    string,
  group:    string,
  consumer: string,
  count = 5,
  blockMs = 2000,
): Promise<Array<{ id: string; fields: Record<string, string> }>> {
  const raw = await (redis as unknown as {
    xreadgroup(...args: unknown[]): Promise<[string, [string, string[]][]][] | null>
  }).xreadgroup(
    'GROUP', group, consumer,
    'COUNT', count,
    'BLOCK', blockMs,
    'STREAMS', queue, '>',
  );

  if (!raw) return [];

  const out: Array<{ id: string; fields: Record<string, string> }> = [];
  for (const [, entries] of raw) {
    for (const [id, flat] of entries) {
      const fields: Record<string, string> = {};
      for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
      out.push({ id, fields });
    }
  }
  return out;
}

export async function ackMsg(queue: string, group: string, id: string): Promise<void> {
  await redis.xack(queue, group, id);
}
