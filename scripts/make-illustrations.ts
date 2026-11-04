// Generate the high-end illustrations used for the production-style tasks.
// We only use images we generate ourselves (no other artists' work as input).
//
//   node --env-file=.env scripts/make-illustrations.ts [name …] [--variants n]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateImage } from '../server/meta.ts';

const out = join(import.meta.dirname, '..', 'out', 'illust');
mkdirSync(out, { recursive: true });

export const ILLUSTRATIONS: Record<string, { size: string; prompt: string }> = {
  armor: {
    size: '1024x1536',
    prompt: `Top-tier fantasy key art, vertical, knees-up portrait of a young knight heroine. Ornate polished silver plate armor covered in fine engraved gold filigree scrollwork, small rubies set along both pauldrons, a large oval faceted sapphire brooch in a gold rose setting clasping a deep navy velvet cape at the collarbone, fine chainmail at the joints, embroidered silver-thread trim on the cape edge. Long platinum-blonde braid over one shoulder held by a small silver hairpin shaped like a plain star. Determined amber eyes with crisp catchlights, calm confident expression, gloved hand resting on a sword pommel with a carved lion crest. Gothic cathedral interior behind her with stained-glass windows softly out of focus, warm rim light and cool fill. Painterly rendering with clean, precise linework, rich material detail on metal, gems and velvet, crowd-favorite illustration quality, no text, no watermark.`,
  },
  gothic: {
    size: '1024x1536',
    prompt: `Highly detailed anime illustration, vertical, waist-up portrait of a gothic lolita girl. Black and wine-red dress with layered white lace ruffles; both sleeve cuffs trimmed with the same white floral lace (a repeating rose-and-scallop pattern); satin ribbons; an ivory cameo brooch of a woman's profile at the high collar; a pearl choker; a headdress of small black roses and ribbon with two tiny crystal hairpins. Long silver twin-tails with fine individual hair strands. Heterochromatic eyes, crimson and violet, with layered highlights; a faint, slightly shy smile. One gloved hand raised near her chin, the other holding a black lace parasol over her shoulder. Victorian glass conservatory with climbing roses behind, soft window light, gentle bokeh. Clean anime line art with painterly shading, intricate costume detail, top-ranking illustration quality, no text, no watermark.`,
  },
  keyvisual: {
    size: '1536x1024',
    prompt: `Anime film key visual, wide cinematic composition. A teenage girl with short black hair and a long red scarf stands on a rooftop at dusk above a dense futuristic city: layered skyscrapers, neon signs, tangled power lines, a monorail curving between towers. Sunset gradient sky from orange to deep violet with towering cumulus clouds and the first stars. Wind lifts her hair and scarf. She wears a navy school blazer with an embroidered gold emblem on the chest pocket (a stylized bird inside a shield), a small silver crescent hairclip, and holds a phone in one hand with all five fingers clearly drawn. Her expression is wistful and quiet. Light particles in the air, rim light on her silhouette, lush painted background with crisp architectural detail, cinematic anime film lighting, no text, no watermark.`,
  },
};

const args = process.argv.slice(2);
const vi = args.indexOf('--variants');
const variants = vi >= 0 ? Number(args[vi + 1]) : 1;
const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--variants');

await Promise.all((names.length ? names : Object.keys(ILLUSTRATIONS)).flatMap((name) =>
  Array.from({ length: variants }, async (_, i) => {
    const { size, prompt } = ILLUSTRATIONS[name];
    const t0 = performance.now();
    const png = await generateImage(prompt, size);
    const file = join(out, `${name}-${i + 1}.png`);
    writeFileSync(file, png);
    console.log(`${file} ${Math.round(performance.now() - t0)} ms`);
  }),
));
