import { create } from "zustand";

interface UiState {
  isPanelOpen: boolean;
  togglePanel: () => void;
  setIsPanelOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  isPanelOpen: true,
  togglePanel: () => set((s) => ({ isPanelOpen: !s.isPanelOpen })),
  setIsPanelOpen: (open) => set({ isPanelOpen: open }),
}));
