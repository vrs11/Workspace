import type * as Monaco from "monaco-editor";

export function registerLanguages(monaco: typeof Monaco) {
  // Monaco bundles the common web, systems, JVM, scripting and config grammars.
  // TOML needs its own grammar: treating it as INI loses arrays/types/strings.
  monaco.languages.register({
    id: "toml",
    extensions: [".toml"],
    aliases: ["TOML"],
  });
  monaco.languages.setMonarchTokensProvider("toml", {
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/"""/, "string", "@multiline"],
        [/'''/, "string", "@literalMultiline"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'[^']*'/, "string"],
        [/\[\[?.*?\]\]?/, "type.identifier"],
        [/[\w.-]+(?=\s*=)/, "key"],
        [/\b(true|false|inf|nan)\b/, "keyword"],
        [/[+-]?\d[\dA-Fa-f_xXob.:+TZ-]*/, "number"],
        [/[=,{}[\]]/, "delimiter"],
      ],
      multiline: [
        [/"""/, "string", "@pop"],
        [/[^"\\]+|\\.|"/, "string"],
      ],
      literalMultiline: [
        [/'''/, "string", "@pop"],
        [/[^']+|'/, "string"],
      ],
    },
  });
  const options = {
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    allowNonTsExtensions: true,
    allowJs: true,
  };
  monaco.typescript.typescriptDefaults.setCompilerOptions(options);
  monaco.typescript.javascriptDefaults.setCompilerOptions(options);
}

export function languageFor(monaco: typeof Monaco, path: string, content = "") {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const lower = name.toLowerCase();
  const languages = monaco.languages.getLanguages();
  const exact = languages.find((language) =>
    language.filenames?.some((file) => file.toLowerCase() === lower),
  );
  if (exact) return exact.id;
  if (/^dockerfile(?:\.|$)/i.test(name)) return "dockerfile";
  if (/^(?:makefile|gnumakefile)(?:\.|$)/i.test(name)) return "makefile";
  if (/^\.env(?:\.|$)/.test(name)) return "shell";
  if (/\.(vue|svelte|astro)$/i.test(name)) return "html";
  const candidates = languages.flatMap((language) =>
    (language.extensions ?? []).map((extension) => ({
      id: language.id,
      extension,
    })),
  );
  const extension = candidates
    .filter((candidate) => lower.endsWith(candidate.extension.toLowerCase()))
    .sort((a, b) => b.extension.length - a.extension.length)[0];
  if (extension) return extension.id;
  const line = content.split(/\r?\n/, 1)[0].slice(0, 1024);
  if (/^#!.*\b(python[\d.]*)\b/.test(line)) return "python";
  if (/^#!.*\b(node|deno|bun)\b/.test(line)) return "javascript";
  if (/^#!.*\b(ba|z|fi|da|k)?sh\b/.test(line)) return "shell";
  for (const language of languages) {
    if (language.firstLine) {
      try {
        if (new RegExp(language.firstLine).test(line)) return language.id;
      } catch {
        /* Only registered grammar metadata; an invalid firstLine is not a file error. */
      }
    }
  }
  return "plaintext";
}
