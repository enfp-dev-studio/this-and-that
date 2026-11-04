import { useEffect, useRef } from 'react';
import { Armchair, Box, Circle, Download, Eraser, Eye, EyeOff, FolderOpen, Frame, Grid3x3, Home, Loader2, Maximize, Mic, Paintbrush, PenLine, Redo2, RotateCcw, Send, Undo2 } from 'lucide-react';
import { engine3d, type ViewName } from '@/three/engine';
import { useEngine3D } from '@/hooks/use-engine3d';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Brand, Chrome, IconButton, Inspector, ModeSwitch, type AppMode } from '@/components/top-bar';
import { PenModes, TypeToggle } from '@/components/toolbar';

const VIEWS: { value: ViewName; label: string }[] = [
  { value: 'front', label: 'Front' },
  { value: 'side', label: 'Side' },
  { value: 'top', label: 'Top' },
  { value: 'three', label: '3/4' },
];

// 3D sketch mode (beta): the three.js scene, full-bleed and themed like the
// image mode's canvas, with the same chrome (undo/redo; mode, pens and the
// drawing plane; Open, Export and the inspector), the same status chip and
// caption, the same bottom bar (talk, the actions that apply, typing behind
// a keyboard button), and view presets at the bottom right where the image
// mode has its zoom.
export function ThreeMode({ onMode }: { onMode: (mode: AppMode) => void }) {
  const s = useEngine3D();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => engine3d.attach(host.current!), []);

  // Space: hold to talk. Cmd/Ctrl+Z: undo (Shift: redo). Enter: build without talking.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement | null)?.tagName === 'TEXTAREA';
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.code === 'Space' && !e.repeat) (e.preventDefault(), engine3d.talkDown());
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') e.shiftKey ? engine3d.redo() : engine3d.undo();
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

  return (
    <div className="absolute inset-0 touch-none select-none">
      <div ref={host} className="absolute inset-0" />

      <Chrome
        left={
          <>
            <Brand />
            <IconButton label="Undo (a snapped stroke first goes back to how it was drawn)" onClick={() => engine3d.undo()} disabled={!s.canUndo || s.working}>
              <Undo2 />
            </IconButton>
            <IconButton label="Redo" onClick={() => engine3d.redo()} disabled={!s.canRedo || s.working}>
              <Redo2 />
            </IconButton>
          </>
        }
        center={
          <>
            <ModeSwitch mode="3d" onMode={onMode} disabled={s.working || s.recording} />
            <Separator orientation="vertical" />
            <PenModes value={s.pen} onChange={(pen) => engine3d.setPen(pen)} />
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
            <OpenSketchMenu disabled={s.working || s.recording} />
            <Tip label="Download the model as glTF (.glb)">
              <Button variant="ghost" size="touch" className="rounded-full" onClick={() => engine3d.exportGlb()} disabled={!s.hasModel}>
                <Download />
                Export
              </Button>
            </Tip>
            <Inspector tip="What Spark saw, what it built, and view options" description="What Muse Spark looked at, what it built, and how the scene shows.">
              <ThreeInspector />
            </Inspector>
          </>
        }
      />

      <Badge variant="secondary" className="absolute top-(--chrome-height) left-1/2 max-w-(--callout-width) -translate-x-1/2 shadow-lg">
        {s.working ? <Loader2 className="animate-spin" /> : s.recording ? <Mic /> : null}
        <span className="truncate">{s.status}</span>
      </Badge>

      <div
        className={cn(
          'pointer-events-none absolute bottom-(--caption-offset) left-1/2 max-w-(--caption-width) -translate-x-1/2 rounded-md bg-popover/90 p-2 text-center text-sm text-popover-foreground shadow-lg backdrop-blur transition-opacity duration-500',
          s.recording || s.caption ? 'opacity-100' : 'opacity-0',
        )}
        aria-live="polite"
      >
        {s.caption || (s.recording ? 'Listening…' : '')}
      </div>

      {/* The same bottom bar as the image mode. */}
      <div className="absolute bottom-(--toolbar-offset) left-1/2 flex -translate-x-1/2 items-center gap-4 rounded-full border bg-card/90 p-2 shadow-xl backdrop-blur">
        <div className="flex items-center gap-2">
          <Tip label="The pen (or left mouse) draws; fingers or the right mouse rotate">
            <Toggle size="icon-touch" className="rounded-full" pressed aria-label="Pen draws">
              <PenLine />
            </Toggle>
          </Tip>
          {(s.hasStrokes || s.hasModel) && (
            <IconButton label="Clear the sketch and the model" onClick={() => engine3d.clear()} disabled={s.working}>
              <Eraser />
            </IconButton>
          )}
        </div>

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

        {s.hasModel && (
          <>
            <Separator orientation="vertical" />
            <div className="flex items-center gap-2">
              <Tip label="The same sketch and words, a fresh answer">
                <Button variant="outline" size="touch" className="rounded-full" onClick={() => engine3d.reroll()} disabled={s.working}>
                  <RotateCcw />
                  Rebuild
                </Button>
              </Tip>
              <Tip label="Muse Image paints the model from this view">
                <Button variant="outline" size="touch" className="rounded-full" onClick={() => engine3d.paint()} disabled={s.working}>
                  <Paintbrush />
                  Paint
                </Button>
              </Tip>
            </div>
          </>
        )}

        <TypeToggle placeholder="Type what it is, e.g. “a chair, the back like this”" sendLabel="Make" busy={s.working} onSend={(text) => engine3d.make(text)} />
      </div>

      {/* Where the image mode has its zoom: view presets and zoom-to-fit. */}
      <div className="absolute right-4 bottom-(--toolbar-offset) flex items-center gap-2 rounded-full border bg-card/90 p-2 shadow-xl backdrop-blur">
        {VIEWS.map((v) => (
          <Button key={v.value} variant="ghost" size="touch" className="rounded-full" onClick={() => engine3d.goTo(v.value)}>
            {v.label}
          </Button>
        ))}
        <IconButton label="Zoom to fit the sketch and the model" onClick={() => engine3d.fit()}>
          <Maximize />
        </IconButton>
      </div>
    </div>
  );
}

