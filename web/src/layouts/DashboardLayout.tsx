import { NavLink, Outlet, Navigate, useNavigate } from 'react-router-dom';
import { BrainCircuit, LayoutDashboard, Database, Puzzle, ClipboardList, Users, LogOut } from 'lucide-react';
import { getAuth, clearAuth } from '../lib/auth';

const NAV_ITEMS = [
  { to: '/dashboard', label: '概览', icon: LayoutDashboard, end: true },
  { to: '/dashboard/assets', label: '资产管理', icon: Database, end: false },
  { to: '/dashboard/plugins', label: '插件配置', icon: Puzzle, end: false },
  { to: '/dashboard/decisions', label: '裁决记录', icon: ClipboardList, end: false },
  { to: '/dashboard/employees', label: '数字员工', icon: Users, end: false },
];

export default function DashboardLayout() {
  const navigate = useNavigate();
  const auth = getAuth();

  if (!auth) {
    return <Navigate to="/login" replace />;
  }

  function handleLogout() {
    clearAuth();
    navigate('/login');
  }

  return (
    <div className="min-h-screen bg-slate-950 flex">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col fixed top-0 left-0 h-full z-40">
        {/* Logo */}
        <div className="flex items-center gap-2 px-5 py-5 border-b border-slate-800">
          <BrainCircuit className="w-7 h-7 text-blue-500 flex-shrink-0" />
          <div>
            <div className="text-white font-bold text-base leading-tight">LIOS</div>
            <div className="text-slate-500 text-xs">企业后台</div>
          </div>
        </div>

        {/* Nav */}
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

        {/* Bottom */}
        <div className="px-3 py-4 border-t border-slate-800">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-sm text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            退出登录
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 ml-60 flex flex-col min-h-screen">
        {/* Top bar */}
        <header className="h-14 bg-slate-950 border-b border-slate-800 flex items-center justify-end px-6 sticky top-0 z-30">
          <div className="flex items-center gap-3">
            <div className="text-sm text-slate-400">
              企业：<span className="text-slate-200 font-medium">{auth.company_name}</span>
            </div>
            <div className="w-8 h-8 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-blue-400 text-sm font-semibold">
              {auth.company_name.charAt(0).toUpperCase()}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
