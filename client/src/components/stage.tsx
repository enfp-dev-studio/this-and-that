import { useEffect, useRef } from 'react';
import { ImageIcon, ZoomIn, ZoomOut } from 'lucide-react';
import { editor } from '@/editor/engine';
import { SAMPLES } from '@/editor/presets';
import { useEditor } from '@/hooks/use-editor';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Toolbar } from '@/components/toolbar';
import { Callouts, Caption, FailNotice, StatusChip } from '@/components/canvas-feedback';
import { RefThumbs } from '@/components/ref-thumbs';

// The picture on a quiet dotted backdrop, and everything about it on top:
// the canvas draws the picture, marks, SAM outlines and sheen; a finished
// edit shows over it (hold it to see before); instructions sit beside their
// marks; the caption runs under it while you talk.
// Bottom right, like a design tool: zoom out, the zoom (tap: back to 100%,
// the picture fitted to the screen), zoom in. Wheel or pinch zooms too; right
// or middle drag (or two fingers with a pen) pans.
function ViewControls({ zoom }: { zoom: number }) {
  const tip = (label: string, child: React.ReactNode) => (
    <Tooltip>
      <TooltipTrigger asChild>{child}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
  return (
    <div className="absolute right-4 bottom-(--toolbar-offset) flex items-center gap-2 rounded-lg border bg-card/90 p-2 shadow-xl backdrop-blur">
      {tip('Zoom out', <Button variant="ghost" size="icon-touch" onClick={() => editor.zoomBy(1 / 1.25)} aria-label="Zoom out"><ZoomOut /></Button>)}
      {tip('Back to 100%: the picture fits the screen · wheel or pinch zooms, right-drag or two fingers pan', <Button variant="ghost" size="touch" className="tabular-nums" onClick={() => editor.fitView()} aria-label="Fit to screen">{Math.round(zoom * 100)}%</Button>)}
      {tip('Zoom in', <Button variant="ghost" size="icon-touch" onClick={() => editor.zoomBy(1.25)} aria-label="Zoom in"><ZoomIn /></Button>)}
    </div>
  );
}

// The same empty state in both modes: one line and a sample to try.
export function EmptyState({ text, onSample }: { text: string; onSample: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 p-4">
      <p className="text-sm text-muted-foreground">{text}</p>
      <Button size="touch" className="pointer-events-auto" onClick={onSample}>
        <ImageIcon />
        Try a sample
      </Button>
    </div>
  );
}

export function Stage() {
  const s = useEditor();
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => editor.attach(stage.current!, canvas.current!), []);

  const pair = editor.comparePair();
  const shown = s.mode === 'review' && pair ? (s.peek ? pair.before : pair.after) : s.peek && pair ? pair.before : null;
  const box = { left: s.fit.x, top: s.fit.y, width: s.fit.w, height: s.fit.h };
  const hold = {
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      editor.setPeek(true);
    },
    onPointerUp: () => editor.setPeek(false),
    onPointerCancel: () => editor.setPeek(false),
  };

  return (
    <div
      ref={stage}
      className="relative min-w-0 flex-1 touch-none select-none canvas-dots"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (!f?.type.startsWith('image/')) return;
        // On an open picture, a dropped image is a reference; otherwise it is the picture.
        if (s.mode === 'empty') editor.openFile(f);
        else editor.addRef(f);
      }}
    >
      <canvas ref={canvas} className="absolute inset-0 size-full touch-none" />

      {s.mode !== 'empty' && <div className="pointer-events-none absolute rounded-sm shadow-2xl ring-1 ring-border" style={box} />}

      {shown && (
        <div className="absolute overflow-hidden rounded-sm" style={box} {...(s.mode === 'review' ? hold : {})}>
          <img src={shown} alt={s.peek ? 'Before' : 'After'} className="absolute inset-0 size-full" draggable={false} />
        </div>
      )}

      {s.mode === 'empty' ? (
        <EmptyState text="Open a picture. Draw on it. Say what you want." onSample={() => editor.open(SAMPLES[0].url)} />
      ) : (
        <>
          <Callouts />
          <StatusChip />
          <FailNotice />
          <Caption />
          {!s.activeRef && <RefThumbs />}
          <ViewControls zoom={s.zoom} />
        </>
      )}
      <Toolbar hold={hold} />
    </div>
  );
}
