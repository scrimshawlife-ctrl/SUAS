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
    parts.push(` ${name}="${escapeHtml(String(value))}"`);
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
