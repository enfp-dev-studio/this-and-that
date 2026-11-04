import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Upload } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Toolbar } from '@/components/toolbar';

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
      className="relative min-w-0 flex-1 touch-none select-none bg-canvas bg-[radial-gradient(var(--canvas-dot)_1px,transparent_1px)] bg-size-[24px_24px]"
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
          <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary shadow-lg" style={{ left: `${split * 100}%` }} />
          <Badge variant="secondary" className="absolute top-3 left-3">Before</Badge>
          <Badge variant="secondary" className="absolute top-3 right-3">After</Badge>
        </div>
      )}

      {s.mode === 'empty' && (
        <div className="absolute inset-0 grid place-items-center p-6">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-xl">Point at it, say it, done.</CardTitle>
              <CardDescription>
                Open an AI image, then draw on it while you talk: circle the mug and say “make this red”. Only what you marked changes.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button size="lg" className="h-11 flex-1" onClick={() => editor.open('/api/sample')}>
                <ImageIcon />
                Try the sample
              </Button>
              <Button size="lg" variant="outline" className="h-11 flex-1" asChild>
                <label>
                  <Upload />
                  Open image
                  <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && editor.openFile(e.target.files[0])} />
                </label>
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {s.mode !== 'empty' && <Toolbar split={split} onSplit={setSplit} />}
    </div>
  );
}
