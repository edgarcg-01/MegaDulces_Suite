import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * MAAT-IQ · MIQ.3 — Cobertura probada / anti-punto-ciego (ADR-028).
 *
 * Responde "¿qué NO estamos revisando?". Una taxonomía canónica de riesgo
 * financiero mapea cada categoría a los detectores que deberían cubrirla; el
 * servicio contrasta contra `finance.rule_registry` (lo que realmente está
 * activo). Una categoría sin NINGÚN detector activo (faltante, deshabilitado o
 * auto-suprimido por ruido) es un PUNTO CIEGO → se emite como hallazgo, así el
 * humano ve el hueco en la misma bandeja en vez de descubrirlo a mano.
 *
 * `coverage()` = reporte para el tablero. `detBlindSpots()` = detector delegado
 * (mismo camino UPSERT/feedback/learning que el resto del motor).
 */

interface CoverageFinding {
  rule_key: string; severity: 'info' | 'warn' | 'critical'; score: number;
  titulo: string; resumen: string; entity: Record<string, any>;
  periodo: string | null; importe: number; evidencia: Record<string, any>; dedup_key: string;
}

/** Taxonomía de riesgo financiero → detectores esperados. Categorías críticas marcadas. */
const CATEGORIES: { key: string; nombre: string; critica: boolean; rules: string[] }[] = [
  { key: 'fraude', nombre: 'Fraude / manipulación', critica: true, rules: ['benford_importes', 'posible_duplicado', 'proveedor_nuevo_grande', 'peer_group_outlier'] },
  { key: 'deducibilidad_sat', nombre: 'Deducibilidad / SAT', critica: true, rules: ['compra_sin_rfc', 'cfdi_sin_poliza', 'poliza_sin_cfdi', 'cfdi_total_cero'] },
  { key: 'error_captura', nombre: 'Errores de captura', critica: false, rules: ['compra_sin_rfc', 'iva_capitalizado', 'prov_203_orfano', 'anticipo_stale', 'cfdi_total_cero'] },
  { key: 'materialidad', nombre: 'Materialidad / cadena', critica: true, rules: ['cadena_incompleta'] },
  { key: 'gasto_anomalo', nombre: 'Gasto anómalo', critica: false, rules: ['gasto_atipico', 'nivel_nuevo_serie', 'peer_group_outlier'] },
  { key: 'precio_costo', nombre: 'Precio / costo', critica: false, rules: ['salto_precio_sku', 'spread_proveedor_sku'] },
  { key: 'proveedor_liquidez', nombre: 'Proveedores / liquidez', critica: false, rules: ['dpo_largo', 'proveedor_nuevo_grande'] },
];

@Injectable()
export class MaatCoverageService {
  private readonly logger = new Logger(MaatCoverageService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Reporte de cobertura por categoría (para el tablero). */
  async coverage(): Promise<any> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();
      const cats = await this.computeCoverage(trx, tenantId);
      const puntos_ciegos = cats.filter((c) => c.activos === 0).map((c) => c.key);
      return {
        categorias: cats,
        total_categorias: cats.length,
        puntos_ciegos,
        cobertura_pct: Math.round((cats.filter((c) => c.activos > 0).length / cats.length) * 100),
      };
    });
  }

  /** Detector delegado: emite un hallazgo por categoría sin cobertura activa. */
  async detBlindSpots(trx: any, tenantId: string, _p: any): Promise<CoverageFinding[]> {
    const cats = await this.computeCoverage(trx, tenantId);
    const out: CoverageFinding[] = [];
    for (const c of cats) {
      if (c.activos > 0) continue;
      const soloSuprimidos = c.registrados > 0 && c.suprimidos >= c.registrados;
      out.push({
        rule_key: 'cobertura_punto_ciego',
        severity: c.critica ? 'critical' : 'warn',
        score: c.critica ? 0.9 : 0.5,
        titulo: `Punto ciego: sin detección activa para "${c.nombre}"`,
        resumen: `La categoría de riesgo "${c.nombre}" no tiene ningún detector activo${soloSuprimidos ? ' (todos se auto-suprimieron por ruido — revisar o fijar)' : ' (faltan o están deshabilitados)'}. Nadie está vigilando este riesgo. Detectores esperados: ${c.rules.join(', ')}.`,
        entity: { categoria: c.key },
        periodo: null, importe: 0,
        evidencia: { categoria: c.key, esperados: c.rules, registrados: c.registrados, activos: c.activos, suprimidos: c.suprimidos, solo_suprimidos: soloSuprimidos },
        dedup_key: `cobertura_punto_ciego|${c.key}`,
      });
    }
    return out;
  }

  private async computeCoverage(trx: any, tenantId: string) {
    const reg = await trx('finance.rule_registry').where('tenant_id', tenantId)
      .select('rule_key', 'enabled', 'suppressed_auto', 'findings_total', 'precision_score');
    const byKey = new Map<string, any>(reg.map((r: any) => [r.rule_key, r]));
    return CATEGORIES.map((c) => {
      let registrados = 0, activos = 0, suprimidos = 0, findings = 0;
      for (const rk of c.rules) {
        const r = byKey.get(rk);
        if (!r) continue;
        registrados++;
        findings += Number(r.findings_total || 0);
        if (r.suppressed_auto) suprimidos++;
        if (r.enabled && !r.suppressed_auto) activos++;
      }
      return { key: c.key, nombre: c.nombre, critica: c.critica, rules: c.rules, registrados, activos, suprimidos, findings };
    });
  }
}
