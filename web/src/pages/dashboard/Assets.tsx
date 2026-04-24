import { useEffect, useState, useRef } from 'react';
import { Upload, Link as LinkIcon, CheckCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { getAuth } from '../../lib/auth';
import Spinner from '../../components/Spinner';
import Empty from '../../components/Empty';
import StatusBadge from '../../components/StatusBadge';

interface Asset {
  id: string;
  name: string;
  asset_type: string;
  scope: string;
  is_indexed: boolean;
  created_at: string;
}

interface AssetsResponse {
  assets?: Asset[];
  total?: number;
}

// Values must match backend enum: ['document','policy','knowledge','template','data']
const ASSET_TYPES = [
  { value: 'document',  label: '文档 / 手册' },
  { value: 'policy',    label: '规章 / 政策' },
  { value: 'knowledge', label: '知识条目' },
  { value: 'template',  label: '模板' },
  { value: 'data',      label: '数据资产' },
];

const SCOPES = [
  { value: 'enterprise', label: '企业 (enterprise)' },
  { value: 'project',    label: '项目 (project)' },
  { value: 'task',       label: '任务 (task)' },
];

type TabType = 'file' | 'url';
type UploadPhase = 'idle' | 'reading' | 'uploading' | 'indexing' | 'ready' | 'error';

export default function Assets() {
  const auth = getAuth();
  const tenantId = auth?.tenant_id ?? '';

  const [activeTab, setActiveTab] = useState<TabType>('file');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [assetType, setAssetType] = useState('document');
  const [scope, setScope] = useState('enterprise');
  const [tags, setTags] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [urlName, setUrlName] = useState('');

  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [phaseMessage, setPhaseMessage] = useState('');
  const [lastPayload, setLastPayload] = useState<{ name: string; content: string } | null>(null);

  useEffect(() => {
    if (!tenantId) { setLoadingAssets(false); return; }
    let cancelled = false;
    setLoadingAssets(true);
    api.get('/lios/assets/search', { tenant_id: tenantId })
      .then(res => { if (!cancelled) setAssets((res as AssetsResponse).assets ?? []); })
      .catch(() => { if (!cancelled) setAssets([]); })
      .finally(() => { if (!cancelled) setLoadingAssets(false); });
    return () => { cancelled = true; };
  }, [tenantId, refreshTick]);

  async function readFileContent(file: File): Promise<string> {
    const textTypes = ['text/', 'application/json', 'application/xml', 'application/csv'];
    const mdExtensions = ['.md', '.txt', '.csv', '.json', '.xml', '.yaml', '.yml'];
    const ext = file.name.toLowerCase();
    const isText = textTypes.some(t => file.type.startsWith(t)) || mdExtensions.some(e => ext.endsWith(e));
    if (isText) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target?.result as string ?? '');
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsText(file);
      });
    }
    return `[待转录：${file.name}]`;
  }

  async function runUpload(name: string, content: string) {
    if (!tenantId) return;
    setLastPayload({ name, content });
    setPhase('uploading');
    setPhaseMessage('');

    try {
      await api.post('/lios/assets/ingest', {
        tenant_id: tenantId,
        name,
        content,
        asset_type: assetType,
        scope,
        scope_ref: tenantId,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      });
    } catch (err) {
      setPhase('error');
      setPhaseMessage(err instanceof Error ? err.message : '上传失败，请重试');
      return;
    }

    setPhase('indexing');
    setRefreshTick(t => t + 1);

    try {
      await api.post('/lios/assets/reindex', { tenant_id: tenantId });
      setPhase('ready');
      setPhaseMessage(`「${name}」已就绪，可用于裁决`);
      setRefreshTick(t => t + 1);
      setSelectedFile(null);
      setTags('');
      setUrlInput('');
      setUrlName('');
    } catch {
      setPhase('ready');
      setPhaseMessage(`「${name}」已上传，索引触发失败（可稍后刷新）`);
      setRefreshTick(t => t + 1);
    }
  }

  async function handleUpload() {
    setPhase('idle');
    if (activeTab === 'file') {
      if (!selectedFile) { setPhase('error'); setPhaseMessage('请先选择文件'); return; }
      setPhase('reading');
      let content = '';
      try { content = await readFileContent(selectedFile); }
      catch { setPhase('error'); setPhaseMessage('文件读取失败，请重试'); return; }
      await runUpload(selectedFile.name, content);
    } else {
      if (!urlInput.trim()) { setPhase('error'); setPhaseMessage('请输入 URL'); return; }
      if (!urlName.trim()) { setPhase('error'); setPhaseMessage('请输入资产名称'); return; }
      await runUpload(urlName.trim(), urlInput.trim());
    }
  }

  async function handleRetry() {
    if (lastPayload) await runUpload(lastPayload.name, lastPayload.content);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) { setSelectedFile(file); setActiveTab('file'); }
  }

  const isBusy = phase === 'reading' || phase === 'uploading' || phase === 'indexing';

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">资产管理</h1>

      {/* Upload status banner */}
      {(phase === 'uploading' || phase === 'reading') && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-blue-500/10 border border-blue-500/30 rounded-xl text-blue-300 text-sm">
          <Spinner size="sm" />
          <div className="flex-1">
            <span className="font-medium">{phase === 'reading' ? '正在读取文件...' : '正在上传...'}</span>
            <div className="w-full h-1.5 bg-blue-500/20 rounded-full overflow-hidden mt-2">
              <div
                className="h-full bg-blue-500 rounded-full"
                style={{ width: '60%', animation: 'indeterminate 1.4s ease-in-out infinite' }}
              />
            </div>
          </div>
        </div>
      )}

      {phase === 'indexing' && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-300 text-sm">
          <Spinner size="sm" />
          <div className="flex-1">
            <span className="font-medium">上传成功，正在建立索引...</span>
            <div className="w-full h-1.5 bg-amber-500/20 rounded-full overflow-hidden mt-2">
              <div className="h-full bg-amber-500 rounded-full" style={{ width: '80%', transition: 'width 2s ease' }} />
            </div>
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-300 text-sm">
          <CheckCircle className="w-5 h-5 flex-shrink-0" />
          <span className="font-medium flex-1">{phaseMessage}</span>
          <button onClick={() => setPhase('idle')} className="text-emerald-500 hover:text-emerald-300 text-xs">关闭</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-300 text-sm">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span className="flex-1">{phaseMessage}</span>
          {lastPayload && (
            <button
              onClick={() => void handleRetry()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 border border-red-500/30 hover:bg-red-500/30 text-red-300 rounded-lg text-xs font-medium transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              重试
            </button>
          )}
          <button onClick={() => setPhase('idle')} className="text-red-500 hover:text-red-300 text-xs ml-1">关闭</button>
        </div>
      )}

      {/* Upload card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
        <h2 className="text-base font-semibold text-white mb-4">上传资产</h2>

        <div className="flex gap-1 mb-6 bg-slate-800 rounded-lg p-1 w-fit">
          <button
            onClick={() => { if (!isBusy) setActiveTab('file'); }}
            disabled={isBusy}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'file' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'} disabled:opacity-50`}
          >
            <Upload className="w-4 h-4" />
            文件上传
          </button>
          <button
            onClick={() => { if (!isBusy) setActiveTab('url'); }}
            disabled={isBusy}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'url' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'} disabled:opacity-50`}
          >
            <LinkIcon className="w-4 h-4" />
            URL 导入
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            {activeTab === 'file' ? (
              <div>
                <div
                  onClick={() => { if (!isBusy) fileInputRef.current?.click(); }}
                  onDragOver={e => { e.preventDefault(); if (!isBusy) setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { if (!isBusy) handleDrop(e); else e.preventDefault(); }}
                  className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${isBusy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${
                    dragOver ? 'border-blue-500 bg-blue-500/10'
                    : selectedFile ? 'border-emerald-500/50 bg-emerald-500/5'
                    : 'border-slate-700 hover:border-slate-600 hover:bg-slate-800/50'
                  }`}
                >
                  <Upload className={`w-10 h-10 mx-auto mb-3 ${selectedFile ? 'text-emerald-400' : 'text-slate-600'}`} />
                  {selectedFile ? (
                    <div>
                      <p className="text-emerald-400 font-medium mb-1">{selectedFile.name}</p>
                      <p className="text-slate-500 text-xs">{(selectedFile.size / 1024).toFixed(1)} KB · 点击更换文件</p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-slate-300 font-medium mb-1">拖拽文件到此处，或点击上传</p>
                      <p className="text-slate-500 text-xs">支持 PDF、Word、TXT、Markdown 等格式</p>
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  disabled={isBusy}
                  onChange={e => { if (e.target.files?.[0]) setSelectedFile(e.target.files[0]); }}
                  accept=".pdf,.doc,.docx,.txt,.md,.csv,.json,.xml,.mp4,.mp3,.wav"
                />
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">网址 URL</label>
                  <input
                    type="url"
                    value={urlInput}
                    onChange={e => setUrlInput(e.target.value)}
                    disabled={isBusy}
                    placeholder="https://example.com/document"
                    className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">资产名称</label>
                  <input
                    type="text"
                    value={urlName}
                    onChange={e => setUrlName(e.target.value)}
                    disabled={isBusy}
                    placeholder="给这个资产取个名字"
                    className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">资产类型</label>
              <select
                value={assetType}
                onChange={e => setAssetType(e.target.value)}
                disabled={isBusy}
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
              >
                {ASSET_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">作用域</label>
              <select
                value={scope}
                onChange={e => setScope(e.target.value)}
                disabled={isBusy}
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
              >
                {SCOPES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">标签（可选）</label>
              <input
                type="text"
                value={tags}
                onChange={e => setTags(e.target.value)}
                disabled={isBusy}
                placeholder="标签1, 标签2"
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
              />
              <p className="text-xs text-slate-500 mt-1">多个标签用逗号分隔</p>
            </div>

            <button
              onClick={() => void handleUpload()}
              disabled={isBusy}
              className="w-full py-2.5 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/40 disabled:cursor-not-allowed text-white rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2"
            >
              {isBusy
                ? <><Spinner size="sm" /><span>{phase === 'reading' ? '读取中...' : phase === 'uploading' ? '上传中...' : '建立索引...'}</span></>
                : <><Upload className="w-4 h-4" />上传</>
              }
            </button>
          </div>
        </div>
      </div>

      {/* Assets list */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">已上传资产（{assets.length} 条）</h2>
          <button
            onClick={() => setRefreshTick(t => t + 1)}
            disabled={loadingAssets}
            className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${loadingAssets ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>

        {loadingAssets ? (
          <div className="py-12 flex justify-center"><Spinner /></div>
        ) : assets.length === 0 ? (
          <Empty message="暂无资产，请上传文件或导入 URL" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">名称</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">类型</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">作用域</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">状态</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">上传时间</th>
                </tr>
              </thead>
              <tbody>
                {assets.map(asset => (
                  <tr key={asset.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-5 py-3 text-slate-200 font-medium">{asset.name}</td>
                    <td className="px-5 py-3 text-slate-400">
                      {ASSET_TYPES.find(t => t.value === asset.asset_type)?.label ?? asset.asset_type}
                    </td>
                    <td className="px-5 py-3 text-slate-400">{asset.scope}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={asset.is_indexed ? 'indexed' : 'indexing'} />
                    </td>
                    <td className="px-5 py-3 text-slate-400">
                      {asset.created_at ? new Date(asset.created_at).toLocaleDateString('zh-CN') : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <style>{`
        @keyframes indeterminate {
          0%   { transform: translateX(-100%) scaleX(0.5); }
          50%  { transform: translateX(0%)    scaleX(1); }
          100% { transform: translateX(200%)  scaleX(0.5); }
        }
      `}</style>
    </div>
  );
}
