import type { ReactNode } from "react";

/**
 * Minimal markdown renderer for agent chat.
 *
 * The agent writes headings, tables and bold text constantly — a strategy spec
 * comes back as a markdown table. Rendering that as raw text is why chat
 * replies read as an unbroken wall of `**Pair** | ARB-USD | |---|---|`.
 *
 * Hand-rolled rather than pulling in react-markdown: this needs headings,
 * emphasis, code, lists, tables and rules, and the project prefers zero
 * dependencies. It is intentionally not a complete CommonMark implementation.
 *
 * All output is React elements built from parsed text — no dangerouslySetInnerHTML,
 * so agent output cannot inject markup into the app.
 */

/* ── inline: **bold**, *italic*, `code` ──────────────────────────────── */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: code first so ** inside backticks stays literal.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(__[^_]+__)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-i${i++}`;

    if (tok.startsWith("`")) {
      out.push(
        <code key={key} className="md-code">
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableDivider = (line: string) => /^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/.test(line) && line.includes("-");

/** Parse markdown into React elements. */
export function renderMarkdown(src: string): ReactNode {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // fenced code
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={`b${key++}`} className="md-pre">
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // table: header row followed by a divider
    if (line.includes("|") && isTableDivider(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|")) {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      blocks.push(
        <div key={`b${key++}`} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{renderInline(h, `h${hi}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{renderInline(c, `c${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // heading
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      blocks.push(
        <div key={`b${key++}`} className={`md-h md-h${level}`}>
          {renderInline(h[2] ?? "", `h${key}`)}
        </div>
      );
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} className="md-hr" />);
      i++;
      continue;
    }

    // lists (bulleted or numbered)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={`b${key++}`} className="md-list">
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `l${key}-${ii}`)}</li>
          ))}
        </Tag>
      );
      continue;
    }

    // blank
    if (!line.trim()) {
      i++;
      continue;
    }

    // paragraph (consume until blank or a block starter)
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(#{1,4})\s+/.test(lines[i] ?? "") &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").trim().startsWith("```") &&
      !((lines[i] ?? "").includes("|") && isTableDivider(lines[i + 1] ?? ""))
    ) {
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push(
      <p key={`b${key++}`} className="md-p">
        {renderInline(para.join(" "), `p${key}`)}
      </p>
    );
  }

  return <>{blocks}</>;
}
