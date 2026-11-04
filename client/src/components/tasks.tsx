import { ListChecks } from 'lucide-react';
import { editor } from '@/editor/engine';
import { TASKS } from '@/editor/presets';
import { useEditor } from '@/hooks/use-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// The Tasks menu: load a correction task (picture + references).
export function TasksMenu({ disabled }: { disabled: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="touch" disabled={disabled}>
          <ListChecks />
          Tasks
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Correction tasks</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TASKS.map((t, i) => (
          <DropdownMenuItem key={t.title} onSelect={() => editor.loadTask(t)}>
            {i + 1}. {t.title}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => editor.loadTask(null)}>Free (no task)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The brief for the loaded task: what to fix, and how to ask in each way.
export function TaskCard() {
  const s = useEditor();
  const task = TASKS.find((t) => t.title === s.task);
  if (!task) return null;
  const ways = [
    { label: 'Draw', text: task.draw },
    { label: 'Say', text: task.say },
    { label: 'Type', text: task.type },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{task.title}</CardTitle>
        <CardDescription>{task.goal}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {ways.map((w) => (
            <li key={w.label} className="flex items-start gap-2 text-sm">
              <Badge variant="outline">{w.label}</Badge>
              <span className="text-muted-foreground">{w.text}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
