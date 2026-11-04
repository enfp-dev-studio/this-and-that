import { useSyncExternalStore } from 'react';
import { engine3d } from '@/three/engine';

export const useEngine3D = () => useSyncExternalStore(engine3d.subscribe, engine3d.getSnapshot);
