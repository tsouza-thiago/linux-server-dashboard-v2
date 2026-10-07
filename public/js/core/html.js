// Template `html` com escape automático (ADR 0010): toda interpolação é escapada; HTML
// cru só entra por `raw()`, explícito e fácil de auditar (grep "raw(").
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escape(value) {
  return String(value ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
}

class SafeHtml {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

/** Marca um trecho como HTML já seguro. Use só com texto produzido pelo próprio código. */
export const raw = (text) => new SafeHtml(String(text));

function piece(value) {
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(piece).join('');
  if (value === null || value === undefined || value === false) return '';
  return escape(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += piece(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/**
 * A CSP não aceita `style="…"` (sem 'unsafe-inline'). Medidas e cores vindas dos dados vão em
 * atributos `data-*` e são aplicadas pelo CSSOM, que a CSP permite:
 * data-w / data-h / data-l = largura / altura / posição esquerda em % (0–100),
 * data-bg = token de cor (ex.: "s1", "ok"), data-op = opacidade (0–1).
 */
export function applyDataStyles(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const pct = (v) => `${Math.min(100, Math.max(0, Number(v) || 0))}%`;
  for (const el of root.querySelectorAll('[data-w],[data-h],[data-l],[data-bg],[data-op]')) {
    const d = el.dataset;
    if (d.w !== undefined) el.style.width = pct(d.w);
    if (d.h !== undefined) el.style.height = pct(d.h);
    if (d.l !== undefined) el.style.left = pct(d.l);
    if (d.bg && /^[a-z0-9-]+$/.test(d.bg)) el.style.background = `var(--${d.bg})`;
    if (d.op !== undefined) el.style.opacity = String(Math.min(1, Math.max(0, Number(d.op) || 0)));
  }
}

/** Troca o conteúdo do elemento pelo template (texto solto também é escapado). */
export function mount(el, template) {
  if (!el) return;
  el.innerHTML = template instanceof SafeHtml ? template.text : escape(template);
  applyDataStyles(el);
}

export const isSafe = (v) => v instanceof SafeHtml;
