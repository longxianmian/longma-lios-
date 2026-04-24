import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Database, RefreshCw, CheckCircle, Clock, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { getAuth } from '../../lib/auth';
import Spinner from '../../components/Spinner';

interface Pipeline {
  intent_type:     string;
  intent_summary:  string;
  decision:        'accept' | 'hold' | 'reject';
  confidence:      number;
  candidate_score: number;
  kb_assets_used:  number;
  error?:          boolean;
}

interface Message {
  id:           string;
  role:         'user' | 'bot';
  text:         string;
  quickReplies?: string[];
  pipeline?:    Pipeline;
  timestamp:    Date;
}

interface ChatResponse {
  reply:         string;
  quick_replies: string[];
  session_id:    string;
  pipeline?:     Pipeline;
}

interface AssetsResponse {
  count: number;
}

const INTENT_LABELS: Record<string, string> = {
  product_inquiry: '商品諮詢',
  order_inquiry:   '訂單查詢',
  return_request:  '退換貨',
  price_inquiry:   '價格諮詢',
  greeting:        '問候',
  complaint:       '投訴',
  other:           '其他',
};

function DecisionBadge({ decision }: { decision: 'accept' | 'hold' | 'reject' }) {
  if (decision === 'accept') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded-full text-xs font-medium">
        <CheckCircle className="w-3 h-3" /> Accept
      </span>
    );
  }
  if (decision === 'hold') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/15 border border-amber-500/30 text-amber-400 rounded-full text-xs font-medium">
        <Clock className="w-3 h-3" /> Hold
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/15 border border-red-500/30 text-red-400 rounded-full text-xs font-medium">
      <XCircle className="w-3 h-3" /> Reject
    </span>
  );
}

function PipelineTrace({ p }: { p: Pipeline }) {
  return (
    <div className="mt-1.5 px-3 py-2 bg-slate-900/80 border border-slate-700/50 rounded-lg text-xs space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-slate-500">裁決</span>
        <DecisionBadge decision={p.decision} />
        <span className="text-slate-500 ml-1">意圖</span>
        <span className="text-slate-300">{INTENT_LABELS[p.intent_type] ?? p.intent_type}</span>
      </div>
      <div className="flex items-center gap-3 text-slate-500">
        <span>置信度 <span className="text-slate-300">{Math.round(p.confidence * 100)}%</span></span>
        <span>·</span>
        <span>候選分 <span className="text-slate-300">{Math.round(p.candidate_score * 100)}%</span></span>
        <span>·</span>
        <span>知識庫 <span className="text-slate-300">{p.kb_assets_used}</span> 條</span>
      </div>
      {p.intent_summary && (
        <p className="text-slate-400 italic truncate">"{p.intent_summary}"</p>
      )}
    </div>
  );
}

