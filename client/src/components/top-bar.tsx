import { useRef } from 'react';
import { useTheme } from '@/components/theme-provider';
import { Columns2, ImageIcon, Moon, PanelRight, Redo2, Sun, Undo2, Upload } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidePanel } from '@/components/side-panel';

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11" onClick={onClick} disabled={disabled} aria-label={label}>
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
    <header className="relative flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
      <div className="flex items-baseline gap-1.5 pl-1 text-base font-semibold tracking-tight">
        This <span className="text-muted-foreground">&amp;</span> That
      </div>

      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
        <IconButton label="Undo" onClick={editor.undo} disabled={busy || s.index <= 0}>
          <Undo2 />
        </IconButton>
        <IconButton label="Redo" onClick={editor.redo} disabled={busy || s.index >= s.versions.length - 1}>
          <Redo2 />
        </IconButton>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-6" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle variant="outline" className="h-11 px-3" pressed={s.compare} onPressedChange={(on) => editor.setCompare(on)} disabled={!canCompare || busy} aria-label="Before and after">
              <Columns2 />
              Before / After
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>Compare with the previous version</TooltipContent>
        </Tooltip>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && editor.openFile(e.target.files[0])} />
        <Button variant="ghost" className="h-11" onClick={() => file.current?.click()} disabled={busy}>
          <Upload />
          Open
        </Button>
        <Button variant="ghost" className="h-11" onClick={() => editor.open('/api/sample')} disabled={busy}>
          <ImageIcon />
          Sample
        </Button>
        <IconButton label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun /> : <Moon />}
        </IconButton>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11 lg:hidden" aria-label="Instructions">
              <PanelRight />
            </Button>
          </SheetTrigger>
          <SheetContent className="w-80 p-0">
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
