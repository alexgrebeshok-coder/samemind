// markdown.tsx — minimal markdown → React elements. React's raw-HTML escape hatch is never used
// anywhere in this app: every node here is a real React element, so a bundle body cannot inject
// HTML, script or style (spec §0 security rule; src/lib.test.mjs greps for the sinks).
// Supported: ATX headings, fenced code, blockquote, hr, ordered/unordered lists, paragraphs;
// inline `code`, **bold**, *italic*, [text](href).
//
// Links are inert by construction. Bundle-internal targets (`/concepts/x.md`) become in-app
// buttons that route to the concept view; anything else renders as an <a rel="noopener
// noreferrer"> WITHOUT an href — visible, copyable via its title, impossible to follow.
import type { ReactNode } from 'react';
import { linkToId } from './lib';

const LINK_CLASS = 'text-accent underline decoration-accent/40 underline-offset-2';

function isInternal(href: string): boolean {
  return /^\/[^/]/.test(href) && /\.md$/i.test(href);
}

function inline(text: string, onOpen?: (id: string) => void, keyBase = ''): ReactNode[] {
  const out: ReactNode[] = [];
  // one pass, longest-first alternatives: code | bold | italic | link
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?:\*|_)([^*_]+)(?:\*|_)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}i${i++}`;
    if (m[1] !== undefined) {
      out.push(
        <code key={k} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(<strong key={k}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      out.push(<em key={k}>{m[3]}</em>);
    } else if (m[4] !== undefined && m[5] !== undefined) {
      const [label, href] = [m[4], m[5]];
      if (isInternal(href) && onOpen) {
        const id = linkToId(href);
        out.push(
          <button key={k} type="button" className={LINK_CLASS} onClick={() => onOpen(id)} title={id}>
            {label}
          </button>,
        );
      } else {
        out.push(
          // no href: inert by construction, not by handler
          <a key={k} rel="noopener noreferrer" title={`${href} (link not followed)`} className={`${LINK_CLASS} cursor-help`}>
            {label}
          </a>,
        );
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const H = ['text-xl font-bold', 'text-lg font-bold', 'text-base font-semibold', 'text-sm font-semibold'];

export function Markdown({ body, onOpen }: { body: string; onOpen?: (id: string) => void }) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let key = 0;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(
      <p key={`p${key++}`} className="my-3 leading-relaxed">
        {inline(para.join(' '), onOpen, `p${key}`)}
      </p>,
    );
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      blocks.push(
        <pre
          key={`c${key++}`}
          className="my-3 overflow-x-auto rounded-[12px] border border-line bg-surface-2 p-3 font-mono text-xs"
        >
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = Math.min(4, h[1].length);
      const Tag = (['h2', 'h3', 'h4', 'h5'] as const)[level - 1];
      blocks.push(
        <Tag key={`h${key++}`} className={`mt-5 mb-2 ${H[level - 1]}`}>
          {inline(h[2], onOpen, `h${key}`)}
        </Tag>,
      );
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flushPara();
      blocks.push(<hr key={`r${key++}`} className="my-5 border-line" />);
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      blocks.push(
        <blockquote key={`q${key++}`} className="my-3 border-l-2 border-accent/50 pl-3 text-muted italic">
          {inline(buf.join(' '), onOpen, `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    const li = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = li[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const m2 = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m2) break;
        items.push(m2[1]);
        i++;
        // fold continuation lines into the current item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+\.)\s/.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        }
      }
      i--;
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List
          key={`l${key++}`}
          className={`my-3 space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-muted`}
        >
          {items.map((t, n) => (
            <li key={n}>{inline(t, onOpen, `l${key}-${n}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();

  return <div className="text-sm">{blocks}</div>;
}
