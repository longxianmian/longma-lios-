import { useEffect, useState } from 'react';
import { Building2, Activity, CheckCircle, Users } from 'lucide-react';
import { api } from '../../lib/api';
import Spinner from '../../components/Spinner';

interface HealthResponse {
  status: string;
  version?: string;
  uptime?: number;
}

interface Tenant {
  id: string;
  company_name: string;
  status: string;
}

interface TenantsResponse {
  tenants?: Tenant[];
}

export default function AdminOverview() {
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [tenantCount, setTenantCount] = useState(0);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [healthRes, tenantsRes] = await Promise.allSettled([
          api.get('/lios/health'),
          api.get('/lios/tenants'),
        ]);
        if (healthRes.status === 'fulfilled') {
          setHealth(healthRes.value as HealthResponse);
        }
        if (tenantsRes.status === 'fulfilled') {
          const data = tenantsRes.value as TenantsResponse;
          setTenantCount(data.tenants?.length ?? 0);
        }
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  const isHealthy = health?.status?.toLowerCase() === 'ok' || health?.status?.toLowerCase() === 'healthy';

  const cards = [
    {
      label: '总企业数',
      value: tenantCount,
      icon: <Building2 className="w-5 h-5" />,
      color: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    },
    {
      label: '今日活跃企业',
      value: '—',
      icon: <Users className="w-5 h-5" />,
      color: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
    },
    {
      label: '全平台裁决次数',
      value: '—',
      icon: <Activity className="w-5 h-5" />,
      color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    },
    {
      label: '系统健康状态',
      value: isHealthy ? 'OK' : (health?.status ?? '未知'),
      icon: <CheckCircle className="w-5 h-5" />,
      color: isHealthy
        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
        : 'bg-red-500/10 text-red-400 border-red-500/20',
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">超管概览</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map(card => (
          <div key={card.label} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-slate-400">{card.label}</p>
              <div className={`p-2 rounded-lg border ${card.color}`}>
                {card.icon}
              </div>
            </div>
            <p className="text-3xl font-bold text-white">{card.value}</p>
          </div>
        ))}
      </div>

      {/* Health details */}
      {health && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-base font-semibold text-white mb-4">系统健康详情</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-slate-800 rounded-lg p-4">
              <p className="text-xs text-slate-500 mb-1">状态</p>
              <p className={`text-lg font-bold ${isHealthy ? 'text-emerald-400' : 'text-red-400'}`}>
                {health.status}
              </p>
            </div>
            {health.version && (
              <div className="bg-slate-800 rounded-lg p-4">
                <p className="text-xs text-slate-500 mb-1">版本</p>
                <p className="text-lg font-bold text-white">{health.version}</p>
              </div>
            )}
            {health.uptime != null && (
              <div className="bg-slate-800 rounded-lg p-4">
                <p className="text-xs text-slate-500 mb-1">运行时长</p>
                <p className="text-lg font-bold text-white">
                  {Math.floor(health.uptime / 3600)}h {Math.floor((health.uptime % 3600) / 60)}m
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
