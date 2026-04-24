import { InboxIcon } from 'lucide-react';

interface EmptyProps {
  message?: string;
  className?: string;
}

export default function Empty({ message = '暂无数据', className = '' }: EmptyProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-16 text-slate-500 ${className}`}>
      <InboxIcon className="w-12 h-12 mb-3 opacity-40" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
