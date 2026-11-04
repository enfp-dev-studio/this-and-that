import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

// Theme colours for the numbered marks, as static classes for Tailwind.
const MARK_BG = ['bg-mark-1', 'bg-mark-2', 'bg-mark-3', 'bg-mark-4', 'bg-mark-5', 'bg-mark-6'];
export const markBg = (mark: number) => MARK_BG[(mark - 1) % MARK_BG.length];

export function MarkBadge({ mark, className }: { mark: number; className?: string }) {
  return (
    <Badge className={cn('size-6 shrink-0 justify-center rounded-full border-0 p-0 text-xs font-semibold text-mark-text tabular-nums', markBg(mark), className)}>
      {mark}
    </Badge>
  );
}
