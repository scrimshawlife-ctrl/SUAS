/**
 * Presentation rules, as one inlined stylesheet.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §4 (action first, low cognitive load, mobile
 *   first, strong operational states, no enterprise-density drift)
 * - SUAS-specs MVP_REFERENCE.md §10 (WCAG 2.2 AA: focus visible, large touch
 *   targets, text zoom/reflow, non-color-only meaning, reduced motion)
 * - SUAS-specs MVP_REFERENCE.md §13 (non-goal: freezing CSS/framework technology)
 *
 * Values here are accessibility floors taken from WCAG 2.2 AA, not brand
 * decisions: 24x24 CSS px minimum target size (2.5.8), visible focus (2.4.7,
 * 2.4.11), reflow at 320 CSS px (1.4.10), and text spacing tolerance (1.4.12).
 * The MVP's own palette and typography are product identity that the reference
 * governs and this implementation does not invent.
 */

/**
 * Minimum target size in CSS pixels. WCAG 2.2 AA 2.5.8 sets 24; the reference's
 * "large action targets" (§4.2) and mobile-first critical paths (§4.7) justify
 * the larger floor on primary actions.
 */
export const MIN_TARGET_PX = 24;
export const PRIMARY_TARGET_PX = 48;

export const STYLESHEET = `
:root {
  --ink: #10151c;
  --ink-muted: #46525f;
  --surface: #ffffff;
  --surface-sunken: #f2f4f7;
  --line: #c7ced6;
  --action: #14425f;
  --action-ink: #ffffff;
  --focus: #b4530a;
  color-scheme: light;
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  /* Relative units so text zoom and reflow (1.4.10, 1.4.4) work. */
  font: 1rem/1.5 system-ui, sans-serif;
  color: var(--ink);
  background: var(--surface);
}

/* 1.4.12 text spacing: never clip on user-adjusted spacing. */
p, li, dd { overflow-wrap: break-word; }

.shell {
  max-width: 34rem;
  margin: 0 auto;
  /* Room for the fixed bottom nav so it never covers the last action. */
  padding: 1rem 1rem 5.5rem;
}

h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 0.5rem; }
h2 { font-size: 1.2rem; line-height: 1.3; margin: 1.5rem 0 0.5rem; }
h3 { font-size: 1rem; margin: 1rem 0 0.25rem; }

/* 2.4.7 / 2.4.11 focus is always visible and never clipped. */
:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
}

.action, .action-secondary {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: ${String(PRIMARY_TARGET_PX)}px;
  padding: 0.75rem 1rem;
  margin: 0.5rem 0;
  border-radius: 0.5rem;
  font-size: 1.05rem;
  font-weight: 600;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
}

.action {
  background: var(--action);
  color: var(--action-ink);
  border: 2px solid var(--action);
}

.action-secondary {
  background: var(--surface);
  color: var(--action);
  border: 2px solid var(--action);
}

/* 2.5.8 target size floor for every remaining interactive element. */
a, button, input, [role="button"] {
  min-height: ${String(MIN_TARGET_PX)}px;
}

.card-grid {
  display: grid;
  /* Reflows to one column at 320 CSS px without horizontal scrolling (1.4.10). */
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.75rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.card {
  display: block;
  min-height: 5rem;
  padding: 0.75rem;
  border: 2px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--ink);
  text-decoration: none;
}

.card-unavailable { background: var(--surface-sunken); }

/*
 * 1.4.1 use of color: every state carries a text label. The badge adds
 * emphasis, it does not carry the meaning on its own.
 */
.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--line);
  border-radius: 1rem;
  font-size: 0.8rem;
  font-weight: 600;
}

.state {
  padding: 0.75rem;
  border: 2px solid var(--line);
  border-left-width: 0.4rem;
  border-radius: 0.375rem;
  background: var(--surface-sunken);
}

.reserved-slot {
  padding: 0.75rem;
  border: 2px dashed var(--line);
  border-radius: 0.5rem;
  background: var(--surface-sunken);
  color: var(--ink-muted);
}

.mobile-nav {
  position: fixed;
  inset: auto 0 0 0;
  display: flex;
  border-top: 2px solid var(--line);
  background: var(--surface);
}

.mobile-nav a {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: ${String(PRIMARY_TARGET_PX)}px;
  padding: 0.5rem;
  color: var(--action);
  font-weight: 600;
  text-decoration: none;
}

.mobile-nav a[aria-current="page"] { text-decoration: underline; }

.muted { color: var(--ink-muted); }

.skip-link {
  position: absolute;
  left: -9999px;
}

.skip-link:focus {
  left: 0;
  top: 0;
  padding: 0.75rem;
  background: var(--action);
  color: var(--action-ink);
}

/* 2.3.3 animation from interactions. Nothing here animates, and this keeps it so. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`.trim();
