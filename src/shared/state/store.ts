import { errorText, errorDetails, type ErrorDetails } from "../errors";
import { create } from "zustand";
import type {
  Project,
  Settings,
  Document,
  Diff,
  GitConflict,
  Media,
} from "../../generated/protocol";
export type DocMeta = Omit<Document, "text" | "recovery"> & {
  language?: string;
  dirty: boolean;
  recovering: boolean;
  acknowledged: number;
  conflict: boolean;
  recoveryError: string | null;
  saveError: string | null;
};
export type Tab =
  | {
      id: string;
      kind: "media";
      instance: string;
      entry: string;
      title: string;
      media: Media;
    }
  | { id: string; kind: "editor"; entry: string; title: string }
  | { id: string; kind: "diff"; diff: Diff; title: string; staged: boolean }
  | { id: string; kind: "conflict"; diff: Diff; title: string }
  | { id: string; kind: "gitConflict"; conflict: GitConflict; title: string };
interface State {
  project: Project | null;
  settings: Settings | null;
  docs: Record<string, DocMeta>;
  tabs: Tab[];
  active: string | null;
  split: string | null;
  bottom: "changes" | "history" | "terminal" | "search" | "output";
  toolRequest: number;
  explorerExpanded: string[];
  gitHistory: boolean;
  navigate: { entry: string; line: number } | null;
  notice: string;
  noticeDetails: ErrorDetails | null;
  busy: number;
  cursor: string;
  set: (patch: Partial<Omit<State, "set" | "doc">>) => void;
  doc: (id: string, patch: Partial<DocMeta>) => void;
}
export const useApp = create<State>((set) => ({
  project: null,
  settings: null,
  docs: {},
  tabs: [],
  active: null,
  split: null,
  bottom: "changes",
  toolRequest: 0,
  explorerExpanded: [],
  gitHistory: false,
  navigate: null,
  notice: "",
  noticeDetails: null,
  busy: 0,
  cursor: "",
  set: (patch) =>
    set((state) => ({
      ...patch,
      ...(patch.notice !== undefined
        ? { noticeDetails: patch.noticeDetails ?? null }
        : {}),
      ...(patch.bottom !== undefined
        ? { toolRequest: state.toolRequest + 1 }
        : {}),
    })),
  doc: (id, patch) =>
    set((state) => ({
      docs: { ...state.docs, [id]: { ...state.docs[id], ...patch } },
    })),
}));
export function notice(message: string, details: ErrorDetails | null = null) {
  useApp.getState().set({ notice: message, noticeDetails: details });
}
export function reportError(
  error: unknown,
  context: { prefix?: string; suffix?: string } = {},
) {
  notice(
    (context.prefix ?? "") + errorText(error) + (context.suffix ?? ""),
    errorDetails(error),
  );
}
export async function perform(work: () => Promise<unknown>) {
  useApp.setState((state) => ({ busy: state.busy + 1 }));
  try {
    await work();
  } catch (error) {
    reportError(error);
  } finally {
    useApp.setState((state) => ({ busy: Math.max(0, state.busy - 1) }));
  }
}
