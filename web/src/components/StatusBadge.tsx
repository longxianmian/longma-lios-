interface StatusBadgeProps {
  status: string;
}

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  accept: { label: '通过', className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  accepted: { label: '通过', className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  hold: { label: '待定', className: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  pending: { label: '待定', className: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  reject: { label: '拒绝', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
  rejected: { label: '拒绝', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
  active: { label: '活跃', className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  disabled: { label: '已禁用', className: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
  indexed: { label: '已就绪', className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  indexing: { label: '索引中', className: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  ok: { label: '正常', className: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  error: { label: '异常', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const key = status?.toLowerCase() ?? '';
  const config = STATUS_MAP[key] ?? {
    label: status,
    className: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${config.className}`}>
      {config.label}
    </span>
  );
}
