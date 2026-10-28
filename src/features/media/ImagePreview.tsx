import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  boundedView,
  imageCssSize,
  imagePlacement,
  fitScale,
  zoomAt,
  type ImageView,
  type Size,
} from "./imageViewport";

export default function ImagePreview({
  src,
  name,
  zoom,
  onZoom,
  onLoad,
  onError,
  vector,
  rendering,
}: {
  vector: boolean;
  rendering: "pixels" | "smooth";
  src: string;
  name: string;
  zoom: string;
  onZoom: (zoom: string) => void;
  onLoad: (size: Size) => void;
  onError: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<Size>({ width: 0, height: 0 });
  const area = useRef({ width: 0, height: 0, left: 0, top: 0 });
  const density = useRef(window.devicePixelRatio || 1);
  const vectorRef = useRef(vector);
  vectorRef.current = vector;
  const view = useRef<ImageView>({ scale: 1, x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const callbacks = useRef({ onZoom, onLoad, onError });
  callbacks.current = { onZoom, onLoad, onError };
  const cancelDrag = useRef<(() => void) | undefined>(undefined);
  const [geometry, setGeometry] = useState({
    view: view.current,
    image: image.current,
    area: area.current,
    density: density.current,
  });
  const [dragging, setDragging] = useState(false);
  const apply = useCallback((next: ImageView) => {
    view.current = boundedView(
      next,
      imageCssSize(image.current, density.current, vectorRef.current),
      area.current,
    );
    setGeometry({
      view: view.current,
      image: image.current,
      area: area.current,
      density: density.current,
    });
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const resize = () => {
      const box = element.getBoundingClientRect();
      area.current = {
        width: box.width,
        height: box.height,
        left: box.left,
        top: box.top,
      };
      density.current = window.devicePixelRatio || 1;
      if (image.current.width)
        apply(
          zoomRef.current === "fit"
            ? {
                scale: fitScale(
                  imageCssSize(
                    image.current,
                    density.current,
                    vectorRef.current,
                  ),
                  area.current,
                ),
                x: 0,
                y: 0,
              }
            : view.current,
        );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const wheel = (event: WheelEvent) => {
      if (!image.current.width || !Number.isFinite(event.deltaY)) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1);
      const next = zoomAt(
        view.current,
        view.current.scale *
          Math.exp(-Math.max(-400, Math.min(400, delta)) * 0.002),
        {
          x: event.clientX - box.left - box.width / 2,
          y: event.clientY - box.top - box.height / 2,
        },
      );
      apply(next);
      callbacks.current.onZoom(String(next.scale));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    let query: MediaQueryList;
    const watchDensity = () => {
      query?.removeEventListener("change", watchDensity);
      resize();
      query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener("change", watchDensity);
    };
    watchDensity();
    window.addEventListener("resize", resize);
    return () => {
      query.removeEventListener("change", watchDensity);
      window.removeEventListener("resize", resize);
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
      cancelDrag.current?.();
    };
  }, [apply]);
  useEffect(() => {
    if (!image.current.width) return;
    if (zoom === "fit")
      apply({
        scale: fitScale(
          imageCssSize(image.current, density.current, vectorRef.current),
          area.current,
        ),
        x: 0,
        y: 0,
      });
    else if (
      Number.isFinite(Number(zoom)) &&
      Number(zoom) > 0 &&
      Math.abs(Number(zoom) - view.current.scale) > 0.00001
    )
      apply(zoomAt(view.current, Number(zoom), { x: 0, y: 0 }));
  }, [zoom, apply]);
  // Reparented dock hosts can move without resizing. Re-read their origin so
  // device-pixel alignment stays correct after a move as well as a resize.
  useLayoutEffect(() => {
    const box = viewport.current!.getBoundingClientRect();
    if (box.left !== area.current.left || box.top !== area.current.top) {
      area.current = {
        width: box.width,
        height: box.height,
        left: box.left,
        top: box.top,
      };
      apply(view.current);
    }
  });
  const placement = imagePlacement(
    geometry.image,
    geometry.area,
    geometry.view,
    geometry.density,
    vector,
  );
  return (
    <div
      ref={viewport}
      className={`image-viewport ${dragging ? "panning" : ""}`}
      aria-label="Image viewport"
      data-image-scale={geometry.view.scale}
      data-image-x={geometry.view.x}
      data-image-y={geometry.view.y}
      data-image-density={geometry.density}
    >
      <img
        src={src}
        alt={name}
        draggable={false}
        onError={() => callbacks.current.onError()}
        style={{
          ...placement,
          imageRendering:
            !vector && rendering === "pixels" && geometry.view.scale >= 1
              ? "pixelated"
              : "auto",
        }}
        onLoad={(event) => {
          image.current = {
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          };
          callbacks.current.onLoad(image.current);
          apply({
            scale:
              zoomRef.current === "fit"
                ? fitScale(
                    imageCssSize(
                      image.current,
                      density.current,
                      vectorRef.current,
                    ),
                    area.current,
                  )
                : Number(zoomRef.current),
            x: 0,
            y: 0,
          });
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          cancelDrag.current?.();
          const element = event.currentTarget,
            id = event.pointerId,
            start = { x: event.clientX, y: event.clientY },
            original = view.current;
          setDragging(true);
          callbacks.current.onZoom(String(original.scale));
          const finish = () => {
            setDragging(false);
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", up, true);
            window.removeEventListener("pointercancel", up, true);
            window.removeEventListener("lostpointercapture", up, true);
            window.removeEventListener("blur", finish);
            window.removeEventListener("pagehide", finish);
            window.removeEventListener("keydown", key, true);
            cancelDrag.current = undefined;
            if (element.hasPointerCapture?.(id))
              element.releasePointerCapture(id);
          };
          const move = (event: PointerEvent) => {
            if (event.pointerId !== id) return;
            if (event.buttons === 0) {
              finish();
              return;
            }
            event.preventDefault();
            apply({
              ...original,
              x: original.x + event.clientX - start.x,
              y: original.y + event.clientY - start.y,
            });
          };
          const up = (event: PointerEvent) => {
            if (event.pointerId === id) finish();
          };
          const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") finish();
          };
          cancelDrag.current = finish;
          window.addEventListener("pointermove", move, true);
          window.addEventListener("pointerup", up, true);
          window.addEventListener("pointercancel", up, true);
          window.addEventListener("lostpointercapture", up, true);
          window.addEventListener("blur", finish);
          window.addEventListener("pagehide", finish);
          window.addEventListener("keydown", key, true);
          try {
            element.setPointerCapture(id);
          } catch (error) {
            if (!(error instanceof DOMException)) {
              finish();
              throw error;
            }
          }
        }}
      />
    </div>
  );
}
