import { useEffect, useState, useRef } from 'react';
import { Upload, CheckCircle, AlertCircle, RefreshCw, BookOpen } from 'lucide-react';
import { api } from '../../lib/api';
import Spinner from '../../components/Spinner';
import Empty from '../../components/Empty';
import StatusBadge from '../../components/StatusBadge';

interface Asset {
  id: string;
  name: string;
  asset_type: string;
  scope: string;
  scope_ref?: string;
  tags?: string[];
  is_indexed: boolean;
  created_at: string;
}

interface AssetsResponse {
  assets?: Asset[];
}

const INDUSTRIES = [
  { value: 'tech',          label: '科技/互联网' },
  { value: 'legal',         label: '法律' },
  { value: 'medical',       label: '医疗健康' },
  { value: 'education',     label: '教育' },
  { value: 'retail',        label: '零售电商' },
  { value: 'finance',       label: '金融' },
  { value: 'manufacturing', label: '制造业' },
];

const INDUSTRY_MAP = Object.fromEntries(INDUSTRIES.map(i => [i.value, i.label]));

const ADMIN_TENANT = 'admin';

type UploadPhase = 'idle' | 'reading' | 'uploading' | 'indexing' | 'ready' | 'error';

function ProgressBar({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden mt-3">
      <div className="h-full bg-blue-500 rounded-full animate-[progress_1.5s_ease-in-out_infinite]"
        style={{ width: '40%', animation: 'progress 1.5s ease-in-out infinite' }}
      />
    </div>
  );
}

