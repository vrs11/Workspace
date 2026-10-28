import { expect, it } from "vitest";
import {
  fitScale,
  zoomAt,
  boundedView,
  imageCssSize,
  imagePlacement,
} from "../../src/features/media/imageViewport";
it("anchors the image point under the pointer through wheel zoom in and out", () => {
  const view = { scale: 0.5, x: 24, y: -13 },
    point = { x: 95, y: 38 };
  const imagePoint = {
    x: (point.x - view.x) / view.scale,
    y: (point.y - view.y) / view.scale,
  };
  const zoomed = zoomAt(view, 1.6, point);
  expect((point.x - zoomed.x) / zoomed.scale).toBeCloseTo(imagePoint.x);
  expect((point.y - zoomed.y) / zoomed.scale).toBeCloseTo(imagePoint.y);
  const restored = zoomAt(zoomed, 0.5, point);
  expect(restored.x).toBeCloseTo(view.x, 10);
  expect(restored.y).toBeCloseTo(view.y, 10);
});
it("fits images on resize and keeps a visible grab target at zoom bounds", () => {
  expect(
    fitScale({ width: 2400, height: 1600 }, { width: 600, height: 600 }),
  ).toBe(0.25);
  expect(fitScale({ width: 8, height: 6 }, { width: 600, height: 600 })).toBe(
    1,
  );
  expect(zoomAt({ scale: 1, x: 0, y: 0 }, 100, { x: 0, y: 0 }).scale).toBe(32);
  expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.001, { x: 0, y: 0 }).scale).toBe(
    0.02,
  );
  const bounded = boundedView(
    { scale: 2, x: 10000, y: -10000 },
    { width: 80, height: 60 },
    { width: 500, height: 300 },
  );
  expect(bounded).toEqual({ scale: 2, x: 282, y: -162 });
});

it("maps raster actual size to physical pixels at standard, Retina and fractional display densities", () => {
  for (const density of [0.75, 1, 1.25, 1.5, 2, 3]) {
    const size = imageCssSize({ width: 1024, height: 768 }, density, false);
    expect(size.width * density).toBeCloseTo(1024, 10);
    expect(size.height * density).toBeCloseTo(768, 10);
    expect(fitScale(size, { width: 3000, height: 2000 })).toBe(1);
  }
  expect(imageCssSize({ width: 80, height: 60 }, 2, true)).toEqual({
    width: 80,
    height: 60,
  });
});
it("aligns raster origins to display pixels without scaling a low-resolution compositor layer", () => {
  for (const density of [1, 1.25, 2, 3])
    for (const scale of [1, 4]) {
      const area = {
        width: 703.125,
        height: 487.5,
        left: 301.328125,
        top: 110.25,
      };
      const rendered = imagePlacement(
        { width: 256, height: 160 },
        area,
        { scale, x: 12.37, y: -8.12 },
        density,
        false,
      );
      expect(rendered.width * density).toBeCloseTo(256 * scale, 9);
      expect((area.left + rendered.left) * density).toBeCloseTo(
        Math.round((area.left + rendered.left) * density),
        9,
      );
      expect((area.top + rendered.top) * density).toBeCloseTo(
        Math.round((area.top + rendered.top) * density),
        9,
      );
    }
});
it("keeps vector layout resolution and a valid fit scale while a panel is hidden", () => {
  expect(
    imagePlacement(
      { width: 80, height: 60 },
      { width: 301, height: 201, left: 0, top: 0 },
      { scale: 4, x: 0, y: 0 },
      2,
      true,
    ),
  ).toEqual({ width: 320, height: 240, left: -9.5, top: -19.5 });
  expect(fitScale({ width: 1200, height: 800 }, { width: 0, height: 0 })).toBe(
    1,
  );
});
