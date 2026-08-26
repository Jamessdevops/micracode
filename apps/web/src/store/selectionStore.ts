import { create } from "zustand";

/**
 * A preview element the user picked to send to chat. `block` is the preformatted
 * "Selected element:" context prepended to the codegen prompt (backend-side, so
 * it never pollutes the visible transcript); `label` is the composer chip text.
 */
export interface PendingSelection {
  block: string;
  label: string;
}

interface SelectionState {
  pending: PendingSelection | null;
  setPending: (s: PendingSelection) => void;
  clear: () => void;
  /** Whether the preview's element-picker is armed. Lives here so the editor
   * top bar can toggle it while `PreviewPanel` reacts to it. */
  selectMode: boolean;
  setSelectMode: (v: boolean) => void;
  toggleSelectMode: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
  clear: () => set({ pending: null }),
  selectMode: false,
  setSelectMode: (selectMode) => set({ selectMode }),
  toggleSelectMode: () => set((s) => ({ selectMode: !s.selectMode })),
}));
