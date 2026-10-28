import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronRight } from "lucide-react";
import type { FilePathKind } from "../../generated/protocol";
import { call, rpc } from "../ipc/client";
import { useApp, perform } from "../state/store";

export async function copyEntryPath(
  scope: string,
  entry: string,
  kind: FilePathKind,
) {
  if (useApp.getState().project?.id !== scope) return;
  const { text } = await call({ type: "filePath", scope, entry, kind }, "text");
  if (useApp.getState().project?.id !== scope) return;
  await rpc({ type: "clipboardWrite", text });
}

// One set of items and one copy implementation for tabs and Explorer entries.
export function FilePathMenuItems({ entry }: { entry: string | null }) {
  const scope = useApp((state) => state.project?.id);
  const trusted = useApp((state) => state.project?.trusted);
  const git = useApp((state) => state.settings?.git);
  const copy = (kind: FilePathKind) => {
    if (scope && entry) void perform(() => copyEntryPath(scope, entry, kind));
  };
  return (
    <>
      <Menu.Item disabled={!entry || !scope} onSelect={() => copy("name")}>
        Copy file name
      </Menu.Item>
      <Menu.Sub>
        <Menu.SubTrigger disabled={!entry || !scope}>
          Copy file path <ChevronRight size={12} />
        </Menu.SubTrigger>
        <Menu.Portal>
          <Menu.SubContent
            className="dock-menu file-path-menu"
            sideOffset={3}
            collisionPadding={8}
          >
            <Menu.Item onSelect={() => copy("project")}>
              From project root
            </Menu.Item>
            <Menu.Item
              disabled={!trusted || !git}
              title={
                !trusted
                  ? "Trust this folder to read its Git root"
                  : !git
                    ? "Configure Git to read its root"
                    : undefined
              }
              onSelect={() => copy("git")}
            >
              From Git root
            </Menu.Item>
            <Menu.Item onSelect={() => copy("absolute")}>
              Absolute path
            </Menu.Item>
          </Menu.SubContent>
        </Menu.Portal>
      </Menu.Sub>
    </>
  );
}
