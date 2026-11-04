import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Armchair, Axis3d, Box, Info, Circle, Cuboid, Download, Eraser, Eye, EyeOff, FileUp, FolderOpen, Grid3x3, Home, Layers2, Loader2, Maximize, Mic, Paintbrush, PenLine, RectangleVertical, Redo2, RotateCcw, Undo2 } from 'lucide-react';
import { engine3d, type ViewName } from '@/three/engine';
import { useEngine3D } from '@/hooks/use-engine3d';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Brand, Chrome, IconButton, Inspector, ModeSwitch, type AppMode } from '@/components/top-bar';
import { BottomBar, PenModes, TalkButton, TypeToggle } from '@/components/toolbar';
import { EmptyState } from '@/components/stage';
import { Separator } from '@/components/ui/separator';

// Sample models to edit (samples/3d, CC0): Poly Haven's Antique Estoc and the
// Khronos glTF Sample Assets' SciFiHelmet (textures at 1024 px).
const SAMPLE_MODELS = [
  { url: '/3d/AntiqueEstoc/antique_estoc_1k.gltf', name: 'sword', height: 0.9, label: 'Sample model: a sword' },
  { url: '/3d/SciFiHelmet/SciFiHelmet.gltf', name: 'sci-fi helmet', height: 0.5, label: 'Sample model: a sci-fi helmet' },
];
const CREDITS = 'Sample models, CC0: “Antique Estoc” by Ulan Cabanilla (modeling) and James Ray Cock (texturing), Poly Haven; “SciFiHelmet” by Michael Pavlovic (converted to glTF by Norbert Nopper), Khronos glTF Sample Assets.';

const VIEWS: { value: ViewName; label: string }[] = [
  { value: 'front', label: 'Front' },
  { value: 'side', label: 'Side' },
  { value: 'top', label: 'Top' },
  { value: 'three', label: '3/4' },
];

