import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * MAAT-IQ · MIQ.4 — El ESCÉPTICO (verificación adversarial determinista, ADR-028).
 *
 * Antes de que un hallazgo llegue al humano, intenta REFUTARLO con pruebas
 * deterministas (materialidad chica, muestra mínima, estacionalidad conocida).
 * Emite un veredicto `sostiene | debil | refutado` que baja el ranking de los
 * débiles SIN borrarlos (reversible, auditable — la refutación queda en la
 * evidencia). NO muta el score del detector → idempotente por ciclo. Corre tras
 * el scan y antes del aprendizaje: el veredicto es también feature del modelo,
 * que aprende si el escéptico acierta.
 */

const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const FLOOR: Record<string, number> = { riesgo: 5000, error_captura: 10000, oportunidad: 20000 };
/** rule_key → (campo de tamaño de muestra en evidencia, mínimo que se considera borderline). */
const SAMPLE: Record<string, { field: string; min: number }> = {
  gasto_atipico: { field: 'meses', min: 6 },
  nivel_nuevo_serie: { field: 'meses', min: 8 },
  peer_group_outlier: { field: 'pares', min: 3 },
  salto_precio_sku: { field: 'compras', min: 4 },
};
const SEASONAL_RULES = new Set(['gasto_atipico', 'nivel_nuevo_serie']);

@Injectable()
export class MaatSkepticService {
  private readonly logger = new Logger(MaatSkepticService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Revisa los hallazgos abiertos, fija veredicto + refutación. Idempotente. */
  async review(): Promise<{ revisados: number; refutado: number; debil: number; sostiene: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.findings')
        .where({ tenant_id: tenantId })
        .whereIn('status', ['nuevo', 'en_revision'])
        .select('id', 'rule_key', 'clase', 'severity', 'periodo', trx.raw('importe::numeric AS importe'), 'evidencia');
      const tally = { revisados: 0, refutado: 0, debil: 0, sostiene: 0 };
      for (const f of rows) {
        const ev = typeof f.evidencia === 'string' ? safe(f.evidencia) : (f.evidencia || {});
        const checks = this.refute(f, ev);
        const verdict = checks.length >= 2 ? 'refutado' : checks.length === 1 ? 'debil' : 'sostiene';
        await trx('finance.findings').where({ tenant_id: tenantId, id: f.id }).update({
          skeptic_verdict: verdict,
          evidencia: trx.raw(`jsonb_set(coalesce(evidencia,'{}'::jsonb), '{refutacion}', ?::jsonb)`, [JSON.stringify(checks)]),
          updated_at: trx.fn.now(),
        });
        tally.revisados++; (tally as any)[verdict]++;
      }
      this.logger.log(`escéptico: ${tally.revisados} revisados → ${tally.refutado} refutados · ${tally.debil} débiles · ${tally.sostiene} sostiene.`);
      return tally;
    });
  }

  private refute(f: any, ev: any): { check: string; motivo: string }[] {
    const checks: { check: string; motivo: string }[] = [];
    const importe = Number(f.importe) || 0;

    // 1. materialidad: monto por debajo del piso de la clase (solo hallazgos monetarios)
    const floor = FLOOR[f.clase] ?? 5000;
    if (importe > 0 && importe < floor) {
      checks.push({ check: 'materialidad', motivo: `importe ${money(importe)} bajo el piso de materialidad (${money(floor)})` });
    }

    // 2. muestra mínima: el estadístico está en el borde (poca evidencia)
    const s = SAMPLE[f.rule_key];
    if (s) {
      const n = Number(ev?.[s.field]);
      if (isFinite(n) && n <= s.min) checks.push({ check: 'muestra_minima', motivo: `solo ${n} ${s.field} — estadístico borderline` });
    }

    // 3. estacionalidad: series de gasto en diciembre suelen subir por cierre/aguinaldo
    if (SEASONAL_RULES.has(f.rule_key) && typeof f.periodo === 'string' && f.periodo.slice(5, 7) === '12') {
      checks.push({ check: 'estacionalidad', motivo: 'diciembre (cierre/aguinaldo) eleva el gasto estacionalmente' });
    }

    return checks;
  }
}

function safe(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
