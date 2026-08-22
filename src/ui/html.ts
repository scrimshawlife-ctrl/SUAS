/**
 * Minimal HTML construction.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §13 (non-goal: freezing CSS/framework technology)
 * - SUAS-specs MVP_REFERENCE.md §11 (repeatable, deterministic fixture comparison)
 *
 * There is no template engine and no client framework. The reference contract
 * governs hierarchy and behavior, not technology, and a server-rendered string
 * is the smallest thing that renders the required surfaces, stays deterministic
 * for fixtures, and keeps the accessibility tree inspectable without a browser.
 */

/** Characters that change parse context inside markup or an attribute value. */
const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape untrusted text for both element content and quoted attribute values.
 *
 * Every value that reaches markup passes through here. Veteran-authored text
 * (a Case note, a resource name, a chat message) is data, never markup.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/**
 * Attributes whose value is a URL, and therefore a script-injection surface that
 * text-escaping alone does not close.
 */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'xlink:href',
]);

/** Schemes safe to keep on a URL attribute. Everything else is defanged. */
const SAFE_URL_SCHEME = /^(?:https?:|mailto:|tel:)/i;
/** A leading scheme token, e.g. `javascript:` or `data:`. */
const LEADING_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Neutralize a dangerous scheme in a URL-bearing attribute.
 *
 * `escapeHtml` makes a value safe as quoted attribute *text*, but it does not
 * stop a `javascript:` / `data:` / `vbscript:` scheme from executing when the
 * attribute is a URL (e.g. an `<a href>`): those schemes contain none of the
 * characters `escapeHtml` rewrites. Relative and same-document references (which
 * carry no scheme) and an allow-list of safe schemes pass through unchanged;
 * anything else is defanged to `#`.
 *
 * Defense-in-depth: no current surface routes untrusted data into a URL
 * attribute, and every existing href is relative or same-document, so this
 * changes no rendered output today. It exists so a future surface cannot
 * introduce script through a URL attribute (SECURITY.md §5 injection threats;
 * the same "veteran text is data, never markup" rule `escapeHtml` enforces).
 */
export function sanitizeUrl(value: string): string {
  const trimmed = value.trim();
  // No scheme (relative path, query, fragment, or bare path) — safe by design.
  if (!LEADING_SCHEME.test(trimmed)) return trimmed;
  return SAFE_URL_SCHEME.test(trimmed) ? trimmed : '#';
}

/** A rendered fragment that is already escaped and must not be escaped again. */
export interface SafeHtml {
  readonly __safeHtml: string;
}

export function raw(markup: string): SafeHtml {
  return { __safeHtml: markup };
}

function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === 'object' && value !== null && '__safeHtml' in value;
}

export type Renderable = string | number | SafeHtml | undefined | null | readonly Renderable[];

/** `Array.isArray` widens a readonly union to `any[]`; this keeps the element type. */
function isRenderableArray(value: Renderable): value is readonly Renderable[] {
  return Array.isArray(value);
}

/** Flatten a renderable tree into markup, escaping every plain string. */
export function render(node: Renderable): string {
  if (node === undefined || node === null) return '';
  if (isRenderableArray(node)) return node.map((child) => render(child)).join('');
  if (isSafeHtml(node)) return node.__safeHtml;
  if (typeof node === 'number') return String(node);
  return escapeHtml(node);
}

export type Attributes = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Serialize attributes. `true` renders a bare boolean attribute, `false` and
 * `undefined` omit it entirely, so an absent affordance leaves no trace in the
 * markup rather than rendering a disabled-looking shell.
 */
function attributes(attrs: Attributes): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (value === true) {
      parts.push(` ${name}`);
      continue;
    }
    const text = URL_ATTRIBUTES.has(name.toLowerCase())
      ? sanitizeUrl(String(value))
      : String(value);
    parts.push(` ${name}="${escapeHtml(text)}"`);
  }
  return parts.join('');
}

/** Elements with no closing tag. */
const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

export function element(tag: string, attrs: Attributes = {}, ...children: Renderable[]): SafeHtml {
  const open = `<${tag}${attributes(attrs)}>`;
  if (VOID_ELEMENTS.has(tag)) return raw(open);
  return raw(`${open}${render(children)}</${tag}>`);
}

/** Curried element helper, so surfaces read as markup rather than function calls. */
function tagFn(tag: string) {
  return (attrs: Attributes = {}, ...children: Renderable[]): SafeHtml =>
    element(tag, attrs, ...children);
}

export const h1 = tagFn('h1');
export const h2 = tagFn('h2');
export const h3 = tagFn('h3');
export const p = tagFn('p');
export const div = tagFn('div');
export const span = tagFn('span');
export const ul = tagFn('ul');
export const li = tagFn('li');
export const a = tagFn('a');
export const button = tagFn('button');
export const section = tagFn('section');
export const nav = tagFn('nav');
export const main = tagFn('main');
export const header = tagFn('header');
export const footer = tagFn('footer');
export const form = tagFn('form');
export const label = tagFn('label');
export const input = tagFn('input');
export const dl = tagFn('dl');
export const dt = tagFn('dt');
export const dd = tagFn('dd');
