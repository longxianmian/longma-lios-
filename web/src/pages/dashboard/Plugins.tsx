import { useEffect, useState } from 'react';
import { Plus, AlertCircle, Info } from 'lucide-react';
import { api } from '../../lib/api';
import { getAuth } from '../../lib/auth';
import Spinner from '../../components/Spinner';
import Empty from '../../components/Empty';
import StatusBadge from '../../components/StatusBadge';

interface Plugin {
  id: string;
  name: string;
  plugin_type: string;
  endpoint: string;
  output_role: string;
  status?: string;
  created_at?: string;
}

interface PluginsResponse {
  plugins?: Plugin[];
}

const PLUGIN_TYPES = [
  { value: 'llm', label: '通用LLM' },
  { value: 'tool', label: '垂直大模型' },
  { value: 'retrieval', label: '专业API' },
];

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions' },
  { value: 'anthropic', label: 'Anthropic', endpoint: 'https://api.anthropic.com/v1/messages' },
  { value: 'qwen', label: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
  { value: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions' },
  { value: 'custom', label: '自定义', endpoint: '' },
];

const OUTPUT_ROLES = [
  { value: 'candidate', label: 'candidate（生成候选）' },
  { value: 'evidence', label: 'evidence（生成证据）' },
];

interface FormData {
  name: string;
  plugin_type: string;
  provider: string;
  endpoint: string;
  api_key: string;
  output_role: string;
  description: string;
}

interface FormErrors {
  name?: string;
  endpoint?: string;
  api_key?: string;
  general?: string;
}

const INITIAL_FORM: FormData = {
  name: '',
  plugin_type: 'llm',
  provider: 'openai',
  endpoint: PROVIDERS[0].endpoint,
  api_key: '',
  output_role: 'candidate',
  description: '',
};

export default function Plugins() {
  const auth = getAuth();
  const tenantId = auth?.tenant_id ?? '';

  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loadingPlugins, setLoadingPlugins] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [success, setSuccess] = useState('');
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [refreshTick, setRefreshTick] = useState(0);

  const [form, setForm] = useState<FormData>(INITIAL_FORM);

  useEffect(() => {
    if (!tenantId) {
      setLoadingPlugins(false);
      return;
    }

    let cancelled = false;
    setLoadingPlugins(true);

    api.get('/lios/plugins', { tenant_id: tenantId })
      .then(res => {
        if (!cancelled) setPlugins((res as PluginsResponse).plugins ?? []);
      })
      .catch(() => {
        if (!cancelled) setPlugins([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPlugins(false);
      });

    return () => { cancelled = true; };
  }, [tenantId, refreshTick]);

  function setField(key: keyof FormData, value: string) {
    setForm(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'provider') {
        const provider = PROVIDERS.find(p => p.value === value);
        next.endpoint = provider?.endpoint ?? '';
      }
      return next;
    });
    if (key in formErrors) {
      setFormErrors(prev => ({ ...prev, [key]: undefined }));
    }
  }

  function validate(): boolean {
    const errs: FormErrors = {};
    if (!form.name.trim()) errs.name = '请输入插件名称';
    if (!form.endpoint.trim()) errs.endpoint = '请输入 API 端点';
    if (!form.api_key.trim()) errs.api_key = '请输入 API Key';
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId || !validate()) return;
    setSubmitting(true);
    setFormErrors({});
    setSuccess('');
    try {
      await api.post('/lios/plugins/register', {
        tenant_id: tenantId,
        name: form.name,
        description: form.description,
        plugin_type: form.plugin_type,
        endpoint: form.endpoint,
        config: { model: 'auto', api_key: '***' },
        output_role: form.output_role,
      });
      setSuccess(`插件「${form.name}」配置成功`);
      setForm(INITIAL_FORM);
      setShowForm(false);
      setRefreshTick(t => t + 1);
    } catch (err) {
      setFormErrors({ general: err instanceof Error ? err.message : '配置失败' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">插件配置</h1>
        <button
          onClick={() => { setShowForm(!showForm); setSuccess(''); setFormErrors({}); }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          新增插件
        </button>
      </div>

      {success && (
        <div className="p-3 mb-4 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-400 text-sm">
          {success}
        </div>
      )}

      {showForm && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
          <div className="flex items-start gap-2 mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
            <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-blue-300">
              插件只能提供候选或证据，不参与最终裁决。最终裁决由 LIOS 核心引擎完成，确保决策的可治理性和一致性。
            </p>
          </div>

          {formErrors.general && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {formErrors.general}
            </div>
          )}

          <form onSubmit={(e) => void handleSubmit(e)}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">插件名称 <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setField('name', e.target.value)}
                  placeholder="例：GPT-4 候选生成器"
                  className={`w-full px-3 py-2.5 bg-slate-800 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm ${formErrors.name ? 'border-red-500' : 'border-slate-700'}`}
                />
                {formErrors.name && <p className="text-red-400 text-xs mt-1">{formErrors.name}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">插件类型</label>
                <select
                  value={form.plugin_type}
                  onChange={e => setField('plugin_type', e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  {PLUGIN_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">模型提供商</label>
                <select
                  value={form.provider}
                  onChange={e => setField('provider', e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  {PROVIDERS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">输出角色</label>
                <select
                  value={form.output_role}
                  onChange={e => setField('output_role', e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  {OUTPUT_ROLES.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-300 mb-1">API 端点 <span className="text-red-400">*</span></label>
                <input
                  type="url"
                  value={form.endpoint}
                  onChange={e => setField('endpoint', e.target.value)}
                  placeholder="https://api.openai.com/v1/chat/completions"
                  className={`w-full px-3 py-2.5 bg-slate-800 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm ${formErrors.endpoint ? 'border-red-500' : 'border-slate-700'}`}
                />
                {formErrors.endpoint && <p className="text-red-400 text-xs mt-1">{formErrors.endpoint}</p>}
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-300 mb-1">API Key <span className="text-red-400">*</span></label>
                <input
                  type="password"
                  value={form.api_key}
                  onChange={e => setField('api_key', e.target.value)}
                  placeholder="sk-..."
                  className={`w-full px-3 py-2.5 bg-slate-800 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm ${formErrors.api_key ? 'border-red-500' : 'border-slate-700'}`}
                />
                {formErrors.api_key && <p className="text-red-400 text-xs mt-1">{formErrors.api_key}</p>}
                <p className="text-xs text-slate-500 mt-1">Key 仅用于验证配置，不会明文存储</p>
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-300 mb-1">插件说明（可选）</label>
                <textarea
                  value={form.description}
                  onChange={e => setField('description', e.target.value)}
                  placeholder="描述这个插件的用途..."
                  rows={2}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm resize-none"
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={submitting}
                className="flex items-center gap-2 px-6 py-2.5 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {submitting ? <><Spinner size="sm" /><span>保存中...</span></> : '保存配置'}
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

      <div className="bg-slate-900 border border-slate-800 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-white">已配置插件</h2>
        </div>

        {loadingPlugins ? (
          <div className="py-12 flex justify-center"><Spinner /></div>
        ) : plugins.length === 0 ? (
          <Empty message="暂无插件，点击「新增插件」开始配置" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">名称</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">类型</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">输出角色</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">状态</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">端点</th>
                </tr>
              </thead>
              <tbody>
                {plugins.map(plugin => (
                  <tr key={plugin.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-5 py-3 text-slate-200 font-medium">{plugin.name}</td>
                    <td className="px-5 py-3 text-slate-400">
                      {PLUGIN_TYPES.find(t => t.value === plugin.plugin_type)?.label ?? plugin.plugin_type}
                    </td>
                    <td className="px-5 py-3 text-slate-400">{plugin.output_role}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={plugin.status ?? 'active'} />
                    </td>
                    <td className="px-5 py-3 text-slate-500 text-xs font-mono truncate max-w-xs">
                      {plugin.endpoint}
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
