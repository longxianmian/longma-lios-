import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BrainCircuit, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import { setAuth } from '../lib/auth';
import Spinner from '../components/Spinner';

interface RegisterResponse {
  tenant_id: string;
  company_name: string;
  token: string;
}

interface FormData {
  company_name: string;
  contact_name: string;
  email: string;
  password: string;
  confirm_password: string;
  industry: string;
  company_size: string;
}

interface FormErrors {
  company_name?: string;
  contact_name?: string;
  email?: string;
  password?: string;
  confirm_password?: string;
  industry?: string;
  company_size?: string;
  general?: string;
}

const INDUSTRIES = [
  { value: 'tech', label: '科技/互联网' },
  { value: 'legal', label: '法律' },
  { value: 'medical', label: '医疗健康' },
  { value: 'education', label: '教育' },
  { value: 'retail', label: '零售电商' },
  { value: 'finance', label: '金融' },
  { value: 'manufacturing', label: '制造业' },
  { value: 'other', label: '其他' },
];

const COMPANY_SIZES = [
  { value: '1-50', label: '1-50人' },
  { value: '51-200', label: '51-200人' },
  { value: '201-500', label: '201-500人' },
  { value: '500+', label: '500人以上' },
];

export default function Register() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormData>({
    company_name: '',
    contact_name: '',
    email: '',
    password: '',
    confirm_password: '',
    industry: '',
    company_size: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  function validate(): boolean {
    const errs: FormErrors = {};
    if (!form.company_name.trim()) errs.company_name = '请输入企业名称';
    if (!form.contact_name.trim()) errs.contact_name = '请输入联系人姓名';
    if (!form.email.trim()) {
      errs.email = '请输入邮箱';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errs.email = '邮箱格式不正确';
    }
    if (!form.password) {
      errs.password = '请输入密码';
    } else if (form.password.length < 8) {
      errs.password = '密码至少需要8位';
    }
    if (!form.confirm_password) {
      errs.confirm_password = '请确认密码';
    } else if (form.confirm_password !== form.password) {
      errs.confirm_password = '两次密码输入不一致';
    }
    if (!form.industry) errs.industry = '请选择所属行业';
    if (!form.company_size) errs.company_size = '请选择企业规模';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    setErrors({});
    try {
      const res = await api.post('/lios/tenants/register', {
        company_name: form.company_name,
        contact_name: form.contact_name,
        email: form.email,
        password: form.password,
        industry: form.industry,
        company_size: form.company_size,
      }) as RegisterResponse;
      setAuth({
        tenant_id: res.tenant_id,
        company_name: res.company_name,
        token: res.token,
      });
      navigate('/dashboard');
    } catch (err) {
      setErrors({ general: err instanceof Error ? err.message : '注册失败，请重试' });
    } finally {
      setLoading(false);
    }
  }

  function setField(key: keyof FormData, value: string) {
    setForm(prev => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors(prev => ({ ...prev, [key]: undefined }));
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <BrainCircuit className="w-8 h-8 text-blue-500" />
          <span className="text-2xl font-bold text-white">LIOS</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8">
          <h1 className="text-2xl font-bold text-white mb-2">创建企业账号</h1>
          <p className="text-slate-400 text-sm mb-8">已有账号？<Link to="/login" className="text-blue-400 hover:text-blue-300">立即登录</Link></p>

          {errors.general && (
            <div className="flex items-center gap-2 p-3 mb-6 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {errors.general}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Company Name */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">企业名称 <span className="text-red-400">*</span></label>
              <input
                type="text"
                value={form.company_name}
                onChange={e => setField('company_name', e.target.value)}
                placeholder="请输入企业全称"
                className={`w-full px-3 py-2.5 bg-slate-800 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-sm ${errors.company_name ? 'border-red-500' : 'border-slate-700'}`}
              />
              {errors.company_name && <p className="text-red-400 text-xs mt-1">{errors.company_name}</p>}
            </div>

            {/* Contact Name */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">联系人 <span className="text-red-400">*</span></label>
              <input
                type="text"
                value={form.contact_name}
                onChange={e => setField('contact_name', e.target.value)}
                placeholder="请输入联系人姓名"
                className={`w-full px-3 py-2.5 bg-slate-800 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-sm ${errors.contact_name ? 'border-red-500' : 'border-slate-700'}`}
              />
              {errors.contact_name && <p className="text-red-400 text-xs mt-1">{errors.contact_name}</p>}
            </div>

            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">邮箱 <span className="text-red-400">*</span></label>
              <input
                type="email"
                value={form.email}
                onChange={e => setField('email', e.target.value)}
                placeholder="company@example.com"
                className={`w-full px-3 py-2.5 bg-slate-800 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-sm ${errors.email ? 'border-red-500' : 'border-slate-700'}`}
              />
              {errors.email && <p className="text-red-400 text-xs mt-1">{errors.email}</p>}
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">密码 <span className="text-red-400">*</span></label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => setField('password', e.target.value)}
                  placeholder="至少8位字符"
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

            {/* Confirm Password */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">确认密码 <span className="text-red-400">*</span></label>
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  value={form.confirm_password}
                  onChange={e => setField('confirm_password', e.target.value)}
                  placeholder="再次输入密码"
                  className={`w-full px-3 py-2.5 pr-10 bg-slate-800 border rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-sm ${errors.confirm_password ? 'border-red-500' : 'border-slate-700'}`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm(!showConfirm)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                >
                  {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {errors.confirm_password && <p className="text-red-400 text-xs mt-1">{errors.confirm_password}</p>}
            </div>

            {/* Industry & Company Size */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">所属行业 <span className="text-red-400">*</span></label>
                <select
                  value={form.industry}
                  onChange={e => setField('industry', e.target.value)}
                  className={`w-full px-3 py-2.5 bg-slate-800 border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-sm ${errors.industry ? 'border-red-500' : 'border-slate-700'}`}
                >
                  <option value="">请选择</option>
                  {INDUSTRIES.map(ind => (
                    <option key={ind.value} value={ind.value}>{ind.label}</option>
                  ))}
                </select>
                {errors.industry && <p className="text-red-400 text-xs mt-1">{errors.industry}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">企业规模 <span className="text-red-400">*</span></label>
                <select
                  value={form.company_size}
                  onChange={e => setField('company_size', e.target.value)}
                  className={`w-full px-3 py-2.5 bg-slate-800 border rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors text-sm ${errors.company_size ? 'border-red-500' : 'border-slate-700'}`}
                >
                  <option value="">请选择</option>
                  {COMPANY_SIZES.map(size => (
                    <option key={size.value} value={size.value}>{size.label}</option>
                  ))}
                </select>
                {errors.company_size && <p className="text-red-400 text-xs mt-1">{errors.company_size}</p>}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/50 text-white rounded-lg font-semibold transition-colors flex items-center justify-center gap-2 mt-6"
            >
              {loading ? <><Spinner size="sm" /><span>注册中...</span></> : '立即注册'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
