import { createElement, type ReactNode } from 'react';

/**
 * 助手回复的 Markdown 排版。
 * 走 React 文本节点，不用 innerHTML：模型写出的 HTML、script 只当文字。
 * 链接只留 http、https、mailto。图片也只做成这种链接，不直接加载。
 */

const HEADS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

type Delim = '*' | '_' | '~';

type ListBlock = {
  kind: 'list';
  ordered: boolean;
  start: number;
  items: ListItem[];
};

type ListItem = {
  text: string;
  /** null 是普通条目；true/false 是任务列表勾选状态 */
  task: boolean | null;
  children: ListBlock[];
};

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'quote'; blocks: Block[] }
  | ListBlock
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'p'; text: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;
  return <div className="chat-md">{blocks.map((block, index) => renderBlock(block, `b${index}`))}</div>;
}

function renderBlock(block: Block, path: string): ReactNode {
  switch (block.kind) {
    case 'code':
      return (
        <pre key={path}>
          <code>{block.text}</code>
        </pre>
      );
    case 'heading': {
      const tag = HEADS[block.level - 1] ?? 'h6';
      return createElement(tag, { key: path }, renderInline(block.text, path));
    }
    case 'hr':
      return <hr key={path} />;
    case 'quote':
      return <blockquote key={path}>{block.blocks.map((child, index) => renderBlock(child, `${path}.${index}`))}</blockquote>;
    case 'list':
      return <RenderList key={path} list={block} path={path} />;
    case 'table':
      return (
        <div key={path} className="chat-md-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} scope="col">
                    {renderInline(cell, `${path}-h${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell, `${path}-r${rowIndex}c${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'p':
      return <p key={path}>{renderInline(block.text, path)}</p>;
    default:
      return null;
  }
}

function RenderList({ list, path }: { list: ListBlock; path: string }) {
  const items = list.items.map((item, index) => (
    <li key={`${path}-${index}`}>
      {item.task === null ? null : (
        <input type="checkbox" disabled checked={item.task} tabIndex={-1} aria-label={item.task ? '已完成' : '未完成'} />
      )}
      {renderInline(item.text, `${path}-${index}`)}
      {item.children.map((child, childIndex) => (
        <RenderList key={`${path}-${index}-${childIndex}`} list={child} path={`${path}-${index}-${childIndex}`} />
      ))}
    </li>
  ));
  if (list.ordered) return <ol start={list.start}>{items}</ol>;
  return <ul>{items}</ul>;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith('mailto:')) return <a href={href}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function renderInline(source: string, key: string, inLink = false): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    out.push(decodeEntities(buf));
    buf = '';
  };
  const pushNode = (node: ReactNode) => {
    flush();
    out.push(node);
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    if (ch === '\n') {
      flush();
      out.push(<br key={`${key}-n${i}`} />);
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < source.length && isEscapable(source[i + 1] ?? '')) {
      buf += source[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const span = readCodeSpan(source, i);
      if (span) {
        pushNode(<code key={`${key}-c${i}`}>{span.text}</code>);
        i = span.end;
        continue;
      }
    }
    if (!inLink && ch === '!' && source[i + 1] === '[') {
      const image = parseLink(source, i + 1);
      if (image) {
        const href = safeHref(decodeEntities(image.href));
        const label = decodeEntities(image.text || image.href);
        if (href) pushNode(<ExternalLink key={`${key}-i${i}`} href={href}>{label}</ExternalLink>);
        else pushNode(<span key={`${key}-i${i}`}>{label}</span>);
        i = image.end;
        continue;
      }
    }
    if (!inLink && ch === '[') {
      const link = parseLink(source, i);
      if (link) {
        const href = safeHref(decodeEntities(link.href));
        const label = link.text ? renderInline(link.text, `${key}-t${i}`, true) : decodeEntities(link.href);
        if (href) pushNode(<ExternalLink key={`${key}-a${i}`} href={href}>{label}</ExternalLink>);
        else pushNode(<span key={`${key}-a${i}`}>{label}</span>);
        i = link.end;
        continue;
      }
    }
    if (!inLink && ch === '<') {
      const angle = readAngleLink(source, i);
      if (angle) {
        pushNode(<ExternalLink key={`${key}-g${i}`} href={angle.href}>{angle.href}</ExternalLink>);
        i = angle.end;
        continue;
      }
    }
    if (!inLink && (source.startsWith('http://', i) || source.startsWith('https://', i))) {
      const bare = readBareUrl(source, i);
      if (bare) {
        pushNode(<ExternalLink key={`${key}-u${i}`} href={bare.href}>{bare.href}</ExternalLink>);
        i = bare.end;
        continue;
      }
    }
    const emph = readEmphasis(source, i);
    if (emph) {
      const inner = renderInline(emph.inner, `${key}-e${i}`, inLink);
      pushNode(emphasisNode(emph.marker, emph.count, inner, `${key}-e${i}`));
      i = emph.end;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

function emphasisNode(marker: Delim, count: number, children: ReactNode, key: string): ReactNode {
  if (marker === '~') return <del key={key}>{children}</del>;
  if (count >= 3) {
    return (
      <strong key={key}>
        <em>{children}</em>
      </strong>
    );
  }
  if (count === 2) return <strong key={key}>{children}</strong>;
  return <em key={key}>{children}</em>;
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const fence = readFence(lines, i);
    if (fence) {
      blocks.push({ kind: 'code', text: fence.text });
      i = fence.next;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line);
    if (heading) {
      const text = heading[2].replace(/[ \t]+#+\s*$/, '').trim();
      if (text) {
        blocks.push({ kind: 'heading', level: heading[1].length, text });
        i += 1;
        continue;
      }
    }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(lines[i] ?? '');
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').trim() !== '' && (lines[i] ?? '').includes('|')) {
        rows.push(splitRow(lines[i] ?? ''));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^ {0,3}>[ \t]?/, ''));
        i += 1;
      }
      const inner = parseBlocks(quoted.join('\n'));
      if (inner.length > 0) blocks.push({ kind: 'quote', blocks: inner });
      continue;
    }
    const list = parseList(lines, i);
    if (list) {
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !startsBlock(lines, i)) {
      para.push(lines[i] ?? '');
      i += 1;
    }
    blocks.push({ kind: 'p', text: para.join('\n') });
  }
  return blocks;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}#{1,6}[ \t]+\S/.test(line)) return true;
  if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (parseListLine(line)) return true;
  return isTableStart(lines, index);
}

function readFence(lines: string[], start: number): { text: string; next: number } | null {
  const open = fenceMarker(lines[start] ?? '');
  if (!open) return null;
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length && !isFenceClose(lines[i] ?? '', open)) {
    body.push(lines[i] ?? '');
    i += 1;
  }
  if (i < lines.length) i += 1;
  return { text: body.join('\n'), next: i };
}

