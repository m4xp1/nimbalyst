import type { Input, KeyboardInputEvent, WebContents } from 'electron';

const PHYSICAL_SYMBOLS: Record<string, [string, string]> = {
  Backquote: ['`', '~'], Minus: ['-', '_'], Equal: ['=', '+'],
  BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'],
  Period: ['.', '>'], Slash: ['/', '?'],
};
const SHIFT_DIGITS = ')!@#$%^&*(';

/** Resolve only modified physical keys; text, IME and AltGr remain native. */
export function physicalShortcutKey(input: Input, rightAltDown = false): string | null {
  if (input.isComposing || rightAltDown || input.modifiers?.some(m => /altgr/i.test(m))) return null;
  if (!input.control && !input.meta && !input.alt) return null;
  let base: string | undefined;
  let shifted: string | undefined;
  if (/^Key[A-Z]$/.test(input.code)) {
    base = input.code.slice(3).toLowerCase(); shifted = base.toUpperCase();
  } else if (/^Digit[0-9]$/.test(input.code)) {
    base = input.code.slice(5); shifted = SHIFT_DIGITS[Number(base)];
  } else if (PHYSICAL_SYMBOLS[input.code]) {
    [base, shifted] = PHYSICAL_SYMBOLS[input.code];
  }
  if (!base || input.key === (input.shift ? shifted : base)) return null;
  // The modifier flags make Chromium generate the appropriate shifted key.
  return base;
}

/**
 * Normalize before Electron accelerators and Chromium editor handlers see the
 * event. Replaying once keeps their existing priority and default edit commands
 * intact, including extension, Lexical and Monaco shortcuts. The original event
 * is cancelled, so a command cannot run twice. The replay already has US keys.
 */
export function installPhysicalShortcuts(contents: WebContents): () => void {
  let rightAltDown = false;
  let replaying = false;
  contents.on('before-input-event', (event, input) => {
    if (input.code === 'AltRight') rightAltDown = input.type === 'keyDown';
    if (replaying) return;
    const keyCode = physicalShortcutKey(input, rightAltDown);
    if (!keyCode || (input.type !== 'keyDown' && input.type !== 'keyUp')) return;
    event.preventDefault();
    const modifiers: NonNullable<KeyboardInputEvent['modifiers']> = [];
    if (input.control) modifiers.push('control');
    if (input.meta) modifiers.push('meta');
    if (input.alt) modifiers.push('alt');
    if (input.shift) modifiers.push('shift');
    if (input.isAutoRepeat) modifiers.push('isautorepeat');
    replaying = true;
    try { contents.sendInputEvent({ type: input.type as 'keyDown' | 'keyUp', keyCode, modifiers }); }
    finally { replaying = false; }
  });
  return () => { rightAltDown = false; };
}
