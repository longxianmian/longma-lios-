interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export default function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  const sizeClass = {
    sm: 'w-4 h-4 border-2',
    md: 'w-8 h-8 border-2',
    lg: 'w-12 h-12 border-4',
  }[size];

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div
        className={`${sizeClass} rounded-full border-slate-600 border-t-blue-500 animate-spin`}
      />
    </div>
  );
}
