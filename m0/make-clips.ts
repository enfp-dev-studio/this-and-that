// M0 risk spike, step 1: make "drawing while speaking" test clips.
// An AI image (Muse Image), objects located with Spark, numbered strokes timed
// to overlap a Korean voice track (macOS `say -v Yuna`), rendered to mp4.
//
//   node --env-file=.env m0/make-clips.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateImage } from '../server/meta.ts';
import { audioDurationMs, guideImage, renderVideo } from '../server/render.ts';
import { buildClip, locate, type Box, type Shape } from './clipkit.ts';

const out = join(import.meta.dirname, '..', 'out', 'm0');
mkdirSync(out, { recursive: true });

const PROMPT = 'Cozy digital illustration of a wooden desk by a window: a ginger cat sleeping on the left, a blue ceramic mug in the middle, a small green potted cactus on the right, a yellow desk lamp at the back right. Soft warm light, clean shapes.';
const OBJECTS = ['the cat', 'the mug', 'the cactus', 'the lamp'];

type Clip = { name: string; segments: { say: string; object: string; shape: Shape; expect: string }[] };
const CLIPS: Clip[] = [
  {
    name: 'a',
    segments: [
      { say: '이거는 빨간색으로 바꾸고,', object: 'the mug', shape: 'circle', expect: 'mug → red' },
      { say: '저건 지워 줘.', object: 'the cactus', shape: 'scribble', expect: 'cactus → remove' },
    ],
  },
  {
    name: 'b',
    segments: [
      { say: '이건 없애 줘.', object: 'the lamp', shape: 'circle', expect: 'lamp → remove' },
      { say: '이거는 검은 고양이로 바꿔 줘.', object: 'the cat', shape: 'circle', expect: 'cat → black cat' },
      { say: '그리고 여기는 노란색으로.', object: 'the mug', shape: 'scribble', expect: 'mug → yellow' },
    ],
  },
  {
    name: 'c',
    segments: [
      { say: '이 고양이가', object: 'the cat', shape: 'circle', expect: 'cat → looks right (with mark 2)' },
      { say: '이쪽을 보게 해 줘.', object: 'the cat', shape: 'arrow', expect: 'direction for mark 1' },
      { say: '그리고 저건 초록색으로.', object: 'the mug', shape: 'circle', expect: 'mug → green' },
    ],
  },
  // Simple edits the app can apply locally (M2 instant edits).
  {
    name: 'd',
    segments: [
      { say: '이거는 빨간색으로 바꾸고,', object: 'the mug', shape: 'circle', expect: 'mug → red (recolor)' },
      { say: '저건 좀 더 밝게 해 줘.', object: 'the lamp', shape: 'circle', expect: 'lamp → brighter (tone)' },
    ],
  },
  {
    name: 'e',
    segments: [
      { say: '이 컵을', object: 'the mug', shape: 'circle', expect: 'mug → move (with mark 2)' },
      { say: '여기로 옮겨 줘.', object: 'the mug', shape: 'arrow', expect: 'destination for mark 1' },
    ],
  },
  {
    name: 'f',
    segments: [
      { say: '이 선인장 좀 더 크게 해 줘.', object: 'the cactus', shape: 'circle', expect: 'cactus → bigger (scale)' },
    ],
  },
];

const imagePath = join(out, 'image.png');
if (!existsSync(imagePath)) {
  console.log('generating image…');
  writeFileSync(imagePath, await generateImage(PROMPT));
}
const image = readFileSync(imagePath);

const boxesPath = join(out, 'boxes.json');
if (!existsSync(boxesPath)) {
  console.log('locating objects…');
  writeFileSync(boxesPath, JSON.stringify(Object.fromEntries(await locate(image, OBJECTS)), null, 2));
}
const boxes = new Map<string, Box>(Object.entries(JSON.parse(readFileSync(boxesPath, 'utf8'))));

for (const clip of CLIPS) {
  const segments = clip.segments.map((seg) => {
    const box = boxes.get(seg.object);
    if (!box) throw new Error(`no box for ${seg.object}`);
    return { say: seg.say, box, shape: seg.shape };
  });
  const { strokes, wav } = await buildClip(out, clip.name, image, segments);
  const durationMs = await audioDurationMs(wav);
  const mp4 = join(out, `${clip.name}.mp4`);
  await renderVideo(image, strokes, wav, mp4, { durationMs });
  writeFileSync(join(out, `${clip.name}-guide.png`), await guideImage(image, strokes));
  console.log(`${clip.name}: ${mp4} (${durationMs} ms) — ${clip.segments.map((s) => s.expect).join('; ')}`);
}
