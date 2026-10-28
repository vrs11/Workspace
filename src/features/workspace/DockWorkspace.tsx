import {
  useCallback,
  useLayoutEffect,
  useState,
  useRef,
  createContext,
  useContext,
  type ReactNode,
  type PointerEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { Group, Panel, useGroupRef } from "react-resizable-panels";
import {
  ResizeSeparator,
  resizeTargetMinimumSize,
} from "../../shared/components/ResizeSeparator";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { GripVertical, Ellipsis, X, PanelsTopLeft, Check } from "lucide-react";
import type { DockLayout, DockNode, DockPanel } from "../../generated/protocol";
import {
  isPanelVisible,
  hidePanel,
  showPanel,
  visibleDockRoot,
  dockKey,
  movePanel,
  panelIds,
  panelTitles,
  resizeDock,
  type DockSide,
} from "./dockModel";
import { beginPanelDrag, type PanelDrop } from "./panelDrag";

const sides: DockSide[] = ["left", "right", "top", "bottom"];
const Visibility = createContext(true);
export const useDockVisible = () => useContext(Visibility);
const HeaderHost = createContext<HTMLDivElement | null>(null);
export function DockHeader({ children }: { children: ReactNode }) {
  const host = useContext(HeaderHost);
  return host ? createPortal(children, host) : children;
}
type Props = {
  layout: DockLayout;
  onChange: Dispatch<SetStateAction<DockLayout>>;
  panels: Record<DockPanel, ReactNode>;
};
type Context = Props & {
  hosts: Record<DockPanel, HTMLDivElement>;
  headers: Record<DockPanel, HTMLDivElement>;
  dragging: DockPanel | null;
  hovered: PanelDrop | null;
  startDrag: (panel: DockPanel, event: PointerEvent<HTMLElement>) => void;
};
function DropTarget({
  context,
  target,
  side,
}: {
  context: Context;
  target: DockPanel | "workspace";
  side: DockSide;
}) {
  const over =
    context.hovered?.target === target && context.hovered.side === side;
  return (
    <div
      className={`dock-drop ${side} ${over ? "over" : ""}`}
      data-dock-target={target}
      data-dock-side={side}
    >
      <span>{side}</span>
    </div>
  );
}
function MoveMenu({ panel, context }: { panel: DockPanel; context: Context }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          aria-label={`Move ${panelTitles[panel]} panel`}
          title="Move or hide panel"
        >
          <Ellipsis size={15} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="dock-menu" sideOffset={4}>
          <Menu.Label>Dock {panelTitles[panel]}</Menu.Label>
          {sides.map((side) => (
            <Menu.Item
              key={side}
              onSelect={() =>
                context.onChange((old) =>
                  movePanel(old, panel, "workspace", side),
                )
              }
            >
              Dock {side}
            </Menu.Item>
          ))}
          <Menu.Separator />
          {panelIds
            .filter(
              (target) =>
                target !== panel && isPanelVisible(context.layout, target),
            )
            .map((target) => (
              <Menu.Sub key={target}>
                <Menu.SubTrigger>
                  Beside {panelTitles[target]} <span>›</span>
                </Menu.SubTrigger>
                <Menu.Portal>
                  <Menu.SubContent className="dock-menu" sideOffset={3}>
                    {sides.map((side) => (
                      <Menu.Item
                        key={side}
                        onSelect={() =>
                          context.onChange((old) =>
                            movePanel(old, panel, target, side),
                          )
                        }
                      >
                        {side[0].toUpperCase() + side.slice(1)}
                      </Menu.Item>
                    ))}
                  </Menu.SubContent>
                </Menu.Portal>
              </Menu.Sub>
            ))}
          <Menu.Separator />
          <Menu.Item
            onSelect={() => context.onChange((old) => hidePanel(old, panel))}
          >
            Hide panel
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
function Leaf({ panel, context }: { panel: DockPanel; context: Context }) {
  const attachHeader = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) element.appendChild(context.headers[panel]);
    },
    [context.headers, panel],
  );
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) element.appendChild(context.hosts[panel]);
    },
    [context.hosts, panel],
  );
  return (
    <section
      className="dock-pane"
      data-dock-panel={panel}
      aria-label={`${panelTitles[panel]} panel`}
    >
      <header className="dock-header">
        <button
          className="dock-grip"
          draggable={false}
          aria-label={`Drag ${panelTitles[panel]} panel`}
          title="Drag to dock this panel on any side"
          onPointerDown={(event) => context.startDrag(panel, event)}
        >
          <GripVertical size={13} />
          <span>{panelTitles[panel]}</span>
        </button>
        <div className="dock-header-slot" ref={attachHeader} />
        <MoveMenu panel={panel} context={context} />
        <button
          aria-label={`Hide ${panelTitles[panel]} panel`}
          title="Hide panel"
          onClick={() => context.onChange((old) => hidePanel(old, panel))}
        >
          <X size={13} />
        </button>
      </header>
      <div className="dock-slot" ref={attach} />
      {context.dragging && context.dragging !== panel && (
        <div className="dock-drop-grid">
          {sides.map((side) => (
            <DropTarget
              key={side}
              target={panel}
              side={side}
              context={context}
            />
          ))}
        </div>
      )}
    </section>
  );
}
function Branch({ node, context }: { node: DockNode; context: Context }) {
  const group = useGroupRef();
  const applying = useRef(false);
  const topology = dockKey(node);
  const latest = useRef(topology);
  latest.current = topology;
  const ratio = node.type === "split" ? node.ratio : null;
  const first = node.type === "split" ? `${node.id}-first` : "",
    second = node.type === "split" ? `${node.id}-second` : "";
  useLayoutEffect(() => {
    if (ratio === null) return;
    const current = group.current?.getLayout();
    if (current && Math.abs(current[first] - ratio * 100) > 0.15) {
      applying.current = true;
      group.current?.setLayout({
        [first]: ratio * 100,
        [second]: (1 - ratio) * 100,
      });
      applying.current = false;
    }
  }, [ratio, first, second, group]);
  if (node.type === "panel")
    return <Leaf panel={node.panel} context={context} />;
  return (
    <Group
      id={node.id}
      disableCursor
      resizeTargetMinimumSize={resizeTargetMinimumSize}
      groupRef={group}
      orientation={node.direction}
      defaultLayout={{
        [first]: node.ratio * 100,
        [second]: (1 - node.ratio) * 100,
      }}
      onLayoutChanged={(sizes) => {
        if (applying.current || latest.current !== topology) return;
        context.onChange((old) => {
          const visible = visibleDockRoot(old);
          const find = (n: DockNode | null): DockNode | null =>
            !n
              ? null
              : n.type === "panel"
                ? null
                : n.id === node.id
                  ? n
                  : (find(n.first) ?? find(n.second));
          const current = find(visible);
          return current && dockKey(current) === topology
            ? resizeDock(old, node.id, sizes[first] / 100)
            : old;
        });
      }}
    >
      <Panel id={first} minSize="5%">
        <Branch key={dockKey(node.first)} node={node.first} context={context} />
      </Panel>
      <ResizeSeparator
        className={`separator ${node.direction === "vertical" ? "horizontal" : ""}`}
      />
      <Panel id={second} minSize="5%">
        <Branch
          key={dockKey(node.second)}
          node={node.second}
          context={context}
        />
      </Panel>
    </Group>
  );
}
export function DockLayoutMenu({
  layout,
  onChange,
  onReset,
  secondary,
}: {
  layout: DockLayout;
  onChange: Dispatch<SetStateAction<DockLayout>>;
  onReset: () => void;
  secondary: boolean;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          aria-label="Workspace layout"
          title="Show, move or reset workspace panels"
        >
          <PanelsTopLeft size={18} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="dock-menu" sideOffset={4}>
          <Menu.Label>Workspace panels</Menu.Label>
          {panelIds.map((panel) => (
            <Menu.CheckboxItem
              key={panel}
              checked={isPanelVisible(layout, panel)}
              disabled={panel === "editorSecondary" && !secondary}
              onCheckedChange={(checked) =>
                onChange((old) =>
                  checked ? showPanel(old, panel) : hidePanel(old, panel),
                )
              }
            >
              <Menu.ItemIndicator>
                <Check size={12} />
              </Menu.ItemIndicator>
              {panelTitles[panel]}
            </Menu.CheckboxItem>
          ))}
          <Menu.Separator />
          <Menu.Item onSelect={onReset}>Reset panel positions</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
export default function DockWorkspace(props: Props) {
  const alive = useRef(true);
  const cancelDrag = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelDrag.current?.();
    };
  }, []);
  const [hosts] = useState(
    () =>
      Object.fromEntries(
        panelIds.map((panel) => {
          const host = document.createElement("div");
          host.className = "dock-pane-body";
          return [panel, host];
        }),
      ) as Record<DockPanel, HTMLDivElement>,
  );
  const [dragging, setDragging] = useState<DockPanel | null>(null);
  const [hovered, setHovered] = useState<PanelDrop | null>(null);
  const [headers] = useState(
    () =>
      Object.fromEntries(
        panelIds.map((panel) => {
          const host = document.createElement("div");
          host.className = "dock-header-content";
          return [panel, host];
        }),
      ) as Record<DockPanel, HTMLDivElement>,
  );
  const change: Props["onChange"] = (update) => {
    if (alive.current) props.onChange(update);
  };
  const context: Context = {
    ...props,
    onChange: change,
    hosts,
    headers,
    dragging,
    hovered,
    startDrag: (panel, event) => {
      if (event.button !== 0 || !event.isPrimary || event.defaultPrevented)
        return;
      cancelDrag.current?.();
      const workspace = event.currentTarget.closest(".dock-workspace")!;
      cancelDrag.current = beginPanelDrag(
        event.currentTarget,
        event.nativeEvent,
        panel,
        {
          start: () => setDragging(panel),
          hover: setHovered,
          finish: (drop) => {
            cancelDrag.current = undefined;
            if (!alive.current) return;
            setDragging(null);
            setHovered(null);
            if (!drop) return;
            change((old) => movePanel(old, panel, drop.target, drop.side));
            requestAnimationFrame(() => {
              if (workspace.isConnected)
                workspace
                  .querySelector<HTMLButtonElement>(
                    `[data-dock-panel="${panel}"] .dock-grip`,
                  )
                  ?.focus();
            });
          },
        },
      );
    },
  };
  const visible = visibleDockRoot(props.layout);
  // A hidden restored terminal must still reattach/drain owned PTYs. All
  // panes keep their instances once activated; no live session is evicted.
  const activated = useRef(new Set<DockPanel>(["terminal"]));
  for (const panel of panelIds)
    if (isPanelVisible(props.layout, panel)) activated.current.add(panel);
  // Portal targets are permanent. Reparenting their DOM hosts preserves Monaco
  // and xterm instances when a dock branch changes; no PTY is re-created.
  return (
    <div
      className={`dock-workspace ${dragging ? "is-dragging" : ""}`}
      data-layout={JSON.stringify(props.layout)}
    >
      {visible ? (
        <Branch key={dockKey(visible)} node={visible} context={context} />
      ) : (
        <div className="empty">
          All panels are hidden. Use Workspace layout to show a panel.
        </div>
      )}
      {panelIds.map(
        (panel) =>
          activated.current.has(panel) &&
          createPortal(
            <Visibility.Provider value={isPanelVisible(props.layout, panel)}>
              <HeaderHost.Provider value={headers[panel]}>
                {props.panels[panel]}
              </HeaderHost.Provider>
            </Visibility.Provider>,
            hosts[panel],
            panel,
          ),
      )}
      {dragging && (
        <div className="dock-workspace-targets">
          {sides.map((side) => (
            <DropTarget
              key={side}
              target="workspace"
              side={side}
              context={context}
            />
          ))}
        </div>
      )}
    </div>
  );
}
