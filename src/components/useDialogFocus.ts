import { useEffect, type RefObject } from 'react';

// aria-modal dialogs: move focus in, keep Tab/Shift+Tab inside, hand focus back to the opener on close.
export function useDialogFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const a = document.activeElement as HTMLElement | null;
    const opener = ref.current?.contains(a) ? null : a; // StrictMode re-run: focus is already inside
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current;
      if (e.key !== 'Tab' || !box) return;
      const items = box.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1], cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus(); };
  }, [ref]);
}
