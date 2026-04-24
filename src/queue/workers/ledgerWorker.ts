import { query } from '../../db/client';
import { writeLedger } from '../../db/ledger';
import { pushProgress, cleanupTrace } from '../../ws/server';
import { consumeGroup, ackMsg, QUEUES, GROUPS } from '../streams';

async function processLedger(fields: Record<string, string>): Promise<void> {
  const { trace_id, tenant_id, intent_id, guarded_verdict } = fields;

  const statusMap: Record<string, string> = {
    accept: 'accepted', hold: 'held', reject: 'rejected',
  };
  const finalStatus = statusMap[guarded_verdict] ?? 'completed';

  await query(
    `UPDATE lios_intents SET status=$1, updated_at=NOW() WHERE id=$2`,
    [finalStatus, intent_id],
  ).catch(() => {});

  await writeLedger('intent', intent_id, 'ledger.closed', {
    final_state: finalStatus, trace_id, tenant_id,
  }, tenant_id).catch(() => {});

  pushProgress(trace_id, 'ledger_closed', { final_state: finalStatus });
  cleanupTrace(trace_id);
}

let _running = false;

export async function startLedgerWorker(): Promise<void> {
  if (_running) return;
  _running = true;
  console.log('[Worker:ledger] started');

  while (_running) {
    try {
      const msgs = await consumeGroup(QUEUES.LEDGER, GROUPS.LEDGER, 'ledger-1');
      for (const { id, fields } of msgs) {
        try {
          await processLedger(fields);
        } catch (err) {
          console.error('[Worker:ledger] processing error:', err);
        } finally {
          await ackMsg(QUEUES.LEDGER, GROUPS.LEDGER, id);
        }
      }
    } catch (err) {
      if (!(err as Error).message?.includes('NOGROUP')) console.error('[Worker:ledger] loop error:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

export function stopLedgerWorker(): void { _running = false; }
