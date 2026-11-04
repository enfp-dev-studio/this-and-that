// Production-style correction tasks on our own illustrations: the fine
// details words fail at. Each says what to fix, and how to ask for it in each
// experiment way, so the four ways can be compared on the same task.

export type Task = {
  title: string;
  image: string;
  refs: { url: string; pinned: boolean }[];
  goal: string;
  draw: string; // Pen and Ref ways
  say: string;
  type: string; // Type way (and what to say in the Voice way)
};

const sample = (path: string) => `/api/samples/${path}`;

export const TASKS: Task[] = [
  {
    title: 'Brooch like the reference',
    image: sample('illust/armor.jpg'),
    refs: [{ url: sample('tasks/ref-rose-brooch.jpg'), pinned: false }],
    goal: 'Make the brooch at her collar match the gold rose ornament in the reference.',
    draw: 'Circle the brooch, then the rose on the reference',
    say: '이 브로치를 이렇게 바꿔 줘',
    type: 'Replace the sapphire brooch at her collar with a gold rose-shaped brooch with a ruby center and seed pearls around it.',
  },
  {
    title: 'Cuff lace like the other cuff',
    image: sample('tasks/gothic-cuff.jpg'),
    refs: [],
    goal: 'The cuff at the lower right has a plain zigzag trim. Make it the same rose lace as the other cuff.',
    draw: 'Circle the zigzag cuff, then the rose-lace cuff',
    say: '이 소매 레이스를 저쪽 소매처럼 맞춰 줘',
    type: 'The cuff at the lower right has a plain zigzag trim; make it the same white rose-and-scallop lace as the cuff near her chin.',
  },
  {
    title: 'More resolute, on-model',
    image: sample('illust/armor.jpg'),
    refs: [{ url: sample('illust/armor.jpg'), pinned: true }],
    goal: 'Make her expression more resolute while her face stays on-model (the original is pinned as the character sheet).',
    draw: 'Circle her face',
    say: '표정을 좀 더 결연하게 해 줘, 얼굴은 그대로',
    type: 'Make her expression more resolute and determined: firmer brows and mouth, a steady gaze. Keep her face, features and art style exactly the same.',
  },
  {
    title: 'Crescent-moon hairpin',
    image: sample('illust/gothic.jpg'),
    refs: [{ url: sample('tasks/ref-crescent-pin.jpg'), pinned: false }],
    goal: 'Redesign the crystal hairpin on the left of her head as the crescent moon in the reference.',
    draw: 'Circle the crystal hairpin, then the crescent on the reference',
    say: '이 머리핀을 이렇게 바꿔 줘',
    type: 'Replace the crystal hairpin on the left side of her head with a silver crescent-moon hairpin with small sapphires and a pearl drop.',
  },
  {
    title: 'Six-finger hand',
    image: sample('tasks/keyvisual-hand.jpg'),
    refs: [],
    goal: 'Her hand holding the phone has six fingers. Fix it to five, keeping the pose.',
    draw: 'Circle the hand',
    say: '이 손, 손가락 다섯 개로 고쳐 줘',
    type: 'Her hand holding the phone has six fingers; fix it to a natural hand with five fingers, keeping the same pose.',
  },
];

// Pictures to try the app on (all made with Muse Image). The first is the default.
export const SAMPLES = [
  { title: 'Armor knight', url: sample('illust/armor.jpg') },
  { title: 'Gothic lolita', url: sample('illust/gothic.jpg') },
  { title: 'Key visual', url: sample('illust/keyvisual.jpg') },
  { title: 'Gothic, mismatched cuff', url: sample('tasks/gothic-cuff.jpg') },
  { title: 'Key visual, six-finger hand', url: sample('tasks/keyvisual-hand.jpg') },
  { title: 'Desk with cat', url: '/api/sample' },
];
