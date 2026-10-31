// Reuse only byte-identical decoded license/notice text. Package-specific
// attributions stay beside each dependency; differing copyrights never merge.
export function noticeTextIndex() {
  const entries = new Map();
  return {
    reference(text) {
      let entry = entries.get(text);
      if (!entry) {
        entry = { number: entries.size + 1, text };
        entries.set(text, entry);
      }
      return `License/notice text: [${entry.number}](#license-text-${entry.number}).`;
    },
    sections() {
      if (!entries.size) return [];
      return [
        "# License and notice texts",
        "",
        "Dependencies above reference these complete upstream texts. Identical texts are included once; distinct copyright and notice text is retained separately.",
        "",
        ...[...entries.values()].flatMap(({ number, text }) => {
          // An upstream document can itself contain Markdown fences.
          const longest = Math.max(
            2,
            ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
          );
          const fence = "`".repeat(longest + 1);
          return [
            `## License text ${number}`,
            "",
            `${fence}text`,
            text,
            fence,
            "",
          ];
        }),
      ];
    },
  };
}
