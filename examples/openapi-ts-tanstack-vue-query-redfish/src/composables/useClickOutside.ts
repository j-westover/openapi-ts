/**
 * Tiny `mousedown`-outside helper for the AppHeader's dropdowns.
 *
 * Prefer this over a third-party library to keep the example's
 * dependency surface minimal. Listens during the capture phase so it
 * fires before any toggle handler that might re-open the menu.
 */

import { onBeforeUnmount, onMounted, type Ref } from 'vue';

export function useClickOutside(
  elementRef: Ref<HTMLElement | null>,
  callback: (event: MouseEvent) => void,
): void {
  function handler(event: MouseEvent): void {
    const el = elementRef.value;
    if (!el) return;
    if (event.target instanceof Node && el.contains(event.target)) return;
    callback(event);
  }

  onMounted(() => document.addEventListener('mousedown', handler, true));
  onBeforeUnmount(() => document.removeEventListener('mousedown', handler, true));
}
