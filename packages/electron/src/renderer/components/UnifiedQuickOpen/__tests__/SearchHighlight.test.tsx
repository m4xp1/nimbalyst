import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SearchHighlight } from '../SearchHighlight';

describe('Quick Open original-text highlighting', () => {
  it('marks a complete decomposed word in the source text', () => {
    const text = '😀 Прие\u0308мка';
    const { container } = render(<SearchHighlight text={text} query="ПРИЕМКА" />);
    expect(container.textContent).toBe(text);
    expect(container.querySelector('mark')?.textContent).toBe('Прие\u0308мка');
  });
  it('marks complete inflected words while preserving the remainder', () => {
    const text = 'Русский интерфейс готов';
    const { container } = render(<SearchHighlight text={text} query="русскими интерфейсами" />);
    expect(container.querySelector('mark')?.textContent).toBe('Русский интерфейс');
    expect(screen.getByText('готов', { exact: false }).textContent).toBe(text);
  });
  it('supports fuzzy Cyrillic file names without losing original accents', () => {
    const text = 'Прие\u0308мкаПроекта.md';
    const { container } = render(<SearchHighlight text={text} query="ПриПро" fuzzy />);
    expect([...container.querySelectorAll('mark')].map(m => m.textContent).join('')).toBe('ПриПро');
    expect(container.textContent).toBe(text);
  });
});
