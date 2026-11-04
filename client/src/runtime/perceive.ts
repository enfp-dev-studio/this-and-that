// Muse Spark looks at the 3D sketch from several viewpoints, reads the
// transcript and the strokes' 3D coordinates, and answers a part list:
// primitives with transforms fitted to the strokes they explain. Runs in the
// browser; Spark is called through the Worker proxy.

import { blobToDataUrl, editImage, sparkStream } from './meta';
import { museParams } from './pipeline';
import { partHolder } from './fit-parts';

type Usage = Record<string, unknown> | undefined;
const imagePart = (dataUrl: string) => ({ type: 'image_url', image_url: { url: dataUrl } });
const textPart = (text: string) => ({ type: 'text', text });

export type View = { name: string; note: string; image: string }; // image: JPEG data URL
export type StrokeInfo = {
  id: number;
  color: string;
  drawnFrom: [number, number, number]; // view direction while drawing (camera → scene)
  plane: 'view' | 'ground' | 'surface';
  pen?: 'point' | 'shape'; // forced by the user: point = marks an existing part, shape = draws geometry
  bbox: { min: number[]; max: number[] };
  points: number[][]; // a few samples along the stroke
  trace?: number[][]; // the whole stroke, evenly sampled: drawn shapes follow it (not sent to Spark)
  closed: boolean;
};
export type Part = {
  name: string;
  primitive: 'box' | 'cylinder' | 'sphere' | 'cone' | 'capsule' | 'extrude' | 'tube' | 'membrane' | 'lathe' | 'mesh';
  center: number[];
  size: number[];
  rotation: number[];
  color: string;
  material: string;
  strokes: number[];
  profile: number;
  path?: number[][]; // tube: control points from its base (the center), in the part's frame
  radii?: number[]; // tube: [base, tip] radius
  outline?: number[][]; // membrane: its flat outline, [x, y] in the part's frame, from its root (the center)
  style?: 'flame' | 'guard'; // a crafted low-poly form for a drawn flame or guard (fit-parts.ts)
  tongues?: number[][]; // flame: [y0, y1, tipX, tipY] per tongue, in the part's frame (x out of the edge, y along it)
  thickness?: number; // flame: tongue thickness; guard: section height
};
// `edits`: reshaping an opened model itself (the geometry comes from the strokes, in the app).
export type Edit = { op: 'lengthen' | 'thin' | 'curve' | 'gem'; segment: 'blade' | 'guard' | 'grip' | 'pommel'; strokes: number[]; color: string };
export type Answer = { subject: string; say: string; parts: Part[]; edits?: Edit[] };

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'say', 'parts', 'edits'],
  properties: {
    subject: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'segment', 'strokes', 'color'],
        properties: {
          op: { type: 'string', enum: ['lengthen', 'thin', 'curve', 'gem'] },
          segment: { type: 'string', enum: ['blade', 'guard', 'grip', 'pommel'] },
          strokes: { type: 'array', items: { type: 'integer' } },
          color: { type: 'string' },
        },
      },
    },
    say: { type: 'string' },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'primitive', 'center', 'size', 'rotation', 'color', 'material', 'strokes', 'profile', 'path', 'radii', 'outline'],
        properties: {
          name: { type: 'string' },
          primitive: { type: 'string', enum: ['box', 'cylinder', 'sphere', 'cone', 'capsule', 'extrude', 'tube', 'membrane', 'lathe', 'mesh'] },
          center: vec3,
          size: vec3,
          rotation: vec3,
          color: { type: 'string' },
          material: { type: 'string', enum: ['wood', 'metal', 'plastic', 'fabric', 'stone', 'glass', 'ceramic', 'plant', 'paint'] },
          strokes: { type: 'array', items: { type: 'integer' } },
          profile: { type: 'integer' },
          path: { type: 'array', items: vec3 },
          radii: { type: 'array', items: { type: 'number' } },
          outline: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
        },
      },
    },
  },
};

