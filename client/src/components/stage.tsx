import { useEffect, useRef } from 'react';
import { ImageIcon } from 'lucide-react';
import { editor } from '@/editor/engine';
import { SAMPLES } from '@/editor/presets';
import { useEditor } from '@/hooks/use-editor';
import { Button } from '@/components/ui/button';
import { Toolbar } from '@/components/toolbar';
import { Callouts, Caption, FailNotice, StatusChip } from '@/components/canvas-feedback';
import { RefThumbs } from '@/components/ref-thumbs';

// The picture on a quiet dotted backdrop, and everything about it on top:
// the canvas draws the picture, marks, SAM outlines and sheen; a finished
// edit shows over it (hold it to see before); instructions sit beside their
// marks; the caption runs under it while you talk.
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
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-4">
          <p className="text-sm text-muted-foreground">Draw on it. Say what you want.</p>
          <Button size="touch" onClick={() => editor.open(SAMPLES[0].url)}>
            <ImageIcon />
            Try a sample
          </Button>
        </div>
      ) : (
        <>
          <Callouts />
          <StatusChip />
          <FailNotice />
          <Caption />
          <RefThumbs />
          <Toolbar hold={hold} />
        </>
      )}
    </div>
  );
}
