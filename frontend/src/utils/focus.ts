/** Keep Tab within an open overlay; never steal focus from a newer modal. */
export function trapTabKey(event: KeyboardEvent, root: HTMLElement | null) {
  if (event.key !== 'Tab' || !root) return;
  const active = document.activeElement as HTMLElement | null;
  if (active?.closest('[aria-modal="true"]') && !root.contains(active)) return;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
    ),
  ).filter((node) => node.getClientRects().length && !node.closest('[inert]'));
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    root.focus();
  } else if (event.shiftKey && (active === first || active === root || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || active === root || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
