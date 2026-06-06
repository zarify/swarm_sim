import { Fragment, type ReactNode } from 'react';

interface InstructionsMarkdownProps {
  markdown: string;
}

type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; code: string };

export function InstructionsMarkdown({ markdown }: InstructionsMarkdownProps) {
  const blocks = parseMarkdownBlocks(markdown);
  return (
    <div className="instructions-markdown">
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  );
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const HeadingTag = `h${block.level}` as const;
      return <HeadingTag key={`heading-${index}`}>{renderInlineMarkdown(block.text)}</HeadingTag>;
    }
    case 'paragraph':
      return <p key={`paragraph-${index}`}>{renderInlineMarkdown(block.text)}</p>;
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag key={`list-${index}`}>
          {block.items.map((item, itemIndex) => (
            <li key={`item-${index}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ListTag>
      );
    }
    case 'code':
      return (
        <pre key={`code-${index}`}>
          <code>{block.code}</code>
        </pre>
      );
  }
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).flatMap((segment, index) => {
    if (!segment) {
      return [];
    }
    if (segment.startsWith('`') && segment.endsWith('`') && segment.length >= 2) {
      return [<code key={`code-${index}`}>{segment.slice(1, -1)}</code>];
    }
    return [<Fragment key={`text-${index}`}>{segment}</Fragment>];
  });
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: 'code', code: codeLines.join('\n') });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const hashes = headingMatch[1]!;
      const text = headingMatch[2]!;
      blocks.push({
        type: 'heading',
        level: hashes.length as 1 | 2 | 3 | 4 | 5 | 6,
        text: text.trim(),
      });
      index += 1;
      continue;
    }

    const listMatch = parseListItem(line);
    if (listMatch) {
      const items: string[] = [];
      const ordered = listMatch.ordered;
      while (index < lines.length) {
        const currentLine = lines[index] ?? '';
        const currentListMatch = parseListItem(currentLine);
        if (!currentListMatch || currentListMatch.ordered !== ordered) {
          break;
        }
        items.push(currentListMatch.text);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const currentLine = lines[index] ?? '';
      if (
        currentLine.trim() === '' ||
        /^```/.test(currentLine) ||
        /^(#{1,6})\s+/.test(currentLine) ||
        parseListItem(currentLine)
      ) {
        break;
      }
      paragraphLines.push(currentLine.trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
  }

  return blocks;
}

function parseListItem(line: string): { ordered: boolean; text: string } | undefined {
  const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
  if (ordered) {
    const text = ordered[1]!;
    return { ordered: true, text: text.trim() };
  }
  const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
  if (unordered) {
    const text = unordered[1]!;
    return { ordered: false, text: text.trim() };
  }
  return undefined;
}
