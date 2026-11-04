// Replays a saved perception request with a given reasoning effort:
//   node --env-file=.env server/bench.ts <job dir> [effort]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { perceive } from './perceive.ts';

const dir = process.argv[2];
const effort = process.argv[3] ?? 'minimal';
const req = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
const jpgs = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
req.views = req.views.map((v: any, i: number) => ({ ...v, image: `data:image/jpeg;base64,${readFileSync(join(dir, jpgs[i])).toString('base64')}` }));
if (process.argv[4]) req.views = req.views.slice(0, Number(process.argv[4]));
const r = await perceive({ ...req, effort, copies: Number(process.env.COPIES ?? 3) }, (e) => e.type !== 'done' && console.log(`  +${e.type}`, e.type === 'part' ? e.part.name : e.type === 'say' ? e.say : ''));
console.log(effort, 'first', r.firstMs, 'done', r.ms, 'ms', JSON.stringify(r.usage));
console.log(r.answer.subject, '|', r.answer.say);
for (const p of r.answer.parts) console.log(' ', p.name.padEnd(18), p.primitive.padEnd(8), 'c', p.center.join(','), 's', p.size.join(','), 'r', p.rotation.join(','), 'st', p.strokes.join(','), p.color);
