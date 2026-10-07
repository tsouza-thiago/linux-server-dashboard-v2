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

/** Troca o conteúdo do elemento pelo template (texto solto também é escapado). */
export function mount(el, template) {
  if (!el) return;
  el.innerHTML = template instanceof SafeHtml ? template.text : escape(template);
}

export const isSafe = (v) => v instanceof SafeHtml;