function fenceMarker(line: string): string | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return match[1];
}

function isFenceClose(line: string, marker: string): boolean {
  const ch = marker[0] === '~' ? '~' : '`';
  return new RegExp(`^ {0,3}${ch}{${marker.length},}[ \\t]*$`).test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? '';
  const sep = lines[index + 1] ?? '';
  if (!header.includes('|') || !sep.includes('|')) return false;
  const cells = splitRow(sep);
  return cells.length >= 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitRow(line: string): string[] {
  let rest = line.trim();
  if (rest.startsWith('|')) rest = rest.slice(1);
  if (rest.endsWith('|')) rest = rest.slice(0, -1);
  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '\\' && rest[i + 1] === '|') {
      buf += '|';
      i += 1;
      continue;
    }
    if (rest[i] === '|') {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += rest[i];
  }
  cells.push(buf.trim());
  return cells;
}

function parseList(lines: string[], start: number): { block: ListBlock; next: number } | null {
  const first = parseListLine(lines[start] ?? '');
  if (!first) return null;
  const root: ListBlock = { kind: 'list', ordered: first.ordered, start: first.num, items: [] };
  const stack: Array<{ indent: number; list: ListBlock }> = [{ indent: first.indent, list: root }];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j += 1;
      const peek = j < lines.length ? parseListLine(lines[j] ?? '') : null;
      if (!peek || peek.indent < first.indent) break;
      i = j;
      continue;
    }
    const parsed = parseListLine(raw);
    if (!parsed || parsed.indent < first.indent) {
      const top = stack[stack.length - 1];
      if (!parsed && top && indentWidth(raw) > top.indent) {
        const item = top.list.items[top.list.items.length - 1];
        if (item) {
          item.text += `\n${raw.trim()}`;
          i += 1;
          continue;
        }
      }
      break;
    }
    while (stack.length > 1 && parsed.indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (!top) break;
    if (parsed.indent > top.indent) {
      const parent = top.list.items[top.list.items.length - 1];
      if (!parent) break;
      const child: ListBlock = { kind: 'list', ordered: parsed.ordered, start: parsed.num, items: [] };
      parent.children.push(child);
      const frame = { indent: parsed.indent, list: child };
      stack.push(frame);
      top = frame;
    } else if (parsed.ordered !== top.list.ordered) {
      if (stack.length === 1) break;
      stack.pop();
      continue;
    }
    top.list.items.push({ text: parsed.text, task: parsed.task, children: [] });
    i += 1;
  }
  return { block: root, next: i };
}