const SYSTEM_BASE = `You are the 3D modeling brain of a sketching app. The user sketched an object with strokes floating in 3D space while talking (Korean or English). Work out what the sketch depicts and rebuild it as a simple low-poly model made of primitives, fitted to the strokes.

Coordinates: Y is up, X to the right, +Z toward the viewer of the FRONT view. The grid is the ground, y = 0. Use the stroke coordinates you are given; the model must sit where the strokes are, at their scale.

How strokes are made: each stroke lies on a flat drawing plane. For plane "view" the plane faced the camera ("drawnFrom" is the camera's looking direction), so the stroke's shape across the screen is reliable but its depth along drawnFrom is only a guess. Use the other views, the other strokes and common sense about the object to put every part at the right depth (a chair back drawn from the front belongs at the back edge of the seat seen in the side view). A stroke drawn from the side is a side profile: one leg stroke drawn from the side stands for the left and the right leg at that depth, not for an extra leg in the middle; the same goes for front views and the front/back pairs. "ground" strokes lie flat at y = 0 or on a horizontal plane; "surface" strokes were drawn on the existing model's surface.

Images: the strokes from several viewpoints, each stroke in its own color with its id number at its middle. A gray model in the images is the current model, which the user is now editing.

Parts:
- primitive: box, cylinder, sphere, cone, capsule, extrude, tube, membrane or lathe; mesh = a model the user opened (a detailed asset shown in the images): return it exactly as given, attach new parts to its surface, never create a mesh.
- center [x,y,z]; size [x,y,z] = full extents in the part's own frame before rotation. Cylinders, cones and capsules have their axis along their own Y: size[1] = length, size[0] = size[2] = diameter; a cone's tip points to its +Y.
- rotation [x,y,z] in degrees, Euler XYZ; [0,0,0] when axis-aligned. Tilt only what is drawn tilted (a reclined back, a roof slope). Signs: a positive X rotation tips an upright part's top toward +Z (the front), so a chair back reclining backward has a negative X rotation; a positive Z rotation tips the top toward -X.
- extrude: a flat slab whose outline is one closed stroke (a house's gable wall, a sign, a leaf, a letter). profile = that stroke id, size[2] = thickness, center = where the outline's middle should end up (move it to the right depth); its rotation is ignored. profile = -1 for every other primitive.
- tube: a smooth, tapered horn, tail, tentacle, antenna or handle. center = its base, where it attaches to the model; path = 3 to 6 control points [x,y,z] relative to the base, from [0,0,0] to the tip, a clean smooth curve (take only the bend and direction from the strokes, never their wobble); radii = [base radius, tip radius]: thick at the base (a horn's base about a quarter of its length across), tapering to a near point; size = the extents of the whole tube; rotation [0,0,0]. path = [] and radii = [] for every other primitive.
- membrane: a thin curved sheet: a wing, fin, ear, sail or cape. center = its root, where it attaches; outline = 5 to 12 [x,y] points of its flat shape in its own plane (x along its span, away from the body; y up), relative to the root, a clean well-proportioned silhouette; wings are bat-like unless the user says otherwise: a long leading edge, 3 to 4 pointed finger tips and scalloped edges between them (the app adds the ribs from the root to the tips), and a dark leathery color (#2b2a30) unless a color is asked for; size[2] = thickness (about 0.01); rotation turns that plane into place. outline = [] for every other primitive (except lathe).
- lathe: a body of revolution about its own vertical axis: a helmet, dome, vase, bottle, bowl, bell. center = the middle of its base; outline = its half profile, [radius, y] from the bottom up to the top (radius 0 at a closed top), relative to center. Use it for the main body of such objects. Pairs (left and right wings, horns, ears) mirror each other.
- color: a plausible real color as #rrggbb (the stroke colors in the images are only labels, never the object's colors) (wood brown, red roof, green leaves), or the color the user asks for. material: the closest hint.
- strokes: the ids of the strokes this part explains. Every stroke is explained by some part, except pure gestures (a circle around a part or an arrow, meaning "this one").
- A stroke with "pen": "point" was drawn with the Point pen: it only marks an existing part or place ("this one"), never new geometry. "pen": "shape" (Shape pen) means it draws geometry to follow, even over an existing part. Without "pen", decide from the drawing and the words.
- Follow the drawing: lines drawn as separate posts, legs or rails become separate thin parts; a closed outline becomes a panel or slab. Anything the user names (roof, backrest, handle, door) gets its own part, so it can be colored and edited.
- Complete what a real object of that kind needs even if only one side was drawn (the hidden legs of a chair, mirrored), but keep it simple: 3 to 16 parts. Parts should touch where they connect; nothing floats and nothing is left open (a gable roof needs its triangular gable ends: an extrude of the outline stroke, or a box rotated 45° about the ridge axis).
- Editing: return the full updated list. Keep unchanged parts exactly as they were (same name, same numbers). "this" / "here" / "이거" / "여기" means the part or place the new strokes touch.
- Reshaping an opened model (a mesh part) itself goes in edits, not parts: "make the blade this long" (lengthen: a line from the tip outward), "make it a thin rapier" (thin: two lines along the blade), "curve it like this, like a katana" (curve: an arc along the blade), "set a gem here" (gem: a small circle; color = the gem's #rrggbb, else ""). segment = the part of the model the strokes are on (blade, guard, grip or pommel); strokes = their ids. Then parts is the current list unchanged. edits = [] otherwise.
- A stroke that draws a shape ("like this", "this shape", an outline or curve) gives that part its geometry, which the app takes from the stroke; a tap or a loose circle only says where. Either way, say which part each stroke makes (strokes) and its kind (primitive), attachment and pair. Design a clean, well-proportioned part of the kind asked for, attached to the model there. Add as many as the words mean: "horns" or "wings" on a head or body = a mirrored pair, even if one side was drawn; never duplicates.

subject: what it is, a few English words. say: one short, friendly Korean sentence about what you made or changed.

Work fast: the user is waiting. Think briefly, read the coordinates straight off the strokes, and answer.`;

