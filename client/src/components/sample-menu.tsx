import { useRef } from 'react';
import { FolderOpen, ImageIcon } from 'lucide-react';
import { editor } from '@/editor/engine';
import { SAMPLES } from '@/editor/presets';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

// Top bar: Open a picture of your own, or one of the samples.
export function OpenMenu({ disabled }: { disabled: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && editor.openFile(e.target.files[0])} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="touch" disabled={disabled}>
            <FolderOpen />
            Open
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => file.current?.click()}>
            <ImageIcon />
            Open image…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Samples</DropdownMenuLabel>
          {SAMPLES.map((s) => (
            <DropdownMenuItem key={s.url} onSelect={() => editor.open(s.url)}>
              <img src={s.url} alt="" className="aspect-video w-(--thumb-width) rounded-sm object-cover" draggable={false} />
              {s.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
