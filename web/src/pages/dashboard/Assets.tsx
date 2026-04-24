import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Upload, Link as LinkIcon, CheckCircle, AlertCircle,
  RefreshCw, Clock, X, FileText,
} from 'lucide-react';
import mammoth from 'mammoth';
import { api } from '../../lib/api';
import { getAuth } from '../../lib/auth';
import Spinner from '../../components/Spinner';
import Empty from '../../components/Empty';
import StatusBadge from '../../components/StatusBadge';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Asset {
  id: string;
  name: string;
  asset_type: string;
  scope: string;
  is_indexed: boolean;
  created_at: string;
}

interface AssetsResponse { assets?: Asset[] }

type FileStatus = 'pending' | 'reading' | 'uploading' | 'done' | 'error';

interface FileItem {
  id:      string;
  file:    File;
  status:  FileStatus;
  error?:  string;
}

type TabType = 'file' | 'url';

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readFileContent(file: File): Promise<string> {
  const ext = file.name.toLowerCase();

  if (ext.endsWith('.docx')) {
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    const text = result.value.trim();
    if (!text) throw new Error('文件内容为空');
    return text;
  }

  const textTypes = ['text/', 'application/json', 'application/xml', 'application/csv'];
  const textExts  = ['.md', '.txt', '.csv', '.json', '.xml', '.yaml', '.yml'];
  const isText = textTypes.some(t => file.type.startsWith(t)) || textExts.some(e => ext.endsWith(e));
  if (isText) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target?.result as string ?? '');
      reader.onerror = () => reject(new Error('读取失败'));
      reader.readAsText(file);
    });
  }

  throw new Error(`不支援 ${ext}，请上传 .docx / .txt / .md / .csv / .json`);
}

function uid() { return Math.random().toString(36).slice(2); }

// ── Component ─────────────────────────────────────────────────────────────────

