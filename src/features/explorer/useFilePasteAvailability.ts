import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "../../shared/ipc/client";

/** Event-driven availability; no polling or file contents in renderer state. */
export function useFilePasteAvailability(
  enabled: boolean,
  owner: string | undefined,
) {
  const [state, setState] = useState({ owner, available: false });
  const epoch = useRef(0);
  const invalidate = useCallback(() => {
    epoch.current++;
    setState((old) => (old.available ? { ...old, available: false } : old));
  }, []);
  const refresh = useCallback(async () => {
    const ticket = ++epoch.current;
    if (!enabled || !owner || document.visibilityState === "hidden") {
      setState((old) => (old.available ? { ...old, available: false } : old));
      return false;
    }
    try {
      const result = await call(
        { type: "clipboardHasFiles" },
        "clipboardFiles",
      );
      if (ticket !== epoch.current) return false;
      setState((old) =>
        old.owner === owner && old.available === result.available
          ? old
          : { owner, available: result.available },
      );
      return result.available;
    } catch {
      if (ticket === epoch.current)
        setState((old) => (old.available ? { ...old, available: false } : old));
      return false;
    }
  }, [enabled, owner]);
  useEffect(() => {
    invalidate();
    if (!enabled) return;
    const update = () => {
      void refresh();
    };
    const changed = () => {
      invalidate();
      void refresh();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") invalidate();
      else update();
    };
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", invalidate);
    window.addEventListener("workspace-clipboard-changed", changed);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("copy", invalidate, true);
    document.addEventListener("cut", invalidate, true);
    return () => {
      epoch.current++;
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", invalidate);
      window.removeEventListener("workspace-clipboard-changed", changed);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("copy", invalidate, true);
      document.removeEventListener("cut", invalidate, true);
    };
  }, [enabled, refresh, invalidate]);
  return {
    available: enabled && state.owner === owner && state.available,
    refresh,
    invalidate,
  };
}
