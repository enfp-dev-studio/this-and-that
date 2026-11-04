import { Check, Circle, ImagePlus, Loader2, Moon, Pin, Sun, Trash2, Zap } from 'lucide-react';
import { editor, type StepState } from '@/editor/engine';
import { useEditor } from '@/hooks/use-editor';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { MarkBadge } from '@/components/mark-badge';
import { ExperimentCard } from '@/components/experiment-card';
import { TaskCard } from '@/components/tasks';
import { refLetter } from '@/components/ref-panel';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { useTheme } from '@/components/theme-provider';
import { LAB } from '@/lab';

const STEPS = [
  { key: 'sam', label: 'SAM', detail: 'outlining what you marked' },
  { key: 'understand', label: 'Spark', detail: 'watching and listening' },
  { key: 'edit', label: 'Muse Image', detail: 'editing the marked parts' },
  { key: 'paste', label: 'Paste', detail: 'only those parts' },
] as const;

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') return <Check />;
  if (state === 'active') return <Loader2 className="animate-spin" />;
  return <Circle className="text-muted-foreground" />;
}

// The details sheet: what the app heard and understood, references, the
// versions, and (lab) the experiment, the task and the progress steps.
export function SidePanel() {
  const s = useEditor();
  const { theme, setTheme } = useTheme();
  const working = s.mode === 'processing';
  const done = STEPS.filter((st) => s.steps[st.key] === 'done').length;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 p-4">
        {LAB && s.experiment && <ExperimentCard />}
        {LAB && <TaskCard />}
        <Card>
          <CardHeader>
            <CardTitle>Caption</CardTitle>
            {s.mode === 'recording' && (
              <CardAction>
                <Badge variant="destructive" className="animate-pulse">Live</Badge>
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            <p className={cn('text-sm', !s.caption && 'text-muted-foreground')}>
              {s.caption ? `“${s.caption}”` : s.mode === 'recording' ? 'Listening…' : 'What you say shows up here as you talk.'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Instructions</CardTitle>
            <CardDescription>Each mark gets a number and a colour.</CardDescription>
          </CardHeader>
          <CardContent>
            {s.edits.length ? (
              <ul className="flex flex-col gap-4">
                {s.edits.map((e) => (
                  <li key={e.mark} className="flex items-start gap-2">
                    <MarkBadge mark={e.mark} />
                    <div className="flex min-w-0 flex-1 flex-col text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{e.target}</span>
                        {e.kind === 'reference' && <Badge variant="outline">Reference</Badge>}
                        {s.localMarks.includes(e.mark) && (
                          <Badge variant="secondary">
                            <Zap />
                            Instant
                          </Badge>
                        )}
                      </div>
                      <span className="text-muted-foreground">{e.instruction}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : working ? (
              <ul className="flex flex-col gap-4">
                {Array.from({ length: Math.max(1, s.marks) }, (_, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <MarkBadge mark={i + 1} />
                    <div className="flex flex-1 flex-col gap-2">
                      <Skeleton size="line-short" />
                      <Skeleton size="line" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Draw a mark while you say what to do with it.</p>
            )}
          </CardContent>
        </Card>

        {LAB && (working || s.mode === 'review') && (
          <Card>
            <CardHeader>
              <CardTitle>Progress</CardTitle>
              {working && <CardDescription className="tabular-nums">{Math.round(s.elapsedMs / 1000)} s</CardDescription>}
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Progress value={(done / STEPS.length) * 100} />
              <ul className="flex flex-col gap-2">
                {STEPS.map((st) => (
                  <li key={st.key} className={cn('flex items-center gap-2 text-sm', s.steps[st.key] === 'pending' && 'text-muted-foreground')}>
                    <StepIcon state={s.steps[st.key]} />
                    <span className="shrink-0 font-medium">{st.label}</span>
                    <span className="truncate text-muted-foreground">{st.detail}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>References</CardTitle>
            <CardDescription>Mark a reference and the picture in the same take. Pinned ones go with every edit.</CardDescription>
            <CardAction>
              <Button variant="outline" size="touch" asChild>
                <label>
                  <ImagePlus />
                  Add
                  <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && editor.addRef(e.target.files[0])} />
                </label>
              </Button>
            </CardAction>
          </CardHeader>
          {s.refs.length > 0 && (
            <CardContent className="grid grid-cols-2 gap-2">
              {s.refs.map((r, i) => (
                <div key={r.id} className="flex flex-col gap-2">
                  <button
                    className={cn(
                      'relative overflow-hidden rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      r.id === s.activeRef ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100',
                    )}
                    onClick={() => editor.openRef(r.id === s.activeRef ? null : r.id)}
                  >
                    <img src={r.url} alt={`Reference ${refLetter(i)}`} className="aspect-video w-full object-cover" draggable={false} />
                    <Badge variant="secondary" className="absolute bottom-2 left-2">
                      {refLetter(i)}
                      {r.pinned && <Pin />}
                    </Badge>
                  </button>
                  <div className="flex items-center justify-between">
                    <Toggle size="icon-touch" pressed={r.pinned} onPressedChange={() => editor.togglePin(r.id)} aria-label="Always include">
                      <Pin />
                    </Toggle>
                    <Button variant="ghost" size="icon-touch" onClick={() => editor.removeRef(r.id)} aria-label="Remove reference">
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>{s.versions.length ? `${s.versions.length} version${s.versions.length > 1 ? 's' : ''}` : 'Each kept edit becomes a version.'}</CardDescription>
          </CardHeader>
          {s.versions.length > 0 && (
            <CardContent className="grid grid-cols-2 gap-2">
              {s.versions.map((v, i) => (
                <button
                  key={v.url}
                  className={cn(
                    'relative overflow-hidden rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    i === s.index ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100',
                  )}
                  onClick={() => editor.goTo(i)}
                  disabled={working || s.mode === 'recording'}
                >
                  <img src={v.url} alt={`Version ${i + 1}`} className="aspect-video w-full object-cover" draggable={false} />
                  <Badge variant="secondary" className="absolute bottom-2 left-2">
                    {i === 0 ? 'Original' : `v${i + 1}`}
                  </Badge>
                </button>
              ))}
            </CardContent>
          )}
        </Card>
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
      </div>
    </ScrollArea>
  );
}
