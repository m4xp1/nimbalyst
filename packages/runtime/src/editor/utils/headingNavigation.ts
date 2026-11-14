import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { slugify } from './headingSlug';

interface MarkdownSyntaxNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: MarkdownSyntaxNode[];
  position?: { start: { line: number } };
}

/** Unique per-document slugs, including collisions with an explicit '-1' heading. */
export function headingSlugs(texts: string[]): string[] {
  const taken = new Set<string>();
  return texts.map(text => {
    const base = slugify(text.normalize('NFC'));
    if (!base) return '';
    let candidate = base;
    for (let n = 1; taken.has(candidate); n++) candidate = `${base}-${n}`;
    taken.add(candidate);
    return candidate;
  });
}

function headingIndex(texts: string[], fragment: string): number {
  const normalized = fragment.normalize('NFC');
  const slugs = headingSlugs(texts);
  const exact = slugs.indexOf(normalized);
  if (exact >= 0) return exact;
  const literal = texts.findIndex(text => text.normalize('NFC').toLocaleLowerCase() === normalized.toLocaleLowerCase());
  return literal >= 0 ? literal : slugs.indexOf(slugify(normalized));
}

export function revealHeading(root: HTMLElement | null, fragment: string): boolean {
  if (!root) return false;
  const headings = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
  const index = headingIndex(headings.map(heading => heading.textContent ?? ''), fragment);
  if (index < 0) return false;
  headings[index].scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}

/** Use the Markdown parser so code fences, inline formatting, and Setext headings agree. */
export function markdownHeadingLine(source: string, fragment: string): number | undefined {
  const withoutFrontmatter = source.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?=\r?\n|$)/, match => match.replace(/[^\r\n]/g, ' '));
  const tree = unified().use(remarkParse).parse(withoutFrontmatter);
  const headings: Array<{ text: string; line: number }> = [];
  function textOf(node: MarkdownSyntaxNode): string {
    return typeof node.value === 'string' ? node.value : node.alt ?? (node.children ?? []).map(textOf).join('');
  }
  function visit(node: MarkdownSyntaxNode): void {
    if (node.type === 'heading' && node.position) headings.push({ text: textOf(node), line: node.position.start.line });
    else for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return headings[headingIndex(headings.map(heading => heading.text), fragment)]?.line;
}