export default function Knowledge() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [textContent, setTextContent] = useState('');
  const [contentName, setContentName] = useState('');
  const [industry, setIndustry] = useState('tech');
  const [inputMode, setInputMode] = useState<'file' | 'text'>('file');

  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [phaseMessage, setPhaseMessage] = useState('');
  const [lastUploadParams, setLastUploadParams] = useState<{ name: string; content: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/lios/assets/search', { tenant_id: ADMIN_TENANT, scope: 'industry' })
      .then(res => { if (!cancelled) setAssets((res as AssetsResponse).assets ?? []); })
      .catch(() => { if (!cancelled) setAssets([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshTick]);

  async function readFileContent(file: File): Promise<string> {
    const mdExtensions = ['.md', '.txt', '.csv', '.json', '.xml', '.yaml', '.yml'];
    const ext = file.name.toLowerCase();
    const isText = file.type.startsWith('text/') || mdExtensions.some(e => ext.endsWith(e));
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
    setLastUploadParams({ name, content });
    setPhase('uploading');
    setPhaseMessage('');

    try {
      await api.post('/lios/assets/ingest', {
        tenant_id: ADMIN_TENANT,
        name,
        content,
        asset_type: 'knowledge',
        scope: 'industry',
        scope_ref: industry,
        tags: [industry],
      });
    } catch (err) {
      setPhase('error');
      setPhaseMessage(err instanceof Error ? err.message : '上传失败，请重试');
      return;
    }

    setPhase('indexing');
    setRefreshTick(t => t + 1);

    try {
      await api.post('/lios/assets/reindex', { tenant_id: ADMIN_TENANT });
      setPhase('ready');
      setPhaseMessage(`「${name}」已就绪，可用于裁决`);
      setRefreshTick(t => t + 1);
      setSelectedFile(null);
      setTextContent('');
      setContentName('');
    } catch {
      setPhase('ready');
      setPhaseMessage(`「${name}」已上传，索引触发失败（可稍后手动刷新）`);
      setRefreshTick(t => t + 1);
    }
  }

  async function handleUpload() {
    setPhase('idle');
    let name = '';
    let content = '';

    if (inputMode === 'file') {
      if (!selectedFile) { setPhase('error'); setPhaseMessage('请先选择文件'); return; }
      setPhase('reading');
      try {
        content = await readFileContent(selectedFile);
        name = selectedFile.name;
      } catch {
        setPhase('error');
        setPhaseMessage('文件读取失败，请重试');
        return;
      }
    } else {
      if (!contentName.trim()) { setPhase('error'); setPhaseMessage('请输入知识名称'); return; }
      if (!textContent.trim()) { setPhase('error'); setPhaseMessage('请输入知识内容'); return; }
      name = contentName.trim();
      content = textContent.trim();
    }

    await runUpload(name, content);
  }

  async function handleRetry() {
    if (lastUploadParams) {
      await runUpload(lastUploadParams.name, lastUploadParams.content);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) { setSelectedFile(file); setInputMode('file'); }
  }

  const isBusy = phase === 'reading' || phase === 'uploading' || phase === 'indexing';

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">行业知识库</h1>

      {/* Upload status banner */}
      {phase === 'uploading' && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-blue-500/10 border border-blue-500/30 rounded-xl text-blue-300 text-sm">
          <Spinner size="sm" />
          <div className="flex-1">
            <span className="font-medium">正在上传...</span>
            <div className="w-full h-1.5 bg-blue-500/20 rounded-full overflow-hidden mt-2">
              <div
                className="h-full bg-blue-500 rounded-full"
                style={{
                  width: '60%',
                  animation: 'indeterminate 1.4s ease-in-out infinite',
                }}
              />
            </div>
          </div>
        </div>
      )}

      {phase === 'reading' && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-blue-500/10 border border-blue-500/30 rounded-xl text-blue-300 text-sm">
          <Spinner size="sm" />
          <span>正在读取文件...</span>
        </div>
      )}

      {phase === 'indexing' && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-300 text-sm">
          <Spinner size="sm" />
          <div className="flex-1">
            <span className="font-medium">上传成功，正在建立索引...</span>
            <div className="w-full h-1.5 bg-amber-500/20 rounded-full overflow-hidden mt-2">
              <div
                className="h-full bg-amber-500 rounded-full"
                style={{ width: '80%', transition: 'width 2s ease' }}
              />
            </div>
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-300 text-sm">
          <CheckCircle className="w-5 h-5 flex-shrink-0" />
          <span className="font-medium">{phaseMessage}</span>
          <button
            onClick={() => setPhase('idle')}
            className="ml-auto text-emerald-500 hover:text-emerald-300 text-xs"
          >
            关闭
          </button>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex items-center gap-3 p-4 mb-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-300 text-sm">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span className="flex-1">{phaseMessage}</span>
          {lastUploadParams && (
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
        <h2 className="text-base font-semibold text-white mb-4">上传行业知识</h2>

        <div className="flex gap-1 mb-5 bg-slate-800 rounded-lg p-1 w-fit">
          <button
            onClick={() => { if (!isBusy) setInputMode('file'); }}
            disabled={isBusy}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${inputMode === 'file' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'} disabled:opacity-50`}
          >
            文件上传
          </button>
          <button
            onClick={() => { if (!isBusy) setInputMode('text'); }}
            disabled={isBusy}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${inputMode === 'text' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'} disabled:opacity-50`}
          >
            文字内容
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            {inputMode === 'file' ? (
              <div>
                <div
                  onClick={() => { if (!isBusy) fileInputRef.current?.click(); }}
                  onDragOver={e => { e.preventDefault(); if (!isBusy) setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { if (!isBusy) handleDrop(e); else e.preventDefault(); }}
                  className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${isBusy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${
                    dragOver ? 'border-blue-500 bg-blue-500/10' :
                    selectedFile ? 'border-emerald-500/50 bg-emerald-500/5' :
                    'border-slate-700 hover:border-slate-600 hover:bg-slate-800/50'
                  }`}
                >
                  <Upload className={`w-10 h-10 mx-auto mb-3 ${selectedFile ? 'text-emerald-400' : 'text-slate-600'}`} />
                  {selectedFile ? (
                    <div>
                      <p className="text-emerald-400 font-medium mb-1">{selectedFile.name}</p>
                      <p className="text-slate-500 text-xs">{(selectedFile.size / 1024).toFixed(1)} KB · 点击更换</p>
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
                  onChange={e => e.target.files?.[0] && setSelectedFile(e.target.files[0])}
                />
              </div>
            ) : (
              <div className="space-y-3">
                <input
                  type="text"
                  value={contentName}
                  onChange={e => setContentName(e.target.value)}
                  disabled={isBusy}
                  placeholder="知识名称（必填）"
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
                />
                <textarea
                  value={textContent}
                  onChange={e => setTextContent(e.target.value)}
                  disabled={isBusy}
                  placeholder="输入知识内容..."
                  rows={6}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm resize-none disabled:opacity-50"
                />
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">行业分类</label>
              <select
                value={industry}
                onChange={e => setIndustry(e.target.value)}
                disabled={isBusy}
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
              >
                {INDUSTRIES.map(ind => (
                  <option key={ind.value} value={ind.value}>{ind.label}</option>
                ))}
              </select>
            </div>

            <div className="p-3 bg-slate-800 rounded-lg text-xs space-y-1">
              <p className="text-slate-500">作用域：<span className="text-slate-300">industry（行业级）</span></p>
              <p className="text-slate-500">租户：<span className="text-slate-300">admin（平台全局）</span></p>
              <p className="text-slate-500">类型：<span className="text-slate-300">knowledge</span></p>
            </div>

            <button
              onClick={() => void handleUpload()}
              disabled={isBusy}
              className="w-full py-2.5 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/40 disabled:cursor-not-allowed text-white rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2"
            >
              {isBusy
                ? <><Spinner size="sm" /><span>{phase === 'reading' ? '读取中...' : phase === 'uploading' ? '上传中...' : '建立索引...'}</span></>
                : <><Upload className="w-4 h-4" />上传知识</>
              }
            </button>
          </div>
        </div>
      </div>

      {/* Knowledge list */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">行业知识库内容（{assets.length} 条）</h2>
          <button
            onClick={() => setRefreshTick(t => t + 1)}
            disabled={loading}
            className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>

        {loading ? (
          <div className="py-12 flex justify-center"><Spinner /></div>
        ) : assets.length === 0 ? (
          <Empty message="暂无行业知识，请上传" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">名称</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">行业分类</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">状态</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">上传时间</th>
                </tr>
              </thead>
              <tbody>
                {assets.map(asset => {
                  const industryTag = asset.tags?.[0] ?? asset.scope_ref ?? '';
                  return (
                    <tr key={asset.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <BookOpen className="w-4 h-4 text-blue-400 flex-shrink-0" />
                          <span className="text-slate-200 font-medium">{asset.name}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-slate-400">
                        {INDUSTRY_MAP[industryTag] ?? industryTag ?? '—'}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={asset.is_indexed ? 'indexed' : 'indexing'} />
                      </td>
                      <td className="px-5 py-3 text-slate-400">
                        {asset.created_at ? new Date(asset.created_at).toLocaleDateString('zh-CN') : '—'}
                      </td>
                    </tr>
                  );
                })}
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
