/** Colours shared by every page, with a dark variant. Tier colours carry meaning, everything else stays neutral. */
export const TOKENS_CSS = `:root{--bg:#edf1f5;--surface:#fff;--ink:#18213a;--muted:#525d78;--line:#c9d1de;--chip:#e0e6ee;--tg:#1b6fb5;--link:#1b6fb5;--focus:#1b6fb5;
--liq:#8a1c2b;--urgent:#d6453d;--warning:#e27d2a;--watch:#d9a21b;--safe:#2e9e6b}
@media (prefers-color-scheme:dark){:root{--bg:#0f1626;--surface:#17203a;--ink:#e8ecf5;--muted:#a3aec8;--line:#2c3758;--chip:#232e4d;--tg:#2a82cf;--link:#7db8f0;--focus:#7db8f0;
--liq:#c2334a;--urgent:#e8605a;--warning:#ea9144;--watch:#e2b12e;--safe:#3bb47d}}`;

export const SERIF = `ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif`;
export const SANS = `system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const MARK_INNER = `<rect width="512" height="512" rx="112" fill="#18213a"/><defs><clipPath id="tw-c"><rect x="64" y="160" width="384" height="192" rx="36"/></clipPath></defs><g clip-path="url(#tw-c)"><rect x="64" y="160" width="96" height="192" fill="#c2334a"/><rect x="160" y="160" width="96" height="192" fill="#ea9144"/><rect x="256" y="160" width="192" height="192" fill="#3bb47d"/></g><line x1="256" y1="100" x2="256" y2="412" stroke="#18213a" stroke-width="48" stroke-linecap="round"/><line x1="256" y1="100" x2="256" y2="412" stroke="#fff" stroke-width="26" stroke-linecap="round"/>`;

/** The Tripwire mark: three zones, and the line between danger and safe. Inline, so it needs no request and no third party. */
export const MARK_SVG = `<svg class="logo" viewBox="0 0 512 512" aria-hidden="true" focusable="false">${MARK_INNER}</svg>`;

/** The same mark as a data: URL for the browser tab. */
export const FAVICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${MARK_INNER}</svg>`)}`;

export const LOGO_CSS = `.brand{display:inline-flex;align-items:center;gap:.55rem}.logo{width:1.75rem;height:1.75rem;flex:none}.top{gap:.5rem 1rem;flex-wrap:wrap}.top nav{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;justify-content:flex-end}`;
