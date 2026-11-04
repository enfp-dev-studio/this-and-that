import { useRef } from 'react';
import { Columns2, FlaskConical, ImageIcon, Moon, PanelRight, Redo2, Sun, Undo2, Upload } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidePanel } from '@/components/side-panel';
import { TasksMenu } from '@/components/tasks';

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

export function TopBar() {
  const s = useEditor();
  const file = useRef<HTMLInputElement>(null);
  const { theme, setTheme } = useTheme();
  const busy = s.mode === 'processing' || s.mode === 'recording';
  const canCompare = !!s.result || s.index > 0;

  return (
    <header className="relative flex shrink-0 items-center justify-between gap-4 border-b bg-background p-2">
      <span className="p-2 font-semibold tracking-tight">
        This <span className="text-muted-foreground">&amp;</span> That
      </span>

      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
        <IconButton label="Undo" onClick={editor.undo} disabled={busy || s.index <= 0}>
          <Undo2 />
        </IconButton>
        <IconButton label="Redo" onClick={editor.redo} disabled={busy || s.index >= s.versions.length - 1}>
          <Redo2 />
        </IconButton>
        <Separator orientation="vertical" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle variant="outline" size="touch" pressed={s.compare} onPressedChange={(on) => editor.setCompare(on)} disabled={!canCompare || busy} aria-label="Before and after">
              <Columns2 />
              Before / After
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>Compare with the previous version</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex items-center gap-2">
        <TasksMenu disabled={busy} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle variant="outline" size="touch" pressed={s.experiment} onPressedChange={(on) => editor.setExperiment(on)} disabled={busy} aria-label="Experiment mode">
              <FlaskConical />
              Experiment
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>Do a task four ways and time each</TooltipContent>
        </Tooltip>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && editor.openFile(e.target.files[0])} />
        <Button variant="ghost" size="touch" onClick={() => file.current?.click()} disabled={busy}>
          <Upload />
          Open
        </Button>
        <Button variant="ghost" size="touch" onClick={() => editor.open('/api/sample')} disabled={busy}>
          <ImageIcon />
          Sample
        </Button>
        <IconButton label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun /> : <Moon />}
        </IconButton>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon-touch" className="lg:hidden" aria-label="Instructions">
              <PanelRight />
            </Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader className="sr-only">
              <SheetTitle>Instructions</SheetTitle>
            </SheetHeader>
            <SidePanel />
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