function parseListLine(line: string): { indent: number; ordered: boolean; num: number; text: string; task: boolean | null } | null {
  const match = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[2];
  const ordered = /^\d/.test(marker);
  let text = match[3];
  let task: boolean | null = null;
  const taskMatch = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(text);
  if (taskMatch) {
    task = taskMatch[1].toLowerCase() === 'x';
    text = taskMatch[2] ?? '';
  }
  return {
    indent: indentWidth(match[1]),
    ordered,
    num: ordered ? Number.parseInt(marker, 10) : 1,
    text,
    task,
  };
}

function indentWidth(spaces: string): number {
  let width = 0;
  for (const ch of spaces) width += ch === '\t' ? 2 : 1;
  return width;
}

function readCodeSpan(source: string, index: number): { text: string; end: number } | null {
  let len = 0;
  while (source[index + len] === '`') len += 1;
  if (len === 0) return null;
  const token = '`'.repeat(len);
  const close = source.indexOf(token, index + len);
  if (close < 0) return null;
  let text = source.slice(index + len, close).replace(/\n/g, ' ');
  if (text.length >= 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') {
    text = text.slice(1, -1);
  }
  return { text, end: close + len };
}

function parseLink(source: string, index: number): { text: string; href: string; end: number } | null {
  if (source[index] !== '[') return null;
  let j = index + 1;
  let depth = 1;
  while (j < source.length && depth > 0) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === '\n') return null;
    if (source[j] === '[') depth += 1;
    else if (source[j] === ']') depth -= 1;
    if (depth > 0) j += 1;
  }
  if (depth !== 0 || source[j] !== ']' || source[j + 1] !== '(') return null;
  let k = j + 2;
  while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k += 1;
  let href = '';
  if (source[k] === '<') {
    k += 1;
    while (k < source.length && source[k] !== '>' && source[k] !== '\n') {
      if (source[k] === '\\') {
        href += source[k + 1] ?? '';
        k += 2;
        continue;
      }
      href += source[k];
      k += 1;
    }
    if (source[k] !== '>') return null;
    k += 1;
  } else {
    while (k < source.length && source[k] !== ')' && !/\s/.test(source[k] ?? '')) {
      if (source[k] === '\\') {
        href += source[k + 1] ?? '';
        k += 2;
        continue;
      }
      href += source[k];
      k += 1;
    }
  }
  while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k += 1;
  if (source[k] === '"' || source[k] === "'") {
    const quote = source[k];
    k += 1;
    while (k < source.length && source[k] !== quote && source[k] !== '\n') k += 1;
    if (source[k] !== quote) return null;
    k += 1;
    while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k += 1;
  }
  if (source[k] !== ')') return null;
  return { text: source.slice(index + 1, j), href, end: k + 1 };
}

