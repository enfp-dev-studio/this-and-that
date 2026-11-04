import { useEffect, useRef, useState } from 'react';
import { Box, Circle, Eraser, Eye, EyeOff, Frame, Grid3x3, Loader2, Maximize, Mic, Paintbrush, RotateCcw, Send, Undo2 } from 'lucide-react';
import { engine3d, type ViewName } from '@/three/engine';
import { useEngine3D } from '@/hooks/use-engine3d';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Brand, Chrome, IconButton, ModeSwitch, type AppMode } from '@/components/top-bar';

const VIEWS: { value: ViewName; label: string }[] = [
  { value: 'front', label: 'Front' },
  { value: 'side', label: 'Side' },
  { value: 'top', label: 'Top' },
  { value: 'three', label: '3/4' },
];

// 3D sketch mode (beta): the three.js scene, full-bleed, and floating over it
// the same chrome as the image mode (undo; mode and drawing plane; sketch
// visibility and clear), what Spark looks at and what it built (right), view
// presets and zoom-to-fit (bottom right), status, caption, and the floating
// toolbar with the hold-to-talk button.
export function ThreeMode({ onMode }: { onMode: (mode: AppMode) => void }) {
  const s = useEngine3D();
  const host = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => engine3d.attach(host.current!), []);

  // Space: hold to talk. Cmd/Ctrl+Z: undo. Enter: build without talking.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement | null)?.tagName === 'TEXTAREA';
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.code === 'Space' && !e.repeat) (e.preventDefault(), engine3d.talkDown());
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') engine3d.undo();
      if (e.key === 'Enter') engine3d.make();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e)) return;
      e.preventDefault();
      engine3d.talkUp();
    };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    return () => {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
    };
  }, []);

  const make = () => {
    engine3d.make(typed.trim());
    setTyped('');
  };

  return (
    <div className="absolute inset-0 touch-none select-none">
      <div ref={host} className="absolute inset-0" />

      <Chrome
        left={
          <>
            <Brand />
            <IconButton label="Undo: the last stroke (a snapped one first goes back to how it was drawn), then the last build" onClick={() => engine3d.undo()} disabled={!s.canUndo || s.working}>
              <Undo2 />
            </IconButton>
          </>
        }
        center={
          <>
            <ModeSwitch mode="3d" onMode={onMode} disabled={s.working || s.recording} />
            <Separator orientation="vertical" />
            <ToggleGroup type="single" variant="segment" size="icon-touch" value={s.plane} onValueChange={(v) => v && engine3d.setPlane(v as 'view' | 'ground')} aria-label="Drawing plane">
              <Tip label="Draw on a plane facing you">
                <ToggleGroupItem value="view" aria-label="Facing me">
                  <Frame />
                </ToggleGroupItem>
              </Tip>
              <Tip label="Draw on a plane flat like the ground">
                <ToggleGroupItem value="ground" aria-label="Ground">
                  <Grid3x3 />
                </ToggleGroupItem>
              </Tip>
            </ToggleGroup>
          </>
        }
        right={
          <>
            <IconButton label={s.sketchVisible ? 'Hide the sketch' : 'Show the sketch'} onClick={() => engine3d.toggleSketch()}>
              {s.sketchVisible ? <Eye /> : <EyeOff />}
            </IconButton>
            <IconButton label="Clear everything" onClick={() => engine3d.clear()} disabled={s.working}>
              <Eraser />
            </IconButton>
          </>
        }
      />

      {/* View presets and zoom-to-fit, stacked in the corner like a view gizmo. */}
      <div className="absolute right-4 bottom-(--toolbar-offset) flex flex-col items-stretch gap-2 rounded-xl border bg-card/90 p-2 shadow-xl backdrop-blur">
        {VIEWS.map((v) => (
          <Button key={v.value} variant="ghost" size="touch" onClick={() => engine3d.goTo(v.value)}>
            {v.label}
          </Button>
        ))}
        <Separator />
        <IconButton label="Zoom to fit the sketch and the model" onClick={() => engine3d.fit()}>
          <Maximize />
        </IconButton>
      </div>

      <Badge variant="secondary" className="absolute top-(--chrome-height) left-1/2 max-w-(--callout-width) -translate-x-1/2 shadow-lg">
        {s.working ? <Loader2 className="animate-spin" /> : s.recording ? <Mic /> : null}
        <span className="truncate">{s.status}</span>
      </Badge>

      <div className="pointer-events-none absolute top-(--chrome-height) right-4 flex w-(--card-width) flex-col items-end gap-2">
        {s.views.length > 0 && (
          <div className="grid w-full grid-cols-6 gap-2">
            {s.views.map((v, i) => (
              <img key={`${v.name}${i}`} src={v.image} alt={v.name} title={v.name} className={cn('aspect-square w-full rounded-md border bg-card object-cover shadow-lg', s.thinking && 'animate-pulse')} />
            ))}
          </div>
        )}
        {s.result && (
          <Card className="pointer-events-auto w-full gap-2 p-4 shadow-xl">
            <p className="text-sm">{s.result.say}</p>
            <div className="flex flex-wrap gap-2">
              {s.result.parts.map((p, i) => (
                <Badge key={`${p.name}${i}`} variant="outline">
                  <Circle style={{ color: p.color, fill: p.color }} />
                  {p.name}
                </Badge>
              ))}
              <Badge variant="secondary">Muse Spark {(s.result.ms / 1000).toFixed(1)} s</Badge>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="touch" onClick={() => engine3d.reroll()} disabled={s.working}>
                <RotateCcw />
                Rebuild
              </Button>
              <Button variant="outline" size="touch" onClick={() => engine3d.paint(typed.trim())} disabled={s.working}>
                <Paintbrush />
                Paint with Muse Image
              </Button>
            </div>
          </Card>
        )}
      </div>

      <div
        className={cn(
          'pointer-events-none absolute bottom-(--caption-offset) left-1/2 max-w-(--caption-width) -translate-x-1/2 rounded-md bg-popover/90 p-2 text-center text-sm text-popover-foreground shadow-lg backdrop-blur transition-opacity duration-500',
          s.recording || s.caption ? 'opacity-100' : 'opacity-0',
        )}
        aria-live="polite"
      >
        {s.caption || (s.recording ? 'Listening…' : '')}
      </div>

      <div className="absolute bottom-(--toolbar-offset) left-1/2 flex -translate-x-1/2 items-center gap-4 rounded-full border bg-card/90 p-2 shadow-xl backdrop-blur">
        <Tip label="Hold to talk (or Space), or tap to start and tap to send">
          <Button
            size="icon-xl"
            variant={s.recording ? 'destructive' : 'default'}
            className={cn(s.recording && 'animate-pulse')}
            disabled={s.working}
            aria-label="Hold to talk"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              engine3d.talkDown();
            }}
            onPointerUp={() => engine3d.talkUp()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {s.working ? <Loader2 className="animate-spin" /> : s.recording ? <Send /> : <Mic />}
          </Button>
        </Tip>

        <Separator orientation="vertical" />
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            make();
          }}
        >
          <Textarea
            className="w-(--type-width)"
            placeholder="Or type it, e.g. “a chair, the back like this”"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                make();
              }
            }}
          />
          <Button type="submit" size="touch" disabled={s.working}>
            <Box />
            Make
          </Button>
        </form>
      </div>
    </div>
  );
}

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
