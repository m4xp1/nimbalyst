import { describe, expect, it, vi } from 'vitest';
import { headingSlugs, markdownHeadingLine, revealHeading } from '../headingNavigation';
import { splitMarkdownLinkTarget } from '../../../utils/markdownLink';

describe('Markdown heading navigation', () => {
  it('separates an encoded filename from a decoded heading before path resolution', () => {
    expect(splitMarkdownLinkTarget('docs/a%23b.md#Требование%20языка')).toEqual({ path: 'docs/a%23b.md', fragment: 'Требование языка' });
    expect(splitMarkdownLinkTarget('a.md#broken%zz')).toEqual({ path: 'a.md', fragment: 'broken%zz' });
  });
  it('resolves source lines for Russian text, formatted and Setext headings, skipping YAML and code', () => {
    const source = '---\ntitle: data\n---\n```md\n# Not a heading\n```\n## Требование **языка**\n\nДругой раздел\n=============\n';
    expect(markdownHeadingLine(source, 'требование-языка')).toBe(7);
    expect(markdownHeadingLine(source, 'Требование языка')).toBe(7);
    expect(markdownHeadingLine(source, 'другой-раздел')).toBe(9);
    expect(markdownHeadingLine(source, 'not-a-heading')).toBeUndefined();
    expect(markdownHeadingLine(source, 'title-data')).toBeUndefined();
  });
  it('assigns collision-free duplicate slugs and scrolls only inside the target editor', () => {
    expect(headingSlugs(['Name', 'Name', 'Name-1', 'Name'])).toEqual(['name', 'name-1', 'name-1-1', 'name-2']);
    const root = document.createElement('div');
    root.innerHTML = '<h2>Повтор</h2><h2>Повтор</h2>';
    const first = root.children[0] as HTMLElement, second = root.children[1] as HTMLElement;
    first.scrollIntoView = vi.fn(); second.scrollIntoView = vi.fn();
    expect(revealHeading(root, 'повтор-1')).toBe(true);
    expect(first.scrollIntoView).not.toHaveBeenCalled();
    expect(second.scrollIntoView).toHaveBeenCalledOnce();
    expect(revealHeading(root, 'missing')).toBe(false);
  });
});
