import { useEffect, useState } from "react";
interface Rules {
  version: 1;
  include: string[];
  exclude: string[];
}
interface Preview {
  rules: Rules;
  files: string[];
  excluded: { path: string; reason: string }[];
}
export function SourceSettings({
  callBackendTool,
  openai,
  onApplied,
}: {
  callBackendTool?: (name: string, params?: any) => Promise<any>;
  openai: boolean;
  onApplied: () => void;
}) {
  const [include, setInclude] = useState(""),
    [exclude, setExclude] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void callBackendTool?.("memory.get_sources")
      .then((rules: Rules) => {
        if (live) {
          setInclude(rules.include.join("\n"));
          setExclude(rules.exclude.join("\n"));
          setLoaded(true);
        }
      })
      .catch(() => {
        if (live) setError("Could not load saved sources.");
      });
    return () => {
      live = false;
    };
  }, [callBackendTool]);
  const rules = (): Rules => ({
    version: 1,
    include: include
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    exclude: exclude
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  const run = async (apply: boolean) => {
    if (!callBackendTool) return;
    setBusy(true);
    setError(null);
    try {
      if (apply) {
        await callBackendTool("memory.set_sources", preview!.rules);
        setPreview(null);
        onApplied();
      } else
        setPreview(await callBackendTool("memory.preview_sources", rules()));
    } catch {
      setError(
        apply
          ? "Could not finish applying sources. Settings may be saved; check index status and use Rebuild."
          : "Could not preview sources. Check relative paths, rules and file access."
      );
    } finally {
      setBusy(false);
    }
  };
  const button = {
    background: "var(--nim-bg-tertiary)",
    color: "var(--nim-text)",
    border: "1px solid var(--nim-border)",
    borderRadius: 6,
    padding: "4px 10px",
  } as const;
  const field = {
    width: "100%",
    minHeight: 75,
    fontFamily: "monospace",
    background: "var(--nim-bg)",
    color: "var(--nim-text)",
    border: "1px solid var(--nim-border)",
    borderRadius: 6,
    padding: 8,
  } as const;
  return (
    <section
      style={{
        border: "1px solid var(--nim-border)",
        borderRadius: 8,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <h4 style={{ margin: 0 }}>Additional Markdown sources</h4>
      <p style={{ margin: 0, color: "var(--nim-text-muted)" }}>
        Built-in sources stay enabled. Add workspace-relative files, folders or
        globs, one per line. Exclusions apply to workspace files, not personal
        harness memory.
      </p>
      <label>
        Include
        <textarea
          aria-label="Additional source includes"
          disabled={busy || !loaded}
          style={field}
          value={include}
          onChange={(e) => {
            setInclude(e.target.value);
            setPreview(null);
          }}
          placeholder={"MAP.md\nresearch/\nprofiles/**/README.md"}
        />
      </label>
      <label>
        Exclude
        <textarea
          aria-label="Source excludes"
          disabled={busy || !loaded}
          style={field}
          value={exclude}
          onChange={(e) => {
            setExclude(e.target.value);
            setPreview(null);
          }}
          placeholder="research/drafts/**"
        />
      </label>
      <p style={{ margin: 0, color: "var(--nim-text-muted)" }}>
        Service/generated directories, archives and obvious secret filenames are
        excluded. Filename filters cannot detect every secret inside a document.
      </p>
      {openai && (
        <p role="note" style={{ margin: 0 }}>
          OpenAI is active: applying sources can send the selected document text
          to OpenAI for embeddings.
        </p>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={button}
          disabled={busy || !loaded || !callBackendTool}
          onClick={() => void run(false)}
        >
          Preview files
        </button>
        <button
          style={button}
          disabled={busy || !preview}
          onClick={() => void run(true)}
        >
          Apply sources
        </button>
      </div>
      {preview && (
        <div>
          <p>
            {preview.files.length} matching Markdown file(s). Overlapping rules
            are deduplicated; built-in matches retain their classification.
          </p>
          <ul style={{ maxHeight: 180, overflowY: "auto" }}>
            {preview.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <details>
            <summary>Exclusions ({preview.excluded.length})</summary>
            <ul>
              {preview.excluded.map((x, i) => (
                <li key={i}>
                  {x.path}: {x.reason}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
