// Lazily mounted editors/terminals register readers without making the shell
// import either renderer. Read only on an explicit quick-open request.
const readers = new Set<() => string | null>();
export function registerSelectionReader(read: () => string | null) {
  readers.add(read);
  return () => {
    readers.delete(read);
  };
}
export function selectedFileQuery() {
  const active = document.activeElement;
  let text = "";
  if (
    (active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement) &&
    !active.closest(".monaco-editor, .terminal-emulator")
  ) {
    if (active instanceof HTMLInputElement && active.type === "password")
      return "";
    text = active.value.slice(
      active.selectionStart ?? 0,
      active.selectionEnd ?? 0,
    );
  } else {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) text = selection.toString();
    else
      for (const read of readers) {
        const value = read();
        if (value !== null) {
          text = value;
          break;
        }
      }
  }
  // File-name search accepts at most 1000 UTF-8 bytes. A multiline selection
  // starts with its first line; never split a Unicode character at the bound.
  let query = "",
    bytes = 0;
  const encoder = new TextEncoder();
  for (const character of text.trim()) {
    if (character === "\n" || character === "\r") break;
    bytes += encoder.encode(character).length;
    if (bytes > 1000) break;
    query += character;
  }
  return query;
}
