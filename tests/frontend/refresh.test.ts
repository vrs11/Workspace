import { expect, it } from "vitest";
import { coalesceRefresh } from "../../src/shared/state/refresh";

it("drains a folder offer signalled while an empty native response is in flight", async () => {
  let release!: () => void;
  const emptyInFlight = new Promise<string>((resolve) => {
    release = () => resolve("");
  });
  const queue: string[] = [];
  const offered: string[] = [];
  let first = true;
  const drain = coalesceRefresh(async () => {
    while (true) {
      const read = first ? emptyInFlight : Promise.resolve(queue.shift() ?? "");
      first = false;
      const path = await read;
      if (!path) return;
      offered.push(path);
    }
  });
  const initial = drain();
  await Promise.resolve();
  queue.push("new folder");
  const notification = drain();
  release();
  await Promise.all([initial, notification]);
  expect(offered).toEqual(["new folder"]);
  await drain();
  expect(offered).toEqual(["new folder"]);
});

it("bounds a refresh burst and reads again after an intervening mutation", async () => {
  const releases: Array<() => void> = [];
  const snapshots: number[] = [];
  let value = 0;
  const refresh = coalesceRefresh(async () => {
    snapshots.push(value);
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  const first = refresh();
  await Promise.resolve();
  value = 1;
  const followers = Array.from({ length: 100 }, () => refresh());
  expect(snapshots).toEqual([0]);
  releases.shift()!();
  await first;
  await Promise.resolve();
  await Promise.resolve();
  expect(snapshots).toEqual([0, 1]);
  releases.shift()!();
  await Promise.all(followers);
  expect(snapshots).toEqual([0, 1]);
});

it("reports read errors and allows a queued refresh to recover", async () => {
  let reads = 0;
  const refresh = coalesceRefresh(async () => {
    if (++reads === 1) throw new Error("read failed");
  });
  const first = refresh();
  const next = refresh();
  await expect(first).rejects.toThrow("read failed");
  await next;
  expect(reads).toBe(2);
});
