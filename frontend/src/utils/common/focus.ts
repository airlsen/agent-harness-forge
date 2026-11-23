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

const modalBackgrounds = new WeakMap<HTMLElement, { count: number; inert: boolean; hidden: string | null }>();
/** Teleported dialogs remain outside #app. Hide the background from interaction
 * and assistive technology, restoring its exact state when the last dialog closes.
 */
export function isolateModalBackground(): () => void {
  const app = document.getElementById('app');
  if (!app) return () => {};
  let state = modalBackgrounds.get(app);
  if (!state) {
    state = { count: 0, inert: app.inert, hidden: app.getAttribute('aria-hidden') };
    modalBackgrounds.set(app, state);
  }
  ++state.count;
  app.inert = true;
  app.setAttribute('aria-hidden', 'true');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.count) return;
    app.inert = state.inert;
    if (state.hidden === null) app.removeAttribute('aria-hidden');
    else app.setAttribute('aria-hidden', state.hidden);
    modalBackgrounds.delete(app);
  };
}
