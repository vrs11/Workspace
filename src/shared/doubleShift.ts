// Two short, unmodified taps. Using releases avoids repeats and held Shift;
// any intervening key or pointer gesture invalidates a possible double tap.
export function doubleShiftGesture() {
  let down: number | null = null;
  let released: number | null = null;
  const reset = () => {
    down = released = null;
  };
  return {
    reset,
    accept(event: KeyboardEvent): boolean {
      if (
        event.key !== "Shift" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.getModifierState("AltGraph")
      ) {
        reset();
        return false;
      }
      const now = performance.now();
      if (event.type === "keydown") {
        if (!event.repeat) {
          if (down !== null) {
            reset();
            return false;
          }
          down = now;
        }
        return false;
      }
      if (event.type !== "keyup" || down === null) return false;
      const tapped = now - down <= 450;
      down = null;
      if (!tapped) {
        reset();
        return false;
      }
      if (released !== null && now - released <= 450) {
        reset();
        return true;
      }
      released = now;
      return false;
    },
  };
}
