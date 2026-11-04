import { Download, Table2, Trash2 } from 'lucide-react';
import { editor } from '@/editor/engine';
import { METHODS, download, summary, toCsv, type Method } from '@/editor/experiment';
import { useEditor } from '@/hooks/use-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

// Experiment mode: pick how to do the task, and see how long each way took.
export function ExperimentCard() {
  const s = useEditor();
  const busy = s.mode === 'recording' || s.mode === 'processing';
  const open = s.trials.at(-1);
  const current = open && open.totalMs === null ? open : null;
  const method = METHODS.find((m) => m.value === s.method)!;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Experiment</CardTitle>
        <CardDescription>{method.detail}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ToggleGroup type="single" variant="outline" size="touch" value={s.method} onValueChange={(v) => v && editor.setMethod(v as Method)} disabled={busy}>
          {METHODS.map((m) => (
            <ToggleGroupItem key={m.value} value={m.value} aria-label={m.detail}>
              {m.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{s.task}</Badge>
          {current ? `round ${current.rounds.length + 1}, Keep ends the trial` : 'starts with your first input'}
        </div>
        <ResultsSheet />
      </CardContent>
    </Card>
  );
}

function ResultsSheet() {
  const s = useEditor();
  const rows = s.trials.map(summary);
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="touch">
          <Table2 />
          Results ({s.trials.length})
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Experiment results</SheetTitle>
          <SheetDescription>One row per trial: a task done one way, from the first input to Keep. Times in seconds.</SheetDescription>
        </SheetHeader>
        <div className="p-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Method</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Rounds</TableHead>
                <TableHead>Input</TableHead>
                <TableHead>Chars</TableHead>
                <TableHead>Speech</TableHead>
                <TableHead>Wait</TableHead>
                <TableHead>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={s.trials[i].id}>
                  <TableCell>{r.method}</TableCell>
                  <TableCell>{r.task}</TableCell>
                  <TableCell className="tabular-nums">{r.rounds}</TableCell>
                  <TableCell className="tabular-nums">{r.inputS}</TableCell>
                  <TableCell className="tabular-nums">{r.chars}</TableCell>
                  <TableCell className="tabular-nums">{r.speechS}</TableCell>
                  <TableCell className="tabular-nums">{r.waitS}</TableCell>
                  <TableCell className="tabular-nums">{r.totalS ?? 'open'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="ghost" size="touch" onClick={() => editor.clearTrials()} disabled={!s.trials.length}>
            <Trash2 />
            Clear
          </Button>
          <Button variant="outline" size="touch" onClick={() => download(`trials-${stamp()}.json`, JSON.stringify(s.trials, null, 2), 'application/json')} disabled={!s.trials.length}>
            <Download />
            JSON
          </Button>
          <Button variant="outline" size="touch" onClick={() => download(`trials-${stamp()}.csv`, toCsv(s.trials), 'text/csv')} disabled={!s.trials.length}>
            <Download />
            CSV
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
