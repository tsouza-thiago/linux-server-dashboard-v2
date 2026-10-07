// Regras de alerta declarativas (ADR 0006). Cada condição tem uma chave estável
// (`disk:/mnt/x:usage`, `temp:cpu`, `service:smbd`...) que não muda com o valor: a mesma
// condição que persiste atualiza o mesmo alerta em vez de criar outro (corrige B3).
// Limiares com histerese: dispara em `limiar` e só limpa quando cai `histerese` abaixo.

export const OFFLINE_KEY = 'servidor-inacessivel';

// Estados de serviço que não indicam parada.
export const SERVICE_OK = new Set(['active', 'reloading', 'activating']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function ramPct(s) {
  const r = s?.ram;
  return r && isNum(r.used) && isNum(r.total) && r.total > 0 ? (r.used / r.total) * 100 : null;
}

/**
 * Regras para um conjunto de limiares. `section` diz se a amostra trouxe aquela parte:
 * sem a seção (ou com valor nulo) o estado do alerta é desconhecido e ele não é resolvido.
 */
export function rulesFor(t) {
  return [
    {
      id: 'disk', prefix: 'disk:', level: 'warning', fire: t.diskPct, clear: t.diskPct - t.hysteresis,
      section: (s) => s.disks,
      items: (s) => (s.disks || []).filter((d) => d && d.mount).map((d) => ({
        key: `disk:${d.mount}:usage`,
        value: isNum(d.pct) ? d.pct : null,
        message: (v) => `Disco ${d.mount} com ${v}% usado`,
      })),
    },
    {
      id: 'ram', prefix: 'ram:', level: 'warning', fire: t.ramPct, clear: t.ramPct - t.hysteresis,
      section: (s) => s.ram,
      items: (s) => [{ key: 'ram:usage', value: ramPct(s), message: (v) => `RAM usada em ${v.toFixed(0)}%` }],
    },
    {
      id: 'temp', prefix: 'temp:', level: 'warning', fire: t.tempC, clear: t.tempC - t.hysteresis,
      section: (s) => s.tempC,
      items: (s) => [{ key: 'temp:cpu', value: isNum(s.tempC) ? s.tempC : null, message: (v) => `Temperatura CPU ${v.toFixed(1)}°C` }],
    },
    {
      id: 'smart', prefix: 'smart:', level: 'critical',
      section: (s) => s.smart,
      items: (s) => (s.smart || []).filter((x) => x && x.dev).map((x) => ({
        key: `smart:${x.dev}`,
        failing: x.status ? x.status === 'FAILED' : null,
        message: () => `SMART /dev/${x.dev}: FAILED`,
      })),
    },
    {
      id: 'service', prefix: 'service:', level: 'critical',
      section: (s) => s.services,
      items: (s) => Object.entries(s.services || {}).map(([name, state]) => ({
        key: `service:${name}`,
        // Sem resposta do systemctl ("desconhecido") não é parada confirmada.
        failing: !state || state === 'desconhecido' ? null : !SERVICE_OK.has(state),
        message: () => `Serviço ${name} ${state}`,
      })),
    },
  ];
}

/**
 * Avalia a amostra contra as regras.
 * @param {object} sample amostra (v1 ou v2)
 * @param {object} t limiares (config.ALERTS)
 * @param {Set<string>} active chaves com alerta aberto (para a histerese)
 * @returns {{conditions: object[], unknown: Set<string>}} condições presentes e chaves
 *   abertas cujo estado não dá para saber nesta amostra (não devem ser resolvidas)
 */
export function evaluate(sample, t, active = new Set()) {
  const conditions = [];
  const unknown = new Set();
  for (const rule of rulesFor(t)) {
    const section = rule.section(sample);
    if (section === null || section === undefined) {
      for (const key of active) if (key.startsWith(rule.prefix)) unknown.add(key);
      continue;
    }
    for (const item of rule.items(sample)) {
      let on;
      if ('failing' in item) {
        on = item.failing;
      } else if (item.value === null) {
        on = null;
      } else {
        const stillOn = t.hysteresis > 0 ? item.value > rule.clear : item.value >= rule.fire;
        on = active.has(item.key) ? stillOn : item.value >= rule.fire;
      }
      if (on === null) {
        if (active.has(item.key)) unknown.add(item.key);
      } else if (on) {
        conditions.push({ key: item.key, level: rule.level, message: item.message(item.value), value: item.value ?? null });
      }
    }
  }
  return { conditions, unknown };
}
