import { useEffect, useRef } from 'react';
import { Pin, X } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const refLetter = (index: number) => String.fromCharCode(65 + index);

// The open reference, beside the picture. Marks drawn here share the take and
// the numbering with marks on the picture: circle the ornament here, circle
// the brooch there, and say "make this like this".
export function RefPanel() {
  const s = useEditor();
  const el = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => editor.attachRef(el.current!, canvas.current!), []);
  const index = s.refs.findIndex((r) => r.id === s.activeRef);
  const ref = s.refs[index];
  if (!ref) return null;

  return (
    <div className="flex w-(--ref-width) shrink-0 flex-col border-r bg-background">
      <div className="flex items-center justify-between gap-2 border-b p-2">
        <Badge variant="secondary">Reference {refLetter(index)}</Badge>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle size="icon-touch" pressed={ref.pinned} onPressedChange={() => editor.togglePin(ref.id)} aria-label="Always include">
                <Pin />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent>Always include with every edit (a character sheet)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-touch" onClick={() => editor.openRef(null)} aria-label="Close reference">
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div ref={el} className="relative min-h-0 flex-1 touch-none select-none canvas-dots">
        <canvas ref={canvas} className="absolute inset-0 size-full touch-none" />
      </div>
    </div>
  );
}
