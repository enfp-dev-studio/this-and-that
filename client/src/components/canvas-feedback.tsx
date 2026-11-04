import { useEffect, useState } from 'react';
import { Loader2, Mic, Zap } from 'lucide-react';
import { useEditor } from '@/hooks/use-editor';
import { cn } from '@/lib/utils';
import { LAB } from '@/lab';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MarkBadge } from '@/components/mark-badge';

// What is happening, in a few words, at the top of the canvas.
export function StatusChip() {
  const s = useEditor();
  const secs = `${Math.round(s.elapsedMs / 1000)} s`;
  let text: string | null = null;
  if (s.mode === 'recording') text = s.marks ? 'Listening' : 'Listening · draw while you talk';
  else if (s.mode === 'processing') {
    const { sam, understand, edit, paste } = s.steps;
    text =
      paste === 'active' ? 'Finishing'
      : edit === 'active' ? (s.localMarks.length ? 'Quick edits done · editing the rest' : 'Editing')
      : understand === 'active' || sam === 'done' ? 'Understanding'
      : 'Outlining';
    if (LAB || edit === 'active') text += ` · ${secs}`;
  } else if (s.mode === 'review') text = s.peek ? 'Before' : 'Hold the picture to see before · Keep or discard';
  if (!text) return null;
  return (
    <Badge variant="secondary" className="absolute top-4 left-1/2 -translate-x-1/2 shadow-lg">
      {s.mode === 'processing' ? <Loader2 className="animate-spin" /> : s.mode === 'recording' ? <Mic /> : null}
      {text}
    </Badge>
  );
}

// Each understood instruction beside its mark: "① brooch → like the rose ref".
export function Callouts() {
  const s = useEditor();
  if (!s.edits.length || s.peek || (s.mode !== 'processing' && s.mode !== 'review')) return null;
  return (
    <>
      {s.edits.map((e) => {
        const at = s.anchors.find((a) => a.mark === e.mark);
        if (!at || /^no change/i.test(e.instruction)) return null;
        const text = e.kind === 'reference' ? `${e.target} (reference)` : `${e.target} → ${e.instruction}`;
        return (
          <Tooltip key={e.mark}>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="absolute max-w-(--callout-width) -translate-y-1/2 shadow-lg" style={{ left: at.x, top: at.y }}>
                <MarkBadge mark={e.mark} />
                {s.localMarks.includes(e.mark) && <Zap />}
                <span className="truncate">{text}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {e.target}: {e.instruction}
              {s.localMarks.includes(e.mark) ? ' (instant)' : ''}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </>
  );
}

// Subtitles under the picture while you speak; they fade out after.
export function Caption() {
  const s = useEditor();
  const recording = s.mode === 'recording';
  const [linger, setLinger] = useState(false);
  useEffect(() => {
    if (recording) return setLinger(true);
    const t = setTimeout(() => setLinger(false), 2500);
    return () => clearTimeout(t);
  }, [recording]);
  const text = s.caption || (recording ? 'Listening…' : '');
  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-(--caption-offset) left-1/2 max-w-(--caption-width) -translate-x-1/2 rounded-md bg-popover/90 p-2 text-center text-sm text-popover-foreground shadow-lg backdrop-blur transition-opacity duration-500',
        recording || (linger && text) ? 'opacity-100' : 'opacity-0',
      )}
      aria-live="polite"
    >
      {text}
    </div>
  );
}
