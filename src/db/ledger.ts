import { query } from './client';
import { LedgerEvent } from '../types/lios';

export async function writeLedger(
  entityType: string,
  entityId:   string,
  eventType:  LedgerEvent,
  payload:    Record<string, unknown>,
  tenantId:   string,
): Promise<void> {
  await query(
    `INSERT INTO lios_ledgers (entity_type, entity_id, event_type, payload, tenant_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityType, entityId, eventType, JSON.stringify(payload), tenantId],
  );
}
