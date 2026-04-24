import { useEffect, useState, useCallback } from 'react';
import { Plus, Users, Copy } from 'lucide-react';
import { api } from '../../lib/api';
import { getAuth } from '../../lib/auth';
import Empty from '../../components/Empty';

interface Plugin {
  id: string;
  name: string;
  plugin_type: string;
}

interface PluginsResponse {
  plugins?: Plugin[];
}

interface Employee {
  id: string;
  name: string;
  industry: string;
  plugin_ids: string[];
  asset_scope: string;
  created_at: string;
}

const INDUSTRIES = [
  { value: 'tech', label: '科技/互联网' },
  { value: 'legal', label: '法律' },
  { value: 'medical', label: '医疗健康' },
  { value: 'education', label: '教育' },
  { value: 'retail', label: '零售电商' },
  { value: 'finance', label: '金融' },
  { value: 'manufacturing', label: '制造业' },
  { value: 'other', label: '其他' },
];

const SCOPES = [
  { value: 'enterprise', label: '企业 (enterprise)' },
  { value: 'project', label: '项目 (project)' },
  { value: 'task', label: '任务 (task)' },
];

const STORAGE_KEY = 'liosEmployees';

function loadEmployees(): Employee[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Employee[];
  } catch {
    return [];
  }
}

function saveEmployees(employees: Employee[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(employees));
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function Employees() {
  const auth = getAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [selectedPlugins, setSelectedPlugins] = useState<string[]>([]);
  const [assetScope, setAssetScope] = useState('enterprise');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    setEmployees(loadEmployees());
  }, []);

  const loadPlugins = useCallback(async () => {
    if (!auth) return;
    try {
      const res = await api.get('/lios/plugins', { tenant_id: auth.tenant_id }) as PluginsResponse;
      setPlugins(res.plugins ?? []);
    } catch {
      setPlugins([]);
    }
  }, [auth]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  function togglePlugin(id: string) {
    setSelectedPlugins(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setFormError('请输入数字员工名称'); return; }
    if (!industry) { setFormError('请选择绑定行业'); return; }
    setFormError('');

    const newEmp: Employee = {
      id: genId(),
      name: name.trim(),
      industry,
      plugin_ids: selectedPlugins,
      asset_scope: assetScope,
      created_at: new Date().toISOString(),
    };

    const updated = [newEmp, ...employees];
    setEmployees(updated);
    saveEmployees(updated);

    // Reset form
    setName('');
    setIndustry('');
    setSelectedPlugins([]);
    setAssetScope('enterprise');
    setShowForm(false);
  }

  function copyEndpoint(id: string, endpoint: string) {
    void navigator.clipboard.writeText(endpoint);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-white">数字员工</h1>
        <button
          onClick={() => { setShowForm(!showForm); setFormError(''); }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          创建数字员工
        </button>
      </div>

      <p className="text-slate-400 text-sm mb-6">
        数字员工是 LIOS 对外提供的智能体接口，将 AI 插件、知识资产和裁决引擎整合，提供垂直领域的智能服务。
      </p>

      {/* Create form */}
      {showForm && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
          <h2 className="text-base font-semibold text-white mb-4">创建数字员工</h2>

          {formError && (
            <div className="p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              {formError}
            </div>
          )}

          <form onSubmit={handleCreate}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">名称 <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="例：法律咨询助手"
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">绑定行业 <span className="text-red-400">*</span></label>
                <select
                  value={industry}
                  onChange={e => setIndustry(e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">请选择</option>
                  {INDUSTRIES.map(ind => (
                    <option key={ind.value} value={ind.value}>{ind.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">绑定资产作用域</label>
                <select
                  value={assetScope}
                  onChange={e => setAssetScope(e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  {SCOPES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Plugin selection */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-300 mb-2">绑定插件（可多选）</label>
              {plugins.length === 0 ? (
                <p className="text-xs text-slate-500 py-2">暂无可用插件，请先在「插件配置」页面添加</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {plugins.map(plugin => (
                    <label
                      key={plugin.id}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedPlugins.includes(plugin.id)
                          ? 'border-blue-500/50 bg-blue-500/10'
                          : 'border-slate-700 bg-slate-800 hover:border-slate-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedPlugins.includes(plugin.id)}
                        onChange={() => togglePlugin(plugin.id)}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500"
                      />
                      <div>
                        <p className="text-sm text-slate-200 font-medium">{plugin.name}</p>
                        <p className="text-xs text-slate-500">{plugin.plugin_type}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                className="px-6 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
              >
                创建
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-6 py-2.5 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600 rounded-lg text-sm font-medium transition-colors"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Employee list */}
      {employees.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <Empty message="暂无数字员工，点击「创建数字员工」开始" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {employees.map(emp => {
            const endpoint = `/lios/run?employee=${emp.id}`;
            const industryLabel = INDUSTRIES.find(i => i.value === emp.industry)?.label ?? emp.industry;
            const boundPlugins = plugins.filter(p => emp.plugin_ids.includes(p.id));

            return (
              <div key={emp.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-colors">
                <div className="flex items-start gap-3 mb-4">
                  <div className="p-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                    <Users className="w-5 h-5 text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-white font-semibold text-sm truncate">{emp.name}</h3>
                    <p className="text-slate-500 text-xs">{industryLabel}</p>
                  </div>
                </div>

                <div className="space-y-2 mb-4">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">绑定插件</span>
                    <span className="text-slate-300">{emp.plugin_ids.length} 个</span>
                  </div>
                  {boundPlugins.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {boundPlugins.slice(0, 3).map(p => (
                        <span key={p.id} className="px-2 py-0.5 bg-slate-800 rounded text-xs text-slate-400">{p.name}</span>
                      ))}
                      {boundPlugins.length > 3 && (
                        <span className="px-2 py-0.5 bg-slate-800 rounded text-xs text-slate-500">+{boundPlugins.length - 3}</span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">资产作用域</span>
                    <span className="text-slate-300">{emp.asset_scope}</span>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-800">
                  <p className="text-xs text-slate-500 mb-1">API 调用地址</p>
                  <div className="flex items-center gap-2 bg-slate-800 rounded-lg px-3 py-1.5">
                    <code className="text-xs text-slate-400 flex-1 truncate font-mono">{endpoint}</code>
                    <button
                      onClick={() => copyEndpoint(emp.id, endpoint)}
                      className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
                    >
                      {copied === emp.id ? (
                        <span className="text-emerald-400 text-xs">已复制</span>
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <p className="text-xs text-slate-600 mt-2">
                  创建于 {new Date(emp.created_at).toLocaleDateString('zh-CN')}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
