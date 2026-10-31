import { call } from "../../shared/ipc/client";
import { ask } from "../../shared/components/Dialog";

// Resolve placement before autosave, editor disposal or terminal-close decisions.
// Returning false means cancellation or a different window owns the request.
export async function chooseCurrentWindow(path: string, hasProject: boolean) {
  try {
    const result = await call(
      { type: "focusProjectWindow", path },
      "windowOpened",
    );
    if (result.existing) return false;
  } catch (error) {
    // Preserve the existing missing-folder/verified-relocation workflow.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "notFound"
    )
      return true;
    throw error;
  }
  if (!hasProject) return true;
  const target = await ask({
    title: "Open project",
    description:
      "Open this folder in a new window, or replace the project in this window?",
    choices: ["New window", "This window"],
  });
  if (target === "This window") return true;
  if (target === "New window")
    await call({ type: "newWindow", path }, "windowOpened");
  return false;
}
