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

  // Mid-roll the element holds both the outgoing and incoming glyph for every
  // slot, so textContent would read as interleaved nonsense. Once a roll has
  // run, its target is the truth. Otherwise fall back to the markup's own text,
  // collapsed — the title spans several source lines and is full of indentation.
  const from =
    el.dataset.rollTarget !== undefined
      ? el.dataset.rollTarget
      : el.textContent.replace(/\s+/g, ' ').trim();
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

/**
 * Roll back to whatever the element said before the first roll.
 *
 * The roll itself can only animate plain text, which would leave the title as a
 * flat string with its link gone. So it rolls toward the original's *text*, and
 * swaps the real markup back in once it lands — the link and its arrow return
 * at the moment the animation finishes, not before.
 */
export function rollRestore(el, opts = {}) {
  if (!el || el.dataset.rollOriginal === undefined) return Promise.resolve();

  const original = el.dataset.rollOriginal;
  const probe = document.createElement('div');
  probe.innerHTML = original;
  const plain = probe.textContent.replace(/\s+/g, ' ').trim();

  return rollText(el, plain, opts).then(() => {
    if (el.dataset.rollTarget !== plain) return; // a newer roll took over
    el.innerHTML = original;
    delete el.dataset.rollTarget;
  });
}
