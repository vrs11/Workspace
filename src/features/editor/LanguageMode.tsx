import { useEffect, useState } from "react";
import { models } from "./models";
import { useApp, perform } from "../../shared/state/store";
export default function LanguageMode({ entry }: { entry: string }) {
  const selected = useApp((s) => s.docs[entry]?.language ?? "plaintext");
  const [languages, setLanguages] = useState<{ id: string; name: string }[]>(
    [],
  );
  useEffect(() => {
    let disposed = false;
    void import("./monaco").then(({ monaco }) => {
      if (!disposed)
        setLanguages(
          monaco.languages
            .getLanguages()
            .map((language) => ({
              id: language.id,
              name: language.aliases?.[0] ?? language.id,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
    });
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <select
      className="language-mode"
      aria-label="Language mode"
      title="Syntax highlighting language"
      value={selected}
      onChange={(event) => {
        const language = event.target.value;
        void perform(async () => {
          const { monaco } = await import("./monaco");
          const model = models.get(entry)?.model;
          if (model) {
            monaco.editor.setModelLanguage(model, language);
            useApp.getState().doc(entry, { language });
          }
        });
      }}
    >
      {languages.length ? (
        languages.map((language) => (
          <option key={language.id} value={language.id}>
            {language.name}
          </option>
        ))
      ) : (
        <option value={selected}>{selected}</option>
      )}
    </select>
  );
}
