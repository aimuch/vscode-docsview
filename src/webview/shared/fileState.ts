// File-level state pushed by the host (default editor association, history support).
import { onMessage } from "./api";

export interface FileState {
  /** Undefined when the default editor cannot be changed for this file type. */
  isDefault?: boolean;
  ext: string;
  history: boolean;
}

let state: FileState = { ext: "", history: false };
const listeners = new Set<(s: FileState) => void>();

export function getFileState(): FileState {
  return state;
}

export function onFileState(listener: (s: FileState) => void): void {
  listeners.add(listener);
}

onMessage((message) => {
  if (message.type === "fileState") {
    state = { isDefault: message.isDefault, ext: message.ext, history: message.history };
    listeners.forEach((l) => l(state));
  }
});
