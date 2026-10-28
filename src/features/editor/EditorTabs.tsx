import * as Menu from "@radix-ui/react-dropdown-menu";
import { useRef, useState, type MouseEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { TabIndicator } from "../../app/StatusBar";
import { useApp, perform, type Tab } from "../../shared/state/store";
import { FilePathMenuItems } from "../../shared/components/FilePathMenu";
import { tabEntry, clearEditorFileFocus } from "../../shared/fileTargets";
import {
  closeTabGroup,
  tabCloseTargets,
  type CloseTabGroup,
} from "./tabActions";

export function EditorTabs({
  tabs,
  active,
  onClose,
}: {
  tabs: Tab[];
  active: string | null;
  onClose: (id: string) => Promise<boolean>;
}) {
  const [context, setContext] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const anchor = useRef<string | null>(null);
  const pending = useRef(false);
  const [closing, setClosing] = useState(false);
  const tab = tabs.find((tab) => tab.id === context?.id);
  const open = (event: MouseEvent | KeyboardEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    anchor.current = id;
    const point =
      "clientX" in event
        ? { x: event.clientX, y: event.clientY }
        : {
            x: event.currentTarget.getBoundingClientRect().left + 12,
            y: event.currentTarget.getBoundingClientRect().bottom,
          };
    setContext({ id, ...point });
  };
  const close = (group: CloseTabGroup) => {
    if (!tab || pending.current) return;
    pending.current = true;
    setClosing(true);
    void perform(async () => {
      try {
        await closeTabGroup(tab.id, group, onClose);
      } finally {
        pending.current = false;
        setClosing(false);
      }
    });
  };
  return (
    <>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${active === tab.id ? "active" : ""}`}
          onContextMenu={(event) => open(event, tab.id)}
          onKeyDown={(event) => {
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            )
              open(event, tab.id);
          }}
        >
          <button
            role="tab"
            data-editor-tab={tab.id}
            aria-selected={active === tab.id}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => {
              clearEditorFileFocus();
              useApp.getState().set({ active: tab.id });
            }}
          >
            <TabIndicator entry={tab.id} />
            {tab.title}
          </button>
          <button
            aria-label={`Close ${tab.title}`}
            disabled={closing}
            onClick={() => void perform(() => onClose(tab.id))}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <Menu.Root
        open={!!tab}
        onOpenChange={(open) => {
          if (!open) setContext(null);
        }}
      >
        <Menu.Trigger asChild>
          <button
            className="tab-context-anchor"
            aria-label="Editor tab actions"
            tabIndex={-1}
            style={{ left: context?.x ?? 0, top: context?.y ?? 0 }}
          />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="dock-menu editor-tab-menu"
            align="start"
            sideOffset={0}
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => {
                if (
                  document.querySelector(
                    '.dialog-content[role="dialog"], [role="menu"]',
                  )
                )
                  return;
                const state = useApp.getState();
                const target = state.tabs.some(
                  (tab) => tab.id === anchor.current,
                )
                  ? anchor.current
                  : state.active;
                [...document.querySelectorAll<HTMLElement>("[data-editor-tab]")]
                  .find((button) => button.dataset.editorTab === target)
                  ?.focus({ preventScroll: true });
              });
            }}
          >
            {(
              [
                ["left", "Close all to the left"],
                ["right", "Close all to the right"],
                ["rest", "Close the rest"],
                ["close", "Close"],
              ] as const
            ).map(([group, label]) => (
              <Menu.Item
                key={group}
                disabled={
                  closing ||
                  !tab ||
                  !tabCloseTargets(tabs, tab.id, group).length
                }
                onSelect={() => close(group)}
              >
                {label}
              </Menu.Item>
            ))}
            <Menu.Separator />
            <FilePathMenuItems entry={tabEntry(tab)} />
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
}
