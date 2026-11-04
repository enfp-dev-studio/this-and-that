import { useEffect, useRef, useState } from 'react';
import { ImageIcon } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toolbar } from '@/components/toolbar';
import { SAMPLES } from '@/editor/presets';

// The image on a quiet dotted backdrop. The canvas draws the image, marks,
// SAM outlines and sheen; the before/after overlay sits exactly over it.
export function Stage() {
  const s = useEditor();
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [split, setSplit] = useState(0.5);

  useEffect(() => editor.attach(stage.current!, canvas.current!), []);
  useEffect(() => {
    if (s.compare) setSplit(0.5);
  }, [s.compare]);

  const pair = s.compare ? editor.comparePair() : null;
  const dragSplit = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = e.currentTarget.getBoundingClientRect();
    setSplit(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)));
  };

  return (
    <div
      ref={stage}
      className="relative min-w-0 flex-1 touch-none select-none canvas-dots"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f?.type.startsWith('image/')) editor.openFile(f);
      }}
    >
      <canvas ref={canvas} className="absolute inset-0 size-full touch-none" />

      {s.mode !== 'empty' && (
        <div className="pointer-events-none absolute rounded-sm shadow-2xl ring-1 ring-border" style={{ left: s.fit.x, top: s.fit.y, width: s.fit.w, height: s.fit.h }} />
      )}

      {pair && (
        <div
          className="absolute cursor-ew-resize overflow-hidden rounded-sm"
          style={{ left: s.fit.x, top: s.fit.y, width: s.fit.w, height: s.fit.h }}
          onPointerDown={dragSplit}
          onPointerMove={dragSplit}
        >
          <img src={pair.after} alt="After" className="absolute inset-0 size-full" draggable={false} />
          <img src={pair.before} alt="Before" className="absolute inset-0 size-full" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }} draggable={false} />
          <div className="absolute inset-y-0 -translate-x-1/2 border-l-2 border-primary shadow-lg" style={{ left: `${split * 100}%` }} />
          <Badge variant="secondary" className="absolute top-4 left-4">Before</Badge>
          <Badge variant="secondary" className="absolute top-4 right-4">After</Badge>
        </div>
      )}

      {s.mode === 'empty' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-4">
          <p className="text-sm text-muted-foreground">Draw on it. Say what you want.</p>
          <Button size="touch" onClick={() => editor.open(SAMPLES[0].url)}>
            <ImageIcon />
            Try a sample
          </Button>
        </div>
      )}

      {s.mode !== 'empty' && <Toolbar split={split} onSplit={setSplit} />}
    </div>
  );
}
