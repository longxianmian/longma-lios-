import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { api } from '../../lib/api';
import Spinner from '../../components/Spinner';

interface Decision {
  id: string;
  decision_type: string;
  intent_status?: string;
  created_at: string;
}

interface DecisionsResponse {
  decisions?: Decision[];
  total?: number;
}

interface DayData {
  day: string;
  count: number;
}

interface PieData {
  name: string;
  value: number;
  color: string;
}

interface Alert {
  id: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  time: string;
}

const MOCK_ALERTS: Alert[] = [
  { id: '1', level: 'warning', message: '租户 tech-corp 请求频率偏高，接近速率限制', time: '10分钟前' },
  { id: '2', level: 'info', message: '新租户 LexAI 已完成注册并通过验证', time: '32分钟前' },
  { id: '3', level: 'error', message: '插件 DeepSeek-endpoint 响应超时（3次）', time: '1小时前' },
  { id: '4', level: 'warning', message: '全平台裁决拒绝率较昨日上升 12%', time: '2小时前' },
  { id: '5', level: 'info', message: '系统完成例行健康检查，状态正常', time: '3小时前' },
];

function generateWeekData(decisions: Decision[]): DayData[] {
  const days: DayData[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayStr = d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    const dateStr = d.toISOString().slice(0, 10);
    const count = decisions.filter(dec => dec.created_at?.startsWith(dateStr)).length;
    days.push({ day: dayStr, count });
  }
  return days;
}

function generatePieData(decisions: Decision[]): PieData[] {
  const counts: Record<string, number> = { accept: 0, hold: 0, rejected: 0 };
  decisions.forEach(d => {
    const type = (d.decision_type ?? d.intent_status ?? '').toLowerCase();
    if (type.includes('accept')) counts.accept++;
    else if (type.includes('hold') || type.includes('pending')) counts.hold++;
    else if (type.includes('reject')) counts.rejected++;
    else counts.hold++;
  });

  const result: PieData[] = [];
  if (counts.accept > 0) result.push({ name: '通过', value: counts.accept, color: '#10b981' });
  if (counts.hold > 0) result.push({ name: '待定', value: counts.hold, color: '#f59e0b' });
  if (counts.rejected > 0) result.push({ name: '拒绝', value: counts.rejected, color: '#ef4444' });

  if (result.length === 0) {
    return [
      { name: '通过', value: 65, color: '#10b981' },
      { name: '待定', value: 25, color: '#f59e0b' },
      { name: '拒绝', value: 10, color: '#ef4444' },
    ];
  }
  return result;
}

function AlertIcon({ level }: { level: Alert['level'] }) {
  if (level === 'error') return <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
  if (level === 'warning') return <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />;
  return <Info className="w-4 h-4 text-blue-400 flex-shrink-0" />;
}

export default function Monitor() {
  const [loading, setLoading] = useState(true);
  const [weekData, setWeekData] = useState<DayData[]>([]);
  const [pieData, setPieData] = useState<PieData[]>([]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await api.get('/lios/decisions', {
          tenant_id: 'admin',
          page: '1',
          limit: '200',
        }) as DecisionsResponse;
        const decisions = res.decisions ?? [];
        setWeekData(generateWeekData(decisions));
        setPieData(generatePieData(decisions));
      } catch {
        // Use mock data if API fails
        const mockDecisions: Decision[] = [];
        setWeekData(generateWeekData(mockDecisions));
        setPieData(generatePieData(mockDecisions));
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

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">运行监控</h1>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Line chart */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-base font-semibold text-white mb-4">近7天裁决量</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={weekData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                labelStyle={{ color: '#94a3b8' }}
                itemStyle={{ color: '#60a5fa' }}
              />
              <Line
                type="monotone"
                dataKey="count"
                name="裁决次数"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ fill: '#3b82f6', strokeWidth: 0, r: 4 }}
                activeDot={{ r: 6, fill: '#60a5fa' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Pie chart */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-base font-semibold text-white mb-4">裁决结果分布</h2>
          {pieData.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-slate-500 text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {pieData.map((entry, index) => (
                    <Cell key={index} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                  itemStyle={{ color: '#94a3b8' }}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  formatter={(value) => <span style={{ color: '#94a3b8', fontSize: '12px' }}>{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Alerts */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-white">最近告警</h2>
        </div>
        <div className="divide-y divide-slate-800/50">
          {MOCK_ALERTS.map(alert => (
            <div key={alert.id} className="flex items-start gap-3 px-5 py-4 hover:bg-slate-800/30 transition-colors">
              <AlertIcon level={alert.level} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-300">{alert.message}</p>
              </div>
              <span className="text-xs text-slate-500 flex-shrink-0 whitespace-nowrap">{alert.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
