import { create } from 'zustand';
import type { ModelStatus } from '@/types/dto';

interface ModelStoreState {
  status: ModelStatus | null;
  setStatus: (status: ModelStatus) => void;
}

export const useModelStore = create<ModelStoreState>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
}));
