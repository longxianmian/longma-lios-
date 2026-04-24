import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { BrainCircuit, LayoutDashboard, Building2, BookOpen, Activity, Lock, Eye, EyeOff } from 'lucide-react';
import { isAdminVerified, setAdminVerified } from '../lib/auth';

const ADMIN_PASSWORD = 'lios-admin-2026';

const NAV_ITEMS = [
  { to: '/admin', label: '概览', icon: LayoutDashboard, end: true },
  { to: '/admin/tenants', label: '租户管理', icon: Building2, end: false },
  { to: '/admin/knowledge', label: '行业知识库', icon: BookOpen, end: false },
  { to: '/admin/monitor', label: '运行监控', icon: Activity, end: false },
];

function AdminGate({ onVerified }: { onVerified: () => void }) {
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password === ADMIN_PASSWORD) {
      setAdminVerified();
      onVerified();
    } else {
      setError('密码错误，请重试');
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <BrainCircuit className="w-8 h-8 text-blue-500" />
          <span className="text-2xl font-bold text-white">LIOS</span>
          <span className="text-xs text-slate-500 border border-slate-700 px-2 py-0.5 rounded ml-1">超管</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8">
          <div className="flex items-center justify-center mb-6">
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
              <Lock className="w-8 h-8 text-amber-400" />
            </div>
          </div>
          <h1 className="text-xl font-bold text-white text-center mb-2">超管验证</h1>
          <p className="text-slate-400 text-sm text-center mb-6">请输入超级管理员密码</p>

          {error && (
            <div className="p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm text-center">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="relative mb-4">
              <input
                type={showPwd ? 'text' : 'password'}
                value={password}
                onChange={e => {
                  setPassword(e.target.value);
                  setError('');
                }}
                placeholder="请输入管理员密码"
                className="w-full px-3 py-2.5 pr-10 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <button
                type="button"
                onClick={() => setShowPwd(!showPwd)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <button
              type="submit"
              className="w-full py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium text-sm transition-colors"
            >
              验证并进入
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function AdminLayout() {
  const [verified, setVerified] = useState(isAdminVerified());

  if (!verified) {
    return <AdminGate onVerified={() => setVerified(true)} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 flex">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col fixed top-0 left-0 h-full z-40">
        <div className="flex items-center gap-2 px-5 py-5 border-b border-slate-800">
          <BrainCircuit className="w-7 h-7 text-blue-500 flex-shrink-0" />
          <div>
            <div className="text-white font-bold text-base leading-tight">LIOS</div>
            <div className="text-amber-400 text-xs">超级管理员</div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`
              }
            >
              <item.icon className="w-4 h-4 flex-shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex-1 ml-60 flex flex-col min-h-screen">
        <header className="h-14 bg-slate-950 border-b border-slate-800 flex items-center justify-end px-6 sticky top-0 z-30">
          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-400 border border-amber-500/30 bg-amber-500/10 px-2 py-1 rounded">超级管理员</span>
          </div>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
