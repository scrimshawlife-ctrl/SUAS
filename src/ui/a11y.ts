/**
 * Structural accessibility checks over rendered markup.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §10 (WCAG 2.2 AA: logical reading/focus order,
 *   keyboard operation, visible focus, non-color-only meaning, large touch
 *   targets, text zoom/reflow, accessible icon names, reduced motion)
 * - SUAS-specs MVP_REFERENCE.md §12 (`UI_CONFORMANCE` requires accessibility
 *   checks to pass)
 *
 * Scope, stated plainly: these are the WCAG 2.2 AA failures that are decidable
 * from markup alone. Contrast ratios, focus *order* as experienced, reflow at
 * 320 CSS px, target size after layout, and screen-reader comprehensibility all
 * require rendering or human review, and none of them are checked here. A green
 * result is a floor, not a conformance claim — §12's gate is reviewed evidence,
 * which this slice does not attempt to satisfy on its own.
 */

export interface AccessibilityFinding {
  /** WCAG 2.2 success criterion, so a finding is traceable to the standard. */
  readonly criterion: string;
  readonly message: string;
}

export type MarkupKind = 'DOCUMENT' | 'FRAGMENT';

/** Strip tags to recover the text a user would perceive. */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, '').trim();
}

function attributeOf(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return match?.[1];
}

/** 3.1.1 Language of Page. */
function checkLanguage(markup: string, findings: AccessibilityFinding[]): void {
  const html = /<html[^>]*>/i.exec(markup)?.[0];
  if (html === undefined || attributeOf(html, 'lang') === undefined) {
    findings.push({
      criterion: '3.1.1 Language of Page',
      message: 'The document has no lang attribute on <html>.',
    });
  }
}

/** 1.4.4 Resize Text — a viewport that blocks zoom fails at AA. */
function checkZoom(markup: string, findings: AccessibilityFinding[]): void {
  const meta = /<meta[^>]+name="viewport"[^>]*>/i.exec(markup)?.[0];
  if (meta === undefined) {
    findings.push({
      criterion: '1.4.4 Resize Text',
      message: 'No viewport meta element; mobile reflow is undefined.',
    });
    return;
  }
  const content = attributeOf(meta, 'content') ?? '';
  if (/user-scalable\s*=\s*no/i.test(content)) {
    findings.push({
      criterion: '1.4.4 Resize Text',
      message: 'The viewport disables zoom with user-scalable=no.',
    });
  }
  const maximum = /maximum-scale\s*=\s*([\d.]+)/i.exec(content)?.[1];
  if (maximum !== undefined && Number(maximum) < 2) {
    findings.push({
      criterion: '1.4.4 Resize Text',
      message: `The viewport caps zoom at ${maximum}x, below the 2x minimum.`,
    });
  }
}

/** 1.3.1 Info and Relationships — one h1, and no skipped heading levels. */
function checkHeadings(markup: string, findings: AccessibilityFinding[]): void {
  const levels = [...markup.matchAll(/<h([1-6])[^>]*>/gi)].map((match) => Number(match[1]));
  const h1Count = levels.filter((level) => level === 1).length;

  if (h1Count === 0) {
    findings.push({
      criterion: '1.3.1 Info and Relationships',
      message: 'The surface has no <h1>.',
    });
  }
  if (h1Count > 1) {
    findings.push({
      criterion: '1.3.1 Info and Relationships',
      message: `The surface has ${String(h1Count)} <h1> elements; expected exactly one.`,
    });
  }

  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1] ?? 1;
    const current = levels[index] ?? 1;
    if (current > previous + 1) {
      findings.push({
        criterion: '1.3.1 Info and Relationships',
        message: `Heading level jumps from h${String(previous)} to h${String(current)}.`,
      });
    }
  }
}

/** 1.3.1 / 2.4.1 — a main landmark and a skip link. */
function checkLandmarks(markup: string, findings: AccessibilityFinding[]): void {
  if (!/<main[\s>]/i.test(markup)) {
    findings.push({
      criterion: '1.3.1 Info and Relationships',
      message: 'The document has no <main> landmark.',
    });
  }
  if (!/class="skip-link"/i.test(markup)) {
    findings.push({
      criterion: '2.4.1 Bypass Blocks',
      message: 'The document has no skip link.',
    });
  }
}

/** 4.1.2 Name, Role, Value — every control needs an accessible name. */
function checkControlNames(markup: string, findings: AccessibilityFinding[]): void {
  for (const match of markup.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const tag = `<${match[1] ?? ''}${match[2] ?? ''}>`;
    const inner = match[3] ?? '';
    const named =
      textOf(inner).length > 0 ||
      attributeOf(tag, 'aria-label') !== undefined ||
      attributeOf(tag, 'aria-labelledby') !== undefined ||
      attributeOf(tag, 'title') !== undefined;
    if (!named) {
      findings.push({
        criterion: '4.1.2 Name, Role, Value',
        message: `A <${match[1] ?? ''}> element has no accessible name.`,
      });
    }
  }
}

/** 3.3.2 Labels or Instructions — every input needs a programmatic label. */
function checkFormLabels(markup: string, findings: AccessibilityFinding[]): void {
  const labelledIds = new Set(
    [...markup.matchAll(/<label[^>]+for="([^"]+)"/gi)].map((match) => match[1] ?? ''),
  );

  for (const match of markup.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const type = attributeOf(tag, 'type') ?? 'text';
    // Submit and hidden inputs take their name from value or carry no name.
    if (type === 'hidden' || type === 'submit' || type === 'button') continue;

    const id = attributeOf(tag, 'id');
    const named =
      (id !== undefined && labelledIds.has(id)) ||
      attributeOf(tag, 'aria-label') !== undefined ||
      attributeOf(tag, 'aria-labelledby') !== undefined;
    if (!named) {
      findings.push({
        criterion: '3.3.2 Labels or Instructions',
        message: `An <input${id === undefined ? '' : ` id="${id}"`}> has no associated label.`,
      });
    }
  }
}

/** 2.4.3 Focus Order — a positive tabindex overrides document order. */
function checkTabOrder(markup: string, findings: AccessibilityFinding[]): void {
  for (const match of markup.matchAll(/\stabindex="(\d+)"/gi)) {
    if (Number(match[1]) > 0) {
      findings.push({
        criterion: '2.4.3 Focus Order',
        message: `A positive tabindex (${match[1] ?? ''}) overrides natural focus order.`,
      });
    }
  }
}

/** 1.1.1 Non-text Content. */
function checkImages(markup: string, findings: AccessibilityFinding[]): void {
  for (const match of markup.matchAll(/<img\b[^>]*>/gi)) {
    if (attributeOf(match[0], 'alt') === undefined) {
      findings.push({
        criterion: '1.1.1 Non-text Content',
        message: 'An <img> has no alt attribute.',
      });
    }
  }
}

/**
 * Run the decidable checks.
 *
 * `FRAGMENT` skips the document-level criteria (language, zoom, landmarks,
 * single h1) that a fragment cannot satisfy on its own.
 */
export function auditAccessibility(
  markup: string,
  kind: MarkupKind = 'DOCUMENT',
): readonly AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];

  if (kind === 'DOCUMENT') {
    checkLanguage(markup, findings);
    checkZoom(markup, findings);
    checkHeadings(markup, findings);
    checkLandmarks(markup, findings);
  }

  checkControlNames(markup, findings);
  checkFormLabels(markup, findings);
  checkTabOrder(markup, findings);
  checkImages(markup, findings);

  return findings;
}
