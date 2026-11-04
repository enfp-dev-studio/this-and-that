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
// status or (when a result is waiting) the before/after slider with Keep.
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
      : review
        ? 'Talk again to keep going'
        : 'Hold or tap, then draw and talk';

  return (
    <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card/90 p-2 shadow-xl backdrop-blur">
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle className="size-11 rounded-full" pressed={s.penOnly} onPressedChange={(on) => editor.setPenOnly(on)} aria-label="Pen only">
            <PenLine />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Pen only: fingers don’t draw (on once a stylus is used)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-11 rounded-full" onClick={() => editor.clearMarks()} disabled={working || review || !s.marks} aria-label="Clear marks">
            <Eraser />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Clear marks</TooltipContent>
      </Tooltip>
      <MarkBadge mark={s.marks + 1} className={cn('mx-1 size-7', (working || review) && 'opacity-40')} />

      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-8" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant={recording ? 'destructive' : 'default'}
            className={cn('size-16 rounded-full [&_svg:not([class*=size-])]:size-7', recording && 'animate-pulse')}
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

      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-8" />

      {review ? (
        <div className="flex items-center gap-3 pr-1">
          <Slider className="w-36" value={[split * 100]} onValueChange={([v]) => onSplit(v / 100)} aria-label="Before and after" />
          <Button className="h-11 rounded-full px-5" onClick={() => editor.keep()}>
            <Check />
            Keep
          </Button>
          <Button variant="outline" className="h-11 rounded-full px-5" onClick={() => editor.discard()}>
            <X />
            Discard
          </Button>
        </div>
      ) : s.compare ? (
        <Slider className="mr-3 w-52" value={[split * 100]} onValueChange={([v]) => onSplit(v / 100)} aria-label="Before and after" />
      ) : (
        <span className="w-52 pr-3 text-sm text-muted-foreground tabular-nums">{status}</span>
      )}
    </div>
  );
}
