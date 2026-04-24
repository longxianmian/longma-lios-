import { Link } from 'react-router-dom';
import { BrainCircuit, ArrowRight, Users, Lightbulb, BookOpen } from 'lucide-react';

const FORMULAS = [
  {
    icon: <Users className="w-6 h-6 text-blue-400" />,
    components: ['LIOS', '垂直大模型', '企业资料'],
    result: '企业数字员工系统',
    desc: '为企业量身定制智能数字员工，覆盖内部流程自动化与客户服务',
  },
  {
    icon: <Lightbulb className="w-6 h-6 text-emerald-400" />,
    components: ['LIOS', 'LLM', '个人资料'],
    result: '私人助理',
    desc: '深度理解个人偏好与行为模式，提供高度个性化的智能辅助体验',
  },
  {
    icon: <BookOpen className="w-6 h-6 text-amber-400" />,
    components: ['LIOS', 'LLM', '行业知识库'],
    result: '行业专家数字人',
    desc: '沉淀行业最佳实践，输出专业级别的决策建议与知识咨询服务',
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BrainCircuit className="w-7 h-7 text-blue-500" />
            <span className="text-xl font-bold text-white tracking-tight">LIOS</span>
            <span className="text-xs text-slate-500 ml-1 hidden sm:block">逻辑智能操作系统</span>
          </div>
          <nav className="flex items-center gap-3">
            <Link
              to="/login"
              className="px-4 py-2 text-sm text-slate-300 hover:text-white transition-colors"
            >
              企业登录
            </Link>
            <Link
              to="/register"
              className="px-4 py-2 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium transition-colors"
            >
              立即注册
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-4 py-24 relative overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl" />
          <div className="absolute top-1/3 left-1/3 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl" />
        </div>

        <div className="relative z-10 max-w-4xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-blue-500/30 bg-blue-500/10 text-blue-400 text-xs font-medium mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            企业级 AI 裁决底座，现已正式发布
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold text-white mb-6 leading-tight tracking-tight">
            LIOS
            <span className="block text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-400">
              逻辑智能操作系统
            </span>
          </h1>

          <p className="text-xl text-slate-400 max-w-2xl mx-auto mb-12 leading-relaxed">
            为企业提供可治理、可追溯的 AI 裁决底座<br />
            将多个 AI 模型的能力统一纳管，输出经过验证的高质量决策
          </p>

          <div className="flex flex-col sm:flex-row items-center gap-4 justify-center">
            <Link
              to="/register"
              className="flex items-center gap-2 px-8 py-4 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-semibold text-lg transition-all hover:scale-105 shadow-lg shadow-blue-500/25"
            >
              立即注册
              <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              to="/login"
              className="flex items-center gap-2 px-8 py-4 border border-slate-700 hover:border-slate-600 text-slate-300 hover:text-white rounded-xl font-semibold text-lg transition-all hover:bg-slate-900"
            >
              企业登录
            </Link>
          </div>
        </div>
      </section>

      {/* Product Formulas */}
      <section className="py-24 px-4 bg-slate-900/30">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-white mb-4">产品能力公式</h2>
            <p className="text-slate-400 text-lg">通过组合 LIOS 与不同能力，快速构建垂直领域智能体</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {FORMULAS.map((formula, idx) => (
              <div
                key={idx}
                className="group bg-slate-900 border border-slate-800 rounded-2xl p-6 hover:border-blue-500/50 hover:bg-slate-900/80 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-blue-500/10"
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 rounded-lg bg-slate-800 group-hover:bg-slate-700 transition-colors">
                    {formula.icon}
                  </div>
                </div>

                {/* Formula */}
                <div className="flex items-center flex-wrap gap-2 mb-4 text-sm font-mono">
                  {formula.components.map((comp, i) => (
                    <span key={i} className="flex items-center gap-2">
                      <span className="px-2 py-1 bg-slate-800 rounded text-slate-300 text-xs">{comp}</span>
                      {i < formula.components.length - 1 && (
                        <span className="text-slate-600">+</span>
                      )}
                    </span>
                  ))}
                  <span className="text-slate-600 ml-1">=</span>
                </div>

                <div className="text-lg font-bold text-white mb-2">{formula.result}</div>
                <p className="text-sm text-slate-400 leading-relaxed">{formula.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-24 px-4">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-white mb-4">核心特性</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { title: '多模型纳管', desc: '统一接入 OpenAI、Anthropic、通义千问等主流大模型', color: 'blue' },
              { title: '可治理裁决', desc: '每次决策均有完整的 rationale 和 confidence 记录', color: 'emerald' },
              { title: '全链路追踪', desc: '从输入到输出，每个步骤均可追溯和审计', color: 'amber' },
              { title: '企业级安全', desc: '多租户隔离，数据加密，合规设计', color: 'indigo' },
            ].map((feature, i) => (
              <div key={i} className="bg-slate-900 border border-slate-800 rounded-xl p-6 hover:border-slate-700 transition-colors">
                <div className={`w-2 h-2 rounded-full mb-4 ${
                  feature.color === 'blue' ? 'bg-blue-500' :
                  feature.color === 'emerald' ? 'bg-emerald-500' :
                  feature.color === 'amber' ? 'bg-amber-500' : 'bg-indigo-500'
                }`} />
                <h3 className="text-white font-semibold mb-2">{feature.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-4 border-t border-slate-800">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-white mb-4">准备好开始了吗？</h2>
          <p className="text-slate-400 mb-8">几分钟内完成注册，立即体验企业级 AI 裁决能力</p>
          <div className="flex flex-col sm:flex-row items-center gap-4 justify-center">
            <Link
              to="/register"
              className="flex items-center gap-2 px-8 py-4 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-semibold transition-all hover:scale-105"
            >
              立即注册
              <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              to="/login"
              className="px-8 py-4 text-slate-400 hover:text-white transition-colors"
            >
              已有账号，直接登录
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-8 px-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-500">
            <BrainCircuit className="w-5 h-5" />
            <span className="text-sm">LIOS 逻辑智能操作系统</span>
          </div>
          <p className="text-xs text-slate-600">© 2026 LIOS Platform. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
