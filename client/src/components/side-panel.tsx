import { Check, Circle, Loader2, Zap } from 'lucide-react';
import { editor, type StepState } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { MarkBadge } from '@/components/mark-badge';

const STEPS = [
  { key: 'sam', label: 'SAM', detail: 'outlining what you marked' },
  { key: 'understand', label: 'Spark', detail: 'watching and listening' },
  { key: 'edit', label: 'Muse Image', detail: 'editing the marked parts' },
  { key: 'paste', label: 'Paste', detail: 'only those parts' },
] as const;

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') return <Check className="size-4 text-foreground" />;
  if (state === 'active') return <Loader2 className="size-4 animate-spin text-foreground" />;
  return <Circle className="size-4 text-muted-foreground/50" />;
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3 px-5 py-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// What the app heard and understood, how far the edit is, and the versions.
export function SidePanel() {
  const s = useEditor();
  const working = s.mode === 'processing';
  const showSteps = working || s.mode === 'review';
  const done = STEPS.filter((st) => s.steps[st.key] === 'done').length;

  return (
    <ScrollArea className="h-full">
      <Section
        title="Caption"
        aside={s.mode === 'recording' && <Badge variant="destructive" className="animate-pulse">Live</Badge>}
      >
        <p className={cn('min-h-10 text-sm leading-relaxed', s.caption ? 'text-foreground' : 'text-muted-foreground')}>
          {s.caption ? `“${s.caption}”` : s.mode === 'recording' ? 'Listening…' : 'What you say shows up here as you talk.'}
        </p>
      </Section>

      <Separator />

      <Section title="Instructions" aside={s.edits.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{s.edits.length}</span>}>
        {s.edits.length ? (
          <ul className="space-y-3">
            {s.edits.map((e) => (
              <li key={e.mark} className="flex gap-3">
                <MarkBadge mark={e.mark} className="mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{e.target}</span>
                    {s.localMarks.includes(e.mark) && (
                      <Badge variant="secondary">
                        <Zap />
                        Instant
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{e.instruction}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : working ? (
          <div className="space-y-3">
            {Array.from({ length: Math.max(1, s.marks) }, (_, i) => (
              <div key={i} className="flex gap-3">
                <MarkBadge mark={i + 1} className="mt-0.5" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Draw a mark while you say what to do with it. Each mark gets a number and a colour.</p>
        )}
      </Section>

      {showSteps && (
        <>
          <Separator />
          <Section title="Progress" aside={working && <span className="text-xs text-muted-foreground tabular-nums">{Math.round(s.elapsedMs / 1000)} s</span>}>
            <Progress value={(done / STEPS.length) * 100} />
            <ul className="space-y-2">
              {STEPS.map((st) => (
                <li key={st.key} className={cn('flex items-center gap-2 text-sm', s.steps[st.key] === 'pending' && 'text-muted-foreground')}>
                  <StepIcon state={s.steps[st.key]} />
                  <span className="font-medium">{st.label}</span>
                  <span className="text-muted-foreground">{st.detail}</span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}

      <Separator />

      <Section title="History" aside={s.versions.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{s.versions.length}</span>}>
        {s.versions.length ? (
          <div className="grid grid-cols-2 gap-2">
            {s.versions.map((v, i) => (
              <button
                key={v.url}
                className={cn(
                  'group relative overflow-hidden rounded-md border text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  i === s.index ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100',
                )}
                onClick={() => editor.goTo(i)}
                disabled={working || s.mode === 'recording'}
              >
                <img src={v.url} alt={`Version ${i + 1}`} className="aspect-[3/2] w-full object-cover" draggable={false} />
                <Badge variant="secondary" className="absolute bottom-1.5 left-1.5">
                  {i === 0 ? 'Original' : `v${i + 1}`}
                </Badge>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Each kept edit becomes a version you can go back to.</p>
        )}
      </Section>
    </ScrollArea>
  );
}
