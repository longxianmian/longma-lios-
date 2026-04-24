import { useEffect, useState, useCallback } from 'react';
import { AlertCircle } from 'lucide-react';
import { api } from '../../lib/api';
import Spinner from '../../components/Spinner';
import Empty from '../../components/Empty';
import StatusBadge from '../../components/StatusBadge';

interface Tenant {
  id: string;
  company_name: string;
  industry?: string;
  contact_name?: string;
  email?: string;
  company_size?: string;
  status: string;
  created_at?: string;
}

interface TenantsResponse {
  tenants?: Tenant[];
}

const INDUSTRY_LABELS: Record<string, string> = {
  tech: '科技/互联网',
  legal: '法律',
  medical: '医疗健康',
  education: '教育',
  retail: '零售电商',
  finance: '金融',
  manufacturing: '制造业',
  other: '其他',
};

export default function Tenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/lios/tenants') as TenantsResponse;
      setTenants(res.tenants ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleStatus(tenant: Tenant) {
    const newStatus = tenant.status === 'active' ? 'disabled' : 'active';
    setUpdatingId(tenant.id);
    setError('');
    setSuccess('');
    try {
      await api.put(`/lios/tenants/${tenant.id}/status`, { status: newStatus });
      setTenants(prev =>
        prev.map(t => t.id === tenant.id ? { ...t, status: newStatus } : t)
      );
      setSuccess(`企业「${tenant.company_name}」已${newStatus === 'active' ? '启用' : '禁用'}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">租户管理</h1>

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {success && (
        <div className="p-3 mb-4 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-400 text-sm">
          {success}
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">共 {tenants.length} 家企业</h2>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="text-xs text-slate-400 hover:text-white transition-colors"
          >
            刷新
          </button>
        </div>

        {loading ? (
          <div className="py-12 flex justify-center"><Spinner /></div>
        ) : tenants.length === 0 ? (
          <Empty message="暂无租户数据" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">企业名称</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">联系人</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">行业</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">注册时间</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">状态</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-slate-500">操作</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map(tenant => (
                  <tr key={tenant.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-5 py-3">
                      <div>
                        <p className="text-slate-200 font-medium">{tenant.company_name}</p>
                        {tenant.email && <p className="text-xs text-slate-500">{tenant.email}</p>}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-slate-400">{tenant.contact_name ?? '—'}</td>
                    <td className="px-5 py-3 text-slate-400">
                      {INDUSTRY_LABELS[tenant.industry ?? ''] ?? tenant.industry ?? '—'}
                    </td>
                    <td className="px-5 py-3 text-slate-400">
                      {tenant.created_at ? new Date(tenant.created_at).toLocaleDateString('zh-CN') : '—'}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={tenant.status} />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => void toggleStatus(tenant)}
                        disabled={updatingId === tenant.id}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                          tenant.status === 'active'
                            ? 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20'
                            : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
                        }`}
                      >
                        {updatingId === tenant.id ? '处理中...' : tenant.status === 'active' ? '禁用' : '启用'}
                      </button>
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
