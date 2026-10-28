import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useRef,
  useState,
  useId,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
export function VirtualList<T>({
  items,
  render,
  onSelect,
  onContextMenu,
  label,
  selected,
  tree,
  id,
  activeIndex,
  onActiveIndexChange,
  fitContent = false,
  onVisibleItemsChange,
  revealIndex,
  onRevealComplete,
}: {
  items: T[];
  render: (item: T, index: number) => ReactNode;
  onSelect: (item: T) => void;
  onContextMenu?: (item: T, point: { x: number; y: number }) => void;
  label: string;
  selected?: (item: T) => boolean;
  id?: string;
  activeIndex?: number;
  onActiveIndexChange?: (index: number) => void;
  fitContent?: boolean;
  onVisibleItemsChange?: (items: T[]) => void;
  revealIndex?: number;
  onRevealComplete?: () => void;
  tree?: {
    level: (item: T) => number;
    expanded: (item: T) => boolean | undefined;
    expand: (item: T) => void;
    collapse: (item: T) => void;
    parent: (index: number) => number;
    focus?: (item: T) => void;
  };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [internalFocus, setInternalFocus] = useState(0);
  const focus = activeIndex ?? internalFocus;
  const setFocus = onActiveIndexChange ?? setInternalFocus;
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const focusIndex = Math.min(focus, Math.max(0, items.length - 1));
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 30,
    overscan: 8,
  });
  const virtualItems = virtual.getVirtualItems();
  const offset = virtual.scrollOffset ?? 0;
  const height = virtual.scrollRect?.height ?? 0;
  const visibleItems = useMemo(
    () =>
      onVisibleItemsChange
        ? virtualItems
            .filter((row) => row.end > offset && row.start < offset + height)
            .filter((row) => row.index < items.length)
            .map((row) => items[row.index])
        : null,
    [virtualItems, items, offset, height, onVisibleItemsChange],
  );
  useEffect(() => {
    if (visibleItems) onVisibleItemsChange?.(visibleItems);
  }, [visibleItems, onVisibleItemsChange]);
  useEffect(() => {
    if (activeIndex !== undefined && items.length)
      virtual.scrollToIndex(focusIndex);
  }, [activeIndex, focusIndex, items.length, virtual]);
  useEffect(() => {
    if (
      revealIndex === undefined ||
      revealIndex < 0 ||
      revealIndex >= items.length
    )
      return;
    virtual.scrollToIndex(revealIndex, { align: "center" });
    setFocus(revealIndex);
    ref.current?.focus({ preventScroll: true });
    onRevealComplete?.();
  }, [revealIndex, items.length, virtual, setFocus, onRevealComplete]);
  return (
    <div
      ref={ref}
      id={baseId}
      style={
        fitContent
          ? {
              flex: "0 1 auto",
              height: Math.max(1, Math.min(items.length, 12)) * 30,
              maxHeight: "45vh",
            }
          : undefined
      }
      className="virtual-list"
      role={tree ? "tree" : "listbox"}
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={
        items.length ? `${baseId}-${focusIndex}` : undefined
      }
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const move = (next: number) => {
          if (!items.length) return;
          next = Math.max(0, Math.min(items.length - 1, next));
          setFocus(next);
          virtual.scrollToIndex(next);
          if (tree) tree.focus?.(items[next]);
        };
        if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          move(e.key === "Home" ? 0 : items.length - 1);
          return;
        }
        const item = items[focusIndex];
        if (
          onContextMenu &&
          item &&
          (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
        ) {
          e.preventDefault();
          const row =
            document
              .getElementById(`${baseId}-${focusIndex}`)
              ?.getBoundingClientRect() ??
            e.currentTarget.getBoundingClientRect();
          onContextMenu(item, { x: row.left + 16, y: row.bottom });
          return;
        }
        if (tree && item && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          const expanded = tree.expanded(item);
          if (e.key === "ArrowRight") {
            if (expanded === false) tree.expand(item);
            else if (
              expanded === true &&
              items[focusIndex + 1] &&
              tree.level(items[focusIndex + 1]) > tree.level(item)
            )
              move(focusIndex + 1);
          } else if (expanded === true) tree.collapse(item);
          else move(tree.parent(focusIndex));
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = Math.max(
            0,
            Math.min(
              items.length - 1,
              focusIndex + (e.key === "ArrowDown" ? 1 : -1),
            ),
          );
          move(next);
        }
        if ((e.key === "Enter" || e.key === " ") && items[focusIndex]) {
          e.preventDefault();
          onSelect(items[focusIndex]);
        }
      }}
    >
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            role={tree ? "treeitem" : "option"}
            aria-level={tree?.level(items[row.index])}
            aria-expanded={tree?.expanded(items[row.index])}
            aria-selected={selected?.(items[row.index]) ?? false}
            id={`${baseId}-${row.index}`}
            key={row.key}
            className={`list-row ${row.index === focusIndex ? "focused-row" : ""}`}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: row.size,
              transform: `translateY(${row.start}px)`,
            }}
            onContextMenu={
              onContextMenu
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setFocus(row.index);
                    onContextMenu(items[row.index], {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }
                : undefined
            }
            onClick={() => {
              setFocus(row.index);
              ref.current?.focus();
              onSelect(items[row.index]);
            }}
          >
            {render(items[row.index], row.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
