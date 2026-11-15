// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { annotationEndRect, transcriptTextRange } from '../transcriptSelection';

afterEach(() => { document.body.innerHTML = ''; });

it('anchors the annotation at its final visible character, ignoring trailing whitespace', () => {
  const node = document.createTextNode('Some text 🙂  \n');
  document.body.append(node);
  const range = document.createRange(); range.selectNodeContents(node);
  const rect = vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
    expect(this.toString()).toBe('🙂');
    return new DOMRect(250, 100, 14, 20);
  });
  try {
    expect(annotationEndRect([range]).toJSON()).toEqual(new DOMRect(264, 100, 0, 20).toJSON());
  } finally { rect.mockRestore(); }
});

it('anchors a selection at real text when its first line contains only a newline', () => {
  document.body.innerHTML = '<section><p>First line\n</p><p>  Actual selected text  </p></section>';
  const root = document.querySelector('section')!;
  const range = document.createRange();
  range.setStart(root.firstChild!.firstChild!, 10);
  range.setEnd(root.lastChild!.firstChild!, 24);
  const actual = transcriptTextRange(root, range)!;
  expect(actual.toString()).toBe('Actual selected text');
  expect(actual.startContainer).toBe(root.lastChild!.firstChild);
  expect(actual.startOffset).toBe(2);
});

it('clips a fast drag to transcript text without surrounding app controls', () => {
  document.body.innerHTML = '<header>Workspace controls</header><section><p>Assistant answer</p><p>User message</p></section><footer>Composer controls</footer>';
  const range = document.createRange();
  range.selectNodeContents(document.body);
  const actual = transcriptTextRange(document.querySelector('section')!, range)!;
  expect(actual.toString()).toBe('Assistant answerUser message');
  expect(actual.startContainer.parentElement?.textContent).toBe('Assistant answer');
  expect(actual.endContainer.parentElement?.textContent).toBe('User message');
});

it('ignores message chrome and icon names at the selection boundary', () => {
  document.body.innerHTML = '<section><div class="rich-transcript-message-header">personYou12:00</div><p>Actual message</p><span class="material-symbols-outlined">content_copy</span><div class="rich-transcript-turn-elapsed">Finished in 10s</div></section>';
  const root = document.querySelector('section')!;
  const range = document.createRange(); range.selectNodeContents(root);
  const actual = transcriptTextRange(root, range)!;
  expect(actual.toString()).toBe('Actual message');
});

it('does not pull floating transcript controls into a drag outside the message area', () => {
  document.body.innerHTML = '<section><button>Planning and navigation</button><p data-annotation-message-id="one">Actual message</p><aside>Other controls</aside></section>';
  const root = document.querySelector('section')!;
  const range = document.createRange(); range.selectNodeContents(root);
  expect(transcriptTextRange(root, range)!.toString()).toBe('Actual message');
});
