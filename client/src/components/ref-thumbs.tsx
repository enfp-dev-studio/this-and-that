import { Pin } from 'lucide-react';
import { editor } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { refLetter } from '@/components/ref-panel';

// References float as small thumbnails at the canvas edge, only once there
// are any (drop or paste an image onto the picture). Tap one to open it
// beside the picture and mark it.
export function RefThumbs() {
  const s = useEditor();
  if (!s.refs.length) return null;
  return (
    <div className="absolute top-(--chrome-height) left-4 flex flex-col gap-2">
      {s.refs.map((r, i) => (
        <Tooltip key={r.id}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="thumb"
              className={cn('relative bg-card', r.id === s.activeRef ? 'ring-2 ring-primary' : 'opacity-80 hover:opacity-100')}
              onClick={() => editor.openRef(r.id === s.activeRef ? null : r.id)}
              aria-label={`Reference ${refLetter(i)}`}
            >
              <img src={r.url} alt="" className="aspect-square w-(--ref-thumb-width) object-cover" draggable={false} />
              <Badge variant="secondary" className="absolute bottom-1 left-1">
                {refLetter(i)}
                {r.pinned && <Pin />}
              </Badge>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{r.id === s.activeRef ? 'Close' : 'Open to mark it'}{r.pinned ? ' · pinned to every edit' : ''}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
