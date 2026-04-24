import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import { getAuth } from '../../lib/auth';
import Spinner from '../../components/Spinner';
import Empty from '../../components/Empty';
import StatusBadge from '../../components/StatusBadge';

interface Decision {
  id: string;
  decision_type: string;
  rationale: string;
  confidence: number;
  created_at: string;
  trace_id: string;
  raw_input: string;
  intent_status: string;
  metadata?: Record<string, unknown>;
}

interface DecisionsResponse {
  total: number;
  page: number;
  limit: number;
  decisions: Decision[];
}

const PAGE_SIZE = 20;

export default function Decisions() {
  const auth = getAuth();
  const tenantId = auth?.tenant_id ?? '';

  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    api.get('/lios/decisions', {
      tenant_id: tenantId,
      page: String(page),
      limit: String(PAGE_SIZE),
    })
      .then(res => {
        if (!cancelled) {
          const data = res as DecisionsResponse;
          setDecisions(data.decisions ?? []);
          setTotal(data.total ?? 0);
        }
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tenantId, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function toggleExpand(id: string) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">裁决记录</h1>

      {error && (
        <div className="p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">共 {total} 条记录</h2>
        </div>

        {loading ? (
          <div className="py-12 flex justify-center"><Spinner /></div>
        ) : decisions.length === 0 ? (
          <Empty message="暂无裁决记录" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">Trace ID</th>
                    <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">时间</th>
                    <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">意图描述</th>
                    <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">裁决结果</th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-slate-500">置信度</th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-slate-500">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map(d => {
                    const isExpanded = expandedId === d.id;
                    const statusKey = d.decision_type ?? d.intent_status ?? 'pending';
                    return (
                      <React.Fragment key={d.id}>
                        <tr
                          className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer"
                          onClick={() => toggleExpand(d.id)}
                        >
                          <td className="px-5 py-3 text-slate-400 font-mono text-xs">
                            {(d.trace_id ?? d.id ?? '').slice(0, 8)}
                          </td>
                          <td className="px-5 py-3 text-slate-400 whitespace-nowrap">
                            {d.created_at
                              ? new Date(d.created_at).toLocaleString('zh-CN', {
                                  month: '2-digit',
                                  day: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })
                              : '-'}
                          </td>
                          <td className="px-5 py-3 text-slate-300">
                            {(d.raw_input ?? '').slice(0, 50)}
                            {(d.raw_input ?? '').length > 50 ? '...' : ''}
                          </td>
                          <td className="px-5 py-3">
                            <StatusBadge status={statusKey} />
                          </td>
                          <td className="px-5 py-3 text-right text-slate-400">
                            {d.confidence != null ? `${Math.round(d.confidence * 100)}%` : '-'}
                          </td>
                          <td className="px-5 py-3 text-right text-slate-500">
                            {isExpanded
                              ? <ChevronUp className="w-4 h-4 inline" />
                              : <ChevronDown className="w-4 h-4 inline" />}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="border-b border-slate-800/50 bg-slate-800/20">
                            <td colSpan={6} className="px-5 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                <div>
                                  <p className="text-xs font-medium text-slate-500 mb-1">完整意图内容</p>
                                  <p className="text-slate-300 bg-slate-800 rounded-lg p-3 leading-relaxed whitespace-pre-wrap text-xs">
                                    {d.raw_input ?? '—'}
                                  </p>
                                </div>
                                <div className="space-y-3">
                                  <div>
                                    <p className="text-xs font-medium text-slate-500 mb-1">裁决理由 (Rationale)</p>
                                    <p className="text-slate-300 bg-slate-800 rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap">
                                      {d.rationale ?? '—'}
                                    </p>
                                  </div>
                                  <div className="grid grid-cols-2 gap-3">
                                    <div>
                                      <p className="text-xs font-medium text-slate-500 mb-1">裁决类型</p>
                                      <StatusBadge status={statusKey} />
                                    </div>
                                    <div>
                                      <p className="text-xs font-medium text-slate-500 mb-1">置信度</p>
                                      <p className="text-slate-300 text-sm font-medium">
                                        {d.confidence != null ? `${Math.round(d.confidence * 100)}%` : '—'}
                                      </p>
                                    </div>
                                  </div>
                                  {d.metadata && (
                                    <div>
                                      <p className="text-xs font-medium text-slate-500 mb-1">Metadata</p>
                                      <pre className="text-xs text-slate-400 bg-slate-800 rounded-lg p-3 overflow-x-auto">
                                        {JSON.stringify(d.metadata, null, 2)}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="px-5 py-4 border-t border-slate-800 flex items-center justify-between">
                <p className="text-xs text-slate-500">
                  第 {page} / {totalPages} 页，共 {total} 条
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    const start = Math.max(1, Math.min(page - 2, totalPages - 4));
                    const pg = start + i;
                    return (
                      <button
                        key={pg}
                        onClick={() => setPage(pg)}
                        className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${pg === page ? 'bg-blue-500 text-white' : 'border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600'}`}
                      >
                        {pg}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
