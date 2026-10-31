import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, SlidersHorizontal } from "lucide-react";
import { useRef } from "react";
import { useApp, reportError } from "../../shared/state/store";
import { setBlame, useDocumentViews } from "./documentViewState";
import { setEditorOption } from "./viewOptions";
import { rememberEditorFile } from "../../shared/fileTargets";

function EditorViewMenuItems({ entry }: { entry?: string }) {
  const wrap = useApp((s) => !!s.settings?.editorSoftWrap);
  const numbers = useApp((s) => s.settings?.editorLineNumbers !== false);
  const canBlame = useApp(
    (s) =>
      !!entry &&
      !!s.project?.trusted &&
      !!s.settings?.git &&
      !!s.docs[entry] &&
      !/^(?:[/\\]|[A-Za-z]:)/.test(s.docs[entry].path),
  );
  const blame = useDocumentViews((s) => !!entry && !!s.blame[entry]);
  return (
    <>
      <Menu.CheckboxItem
        checked={wrap}
        onCheckedChange={(value) =>
          void setEditorOption("softWrap", value === true).catch(reportError)
        }
      >
        Soft wrap{" "}
        <Menu.ItemIndicator>
          <Check size={13} />
        </Menu.ItemIndicator>
      </Menu.CheckboxItem>
      <Menu.CheckboxItem
        checked={numbers}
        onCheckedChange={(value) =>
          void setEditorOption("lineNumbers", value === true).catch(reportError)
        }
      >
        Show line numbers{" "}
        <Menu.ItemIndicator>
          <Check size={13} />
        </Menu.ItemIndicator>
      </Menu.CheckboxItem>
      <Menu.Separator />
      <Menu.CheckboxItem
        disabled={!canBlame && !blame}
        checked={blame}
        onCheckedChange={(value) => {
          if (entry) setBlame(entry, value === true);
        }}
      >
        Git blame{" "}
        <Menu.ItemIndicator>
          <Check size={13} />
        </Menu.ItemIndicator>
      </Menu.CheckboxItem>
    </>
  );
}
export function EditorViewMenu({ entry }: { entry?: string }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          aria-label="Editor view options"
          title="Editor view options"
          onFocus={() => {
            if (entry) rememberEditorFile(entry);
          }}
        >
          <SlidersHorizontal size={15} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="dock-menu" align="end" sideOffset={4}>
          <Menu.Label>Editor view</Menu.Label>
          <EditorViewMenuItems entry={entry} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function GutterContextMenu({
  entry,
  point,
  onClose,
  onFocus,
}: {
  entry?: string;
  point: { x: number; y: number } | null;
  onClose: () => void;
  onFocus: () => void;
}) {
  const focus = useRef(onFocus);
  focus.current = onFocus;
  const numbers = useApp((s) => s.settings?.editorLineNumbers !== false);
  return (
    <Menu.Root
      open={!!point && numbers}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Trigger asChild>
        <button
          className="tab-context-anchor"
          aria-label="Line number actions"
          tabIndex={-1}
          style={{ left: point?.x ?? 0, top: point?.y ?? 0 }}
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="dock-menu"
          align="start"
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focus.current();
          }}
        >
          <EditorViewMenuItems entry={entry} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
