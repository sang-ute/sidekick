// Minimal, safe markdown for chat replies, rendered as React elements (never raw HTML):
// paragraphs, line breaks, bullet/numbered lists, headings, **bold**, *italic*, `code`,
// and [links](https://…).
import { Fragment, type ReactNode } from "react";

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(\*[^*\s][^*]*\*)|(\b_[^_\s][^_]*_\b)/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}.${i++}`;
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (m[3]) {
      out.push(
        <a key={key} href={m[4]} target="_blank" rel="noopener noreferrer">
          {tok.slice(1, tok.indexOf("]("))}
        </a>,
      );
    } else out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

export function Markdown({ text }: { text: string }) {
  const blocks: Block[] = [];
  let para: Extract<Block, { kind: "p" }> | null = null;
  let list: Extract<Block, { kind: "ul" | "ol" }> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { para = null; list = null; continue; }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      para = null; list = null;
      blocks.push({ kind: "h", text: heading[1] });
      continue;
    }
    const item = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      para = null;
      const kind = /\d/.test(item[1]) ? "ol" : "ul";
      if (!list || list.kind !== kind) { list = { kind, items: [] }; blocks.push(list); }
      list.items.push(item[2]);
      continue;
    }
    list = null;
    if (!para) { para = { kind: "p", lines: [] }; blocks.push(para); }
    para.lines.push(line.trim());
  }
  return (
    <>
      {blocks.map((b, i) => {
        const k = String(i);
        if (b.kind === "h") return <p key={k} className="h">{inline(b.text, k)}</p>;
        if (b.kind === "p") {
          return (
            <p key={k}>
              {b.lines.map((l, j) => (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  {inline(l, `${k}.${j}`)}
                </Fragment>
              ))}
            </p>
          );
        }
        const Tag = b.kind;
        return <Tag key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}.${j}`)}</li>)}</Tag>;
      })}
    </>
  );
}
