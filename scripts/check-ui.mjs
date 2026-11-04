// npm run check:ui — app code (client/src outside components/ui) must take
// its sizes from shadcn variants and theme.css: no arbitrary values, no
// height/width/size, text-size, padding, margin or gap utilities beyond a
// tiny allowed set.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..', 'client', 'src');
const ALLOWED = new Set([
  'h-full', 'h-dvh', 'w-full', 'size-full', 'min-h-0', 'min-w-0',
  'w-(--panel-width)', 'w-(--status-width)', 'w-(--slider-width)', 'w-(--card-width)',
  'p-2', 'p-4', 'gap-2', 'gap-4',
]);
const RULES = [
  [/-\[/, 'arbitrary value'],
  [/^(min-|max-)?(h|w|size)-/, 'size (use a component variant or a theme variable)'],
  [/^text-(xs|base|lg|[2-9]?xl)$/, 'text size (use text-sm or the component)'],
  [/^-?(p|px|py|pt|pb|pl|pr|ps|pe)-/, 'padding'],
  [/^-?(m|mx|my|mt|mb|ml|mr|ms|me)-/, 'margin (space with gap)'],
  [/^(gap|gap-x|gap-y|space-x|space-y)-/, 'spacing'],
];

const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return p.endsWith(join('components', 'ui')) ? [] : files(p);
  return /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
});

// The utility a class token applies, without variant prefixes (hover:, lg:, …).
const base = (token) => {
  let depth = 0, cut = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '[' || token[i] === '(') depth++;
    else if (token[i] === ']' || token[i] === ')') depth--;
    else if (token[i] === ':' && depth === 0) cut = i + 1;
  }
  return token.slice(cut).replace(/^!/, '');
};

let problems = 0;
for (const file of files(root)) {
  const src = readFileSync(file, 'utf8');
  // Class names live in string literals: className="…", cn('…'), arrays of classes.
  for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    for (const token of m[2].split(/\s+/)) {
      if (!token || ALLOWED.has(base(token))) continue;
      for (const [re, why] of RULES) {
        if (re.test(re.source === '-\\[' ? token : base(token))) {
          const line = src.slice(0, m.index).split('\n').length;
          console.log(`${relative(process.cwd(), file)}:${line}  ${token}  (${why})`);
          problems++;
          break;
        }
      }
    }
  }
}
if (problems) {
  console.log(`\ncheck:ui: ${problems} problem(s)`);
  process.exit(1);
}
console.log('check:ui: ok');
