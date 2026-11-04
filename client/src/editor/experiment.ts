// Experiment mode: the same task done four ways, timed. A trial is one task
// with one method, from the first input until Keep; each send is a round.

export type Method = 'type' | 'voice' | 'pen' | 'pen-ref';
export const METHODS: { value: Method; label: string; detail: string }[] = [
  { value: 'type', label: 'Type', detail: 'typed request, whole-picture edit' },
  { value: 'voice', label: 'Voice', detail: 'spoken request, no marks, whole picture' },
  { value: 'pen', label: 'Pen', detail: 'marks + voice, only marked parts change' },
  { value: 'pen-ref', label: 'Ref', detail: 'marks + voice + reference' },
];

export type Round = {
  inputMs: number; // first keystroke or press → send
  chars: number; // typed characters (Type)
  speechMs: number; // recording length (the other methods)
  marks: number;
  waitMs: number; // send → result
  kept: boolean;
};
export type Trial = { id: string; method: Method; task: string; startedAt: number; rounds: Round[]; totalMs: number | null };

const KEY = 'this-and-that-trials';

export function loadTrials(): Trial[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveTrials(trials: Trial[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(trials));
  } catch {}
}

const s = (ms: number) => Math.round(ms / 100) / 10;
const sum = (t: Trial, f: (r: Round) => number) => t.rounds.reduce((n, r) => n + f(r), 0);

// One row per trial, as shown in the table and exported to CSV.
export function summary(t: Trial) {
  return {
    method: METHODS.find((m) => m.value === t.method)?.label ?? t.method,
    task: t.task,
    rounds: t.rounds.length,
    inputS: s(sum(t, (r) => r.inputMs)),
    chars: sum(t, (r) => r.chars),
    speechS: s(sum(t, (r) => r.speechMs)),
    waitS: s(sum(t, (r) => r.waitMs)),
    totalS: t.totalMs === null ? null : s(t.totalMs),
    kept: t.totalMs !== null,
  };
}

export function toCsv(trials: Trial[]) {
  const rows = trials.map(summary);
  const cols = ['method', 'task', 'rounds', 'inputS', 'chars', 'speechS', 'waitS', 'totalS', 'kept'] as const;
  const cell = (v: unknown) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v ?? ''));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
