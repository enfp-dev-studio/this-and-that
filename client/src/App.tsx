import { useEffect } from 'react';
import { toast } from 'sonner';
import { editor } from '@/editor/engine';
import { TopBar } from '@/components/top-bar';
import { Stage } from '@/components/stage';
import { SidePanel } from '@/components/side-panel';

// Canvas-first editor: slim top bar, the image in the middle with a floating
// toolbar, and the understood instructions, captions and history on the right.
export function App() {
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
        <Stage />
        <aside className="hidden w-80 shrink-0 border-l bg-background lg:block">
          <SidePanel />
        </aside>
      </div>
    </div>
  );
}
