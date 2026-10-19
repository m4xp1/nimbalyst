// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {embeddingInput} from '../embeddingInput.js';
import { chunkMarkdown, stripFrontmatter, estimateTokens } from '../chunker.js';

describe('chunkMarkdown', () => {
  it('produces heading-aware chunks carrying the heading breadcrumb', () => {
    const md = [
      '---',
      'title: Sample',
      'tags: [a, b]',
      '---',
      '# Top',
      'Intro paragraph under top.',
      '',
      '## Alpha',
      'Alpha body paragraph.',
      '',
      '### Alpha Detail',
      'Detail body.',
      '',
      '## Beta',
      'Beta body.',
    ].join('\n');

    const chunks = chunkMarkdown('design/sample.md', 'design', md);

    // Frontmatter must not appear in any chunk.
    expect(chunks.every((c) => !c.text.includes('title: Sample'))).toBe(true);

    // Each chunk carries sourcePath/sourceClass and a stable ordinal id.
    expect(chunks[0].sourcePath).toBe('design/sample.md');
    expect(chunks[0].sourceClass).toBe('design');
    expect(chunks.map((c) => c.id)).toEqual(
      chunks.map((_, i) => `design/sample.md#${i}`)
    );

    // The deepest section's breadcrumb is the full heading path.
    const detail = chunks.find((c) => c.text.includes('Detail body.'));
    expect(detail?.headingPath).toEqual(['Top', 'Alpha', 'Alpha Detail']);

    // Sibling section resets the breadcrumb back to depth 2.
    const beta = chunks.find((c) => c.text.includes('Beta body.'));
    expect(beta?.headingPath).toEqual(['Top', 'Beta']);

    // Content hash is populated and deterministic.
    expect(chunks[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(chunkMarkdown('design/sample.md', 'design', md)[0].contentHash).toBe(
      chunks[0].contentHash
    );
  });

  it('does not treat ATX headings inside fenced code blocks as headings', () => {
    const md = [
      '# Real Heading',
      'Body.',
      '',
      '```sh',
      '# not a heading, just a shell comment',
      'echo hi',
      '```',
      '',
      'Trailing body.',
    ].join('\n');

    const chunks = chunkMarkdown('docs/x.md', 'docs', md);
    // Only one heading ⇒ every chunk shares the same breadcrumb.
    expect(new Set(chunks.map((c) => c.headingPath.join('>')))).toEqual(
      new Set(['Real Heading'])
    );
    // The fenced comment line survived intact inside a chunk.
    expect(chunks.some((c) => c.text.includes('# not a heading'))).toBe(true);
  });

  it('splits a long section into multiple bounded chunks', () => {
    const para = 'word '.repeat(400).trim(); // ~2000 chars ≈ 500 tokens
    const md = ['# Big', para, '', para, '', para].join('\n');
    const chunks = chunkMarkdown('docs/big.md', 'docs', md, {
      minTokens: 100,
      maxTokens: 200,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Allow some slack for the greedy packer, but nothing wildly oversized.
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(300);
    }
  });
});

describe('stripFrontmatter', () => {
  it('removes a leading YAML block and leaves bodies without one untouched', () => {
    expect(stripFrontmatter('---\na: 1\n---\nbody')).toBe('body');
    expect(stripFrontmatter('no frontmatter here')).toBe('no frontmatter here');
  });
});


describe('oversized searchable text', () => {
  it('retains continuous text and Unicode in bounded chunks', () => {
    for (const raw of ['Qx7Zm9'.repeat(20000), 'Я😀ё'.repeat(12000)]) {
      const chunks = chunkMarkdown('synthetic.txt', 'custom', raw, { plainText: true });
      expect(chunks.map(c => c.text).join('')).toBe(raw);
      expect(chunks.every(c => Buffer.byteLength(c.text, 'utf8') <= 5000)).toBe(true);
      expect(chunks.every(c => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(c.text))).toBe(true);
    }
  });
});


describe('structured searchable fragments',()=>{
 it('keeps shorter fences and false headings inside the outer fence',()=>{
  const tick=String.fromCharCode(96),raw='# Real\n'+tick.repeat(4)+'md\n'+tick.repeat(3)+'js\n# false heading\n'+tick.repeat(3)+'\n'+tick.repeat(4)+'\n## Next\nTail';
  const chunks=chunkMarkdown('docs/fence.md','docs',raw);
  expect(chunks.filter(c=>c.text.includes('false heading')).every(c=>c.headingPath.join('/')==='Real')).toBe(true);
 });
 it('splits tables between complete rows and carries column context separately from source text',()=>{
  const header='| Name | Value |\n| --- | --- |\n',rows=Array.from({length:30},(_,i)=>'| ROW_'+i+' | '+('data '.repeat(8))+'|\n');
  const raw='# Measurements\n'+header+rows.join('');
  const chunks=chunkMarkdown('docs/table.md','docs',raw,{minTokens:40,maxTokens:90});
  expect(chunks.map(c=>c.text).join('')).toBe(raw);
  for(const row of rows)expect(chunks.some(c=>c.text.includes(row))).toBe(true);
  const continuation=chunks.find(c=>c.text.includes('ROW_20')) as any;
  expect(continuation.context).toContain('| Name | Value |');expect(continuation.text).not.toContain('| Name | Value |');
  expect(raw.slice(continuation.sourceRange.start,continuation.sourceRange.end)).toBe(continuation.text);
 });
 it('preserves indentation and separates repeated heading identities',()=>{
  const tick=String.fromCharCode(96),code='  if (enabled) {\n    preserveIndent();\n  }\n'.repeat(30),raw='# Same\n'+tick.repeat(3)+'js\n'+code+tick.repeat(3)+'\n# Same\nSecond';
  const chunks=chunkMarkdown('docs/code.md','docs',raw,{minTokens:40,maxTokens:90}) as any[];
  expect(chunks.map(c=>c.text).join('')).toBe(raw);
  expect(chunks.some(c=>c.context?.includes('Code continuation'))).toBe(true);
  expect(new Set(chunks.map(c=>c.sectionId)).size).toBe(2);
 });
});


describe('closest heading context',()=>{
 it('retains the nearest heading when an ancestor exceeds the input prefix budget',()=>{
  const input=embeddingInput(['Огромный предок '.repeat(300),'БлижайшаяТема'],'Исходный текст','Table columns: Name | Value');
  expect(input).toContain('БлижайшаяТема');expect(input).toContain('Name | Value');expect(Buffer.byteLength(input,'utf8')).toBeLessThanOrEqual(6000);
 });
});


describe('word boundaries and precise sections',()=>{
 it('keeps ordinary words complete when a long prose line needs splitting',()=>{
  const text='alpha beta gamma delta '.repeat(80),chunks=chunkMarkdown('docs/words.md','docs',text,{minTokens:10,maxTokens:20});
  expect(chunks.map(c=>c.text).join('')).toBe(text);
  expect(chunks.flatMap(c=>c.text.split(/\s+/).filter(Boolean)).every(word=>['alpha','beta','gamma','delta'].includes(word))).toBe(true);
 });
});
