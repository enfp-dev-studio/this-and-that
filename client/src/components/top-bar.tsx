import { Box, Download, FlaskConical, ImageIcon, Moon, PanelRight, Redo2, Sun, Undo2 } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { LAB } from '@/lab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidePanel } from '@/components/side-panel';
import { TasksMenu } from '@/components/tasks';
import { OpenMenu } from '@/components/sample-menu';
import { PenModes } from '@/components/toolbar';
import { useTheme } from '@/components/theme-provider';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export type AppMode = 'image' | '3d';

// The app's chrome, the same in both modes: floating rounded panels over the
// full-bleed canvas. Left: the name and undo; centre: the mode and the
// mode's drawing tools; right: files and the inspector.
const PANEL = 'absolute top-4 z-10 flex items-center gap-2 rounded-full border bg-card/90 p-2 shadow-xl backdrop-blur';

export function Chrome({ left, center, right }: { left: React.ReactNode; center: React.ReactNode; right?: React.ReactNode }) {
  return (
    <>
      <div className={`${PANEL} left-4`}>{left}</div>
      <div className={`${PANEL} left-1/2 -translate-x-1/2`}>{center}</div>
      {right && <div className={`${PANEL} right-4`}>{right}</div>}
    </>
  );
}

export function Brand() {
  return (
    <span className="p-2 text-sm font-semibold tracking-tight">
      This <span className="text-muted-foreground">&amp;</span> That
    </span>
  );
}

export function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-touch" onClick={onClick} disabled={disabled} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ModeSwitch({ mode, onMode, disabled }: { mode: AppMode; onMode: (mode: AppMode) => void; disabled?: boolean }) {
  return (
    <ToggleGroup type="single" variant="segment" size="touch" value={mode} onValueChange={(v) => v && onMode(v as AppMode)} disabled={disabled} aria-label="Mode">
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="image" aria-label="Image">
            <ImageIcon />
            Image
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>Refine a picture: mark it and say what to change</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="3d" aria-label="3D">
            <Box />
            3D
            <Badge variant="secondary">beta</Badge>
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>3D sketch mode (beta): draw in 3D, say what it is</TooltipContent>
      </Tooltip>
    </ToggleGroup>
  );
}

// The inspector, the same in both modes: a sheet from the right, collapsed by default.
export function Inspector({ tip, description, children }: { tip: string; description: string; children: React.ReactNode }) {
  return (
    <Sheet>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon-touch" aria-label="Details">
              <PanelRight />
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Details</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {children}
        <div className="p-4">
          <ThemeCard />
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Light or dark, for both modes.
function ThemeCard() {
  const { theme, setTheme } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme</CardTitle>
        <CardDescription>{theme === 'dark' ? 'Dark' : 'Light'}</CardDescription>
        <CardAction>
          <Button variant="outline" size="icon-touch" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Switch theme">
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

// Image mode's chrome: undo/redo, the pen modes, Open / Export and the
// inspector (history, references, what was understood), collapsed by default.
export function ImageChrome({ onMode }: { onMode: (mode: AppMode) => void }) {
  const s = useEditor();
  const busy = s.mode === 'processing' || s.mode === 'recording';
  return (
    <Chrome
      left={
        <>
          <Brand />
          {/* Right after a stroke snapped to a shape, Undo puts the freehand stroke back. */}
          <IconButton label="Undo" onClick={editor.undo} disabled={!s.canUnsnap && (busy || s.index <= 0)}>
            <Undo2 />
          </IconButton>
          <IconButton label="Redo" onClick={editor.redo} disabled={busy || s.index >= s.versions.length - 1}>
            <Redo2 />
          </IconButton>
        </>
      }
      center={
        <>
          <ModeSwitch mode="image" onMode={onMode} disabled={busy} />
          <Separator orientation="vertical" />
          <PenModes value={s.penMode} onChange={(mode) => editor.setPenMode(mode)} />
        </>
      }
      right={
        <>
          {LAB && <TasksMenu disabled={busy} />}
          {LAB && (
            <Toggle variant="outline" size="touch" pressed={s.experiment} onPressedChange={(on) => editor.setExperiment(on)} disabled={busy} aria-label="Experiment mode">
              <FlaskConical />
              Experiment
            </Toggle>
          )}
          <OpenMenu disabled={busy} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="touch" onClick={() => editor.exportCurrent()} disabled={!s.versions.length}>
                <Download />
                Export
              </Button>
            </TooltipTrigger>
            <TooltipContent>Save the current picture</TooltipContent>
          </Tooltip>
          <Inspector tip="History, references and details" description="History, references and what was understood.">
            <SidePanel />
          </Inspector>
        </>
      }
    />
  );
}
