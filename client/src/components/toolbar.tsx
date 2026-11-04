import { useState } from 'react';
import { Check, Eraser, Eye, Keyboard, Loader2, Mic, PenLine, PenTool, Pointer, Send, WandSparkles, X } from 'lucide-react';
import { editor, type PenMode } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type Hold = { onPointerDown: (e: React.PointerEvent) => void; onPointerUp: () => void; onPointerCancel: () => void };

// No backdrop blur here: it would make each group the anchor of the typing
// field, which belongs centred above the whole bar.
const GROUP = 'pointer-events-auto flex items-center gap-2 rounded-lg border bg-card/90 p-2 shadow-xl';

// The bottom bar of both modes, in three slots: the talk button stays at the
// centre, what applies now sits in groups to its left and right (so nothing
// shifts it sideways), and typing opens just above the bar.
export function BottomBar({ left, center, right }: { left?: React.ReactNode; center: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute bottom-(--toolbar-offset) left-1/2 grid w-(--bar-width) -translate-x-1/2 grid-cols-3 items-center gap-4">
      <div className="flex justify-end">{left && <div className={GROUP}>{left}</div>}</div>
      <div className="pointer-events-auto flex justify-center">{center}</div>
      <div className="flex justify-start">{right && <div className={GROUP}>{right}</div>}</div>
    </div>
  );
}

// The hold-to-talk button, the same in both modes.
export function TalkButton({ recording, working, disabled, sending, onDown, onUp, tip }: { recording: boolean; working: boolean; disabled?: boolean; sending?: boolean; onDown: () => void; onUp: () => void; tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xl"
          variant={recording ? 'destructive' : 'default'}
          className={cn('shadow-xl', recording && 'animate-pulse')}
          disabled={working || disabled}
          aria-label="Hold to talk"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            onDown();
          }}
          onPointerUp={onUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          {working ? <Loader2 className="animate-spin" /> : recording && sending ? <Send /> : <Mic />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

// Image mode's bottom bar: the pen tool and Clear, the talk button (off
// until a picture is open), Before / Keep / Discard when they apply, and
// typing instead of talking.
export function Toolbar({ hold }: { hold: Hold }) {
  const s = useEditor();
  const empty = s.mode === 'empty';
  const recording = s.mode === 'recording';
  const working = s.mode === 'processing';
  const review = s.mode === 'review';
  const typing = s.experiment && s.method === 'type';
  const canPeek = review || (s.mode === 'idle' && s.index > 0);
  const canClear = s.marks > 0 && !working && !review;

  return (
    <BottomBar
      left={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle size="icon-touch" pressed={s.penOnly} onPressedChange={(on) => editor.setPenOnly(on)} aria-label="Pen only">
                <PenLine />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent>Pen only: fingers don’t draw (on once a stylus is used)</TooltipContent>
          </Tooltip>
          {canClear && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-touch" onClick={() => editor.clearMarks()} aria-label="Clear marks">
                  <Eraser />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear marks</TooltipContent>
            </Tooltip>
          )}
        </>
      }
      center={
        typing ? (
          <TypeBox busy={working} />
        ) : (
          <TalkButton recording={recording} working={working} disabled={empty} sending={s.marks > 0} onDown={() => editor.talkDown()} onUp={() => editor.talkUp()} tip={empty ? 'Open a picture first' : 'Hold to talk, or tap to start and tap to send'} />
        )
      }
      right={
        (canPeek || review || (!typing && !empty)) && (
          <>
            {canPeek && (
              <Button variant="outline" size="touch" {...hold} onContextMenu={(e) => e.preventDefault()} aria-label="Hold to see before">
                <Eye />
                Before
              </Button>
            )}
            {review && (
              <>
                <Button size="touch" onClick={() => editor.keep()}>
                  <Check />
                  Keep
                </Button>
                <Button variant="outline" size="touch" onClick={() => editor.discard()}>
                  <X />
                  Discard
                </Button>
              </>
            )}
            {!typing && !review && !empty && <TypeToggle placeholder="Draw marks, then type what to change at them" sendLabel="Send" busy={working} onSend={(text) => editor.sendTyped(text)} />}
          </>
        )
      }
    />
  );
}

// What a mark means, in the top toolbar of both modes: Auto (the app tells
// from what you say, "이렇게" / "like this", whether a mark picks a thing or
// draws its new shape), Point or Shape.
export function PenModes({ value, onChange }: { value: PenMode; onChange: (mode: PenMode) => void }) {
  const modes = [
    { value: 'auto', label: 'Auto', icon: WandSparkles, tip: 'Auto: the app tells from what you say whether a mark picks a thing or draws its shape' },
    { value: 'point', label: 'Point', icon: Pointer, tip: 'Point: marks pick what to change' },
    { value: 'shape', label: 'Shape', icon: PenTool, tip: 'Shape: marks draw the new outline to follow' },
  ] as const;
  return (
    <ToggleGroup type="single" variant="segment" size="icon-touch" value={value} onValueChange={(v) => v && onChange(v as PenMode)} aria-label="Pen mode">
      {modes.map((m) => (
        <Tooltip key={m.value}>
          <TooltipTrigger asChild>
            <ToggleGroupItem value={m.value} aria-label={m.label}>
              <m.icon />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>{m.tip}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}

// Typing instead of talking, for both modes: a keyboard button that opens a
// text field (collapsed by default; the core loop is drawing and talking).
export function TypeToggle({ placeholder, sendLabel, busy, onSend }: { placeholder: string; sendLabel: string; busy: boolean; onSend: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle size="icon-touch" pressed={open} onPressedChange={setOpen} aria-label="Type instead">
            <Keyboard />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Type instead of talking</TooltipContent>
      </Tooltip>
      {open && (
        <form
          className="absolute bottom-full left-1/2 flex -translate-x-1/2 -translate-y-4 items-center gap-2 rounded-lg border bg-card/90 p-2 shadow-xl backdrop-blur"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Textarea
            autoFocus
            className="w-(--type-width)"
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button type="submit" size="touch" disabled={busy || !text.trim()}>
            <Send />
            {sendLabel}
          </Button>
        </form>
      )}
    </>
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
