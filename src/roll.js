// Odometer-style text roll: each character leaves upward while its replacement
// rises into the same slot, staggered left to right so the change ripples along
// the line rather than snapping all at once.

const DEFAULT_DURATION = 1100; // ms per character
const DEFAULT_STAGGER = 55; // ms between neighbouring characters

/**
 * Rolls an element's text over to something else.
 *
 * The element's original markup is stashed on first use, so `restore()` can put
 * it back exactly — links and all — rather than leaving a flat string behind.
 */
export function rollText(el, next, { duration = DEFAULT_DURATION, stagger = DEFAULT_STAGGER } = {}) {
  if (!el) return;
  if (el.dataset.rollOriginal === undefined) el.dataset.rollOriginal = el.innerHTML;

  // the title is written across several source lines, so its textContent is
  // full of indentation — collapse it or the roll animates whitespace
  const from = el.textContent.replace(/\s+/g, ' ').trim();
  const to = next;
  const len = Math.max(from.length, to.length);

  el.dataset.rollTarget = to;
  el.textContent = '';
  el.style.setProperty('--roll-dur', `${duration}ms`);

  const cells = [];
  for (let i = 0; i < len; i++) {
    const cell = document.createElement('span');
    cell.className = 'roll';

    const out = document.createElement('span');
    out.className = 'roll-out';
    out.textContent = from[i] ?? ' ';

    const inc = document.createElement('span');
    inc.className = 'roll-in';
    inc.textContent = to[i] ?? ' ';

    // the slot has to be as wide as whichever glyph is wider, or the line
    // jitters as characters swap
    cell.append(out, inc);
    el.append(cell);
    cells.push(cell);
  }

  // let layout settle before flipping the class, or the transition won't run
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      cells.forEach((cell, i) => {
        setTimeout(() => cell.classList.add('rolling'), i * stagger);
      });
    });
  });

  const total = duration + stagger * len;
  return new Promise((res) =>
    setTimeout(() => {
      // collapse back to plain text once it's landed, so the DOM stays tidy —
      // unless a newer roll has since claimed this element
      if (el.dataset.rollTarget === to) el.textContent = to;
      res();
    }, total + 60)
  );
}

/** Put the element back to the markup it had before the first roll. */
export function restoreText(el) {
  if (!el || el.dataset.rollOriginal === undefined) return;
  el.innerHTML = el.dataset.rollOriginal;
  delete el.dataset.rollTarget;
}
