/** A presentation-only transition after the first turn has been accepted. */
type FadingPart = { node: HTMLElement; rect: DOMRect };
export type ComposerOrigin = {
  rect: DOMRect;
  viewport: { width: number; height: number };
  fading: FadingPart[];
};

function motionAllowed() {
  return (
    typeof window.matchMedia === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    !window.matchMedia('(max-width: 700px), (max-height: 640px)').matches
  );
}

/** Capture while the welcome DOM is still mounted; never clone the user's input. */
export function captureComposerOrigin(): ComposerOrigin | null {
  try {
    if (!motionAllowed() || typeof Element.prototype.animate !== 'function') return null;
    const start = document.querySelector<HTMLElement>('.conversation-start-surface');
    const composer = start?.querySelector<HTMLElement>('.task-composer-hero');
    if (!start || !composer) return null;
    const rect = composer.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.top < 0 || rect.bottom > window.innerHeight) return null;
    const fading = Array.from(
      start.querySelectorAll<HTMLElement>('.conversation-start-heading, .conversation-start-discover'),
    ).map((element) => ({
      node: element.cloneNode(true) as HTMLElement,
      rect: element.getBoundingClientRect(),
    }));
    return { rect, viewport: { width: window.innerWidth, height: window.innerHeight }, fading };
  } catch {
    // Visual enhancements must never prevent an accepted turn from navigating.
    return null;
  }
}

/** Animate the real destination, not an interactive clone. Skip if the viewport changed. */
export function animateComposerArrival(origin: ComposerOrigin | null) {
  if (
    !origin ||
    !motionAllowed() ||
    origin.viewport.width !== window.innerWidth ||
    origin.viewport.height !== window.innerHeight
  )
    return;
  const target = document.querySelector<HTMLElement>('.enterprise-composer-area .task-composer');
  if (!target || !target.isConnected) return;
  const end = target.getBoundingClientRect();
  if (!end.width || !end.height || end.bottom > window.innerHeight) return;
  const dx = origin.rect.left - end.left;
  const dy = origin.rect.top - end.top;
  const sx = origin.rect.width / end.width;
  const sy = origin.rect.height / end.height;
  if (Math.abs(dy) < 1 || !Number.isFinite(sx) || !Number.isFinite(sy)) return;

  const overlays: HTMLElement[] = [];
  const animations: Animation[] = [];
  let observer: MutationObserver | undefined;
  const cleanup = () => {
    observer?.disconnect();
    window.removeEventListener('resize', cancel);
    overlays.forEach((node) => node.remove());
  };
  const cancel = () => {
    animations.forEach((animation) => animation.cancel());
    cleanup();
  };
  try {
    for (const { node, rect } of origin.fading) {
      node.inert = true;
      node.setAttribute('aria-hidden', 'true');
      node.removeAttribute('id');
      node.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'));
      Object.assign(node.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        margin: '0',
        pointerEvents: 'none',
        zIndex: '100',
      });
      document.body.appendChild(node);
      overlays.push(node);
      animations.push(node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }));
    }
    animations.push(
      target.animate(
        [
          { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)' },
        ],
        { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      ),
    );
    window.addEventListener('resize', cancel, { once: true });
    observer = new MutationObserver(() => {
      if (!target.isConnected) cancel();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Cancellation rejects Animation.finished; cleanup must not affect the turn.
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(cleanup);
  } catch {
    cancel();
  }
}
