import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DocsSection } from "../api/client";
import { renderMarkdown } from "../md";

const SECTION_LABEL: Record<string, string> = {
  concepts: "Concepts",
  python: "Python",
  javascript: "JavaScript",
  "html-css": "HTML / CSS",
  csharp: "C#",
};

interface Props {
  /** "section/slug" to open initially */
  initial?: string | null;
  compact?: boolean; // drawer mode
}

export default function Docs({ initial, compact }: Props) {
  const [index, setIndex] = useState<DocsSection[]>([]);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [current, setCurrent] = useState<string | null>(initial ?? null);
  const [markdown, setMarkdown] = useState<string>("");
  // Parsed when the page changes, not on every keystroke in the search box.
  const docHtml = useMemo(() => renderMarkdown(markdown), [markdown]);
  // Lazily built on first search: "section/slug" → lowercased page headings,
  // so search covers headings without shipping them in the index.
  const [headings, setHeadings] = useState<Record<string, string[]> | null>(null);
  const headingsLoading = useRef(false);

  const load = useCallback(() => {
    setError(false);
    api
      .docsIndex()
      .then(setIndex)
      .catch(() => setError(true));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (initial) setCurrent(initial);
  }, [initial]);

  useEffect(() => {
    if (!current) return;
    const [section, slug] = current.split("/");
    api
      .docsPage(section, slug)
      .then((j) => setMarkdown(j.markdown ?? `*Page ${current} not found.*`))
      .catch(() => setMarkdown("*Failed to load page.*"));
  }, [current]);

  useEffect(() => {
    if (!search.trim() || headings || headingsLoading.current || index.length === 0) return;
    headingsLoading.current = true;
    (async () => {
      const map: Record<string, string[]> = {};
      await Promise.all(
        index.flatMap((s) =>
          s.pages.map(async (p) => {
            try {
              const j = await api.docsPage(s.section, p.slug);
              map[`${s.section}/${p.slug}`] = [...(j.markdown ?? "").matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) =>
                m[1].toLowerCase(),
              );
            } catch {
              // page unreadable — heading search just skips it
            }
          }),
        ),
      );
      setHeadings(map);
    })();
  }, [search, headings, index]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return index;
    return index
      .map((s) => ({
        ...s,
        pages: s.pages.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            p.slug.includes(q) ||
            p.keywords.some((k) => k.toLowerCase().includes(q)) ||
            (headings?.[`${s.section}/${p.slug}`]?.some((h) => h.includes(q)) ?? false),
        ),
      }))
      .filter((s) => s.pages.length > 0);
  }, [index, search, headings]);

  return (
    <div className={`docs-view ${compact ? "compact" : ""}`}>
      <nav className="docs-nav" aria-label="Documentation pages">
        <input
          className="chat-input docs-search"
          placeholder="Search docs…"
          value={search}
          aria-label="Search documentation"
          onChange={(e) => setSearch(e.target.value)}
        />
        {filtered.map((s) => (
          <div key={s.section}>
            <div className="docs-section-label">{SECTION_LABEL[s.section] ?? s.section}</div>
            {s.pages.map((p) => {
              const key = `${s.section}/${p.slug}`;
              return (
                <button
                  key={key}
                  className={`docs-link ${current === key ? "active" : ""}`}
                  onClick={() => setCurrent(key)}
                >
                  {p.title}
                </button>
              );
            })}
          </div>
        ))}
        {index.length === 0 && error && (
          <div className="dim small">
            <p>Can't reach the local server.</p>
            <button onClick={load}>Retry</button>
          </div>
        )}
        {index.length === 0 && !error && <p className="dim small">No docs yet.</p>}
      </nav>
      <article className="docs-body lesson-md">
        {current ? (
          <div dangerouslySetInnerHTML={{ __html: docHtml }} />
        ) : (
          <p className="dim">Pick a page — or search. These docs are always one Ctrl+D away.</p>
        )}
      </article>
    </div>
  );
}
