import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BrainCircuit, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import { setAuth } from '../lib/auth';
import Spinner from '../components/Spinner';

interface LoginResponse {
  tenant_id: string;
  company_name: string;
  token: string;
}

interface FormErrors {
  email?: string;
  password?: string;
  general?: string;
}

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);

  function validate(): boolean {
    const errs: FormErrors = {};
    if (!email.trim()) {
      errs.email = '请输入邮箱';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errs.email = '邮箱格式不正确';
    }
    if (!password) {
      errs.password = '请输入密码';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    setErrors({});
    try {
      const res = await api.post('/lios/tenants/login', { email, password }) as LoginResponse;
      setAuth({
        tenant_id: res.tenant_id,
        company_name: res.company_name,
        token: res.token,
      });
      if (rememberMe) {
        // token is already persisted in localStorage via setAuth
      }
      navigate('/dashboard');
    } catch (err) {
      setErrors({ general: err instanceof Error ? err.message : '登录失败，请检查邮箱和密码' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <BrainCircuit className="w-8 h-8 text-blue-500" />
          <span className="text-2xl font-bold text-white">LIOS</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8">
          <h1 className="text-2xl font-bold text-white mb-2">企业登录</h1>
          <p className="text-slate-400 text-sm mb-8">
            还没有账号？<Link to="/register" className="text-blue-400 hover:text-blue-300">立即注册</Link>
          </p>

          {errors.general && (
            <div className="flex items-center gap-2 p-3 mb-6 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {errors.general}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">邮箱</label>
              <input
                type="email"
                value={email}
                onChange={e => {
                  setEmail(e.target.value);
                  if (errors.email) setErrors(prev => ({ ...prev, email: undefined }));
                }}
                placeholder="company@example.com"
                className={`w-full px-3 py-2.5 bg-slate-800 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-sm ${errors.email ? 'border-red-500' : 'border-slate-700'}`}
              />
              {errors.email && <p className="text-red-400 text-xs mt-1">{errors.email}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">密码</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => {
                    setPassword(e.target.value);
                    if (errors.password) setErrors(prev => ({ ...prev, password: undefined }));
                  }}
                  placeholder="输入密码"
                  className={`w-full px-3 py-2.5 pr-10 bg-slate-800 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-sm ${errors.password ? 'border-red-500' : 'border-slate-700'}`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {errors.password && <p className="text-red-400 text-xs mt-1">{errors.password}</p>}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="rememberMe"
                checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)}
                className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
              />
              <label htmlFor="rememberMe" className="text-sm text-slate-400">记住我</label>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/50 text-white rounded-lg font-semibold transition-colors flex items-center justify-center gap-2 mt-2"
            >
              {loading ? <><Spinner size="sm" /><span>登录中...</span></> : '登录'}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-slate-800 text-center">
            <p className="text-sm text-slate-500">
              还没有账号？
              <Link to="/register" className="text-blue-400 hover:text-blue-300 ml-1">立即注册</Link>
            </p>
          </div>
        </div>

        <div className="mt-4 text-center">
          <Link to="/" className="text-sm text-slate-600 hover:text-slate-400 transition-colors">
            返回首页
          </Link>
        </div>
      </div>
    </div>
  );
}
