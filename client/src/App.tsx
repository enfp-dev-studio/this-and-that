import { lazy, Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { editor } from '@/editor/engine';
import { ImageChrome, type AppMode } from '@/components/top-bar';

// three.js loads only when 3D mode opens, so the image mode starts as light as before.
const ThreeMode = lazy(() => import('@/components/three-mode').then((m) => ({ default: m.ThreeMode })));
import { Stage } from '@/components/stage';
import { RefPanel } from '@/components/ref-panel';
import { useEditor } from '@/hooks/use-editor';

// One gesture: point and talk. The canvas and the talk button are always
// there; everything else appears when it matters or lives in the details sheet.
// Two modes: refine an image (the core), or sketch in 3D (beta; #3d in the URL).
export function App() {
  const s = useEditor();
  const [mode, setMode] = useState<AppMode>(location.hash === '#3d' ? '3d' : 'image');
  const switchMode = (m: AppMode) => {
    setMode(m);
    history.replaceState(null, '', m === '3d' ? '#3d' : location.pathname + location.search);
  };
  useEffect(() => {
    if (mode !== 'image') return;
    editor.onError = (message) => toast.error('Something went wrong', { description: message });
    editor.onNotice = (message) => toast(message);
    // Paste: the picture when none is open, otherwise a reference.
    const paste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
      if (!file) return;
      if (editor.getSnapshot().mode === 'empty') editor.openFile(file);
      else editor.addRef(file);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [mode]);

  return (
    // Full-bleed canvas; each mode floats its chrome over it.
    <div className="relative h-dvh overflow-hidden">
      {mode === '3d' ? (
        <Suspense>
          <ThreeMode onMode={switchMode} />
        </Suspense>
      ) : (
        <>
          <div className="absolute inset-0 flex">
            <Stage />
            {s.activeRef && <RefPanel key={s.activeRef} />}
          </div>
          <ImageChrome onMode={switchMode} />
        </>
      )}
    </div>
  );
}
