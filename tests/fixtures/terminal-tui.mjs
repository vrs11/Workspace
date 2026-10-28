// Ordinary deterministic CLI program, launched by user-visible terminal input.
import fs from "node:fs";
import process from "node:process";
const log = process.argv[2];
function record(value) {
  fs.appendFileSync(log, JSON.stringify(value) + "\n");
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write(
  "\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[HINTERACTIVE_TUI_READY 🚀\r\n",
);
record({
  ready: true,
  pid: process.pid,
  cols: process.stdout.columns,
  rows: process.stdout.rows,
});
process.stdout.on("resize", () => {
  record({
    resize: true,
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  });
  process.stdout.write(
    `\x1b[HRESIZED ${process.stdout.columns}x${process.stdout.rows}\r\n`,
  );
});
process.stdin.on("data", (data) => {
  record({ input: data.toString("hex") });
  if (data.includes(4)) {
    process.stdout.write("\x1b[?2004l\x1b[?1049l");
    process.stdin.setRawMode(false);
    process.exit(17);
  }
});
