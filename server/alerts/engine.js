// Motor de alertas (ADR 0006): aplica as regras com histerese a cada coleta, segura o
// alerta de servidor inacessível até N falhas seguidas (debounce, padrão 2 ≈ 2 min) e
// registra as quedas no log próprio. Os limiares vêm do .env (config.ALERTS).
import { evaluate, OFFLINE_KEY } from './rules.js';
import { healthScore } from './health.js';

export class AlertEngine {
  /**
   * @param {object} opts
   * @param {import('../stores.js').AlertsStore} opts.alerts
   * @param {import('../storage/outages.js').OutageLog} opts.outages
   * @param {object} opts.thresholds config.ALERTS
   */
  constructor({ alerts, outages, thresholds, now = () => Date.now() }) {
    this.alerts = alerts;
    this.outages = outages;
    this.t = thresholds;
    this.now = now;
    this.failures = 0;
    this.firstFailureAt = null;
    this.firstError = null;
    // Reiniciado no meio de uma queda: continua offline até a próxima coleta OK.
    this.offline = outages.isOpen || alerts.active.some((a) => a.key === OFFLINE_KEY);
  }

  /** Início da queda em andamento (ISO), ou null. */
  get offlineSince() {
    if (!this.offline) return null;
    const open = this.outages.list({ fromMs: -Infinity }).find((o) => o.ongoing);
    return open ? open.from : (this.firstFailureAt ? new Date(this.firstFailureAt).toISOString() : null);
  }

  /** Coleta OK: fecha a queda, se havia, e reconcilia os alertas da amostra. */
  onSample(sample) {
    const at = Date.parse(sample?.ts);
    this.failures = 0;
    this.firstFailureAt = null;
    this.firstError = null;
    if (this.offline) {
      this.outages.end(Number.isFinite(at) ? at : this.now());
      this.offline = false;
    }
    const active = new Set(this.alerts.active.map((a) => a.key).filter(Boolean));
    const { conditions, unknown } = evaluate(sample, this.t, active);
    this.alerts.reconcile(conditions, { keep: unknown });
    return conditions;
  }

  /**
   * Coleta falhou. Só depois de `offlineAfter` falhas seguidas o servidor vira
   * inacessível; a queda começa no instante da 1ª falha.
   */
  onFailure(error) {
    this.failures += 1;
    if (this.firstFailureAt === null) {
      this.firstFailureAt = this.now();
      this.firstError = error;
    }
    if (this.offline || this.failures >= this.t.offlineAfter) {
      this.offline = true;
      this.outages.start(this.firstFailureAt, this.firstError);
      // Nada foi medido: os outros alertas abertos ficam como estão.
      this.alerts.reconcile([{ key: OFFLINE_KEY, level: 'critical', message: `Servidor inacessível: ${error}` }], { keep: 'all' });
    }
    return { offline: this.offline, failures: this.failures };
  }

  health(sample) {
    return healthScore(sample, this.t, { offline: this.offline });
  }
}
