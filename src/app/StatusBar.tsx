import { lazy, Suspense } from "react";
import { useApp } from "../shared/state/store";
const LanguageMode = lazy(() => import("../features/editor/LanguageMode"));
function Cursor() {
  const position = useApp((s) => s.cursor);
  return <span>{position}</span>;
}
function Recovery() {
  const document = useApp((s) => s.docs[s.active ?? ""]);
  return (
    <span>
      {document?.dirty
        ? `Unsaved · recovery ${document.acknowledged}/${document.revision}`
        : ""}
    </span>
  );
}
export function TabIndicator({ entry }: { entry: string }) {
  const indicator = useApp((s) =>
    s.docs[entry]?.recoveryError || s.docs[entry]?.saveError
      ? "⚠ "
      : s.docs[entry]?.dirty
        ? "● "
        : "",
  );
  return <>{indicator}</>;
}
export default function StatusBar() {
  const project = useApp((s) => s.project),
    busy = useApp((s) => s.busy);
  const recoveryError = useApp((s) =>
    Object.values(s.docs).some((d) => d.recoveryError),
  );
  const entry = useApp((s) => s.docs[s.active ?? ""]?.id),
    encoding = useApp((s) => s.docs[s.active ?? ""]?.encoding),
    eol = useApp((s) => s.docs[s.active ?? ""]?.eol);
  return (
    <footer className="status-bar">
      <span>
        {project?.name ?? "No project"}
        {project && (project.trusted ? " · Trusted" : " · Restricted")}
      </span>
      <span>
        {recoveryError
          ? "Recovery needs attention"
          : busy
            ? "Working…"
            : "Ready"}
      </span>
      <div className="header-spacer" />
      {entry && (
        <Suspense fallback={null}>
          <LanguageMode entry={entry} />
        </Suspense>
      )}
      <span>
        {encoding} {eol}
      </span>
      <Recovery />
      <Cursor />
    </footer>
  );
}
