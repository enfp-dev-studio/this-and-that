import { Download, FlaskConical, PanelRight, Redo2, Undo2 } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { LAB } from '@/lab';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidePanel } from '@/components/side-panel';
import { TasksMenu } from '@/components/tasks';
import { OpenMenu } from '@/components/sample-menu';

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
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

// Minimal: the name, Undo/Redo, Open (with the samples), Export, and the
// details sheet (history, references, what was understood).
export function TopBar() {
  const s = useEditor();
  const busy = s.mode === 'processing' || s.mode === 'recording';

  return (
    <header className="relative flex shrink-0 items-center justify-between gap-4 border-b bg-background p-2">
      <span className="p-2 font-semibold tracking-tight">
        This <span className="text-muted-foreground">&amp;</span> That
      </span>

      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
        {/* Right after a stroke snapped to a shape, Undo puts the freehand stroke back. */}
        <IconButton label="Undo" onClick={editor.undo} disabled={!s.canUnsnap && (busy || s.index <= 0)}>
          <Undo2 />
        </IconButton>
        <IconButton label="Redo" onClick={editor.redo} disabled={busy || s.index >= s.versions.length - 1}>
          <Redo2 />
        </IconButton>
      </div>

      <div className="flex items-center gap-2">
        {LAB && <TasksMenu disabled={busy} />}
        {LAB && (
          <Toggle variant="outline" size="touch" pressed={s.experiment} onPressedChange={(on) => editor.setExperiment(on)} disabled={busy} aria-label="Experiment mode">
            <FlaskConical />
            Experiment
          </Toggle>
        )}
        <OpenMenu disabled={busy} />
        <Button variant="ghost" size="touch" onClick={() => editor.exportCurrent()} disabled={!s.versions.length}>
          <Download />
          Export
        </Button>
        <Sheet>
          <Tooltip>
            <TooltipTrigger asChild>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon-touch" aria-label="Details">
                  <PanelRight />
                </Button>
              </SheetTrigger>
            </TooltipTrigger>
            <TooltipContent>History, references and details</TooltipContent>
          </Tooltip>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Details</SheetTitle>
              <SheetDescription>History, references and what was understood.</SheetDescription>
            </SheetHeader>
            <SidePanel />
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
