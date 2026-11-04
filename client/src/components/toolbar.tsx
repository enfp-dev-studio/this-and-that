import { useState } from 'react';
import { Check, Eraser, Eye, Loader2, Mic, PenLine, Send, X } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type Hold = { onPointerDown: (e: React.PointerEvent) => void; onPointerUp: () => void; onPointerCancel: () => void };

// The always-there controls: the pen tool and the hold-to-talk button. Clear,
// Before, Keep and Discard appear only when they apply.
export function Toolbar({ hold }: { hold: Hold }) {
  const s = useEditor();
  const recording = s.mode === 'recording';
  const working = s.mode === 'processing';
  const review = s.mode === 'review';
  const typing = s.experiment && s.method === 'type';
  const canPeek = review || (s.mode === 'idle' && s.index > 0);
  const canClear = s.marks > 0 && !working && !review;

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
        {canClear && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-touch" className="rounded-full" onClick={() => editor.clearMarks()} aria-label="Clear marks">
                <Eraser />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear marks</TooltipContent>
          </Tooltip>
        )}
      </div>

      {typing ? (
        <TypeBox busy={working} />
      ) : (
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
      )}

      {(canPeek || review) && (
        <>
          <Separator orientation="vertical" />
          <div className="flex items-center gap-2">
            {canPeek && (
              <Button variant="outline" size="touch" className="rounded-full" {...hold} onContextMenu={(e) => e.preventDefault()} aria-label="Hold to see before">
                <Eye />
                Before
              </Button>
            )}
            {review && (
              <>
                <Button size="touch" className="rounded-full" onClick={() => editor.keep()}>
                  <Check />
                  Keep
                </Button>
                <Button variant="outline" size="touch" className="rounded-full" onClick={() => editor.discard()}>
                  <X />
                  Discard
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Experiment, Type way: the request as text. Enter sends, Shift+Enter is a new line.
function TypeBox({ busy }: { busy: boolean }) {
  const [text, setText] = useState('');
  const send = () => {
    editor.submitText(text);
    setText('');
  };
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <Textarea
        className="w-(--type-width)"
        placeholder="Describe the change, e.g. “replace the crystal hairpin on her left with a crescent moon”"
        value={text}
        disabled={busy}
        onChange={(e) => {
          editor.markInput();
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <Button type="submit" size="icon-xl" disabled={busy || !text.trim()} aria-label="Send">
        {busy ? <Loader2 className="animate-spin" /> : <Send />}
      </Button>
    </form>
  );
}
