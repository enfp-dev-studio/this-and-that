import { useSyncExternalStore } from 'react';
import { editor } from '@/editor/engine';

export const useEditor = () => useSyncExternalStore(editor.subscribe, editor.getSnapshot);