function readAngleLink(source: string, index: number): { href: string; end: number } | null {
  const match = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(source.slice(index));
  if (!match) return null;
  const href = safeHref(decodeEntities(match[1]));
  if (!href) return null;
  return { href, end: index + match[0].length };
}

function readBareUrl(source: string, index: number): { href: string; end: number } | null {
  const prev = index === 0 ? '' : (source[index - 1] ?? '');
  if (prev && /[A-Za-z0-9/]/.test(prev)) return null;
  const match = /^https?:\/\/[^\s<]+/i.exec(source.slice(index));
  if (!match) return null;
  let raw = match[0];
  while (/[),.;:!?，。；、！？]$/.test(raw)) raw = raw.slice(0, -1);
  const href = safeHref(raw);
  if (!href) return null;
  const host = href.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] ?? '';
  if (!host) return null;
  return { href, end: index + raw.length };
}

function readEmphasis(source: string, index: number): { marker: Delim; count: number; inner: string; end: number } | null {
  const ch = source[index];
  if (ch !== '*' && ch !== '_' && ch !== '~') return null;
  let count = 0;
  while (source[index + count] === ch) count += 1;
  if (ch === '~' && count < 2) return null;
  const marker: Delim = ch;
  const max = marker === '~' ? 2 : Math.min(count, 3);
  const min = marker === '~' ? 2 : 1;
  for (let take = max; take >= min; take -= 1) {
    if (!canOpen(source, index, marker, take)) continue;
    const close = findCloser(source, index + take, marker, take);
    if (close < 0) continue;
    const inner = source.slice(index + take, close);
    if (!inner) continue;
    return { marker, count: take, inner, end: close + take };
  }
  return null;
}

function canOpen(source: string, index: number, marker: Delim, count: number): boolean {
  const after = source[index + count] ?? '';
  if (!after || /\s/.test(after)) return false;
  if (marker === '_') {
    const before = source[index - 1] ?? '';
    if (before && /[\p{L}\p{N}_]/u.test(before)) return false;
  }
  return true;
}

function canClose(source: string, index: number, marker: Delim, count: number): boolean {
  const before = source[index - 1] ?? '';
  if (!before || /\s/.test(before)) return false;
  if (marker === '_') {
    const after = source[index + count] ?? '';
    if (after && /[\p{L}\p{N}_]/u.test(after)) return false;
  }
  return true;
}

function findCloser(source: string, from: number, marker: Delim, count: number): number {
  let i = from;
  while (i < source.length) {
    if (source[i] === '\\' && i + 1 < source.length) {
      i += 2;
      continue;
    }
    if (source[i] === '`') {
      const span = readCodeSpan(source, i);
      if (!span) return -1;
      i = span.end;
      continue;
    }
    if (source[i] === marker) {
      let n = 0;
      while (source[i + n] === marker) n += 1;
      if (n >= count && canClose(source, i, marker, count)) return i;
      i += Math.max(n, 1);
      continue;
    }
    i += 1;
  }
  return -1;
}

function isEscapable(ch: string): boolean {
  return ch.length === 1 && ch.charCodeAt(0) < 127 && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(ch);
}

function safeHref(href: string): string | null {
  const value = href.trim();
  if (!value || /[\u0000-\u001F\s]/.test(value)) return null;
  const match = /^([a-zA-Z][a-zA-Z+\-.]*):(.*)$/.exec(value);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return null;
  if (scheme === 'mailto' && match[2].length === 0) return null;
  return value;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (all, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body] ?? all;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all;
    return String.fromCodePoint(code);
  });
}