// Open: the scripted sketches (no pen needed to try it).
function OpenSketchMenu({ disabled }: { disabled: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="touch" className="rounded-full" disabled={disabled}>
          <FolderOpen />
          Open
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Sample sketches</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => (engine3d.clear(), engine3d.demoChair())}>
          <Armchair />
          Chair (front and side)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => (engine3d.clear(), engine3d.demoHouse())}>
          <Home />
          House (front and side)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => engine3d.replayChair()}>
          <PenLine />
          Draw and build the chair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The inspector: what Spark looked at, what it built, and view options.
function ThreeInspector() {
  const s = useEngine3D();
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-4">
        <Card>
          <CardHeader>
            <CardTitle>What Muse Spark saw</CardTitle>
            <CardDescription>The sketch from six sides, each stroke in its own colour.</CardDescription>
          </CardHeader>
          <CardContent>
            {s.views.length ? (
              <div className="grid grid-cols-3 gap-2">
                {s.views.map((v, i) => (
                  <img key={`${v.name}${i}`} src={v.image} alt={v.name} title={v.name} className={cn('aspect-square w-full rounded-md border bg-card object-cover', s.thinking && 'animate-pulse')} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Draw, talk and release: the views show up here.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Model</CardTitle>
            {s.result && <CardDescription>Muse Spark {(s.result.ms / 1000).toFixed(1)} s</CardDescription>}
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {s.result ? (
              <>
                <p className="text-sm">{s.result.say}</p>
                <div className="flex flex-wrap gap-2">
                  {s.result.parts.map((p, i) => (
                    <Badge key={`${p.name}${i}`} variant="outline">
                      <Circle style={{ color: p.color, fill: p.color }} />
                      {p.name}
                    </Badge>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No model yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>View</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Toggle variant="outline" size="touch" pressed={s.sketchVisible} onPressedChange={() => engine3d.toggleSketch()}>
              {s.sketchVisible ? <Eye /> : <EyeOff />}
              Sketch
            </Toggle>
            <Toggle variant="outline" size="touch" pressed={s.gridVisible} onPressedChange={() => engine3d.toggleGrid()}>
              <Grid3x3 />
              Floor grid
            </Toggle>
            <Toggle variant="outline" size="touch" pressed={s.wireframe} onPressedChange={() => engine3d.toggleWireframe()} disabled={!s.hasModel}>
              <Box />
              Wireframe
            </Toggle>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
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
