import { useEffect } from 'react';
import { toast } from 'sonner';
import { editor } from '@/editor/engine';
import { TopBar } from '@/components/top-bar';
import { Stage } from '@/components/stage';
import { RefPanel } from '@/components/ref-panel';
import { useEditor } from '@/hooks/use-editor';

// One gesture: point and talk. The canvas and the talk button are always
// there; everything else appears when it matters or lives in the details sheet.
export function App() {
  const s = useEditor();
  useEffect(() => {
    editor.onError = (message) => toast.error('Something went wrong', { description: message });
    editor.onNotice = (message) => toast(message);
    const paste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
      if (file) editor.openFile(file);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {s.activeRef && <RefPanel key={s.activeRef} />}
        <Stage />
      </div>
    </div>
  );
}
