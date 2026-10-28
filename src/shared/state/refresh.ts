// Share bursts of read requests without dropping a refresh requested after a
// mutation. There is at most one active read and one following batch.
export function coalesceRefresh(read: () => Promise<void>) {
  let active: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  function run() {
    const result = Promise.resolve().then(read);
    active = result;
    void result
      .finally(() => {
        if (active === result) active = null;
      })
      .catch(() => {});
    return result;
  }
  return () => {
    if (!active) return run();
    if (!queued) {
      queued = active
        .catch(() => {})
        .then(() => {
          queued = null;
          return run();
        });
    }
    return queued;
  };
}
