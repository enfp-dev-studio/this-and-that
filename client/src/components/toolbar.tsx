import { Check, Eraser, Loader2, Mic, PenLine, Send, X } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MarkBadge } from '@/components/mark-badge';

// Floating toolbar: mark tools, the big hold-to-talk button, and either the
// status or (when comparing) the before/after slider, with Keep for a result.
export function Toolbar({ split, onSplit }: { split: number; onSplit: (v: number) => void }) {
  const s = useEditor();
  const recording = s.mode === 'recording';
  const working = s.mode === 'processing';
  const review = s.mode === 'review';

  const status = recording
    ? s.marks
      ? 'Release or tap to send'
      : 'Listening… now draw'
    : working
      ? `Working… ${Math.round(s.elapsedMs / 1000)} s`
      : 'Hold or tap, then draw and talk';
  const slider = <Slider className="w-(--slider-width)" value={[split * 100]} onValueChange={([v]) => onSplit(v / 100)} aria-label="Before and after" />;

  return (
    <div className="absolute bottom-(--toolbar-offset) left-1/2 flex -translate-x-1/2 items-center gap-4 rounded-full border bg-card/90 p-2 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle size="icon-touch" className="rounded-full" pressed={s.penOnly} onPressedChange={(on) => editor.setPenOnly(on)} aria-label="Pen only">
              <PenLine />
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>Pen only: fingers don’t draw (on once a stylus is used)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-touch" className="rounded-full" onClick={() => editor.clearMarks()} disabled={working || review || !s.marks} aria-label="Clear marks">
              <Eraser />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clear marks</TooltipContent>
        </Tooltip>
        <MarkBadge mark={s.marks + 1} className={cn((working || review) && 'opacity-40')} />
      </div>

      <Separator orientation="vertical" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xl"
            variant={recording ? 'destructive' : 'default'}
            className={cn(recording && 'animate-pulse')}
            disabled={working}
            aria-label="Hold to talk"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              editor.talkDown();
            }}
            onPointerUp={() => editor.talkUp()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {working ? <Loader2 className="animate-spin" /> : recording && s.marks ? <Send /> : <Mic />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Hold to talk, or tap to start and tap to send</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" />

      {review ? (
        <div className="flex items-center gap-2">
          {slider}
          <Button size="touch" className="rounded-full" onClick={() => editor.keep()}>
            <Check />
            Keep
          </Button>
          <Button variant="outline" size="touch" className="rounded-full" onClick={() => editor.discard()}>
            <X />
            Discard
          </Button>
        </div>
      ) : s.compare ? (
        slider
      ) : (
        <span className="w-(--status-width) text-sm text-muted-foreground tabular-nums">{status}</span>
      )}
    </div>
  );
}
