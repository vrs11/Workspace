import { expect, it } from "vitest";
import type * as Monaco from "monaco-editor";
import { languageFor } from "../../src/features/editor/languages";
const monaco = {
  languages: {
    getLanguages: () => [
      { id: "kotlin", extensions: [".kt", ".kts"] },
      { id: "yaml", extensions: [".yaml", ".yml"] },
      { id: "dockerfile", filenames: ["Dockerfile"] },
      { id: "typescript", extensions: [".ts", ".tsx"] },
      { id: "toml", extensions: [".toml"] },
    ],
  },
} as unknown as typeof Monaco;
it("uses registered filenames/extensions, technologies and shebangs without forcing unknown files into code", () => {
  for (const [name, language, content] of [
    ["build.gradle.kts", "kotlin", ""],
    [".github/ci.YML", "yaml", ""],
    ["Dockerfile.dev", "dockerfile", ""],
    ["Makefile", "makefile", ""],
    ["Component.vue", "html", ""],
    ["script", "python", "#!/usr/bin/env python3"],
    ["Cargo.toml", "toml", ""],
    ["App.tsx", "typescript", ""],
    ["unknown.format", "plaintext", ""],
  ])
    expect(languageFor(monaco, name, content)).toBe(language);
});
