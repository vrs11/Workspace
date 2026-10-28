export type ImageView = { scale: number; x: number; y: number };
export type Size = { width: number; height: number };
export function fitScale(image: Size, viewport: Size) {
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(
    1,
    viewport.width / Math.max(1, image.width),
    viewport.height / Math.max(1, image.height),
  );
}
export function boundedView(
  view: ImageView,
  image: Size,
  viewport: Size,
): ImageView {
  const width = image.width * view.scale,
    height = image.height * view.scale;
  const x = Math.max(
    0,
    (width + viewport.width) / 2 - Math.min(48, width, viewport.width),
  );
  const y = Math.max(
    0,
    (height + viewport.height) / 2 - Math.min(48, height, viewport.height),
  );
  return {
    ...view,
    x: Math.max(-x, Math.min(x, view.x)),
    y: Math.max(-y, Math.min(y, view.y)),
  };
}
export function zoomAt(
  view: ImageView,
  scale: number,
  point: { x: number; y: number },
): ImageView {
  scale = Math.max(0.02, Math.min(32, scale));
  const factor = scale / view.scale;
  return {
    scale,
    x: point.x - (point.x - view.x) * factor,
    y: point.y - (point.y - view.y) * factor,
  };
}

export function imageCssSize(
  image: Size,
  density: number,
  vector: boolean,
): Size {
  const pixelsPerCssPixel =
    vector || !Number.isFinite(density) || density <= 0 ? 1 : density;
  return {
    width: image.width / pixelsPerCssPixel,
    height: image.height / pixelsPerCssPixel,
  };
}
export function imagePlacement(
  image: Size,
  viewport: Size & { left: number; top: number },
  view: ImageView,
  density: number,
  vector: boolean,
) {
  const base = imageCssSize(image, density, vector),
    width = base.width * view.scale,
    height = base.height * view.scale;
  const left = (viewport.width - width) / 2 + view.x,
    top = (viewport.height - height) / 2 + view.y;
  return {
    width,
    height,
    left: vector
      ? left
      : Math.round((viewport.left + left) * density) / density - viewport.left,
    top: vector
      ? top
      : Math.round((viewport.top + top) * density) / density - viewport.top,
  };
}
