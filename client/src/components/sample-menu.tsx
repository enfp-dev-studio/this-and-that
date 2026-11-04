import { ChevronDown, ImageIcon } from 'lucide-react';
import { editor } from '@/editor/engine';
import { SAMPLES } from '@/editor/presets';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

function SampleItems() {
  return (
    <>
      <DropdownMenuLabel>Sample pictures</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {SAMPLES.map((s) => (
        <DropdownMenuItem key={s.url} onSelect={() => editor.open(s.url)}>
          <img src={s.url} alt="" className="aspect-video w-(--thumb-width) rounded-sm object-cover" draggable={false} />
          {s.title}
        </DropdownMenuItem>
      ))}
    </>
  );
}

// Top bar: "Sample" opens the list.
export function SampleMenu({ disabled }: { disabled: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="touch" disabled={disabled}>
          <ImageIcon />
          Sample
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <SampleItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Empty stage: "Try the sample" opens the first sample; the arrow lists the rest.
export function TrySample() {
  return (
    <div className="flex flex-1 items-center gap-2">
      <Button size="touch" className="flex-1" onClick={() => editor.open(SAMPLES[0].url)}>
        <ImageIcon />
        Try the sample
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-touch" aria-label="Choose a sample">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <SampleItems />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