const SYSTEM = SYSTEM_BASE;

// Completed objects of the "parts" array in a JSON answer that is still being written.
export function partsSoFar(text: string): Part[] {
  const start = text.indexOf('"parts"');
  if (start < 0) return [];
  const open = text.indexOf('[', start);
  if (open < 0) return [];
  const out: Part[] = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') {
      if (depth === 0 && c === '{') objStart = i;
      depth++;
    } else if (c === '}' || c === ']') {
      if (depth === 0) break; // end of the parts array
      depth--;
      if (depth === 0 && c === '}' && objStart >= 0) {
        try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch {}
        objStart = -1;
      }
    }
  }
  return out;
}

const field = (text: string, name: string) => {
  const m = text.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`) as string; } catch { return null; }
};

export type PerceiveEvent =
  | { type: 'say'; subject: string | null; say: string }
  | { type: 'part'; part: Part; firstMs: number }
  | { type: 'done'; answer: Answer; usage: Usage; ms: number; firstMs: number };

export async function perceive(req: { views: View[]; strokes: StrokeInfo[]; transcript: string; parts: Part[]; effort?: string; copies?: number }, onEvent: (e: PerceiveEvent) => void = () => {}): Promise<{ answer: Answer; usage: Usage; ms: number; firstMs: number }> {
  const content: any[] = [];
  for (const v of req.views) {
    content.push(textPart(`${v.name}: ${v.note}`));
    content.push(imagePart(v.image));
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const strokes = req.strokes.map((s) => ({
    id: s.id,
    color: s.color,
    plane: s.plane,
    drawnFrom: s.drawnFrom.map((n) => Math.round(n * 100) / 100),
    closed: s.closed,
    bboxMin: s.bbox.min.map(r3),
    bboxMax: s.bbox.max.map(r3),
    points: s.points.map((p) => p.map(r3)),
    ...(s.pen ? { pen: s.pen } : {}),
  }));
  content.push(textPart(`Strokes (${strokes.length}):\n${JSON.stringify(strokes)}`));
  if (req.parts.length) content.push(textPart(`Current model (edit it):\n${JSON.stringify(req.parts)}`));
  content.push(textPart(`What the user said while drawing: ${req.transcript ? `"${req.transcript}"` : '(nothing; go by the sketch alone)'}`));
  const t0 = Date.now();
  let sent = 0, said = false, firstMs = 0;
  // Parts held to the sketch as they stream in (on their strokes; no duplicates in an edit).
  const hold = partHolder<Part>(req.parts, req.strokes, req.transcript);
  const { text, usage, firstMs: fm } = await sparkStream({
    system: SYSTEM,
    content,
    schema: SCHEMA,
    effort: req.effort ?? 'minimal',
    copies: req.copies ?? 3,
    onText: (t) => {
      firstMs ||= Date.now() - t0;
      if (!said) {
        const say = field(t, 'say');
        if (say !== null && /"say"\s*:\s*"(?:[^"\\]|\\.)*"/.test(t)) (said = true), onEvent({ type: 'say', subject: field(t, 'subject'), say });
      }
      const parts = partsSoFar(t);
      for (; sent < parts.length; sent++) {
        const part = hold.next(parts[sent]);
        if (part) onEvent({ type: 'part', part, firstMs });
      }
    },
  });
  const raw = JSON.parse(text) as Answer;
  const answer = { ...raw, parts: partHolder<Part>(req.parts, req.strokes, req.transcript, (s) => console.info(s)).all(raw.parts) };
  const ms = Date.now() - t0;
  onEvent({ type: 'done', answer, usage, ms, firstMs: fm });
  return { answer, usage, ms, firstMs: fm };
}

// Muse Image repaints a render of the model; the client projects it back on.
export async function paintModel(image: string, subject: string, style: string) {
  const prompt = `This is a plain 3D render of a simple low-poly ${subject || 'object'} on a white background. Repaint it as a finished, stylized, hand-painted 3D game asset. This is texture painting only: the result is projected back onto the 3D model, so every edge, the silhouette, the position, the size and the camera angle must stay exactly where they are in this render, even if a shape looks odd. Only add surface materials and detail (for example wood grain, roof tiles, bricks, fabric weave), richer painted colors and soft lighting. Do not add, remove, move or reshape anything. Keep the plain white background.${style ? ` Style: ${style}.` : ''}`;
  const t0 = Date.now();
  const out = await editImage(prompt, [image], '1024x1024', undefined, museParams('notools'));
  return { image: await blobToDataUrl(out), ms: Date.now() - t0 };
}
