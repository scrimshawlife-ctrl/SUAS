/**
 * HTML rendering security evidence.
 *
 * SUAS-specs SECURITY.md §5 (injection threats; veteran-authored text is data,
 * never markup); MVP_REFERENCE.md §13 (server-rendered strings).
 *
 * escapeHtml() closes the attribute/element-text vector; sanitizeUrl() closes
 * the residual URL-scheme vector (a `javascript:` href is not caught by
 * text-escaping). Together they keep untrusted data out of executable positions.
 */

import { describe, expect, it } from 'vitest';
import { a, element, escapeHtml, render, sanitizeUrl } from '../../src/ui/html.js';

describe('escapeHtml', () => {
  it('escapes every context-changing character', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('renders veteran-authored markup as text, not markup', () => {
    const injected = '<script>steal()</script>';
    const out = render(injected);
    expect(out).toBe('&lt;script&gt;steal()&lt;/script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('escapes quoted attribute values', () => {
    const out = element('span', { title: 'a" onmouseover="x' }).__safeHtml;
    expect(out).not.toContain('onmouseover="x"');
    expect(out).toContain('&quot;');
  });
});

describe('sanitizeUrl', () => {
  it('passes relative and same-document references through unchanged', () => {
    for (const url of ['/app/home', 'app/resources', '?cursor=abc', '#main', '']) {
      expect(sanitizeUrl(url)).toBe(url);
    }
  });

  it('passes safe schemes through unchanged', () => {
    expect(sanitizeUrl('https://example.org/help')).toBe('https://example.org/help');
    expect(sanitizeUrl('HTTP://example.org')).toBe('HTTP://example.org');
    expect(sanitizeUrl('mailto:intake@example.org')).toBe('mailto:intake@example.org');
    expect(sanitizeUrl('tel:frontdesk')).toBe('tel:frontdesk');
  });

  it('defangs dangerous schemes to "#"', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#');
    expect(sanitizeUrl('  javascript:alert(1)')).toBe('#');
    expect(sanitizeUrl('JaVaScRiPt:alert(1)')).toBe('#');
    expect(sanitizeUrl('data:text/html,<script>x</script>')).toBe('#');
    expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('#');
  });
});

describe('URL attributes are sanitized at render time', () => {
  it('neutralizes a javascript: href but keeps the element', () => {
    const out = a({ href: 'javascript:alert(1)' }, 'Click').__safeHtml;
    expect(out).toContain('href="#"');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('>Click</a>');
  });

  it('leaves a safe href unchanged', () => {
    expect(a({ href: '/app/home' }, 'Home').__safeHtml).toContain('href="/app/home"');
  });

  it('sanitizes src as well as href', () => {
    expect(element('img', { src: 'javascript:alert(1)' }).__safeHtml).toContain('src="#"');
  });

  it('does not alter a non-URL attribute that happens to contain a colon', () => {
    expect(element('span', { 'data-note': 'time: now' }).__safeHtml).toContain(
      'data-note="time: now"',
    );
  });
});