export default function Assets() {
  const auth     = getAuth();
  const tenantId = auth?.tenant_id ?? '';

  // asset list
  const [assets, setAssets]           = useState<Asset[]>([]);
  const [loadingAssets, setLoading]   = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  // upload config
  const [activeTab, setActiveTab] = useState<TabType>('file');
  const [assetType, setAssetType] = useState('document');
  const [scope, setScope]         = useState('enterprise');
  const [tags, setTags]           = useState('');

  // multi-file state
  const [fileItems, setFileItems]   = useState<FileItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [dragOver, setDragOver]     = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // URL upload
  const [urlInput, setUrlInput]       = useState('');
  const [urlName, setUrlName]         = useState('');
  const [urlUploading, setUrlUploading] = useState(false);
  const [urlMessage, setUrlMessage]   = useState<{ ok: boolean; text: string } | null>(null);

  // Use ref for patch fn to avoid stale closures inside concurrent tasks
  const patchItem = useCallback((id: string, patch: Partial<FileItem>) => {
    setFileItems(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }, []);

  // Load asset list
  useEffect(() => {
    if (!tenantId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.get('/lios/assets/search', { tenant_id: tenantId })
      .then(res  => { if (!cancelled) setAssets((res as AssetsResponse).assets ?? []); })
      .catch(()  => { if (!cancelled) setAssets([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId, refreshTick]);

  // Add files (deduplicate by name)
  function addFiles(incoming: File[]) {
    setFileItems(prev => {
      const existing = new Set(prev.map(f => f.file.name));
      const news = incoming
        .filter(f => !existing.has(f.name))
        .map(f  => ({ id: uid(), file: f, status: 'pending' as FileStatus }));
      return [...prev, ...news];
    });
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length) addFiles(files);
    e.target.value = '';   // allow re-selecting same files
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) { addFiles(files); setActiveTab('file'); }
  }

  function removeItem(id: string) {
    setFileItems(prev => prev.filter(f => f.id !== id));
  }

  function clearDone() {
    setFileItems(prev => prev.filter(f => f.status !== 'done'));
  }

  // Upload a single file item; returns true on success
  async function uploadOne(item: FileItem): Promise<boolean> {
    // 1. Parse
    patchItem(item.id, { status: 'reading', error: undefined });
    let content: string;
    try {
      content = await readFileContent(item.file);
    } catch (err) {
      patchItem(item.id, { status: 'error', error: err instanceof Error ? err.message : '解析失败' });
      return false;
    }

    // 2. Upload
    patchItem(item.id, { status: 'uploading' });
    try {
      await api.post('/lios/assets/ingest', {
        tenant_id: tenantId,
        name:      item.file.name,
        content,
        asset_type: assetType,
        scope,
        scope_ref:  tenantId,
        tags:       tags.split(',').map(t => t.trim()).filter(Boolean),
      });
      patchItem(item.id, { status: 'done' });
      return true;
    } catch (err) {
      patchItem(item.id, { status: 'error', error: err instanceof Error ? err.message : '上传失败' });
      return false;
    }
  }

  async function handleBatchUpload() {
    const pending = fileItems.filter(f => f.status === 'pending' || f.status === 'error');
    if (!pending.length || !tenantId) return;

    setIsUploading(true);

    // Concurrent uploads
    await Promise.allSettled(pending.map(item => uploadOne(item)));

    // Reindex + embed once after all uploads
    try {
      await api.post('/lios/assets/reindex', { tenant_id: tenantId });
    } catch { /* non-critical */ }

    setIsUploading(false);
    setRefreshTick(t => t + 1);
  }

  async function retryItem(item: FileItem) {
    if (isUploading) return;
    setIsUploading(true);
    await uploadOne(item);
    try { await api.post('/lios/assets/reindex', { tenant_id: tenantId }); } catch { /* ok */ }
    setIsUploading(false);
    setRefreshTick(t => t + 1);
  }

  async function handleUrlUpload() {
    if (!urlInput.trim() || !urlName.trim() || !tenantId) return;
    setUrlUploading(true);
    setUrlMessage(null);
    try {
      await api.post('/lios/assets/ingest', {
        tenant_id: tenantId,
        name:      urlName.trim(),
        content:   urlInput.trim(),
        asset_type: assetType,
        scope,
        scope_ref:  tenantId,
        tags:       tags.split(',').map(t => t.trim()).filter(Boolean),
      });
      await api.post('/lios/assets/reindex', { tenant_id: tenantId });
      setUrlMessage({ ok: true, text: `「${urlName}」已就绪` });
      setUrlInput('');
      setUrlName('');
      setRefreshTick(t => t + 1);
    } catch (err) {
      setUrlMessage({ ok: false, text: err instanceof Error ? err.message : '上传失败' });
    } finally {
      setUrlUploading(false);
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const pendingCount   = fileItems.filter(f => f.status === 'pending' || f.status === 'error').length;
  const activeCount    = fileItems.filter(f => f.status === 'reading' || f.status === 'uploading').length;
  const doneCount      = fileItems.filter(f => f.status === 'done').length;
  const hasFiles       = fileItems.length > 0;
  const allDone        = hasFiles && fileItems.every(f => f.status === 'done' || f.status === 'error');

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">资产管理</h1>

      {/* Upload card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
        <h2 className="text-base font-semibold text-white mb-4">上传资产</h2>

        {/* Tab switcher */}
        <div className="flex gap-1 mb-6 bg-slate-800 rounded-lg p-1 w-fit">
          {(['file', 'url'] as TabType[]).map(tab => (
            <button
              key={tab}
              onClick={() => { if (!isUploading) setActiveTab(tab); }}
              disabled={isUploading}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50 ${
                activeTab === tab ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab === 'file' ? <><Upload className="w-4 h-4" />文件上传</> : <><LinkIcon className="w-4 h-4" />URL 导入</>}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Left: dropzone or URL */}
          <div className="lg:col-span-2 space-y-4">
            {activeTab === 'file' ? (
              <>
                {/* Drop zone */}
                <div
                  onClick={() => { if (!isUploading) fileInputRef.current?.click(); }}
                  onDragOver={e => { e.preventDefault(); if (!isUploading) setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { if (!isUploading) handleDrop(e); else e.preventDefault(); }}
                  className={`border-2 border-dashed rounded-xl p-7 text-center transition-colors ${
                    isUploading ? 'opacity-50 cursor-not-allowed'
                    : dragOver   ? 'border-blue-500 bg-blue-500/10 cursor-copy'
                    : hasFiles   ? 'border-blue-500/40 bg-blue-500/5 cursor-pointer hover:border-blue-500/60'
                    :              'border-slate-700 hover:border-slate-600 hover:bg-slate-800/50 cursor-pointer'
                  }`}
                >
                  <Upload className={`w-9 h-9 mx-auto mb-2 ${hasFiles ? 'text-blue-400' : 'text-slate-600'}`} />
                  {hasFiles ? (
                    <p className="text-blue-300 font-medium text-sm">
                      已选 {fileItems.length} 个文件 · 点击或拖入继续添加
                    </p>
                  ) : (
                    <>
                      <p className="text-slate-300 font-medium text-sm mb-1">拖拽多个文件到此处，或点击选择</p>
                      <p className="text-slate-500 text-xs">支持 .docx、.txt、.md、.csv、.json（可多选）</p>
                    </>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  disabled={isUploading}
                  onChange={handleFileInputChange}
                  accept=".docx,.txt,.md,.csv,.json,.xml,.yaml,.yml"
                />

                {/* File list */}
                {hasFiles && (
                  <div className="border border-slate-700 rounded-xl overflow-hidden">
                    {/* List header */}
                    <div className="flex items-center justify-between px-4 py-2.5 bg-slate-800/60 border-b border-slate-700">
                      <span className="text-xs text-slate-400 font-medium">
                        {fileItems.length} 个文件
                        {doneCount > 0 && <span className="text-emerald-400 ml-1">· {doneCount} 已完成</span>}
                        {activeCount > 0 && <span className="text-blue-400 ml-1">· {activeCount} 上传中</span>}
                      </span>
                      <div className="flex items-center gap-3">
                        {doneCount > 0 && (
                          <button
                            onClick={clearDone}
                            disabled={isUploading}
                            className="text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40"
                          >
                            清除已完成
                          </button>
                        )}
                        <button
                          onClick={() => setFileItems([])}
                          disabled={isUploading}
                          className="text-xs text-slate-500 hover:text-red-400 transition-colors disabled:opacity-40"
                        >
                          清空列表
                        </button>
                      </div>
                    </div>

                    {/* File rows */}
                    <div className="max-h-64 overflow-y-auto divide-y divide-slate-800/60">
                      {fileItems.map(item => (
                        <FileRow
                          key={item.id}
                          item={item}
                          onRemove={() => removeItem(item.id)}
                          onRetry={() => void retryItem(item)}
                          disabled={isUploading}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* URL tab */
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">网址 URL</label>
                  <input
                    type="url" value={urlInput} onChange={e => setUrlInput(e.target.value)}
                    disabled={urlUploading}
                    placeholder="https://example.com/document"
                    className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">资产名称</label>
                  <input
                    type="text" value={urlName} onChange={e => setUrlName(e.target.value)}
                    disabled={urlUploading}
                    placeholder="给这个资产取个名字"
                    className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
                  />
                </div>
                {urlMessage && (
                  <p className={`text-xs ${urlMessage.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                    {urlMessage.ok ? '✅' : '❌'} {urlMessage.text}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Right: config + action button */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">资产类型</label>
              <select
                value={assetType} onChange={e => setAssetType(e.target.value)}
                disabled={isUploading || urlUploading}
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
              >
                {ASSET_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">作用域</label>
              <select
                value={scope} onChange={e => setScope(e.target.value)}
                disabled={isUploading || urlUploading}
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
              >
                {SCOPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">标签（可选）</label>
              <input
                type="text" value={tags} onChange={e => setTags(e.target.value)}
                disabled={isUploading || urlUploading}
                placeholder="标签1, 标签2"
                className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
              />
              <p className="text-xs text-slate-500 mt-1">多个标签用逗号分隔</p>
            </div>

            {activeTab === 'file' ? (
              <div className="space-y-2">
                <button
                  onClick={() => void handleBatchUpload()}
                  disabled={isUploading || pendingCount === 0}
                  className="w-full py-2.5 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/40 disabled:cursor-not-allowed text-white rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2"
                >
                  {isUploading
                    ? <><Spinner size="sm" /><span>上传中 ({activeCount}/{pendingCount + activeCount})...</span></>
                    : <><Upload className="w-4 h-4" />{pendingCount > 0 ? `上传 ${pendingCount} 个文件` : '上传'}</>
                  }
                </button>
                {allDone && doneCount > 0 && (
                  <p className="text-center text-xs text-emerald-400">
                    ✅ {doneCount} 个文件已就绪，知识库已更新
                  </p>
                )}
              </div>
            ) : (
              <button
                onClick={() => void handleUrlUpload()}
                disabled={urlUploading || !urlInput.trim() || !urlName.trim()}
                className="w-full py-2.5 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/40 disabled:cursor-not-allowed text-white rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2"
              >
                {urlUploading ? <><Spinner size="sm" /><span>上传中...</span></> : <><Upload className="w-4 h-4" />导入</>}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Asset list table */}
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
    </div>
  );
}

// ── FileRow sub-component ─────────────────────────────────────────────────────

interface FileRowProps {
  item:     FileItem;
  onRemove: () => void;
  onRetry:  () => void;
  disabled: boolean;
}

function FileRow({ item, onRemove, onRetry, disabled }: FileRowProps) {
  const { file, status, error } = item;
  const sizeKB = (file.size / 1024).toFixed(1);

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-800/30 transition-colors">
      {/* Icon */}
      <FileText className="w-4 h-4 flex-shrink-0 text-slate-500" />

      {/* Name + size */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${
          status === 'done'  ? 'text-emerald-300'
          : status === 'error' ? 'text-red-300'
          : 'text-slate-200'
        }`}>
          {file.name}
        </p>

        {/* Progress bar (reading / uploading) */}
        {(status === 'reading' || status === 'uploading') && (
          <div className="w-full h-1 bg-slate-700 rounded-full overflow-hidden mt-1">
            <div
              className="h-full bg-blue-500 rounded-full"
              style={{ width: '65%', animation: 'slide 1.2s ease-in-out infinite' }}
            />
          </div>
        )}

        {/* Error message */}
        {status === 'error' && error && (
          <p className="text-xs text-red-400 mt-0.5 truncate">{error}</p>
        )}

        {/* Size */}
        {status === 'pending' && (
          <p className="text-xs text-slate-500">{sizeKB} KB</p>
        )}
      </div>

      {/* Status badge */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {status === 'pending'   && <Clock        className="w-4 h-4 text-slate-500" />}
        {status === 'reading'   && <Spinner size="sm" />}
        {status === 'uploading' && <Spinner size="sm" />}
        {status === 'done'      && <CheckCircle  className="w-4 h-4 text-emerald-400" />}
        {status === 'error'     && (
          <>
            <AlertCircle className="w-4 h-4 text-red-400" />
            <button
              onClick={onRetry}
              disabled={disabled}
              className="flex items-center gap-1 px-2 py-0.5 text-xs bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-300 rounded transition-colors disabled:opacity-40"
            >
              <RefreshCw className="w-3 h-3" /> 重试
            </button>
          </>
        )}

        {/* Remove (pending / error only) */}
        {(status === 'pending' || status === 'error') && (
          <button
            onClick={onRemove}
            disabled={disabled}
            className="text-slate-600 hover:text-slate-400 transition-colors disabled:opacity-40 ml-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
