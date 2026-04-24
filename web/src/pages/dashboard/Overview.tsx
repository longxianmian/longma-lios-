import { useEffect, useState } from 'react';
import { Database, ClipboardList, CheckCircle, Puzzle, AlertCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { getAuth } from '../../lib/auth';
import Spinner from '../../components/Spinner';
import StatusBadge from '../../components/StatusBadge';
import Empty from '../../components/Empty';

interface Decision {
  id: string;
  decision_type: string;
  rationale: string;
  confidence: number;
  created_at: string;
  trace_id: string;
  raw_input: string;
  intent_status: string;
}

interface StatsResponse {
  tenant_id: string;
  total_decisions: number;
  accept_rate: number;
  total_assets: number;
  total_plugins: number;
  recent_decisions: Decision[];
}

interface StatCard {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
}

export default function Overview() {
  const auth = getAuth();
  const tenantId = auth?.tenant_id ?? '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stats, setStats] = useState({ assets: 0, decisions: 0, acceptRate: 0, plugins: 0 });
  const [recentDecisions, setRecentDecisions] = useState<Decision[]>([]);

  useEffect(() => {
    if (!tenantId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const res = await api.get('/lios/dashboard/stats', { tenant_id: tenantId }) as StatsResponse;
        if (cancelled) return;
        setStats({
          assets: res.total_assets ?? 0,
          decisions: res.total_decisions ?? 0,
          acceptRate: res.accept_rate ?? 0,
          plugins: res.total_plugins ?? 0,
        });
        setRecentDecisions(res.recent_decisions ?? []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '数据加载失败，请刷新重试');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [tenantId]);

  const cards: StatCard[] = [
    {
      label: '已上传资产',
      value: stats.assets,
      icon: <Database className="w-5 h-5" />,
      color: 'blue',
    },
    {
      label: '历史裁决次数',
      value: stats.decisions,
      icon: <ClipboardList className="w-5 h-5" />,
      color: 'indigo',
    },
    {
      label: '裁决通过率',
      value: `${stats.acceptRate}%`,
      icon: <CheckCircle className="w-5 h-5" />,
      color: 'emerald',
    },
    {
      label: '已配置插件',
      value: stats.plugins,
      icon: <Puzzle className="w-5 h-5" />,
      color: 'amber',
    },
  ];

  const colorMap: Record<string, string> = {
    blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    indigo: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">概览</h1>

      {error && (
        <div className="flex items-center gap-2 mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button
            onClick={() => window.location.reload()}
            className="ml-auto text-red-400 hover:text-red-300 underline text-xs"
          >
            刷新页面
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map(card => (
          <div key={card.label} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-slate-400">{card.label}</p>
              <div className={`p-2 rounded-lg border ${colorMap[card.color]}`}>
                {card.icon}
              </div>
            </div>
            <p className="text-3xl font-bold text-white">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-white">最近裁决记录</h2>
        </div>
        {recentDecisions.length === 0 ? (
          <Empty message="暂无裁决记录" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">Trace ID</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">时间</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">意图描述</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">裁决结果</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-slate-500">置信度</th>
                </tr>
              </thead>
              <tbody>
                {recentDecisions.map(d => (
                  <tr key={d.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-5 py-3 text-slate-400 font-mono text-xs">
                      {(d.trace_id ?? d.id ?? '').slice(0, 8)}
                    </td>
                    <td className="px-5 py-3 text-slate-400">
                      {d.created_at ? new Date(d.created_at).toLocaleDateString('zh-CN') : '-'}
                    </td>
                    <td className="px-5 py-3 text-slate-300 max-w-xs truncate">
                      {d.raw_input ?? ''}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={d.decision_type ?? d.intent_status ?? 'pending'} />
                    </td>
                    <td className="px-5 py-3 text-right text-slate-400">
                      {d.confidence != null ? `${Math.round(d.confidence * 100)}%` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