// 3D sketch mode (beta): the three.js scene, full-bleed and themed like the
// image mode's canvas, with the same chrome (undo/redo; mode and pens; Open,
// Export and the inspector), the same status chip, caption, empty state and
// bottom bar (the drawing plane and Clear; talk; Rebuild, Paint and typing),
// and the views where the image mode has its zoom.
export function ThreeMode({ onMode }: { onMode: (mode: AppMode) => void }) {
  const s = useEngine3D();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    engine3d.onError = (message) => toast.error('Something went wrong', { description: message });
    engine3d.onNotice = (message) => toast(message);
    return engine3d.attach(host.current!);
  }, []);

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

  const empty = !s.hasStrokes && !s.hasModel && !s.working && !s.recording;

  return (
    <div className="absolute inset-0 touch-none select-none">
      <div ref={host} className="absolute inset-0" />

      {empty && <EmptyState text="Draw in 3D with the pen. Say what it is." onSample={() => engine3d.demoChair()} />}

      <Chrome
        left={
          <>
            <Brand />
            <IconButton label="Undo" onClick={() => engine3d.undo()} disabled={!s.canUndo || s.working}>
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
          </>
        }
        right={
          <>
            <OpenSketchMenu disabled={s.working || s.recording} />
            <Tip label="Download the model as glTF (.glb)">
              <Button variant="ghost" size="touch" onClick={() => engine3d.exportGlb()} disabled={!s.hasModel}>
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

      {(s.working || s.recording) && (
        <Badge variant="outline" className="absolute top-(--chrome-height) left-1/2 max-w-(--callout-width) -translate-x-1/2 bg-card shadow-lg">
          {s.working ? <Loader2 className="animate-spin" /> : <Mic />}
          <span className="truncate">{s.status}</span>
        </Badge>
      )}

      <div
        className={cn(
          'pointer-events-none absolute bottom-(--caption-offset) left-1/2 max-w-(--caption-width) -translate-x-1/2 rounded-md bg-popover/90 p-2 text-center text-sm text-popover-foreground shadow-lg backdrop-blur transition-opacity duration-500',
          s.recording || s.caption ? 'opacity-100' : 'opacity-0',
        )}
        aria-live="polite"
      >
        {s.caption || (s.recording ? 'Listening…' : '')}
      </div>

      <BottomBar
        left={
          <>
            <ToggleGroup type="single" variant="segment" size="icon-touch" value={s.plane} onValueChange={(v) => v && engine3d.setPlane(v as 'view' | 'ground')} aria-label="Drawing plane">
              <Tip label="Draw on a plane facing you">
                <ToggleGroupItem value="view" aria-label="Facing me">
                  <RectangleVertical />
                </ToggleGroupItem>
              </Tip>
              <Tip label="Draw on a flat plane, like the ground">
                <ToggleGroupItem value="ground" aria-label="Ground">
                  <Layers2 />
                </ToggleGroupItem>
              </Tip>
            </ToggleGroup>
            {(s.hasStrokes || s.hasModel) && (
              <IconButton label="Clear the sketch and the model" onClick={() => engine3d.clear()} disabled={s.working}>
                <Eraser />
              </IconButton>
            )}
          </>
        }
        center={<TalkButton recording={s.recording} working={s.working} sending={s.hasStrokes} onDown={() => engine3d.talkDown()} onUp={() => engine3d.talkUp()} tip="Hold to talk (or Space), or tap to start and tap to send" />}
        right={
          <>
            {s.hasModel && (
              <>
                <Tip label="The same sketch and words, a fresh answer">
                  <Button variant="outline" size="touch" onClick={() => engine3d.reroll()} disabled={s.working}>
                    <RotateCcw />
                    Rebuild
                  </Button>
                </Tip>
                <Tip label="Muse Image paints the model from this view">
                  <Button variant="outline" size="touch" onClick={() => engine3d.paint()} disabled={s.working}>
                    <Paintbrush />
                    Paint
                  </Button>
                </Tip>
              </>
            )}
            <TypeToggle placeholder="Type what it is, e.g. “a chair, the back like this”" sendLabel="Make" busy={s.working} onSend={(text) => engine3d.make(text)} />
          </>
        }
      />

      {/* Where the image mode has its zoom: the views and zoom-to-fit. */}
      <div className="absolute right-4 bottom-(--toolbar-offset) flex items-center gap-2 rounded-lg border bg-card/90 p-2 shadow-xl backdrop-blur">
        <DropdownMenu>
          <Tip label="Look from the front, the side, the top or at three quarters">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="touch">
                <Axis3d />
                Views
              </Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end" side="top">
            {VIEWS.map((v) => (
              <DropdownMenuItem key={v.value} onSelect={() => engine3d.goTo(v.value)}>
                {v.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton label="Zoom to fit the sketch and the model" onClick={() => engine3d.fit()}>
          <Maximize />
        </IconButton>
      </div>
    </div>
  );
}

// Open: a .glb to sketch over, or a sample sketch (no pen needed to try it).
function OpenSketchMenu({ disabled }: { disabled: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={file} type="file" accept=".glb,.gltf,model/gltf-binary" hidden onChange={(e) => e.target.files?.[0] && engine3d.importModel(e.target.files[0])} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="touch" disabled={disabled}>
            <FolderOpen />
            Open
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => file.current?.click()}>
            <FileUp />
            Open file… (.glb, to sketch over)
          </DropdownMenuItem>
          {SAMPLE_MODELS.map((m) => (
            <DropdownMenuItem key={m.url} onSelect={() => engine3d.loadModel(m.url, m.name, m.height)}>
              <Box />
              {m.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => engine3d.onNotice(CREDITS)}>
            <Info />
            Credits
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Sample sketches</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => (engine3d.clear(), engine3d.demoChair())}>
            <Armchair />
            Chair (front and side)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => (engine3d.clear(), engine3d.demoHouse())}>
            <Home />
            House (front and side)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Demo (calls Muse Spark)</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => engine3d.replayChair()}>
            <PenLine />
            Draw and build the chair
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
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
              <Cuboid />
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