export default function ChatTest() {
  const auth = getAuth();
  const tenantId = auth?.tenant_id ?? '';

  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'bot',
      text: `您好！我是您企業的 AI 客服助手。\n\n我會先分析您的意圖，再從知識庫搜尋候選答案，最後由 LI Kernel 裁決後生成回覆。請提問！`,
      quickReplies: ['查詢商品', '退換貨政策', '聯繫人工客服'],
      timestamp: new Date(),
    },
  ]);
  const [input, setInput]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [kbCount, setKbCount]   = useState<number | null>(null);
  const [showTrace, setShowTrace] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!tenantId) return;
    api.get('/lios/assets/search', { tenant_id: tenantId, indexed: 'true' })
      .then(res => setKbCount((res as AssetsResponse).count ?? 0))
      .catch(() => setKbCount(0));
  }, [tenantId]);

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;
    setInput('');

    const userMsg: Message = {
      id: `u-${Date.now()}`, role: 'user', text: text.trim(), timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await api.post('/lios/chat', {
        tenant_id: tenantId,
        message:   text.trim(),
        session_id: sessionId || undefined,
        lang:      'zh-TW',
      }) as ChatResponse;

      if (res.session_id) setSessionId(res.session_id);

      const botMsg: Message = {
        id: `b-${Date.now()}`, role: 'bot',
        text:         res.reply,
        quickReplies: res.quick_replies,
        pipeline:     res.pipeline,
        timestamp:    new Date(),
      };
      setMessages(prev => [...prev, botMsg]);
    } catch (err) {
      setMessages(prev => [...prev, {
        id: `e-${Date.now()}`, role: 'bot',
        text: `系統錯誤：${err instanceof Error ? err.message : '請稍後重試'}`,
        timestamp: new Date(),
      }]);
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setSessionId('');
    setMessages([{
      id: `welcome-${Date.now()}`, role: 'bot',
      text: `您好！我是您企業的 AI 客服助手。\n\n我會先分析您的意圖，再從知識庫搜尋候選答案，最後由 LI Kernel 裁決後生成回覆。請提問！`,
      quickReplies: ['查詢商品', '退換貨政策', '聯繫人工客服'],
      timestamp: new Date(),
    }]);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">AI 客服測試</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Intent → Candidate Space → LI Kernel → Response Generation
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTrace(v => !v)}
            className={`px-3 py-2 border rounded-lg text-xs font-medium transition-colors ${
              showTrace
                ? 'bg-blue-500/15 border-blue-500/30 text-blue-400'
                : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
            }`}
          >
            Pipeline 追蹤 {showTrace ? '開' : '關'}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg text-sm transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            重置
          </button>
        </div>
      </div>

      {/* KB status */}
      <div className="flex items-center gap-2 px-4 py-2.5 mb-4 bg-slate-900 border border-slate-800 rounded-xl text-sm">
        <Database className="w-4 h-4 text-blue-400 flex-shrink-0" />
        {kbCount === null ? (
          <span className="text-slate-400">正在載入知識庫...</span>
        ) : kbCount === 0 ? (
          <span className="text-amber-400">
            知識庫為空 — 請先至【資產管理】上傳企業資料
          </span>
        ) : (
          <span className="text-slate-300">
            已載入 <span className="text-blue-400 font-semibold">{kbCount}</span> 條知識庫資產
            <span className="text-slate-500 ml-2">·</span>
            <span className="text-slate-500 ml-2">GPT-4o-mini · LI Kernel 三態裁決</span>
          </span>
        )}
      </div>

      {/* Chat window */}
      <div className="flex-1 bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map(msg => (
            <div key={msg.id} className={`flex items-end gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
              {/* Avatar */}
              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                msg.role === 'bot'
                  ? 'bg-blue-500/20 border border-blue-500/30'
                  : 'bg-slate-700'
              }`}>
                {msg.role === 'bot'
                  ? <Bot className="w-4 h-4 text-blue-400" />
                  : <User className="w-4 h-4 text-slate-300" />
                }
              </div>

              <div className={`max-w-[72%] flex flex-col gap-1.5 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                {/* Bubble */}
                <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-line ${
                  msg.role === 'user'
                    ? 'bg-blue-500 text-white rounded-br-sm'
                    : 'bg-slate-800 text-slate-200 rounded-bl-sm'
                }`}>
                  {msg.text}
                </div>

                {/* Pipeline trace (bot messages only) */}
                {msg.role === 'bot' && showTrace && msg.pipeline && !msg.pipeline.error && (
                  <PipelineTrace p={msg.pipeline} />
                )}

                {/* Quick replies */}
                {msg.role === 'bot' && msg.quickReplies && msg.quickReplies.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {msg.quickReplies.map(qr => (
                      <button
                        key={qr}
                        onClick={() => void sendMessage(qr)}
                        disabled={loading}
                        className="px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-blue-500/50 text-slate-300 hover:text-blue-300 rounded-full text-xs transition-colors disabled:opacity-40"
                      >
                        {qr}
                      </button>
                    ))}
                  </div>
                )}

                <span className="text-slate-600 text-xs px-1">
                  {msg.timestamp.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-end gap-2">
              <div className="w-7 h-7 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                <Bot className="w-4 h-4 text-blue-400" />
              </div>
              <div className="space-y-1">
                <div className="px-4 py-3 bg-slate-800 rounded-2xl rounded-bl-sm flex items-center gap-2">
                  <Spinner size="sm" />
                  <span className="text-slate-400 text-xs">Intent → Candidate → Kernel → 生成回覆...</span>
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-slate-800 p-3">
          <form
            onSubmit={e => { e.preventDefault(); void sendMessage(input); }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              disabled={loading}
              placeholder="輸入問題，測試完整 LIOS Pipeline..."
              className="flex-1 px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="w-10 h-10 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/40 disabled:cursor-not-allowed rounded-xl flex items-center justify-center transition-colors flex-shrink-0"
            >
              <Send className="w-4 h-4 text-white" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
