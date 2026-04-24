import { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { query, queryOne } from '../db/client';

interface LiosTenant {
  id:            string;
  tenant_id:     string;
  company_name:  string;
  contact_name:  string;
  email:         string;
  password_hash: string;
  industry:      string;
  company_size:  string;
  status:        'active' | 'disabled';
  token:         string;
  created_at:    Date;
  updated_at:    Date;
}

function hashPassword(pw: string): string {
  return createHash('sha256').update(pw + ':lios-salt-2026').digest('hex');
}

function makeTenantId(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 24)
    .replace(/^-|-$/g, '') || 'tenant';
  return `${slug}-${randomUUID().slice(0, 6)}`;
}

export async function tenantRoutes(app: FastifyInstance) {

  // ── POST /lios/tenants/register ──────────────────────────────────────────
  app.post<{
    Body: {
      company_name:  string;
      contact_name:  string;
      email:         string;
      password:      string;
      industry?:     string;
      company_size?: string;
    };
  }>('/lios/tenants/register', {
    schema: {
      body: {
        type: 'object',
        required: ['company_name', 'contact_name', 'email', 'password'],
        properties: {
          company_name:  { type: 'string', minLength: 1 },
          contact_name:  { type: 'string', minLength: 1 },
          email:         { type: 'string', minLength: 5 },
          password:      { type: 'string', minLength: 8 },
          industry:      { type: 'string' },
          company_size:  { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { company_name, contact_name, email, password, industry = '', company_size = '' } = req.body;

    const existing = await queryOne('SELECT id FROM lios_tenants WHERE email=$1', [email]);
    if (existing) return reply.code(409).send({ error: '该邮箱已注册' });

    const tenantId     = makeTenantId(company_name);
    const passwordHash = hashPassword(password);
    const token        = randomUUID();

    const [tenant] = await query<LiosTenant>(
      `INSERT INTO lios_tenants
         (tenant_id, company_name, contact_name, email, password_hash, industry, company_size, token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, tenant_id, company_name, token`,
      [tenantId, company_name, contact_name, email, passwordHash, industry, company_size, token]
    );

    return reply.code(201).send({
      tenant_id:    tenant.tenant_id,
      company_name: tenant.company_name,
      token:        tenant.token,
    });
  });

  // ── POST /lios/tenants/login ─────────────────────────────────────────────
  app.post<{ Body: { email: string; password: string } }>('/lios/tenants/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body;
    const passwordHash = hashPassword(password);

    const tenant = await queryOne<LiosTenant>(
      `SELECT * FROM lios_tenants WHERE email=$1 AND password_hash=$2`,
      [email, passwordHash]
    );

    if (!tenant) return reply.code(401).send({ error: '邮箱或密码错误' });
    if (tenant.status === 'disabled') return reply.code(403).send({ error: '账号已被禁用，请联系管理员' });

    const newToken = randomUUID();
    await query('UPDATE lios_tenants SET token=$1, updated_at=NOW() WHERE id=$2', [newToken, tenant.id]);

    return reply.code(200).send({
      tenant_id:    tenant.tenant_id,
      company_name: tenant.company_name,
      token:        newToken,
    });
  });

  // ── GET /lios/tenants ────────────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string } }>('/lios/tenants', async (req, reply) => {
    const page   = Math.max(1, parseInt(req.query.page  ?? '1',  10));
    const limit  = Math.min(100, parseInt(req.query.limit ?? '20', 10));
    const offset = (page - 1) * limit;

    const tenants = await query(
      `SELECT id, tenant_id, company_name, contact_name, email, industry, company_size, status, created_at
       FROM lios_tenants ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countRow = await queryOne<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM lios_tenants', []);
    return reply.code(200).send({ total: parseInt(countRow?.cnt ?? '0', 10), page, limit, tenants });
  });

  // ── PUT /lios/tenants/:id/status ─────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body:   { status: 'active' | 'disabled' };
  }>('/lios/tenants/:id/status', {
    schema: {
      body: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string', enum: ['active', 'disabled'] } },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params;
    const { status } = req.body;

    const rows = await query(
      `UPDATE lios_tenants SET status=$1, updated_at=NOW() WHERE id=$2
       RETURNING id, tenant_id, company_name, status`,
      [status, id]
    );
    if (!rows.length) return reply.code(404).send({ error: 'tenant not found' });
    return reply.code(200).send(rows[0]);
  });
}
