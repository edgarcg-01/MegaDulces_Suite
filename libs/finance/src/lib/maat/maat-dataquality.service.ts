import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * MAAT-IQ · MIQ.3 — Calidad de datos (ADR-028). Garbage in → hallazgos malos.
 *
 * Mide la completitud/validez de los feeds que alimentan al motor (analytics.*)
 * y produce un SCORE 0-100 por dimensión + índice global. Las dimensiones
 * degradadas se emiten como hallazgos (clase error_captura) — así el 55% de
 * compras sin RFC o el costo faltante dejan de ser invisibles. El score también
 * sirve de GATE de confianza: los detectores que dependen de un feed sucio valen
 * menos (lo consume el modelo/UI). Solo lee analytics.* + finance.findings
 * (frontera limpia de libs/finance).
 *
 * `report()` = tablero + persiste baseline. `detDataQuality()` = detector delegado.
 */

interface DqFinding {
  rule_key: string; severity: 'info' | 'warn' | 'critical'; score: number;
  titulo: string; resumen: string; entity: Record<string, any>;
  periodo: string | null; importe: number; evidencia: Record<string, any>; dedup_key: string;
}
interface Dim { key: string; nombre: string; weight: number; score: number; pct_malo: number; n: number; importe: number; detalle: string; }

const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const pctScore = (bad: number) => Math.max(0, Math.round(100 * (1 - bad)));

@Injectable()
export class MaatDataQualityService {
  private readonly logger = new Logger(MaatDataQualityService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async report(): Promise<any> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();
      const dims = await this.computeMetrics(trx, tenantId);
      const wsum = dims.reduce((a, d) => a + d.weight, 0) || 1;
      const overall = Math.round(dims.reduce((a, d) => a + d.score * d.weight, 0) / wsum);
      await trx.raw(
        `INSERT INTO finance.baselines (tenant_id, scope, key_text, key, stats, computed_at)
         VALUES (?, 'data_quality', 'global', '{"scope":"global"}'::jsonb, ?::jsonb, now())
         ON CONFLICT (tenant_id, scope, key_text) DO UPDATE SET stats = EXCLUDED.stats, computed_at = now()`,
        [tenantId, JSON.stringify({ overall, dims })],
      );
      return { indice_global: overall, semaforo: overall >= 80 ? 'verde' : overall >= 60 ? 'amarillo' : 'rojo', dimensiones: dims };
    });
  }

  async detDataQuality(trx: any, tenantId: string, p: any): Promise<DqFinding[]> {
    const warn = Number(p.umbral_warn) || 20;   // % malo
    const crit = Number(p.umbral_crit) || 40;
    const dims = await this.computeMetrics(trx, tenantId);
    const out: DqFinding[] = [];
    for (const d of dims) {
      const pctMalo = Math.round(d.pct_malo * 100);
      if (pctMalo < warn) continue;
      out.push({
        rule_key: 'calidad_datos',
        severity: pctMalo >= crit ? 'critical' : 'warn',
        score: Math.min(1, d.pct_malo),
        titulo: `Calidad de datos baja: ${d.nombre} (${pctMalo}%)`,
        resumen: `${d.detalle} Score ${d.score}/100. Mientras esté sucio, los hallazgos que dependen de este feed son menos confiables.`,
        entity: { dimension: d.key },
        periodo: null, importe: d.importe,
        evidencia: { score: d.score, pct_malo: pctMalo, n: d.n, importe: d.importe, umbral: warn },
        dedup_key: `calidad_datos|${d.key}`,
      });
    }
    return out;
  }

  private async computeMetrics(trx: any, tenantId: string): Promise<Dim[]> {
    const dims: Dim[] = [];

    // compras/gastos sin RFC (ponderado por importe)
    const docs = await trx.raw(
      `SELECT doc_tipo, SUM(importe)::numeric AS total,
              (SUM(importe) FILTER (WHERE rfc IS NULL OR btrim(rfc)=''))::numeric AS sin_rfc,
              COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE rfc IS NULL OR btrim(rfc)=''))::int AS n_sin
         FROM analytics.expense_documents WHERE tenant_id=? AND doc_tipo IN ('XA2001','XA1001') GROUP BY doc_tipo`, [tenantId]);
    for (const cfg of [{ t: 'XA2001', key: 'compras_sin_rfc', nombre: 'Compras con RFC', w: 3 }, { t: 'XA1001', key: 'gastos_sin_rfc', nombre: 'Gastos con RFC', w: 1 }]) {
      const r = docs.rows.find((x: any) => x.doc_tipo === cfg.t) || { total: 0, sin_rfc: 0, n: 0, n_sin: 0 };
      const total = Number(r.total) || 0, sinRfc = Number(r.sin_rfc) || 0;
      const bad = total > 0 ? sinRfc / total : 0;
      dims.push({ key: cfg.key, nombre: cfg.nombre, weight: cfg.w, score: pctScore(bad), pct_malo: bad, n: Number(r.n_sin) || 0, importe: Math.round(sinRfc),
        detalle: `${Number(r.n_sin) || 0} documento(s) por ${money(sinRfc)} sin RFC de proveedor (no deducibles, sin DIOT, sin materialidad).` });
    }

    // cadena sin recepción
    const ch = await trx.raw(
      `SELECT COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE recepcion_folio IS NULL))::int AS sin_rec,
              SUM(total)::numeric AS total, (SUM(total) FILTER (WHERE recepcion_folio IS NULL))::numeric AS total_sin
         FROM analytics.expense_doc_chain WHERE tenant_id=?`, [tenantId]);
    { const r = ch.rows[0] || {}; const total = Number(r.total) || 0, tsin = Number(r.total_sin) || 0; const bad = total > 0 ? tsin / total : 0;
      dims.push({ key: 'cadena_sin_recepcion', nombre: 'Cadena con recepción', weight: 2, score: pctScore(bad), pct_malo: bad, n: Number(r.sin_rec) || 0, importe: Math.round(tsin),
        detalle: `${Number(r.sin_rec) || 0} factura(s) por ${money(tsin)} sin recepción correlacionada.` }); }

    // líneas sin costo (afecta detectores de precio)
    const ln = await trx.raw(
      `SELECT COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE costo_unitario IS NULL OR costo_unitario<=0))::int AS sin_costo
         FROM analytics.expense_document_lines WHERE tenant_id=?`, [tenantId]);
    { const r = ln.rows[0] || {}; const n = Number(r.n) || 0, sc = Number(r.sin_costo) || 0; const bad = n > 0 ? sc / n : 0;
      dims.push({ key: 'lineas_sin_costo', nombre: 'Líneas con costo', weight: 1, score: pctScore(bad), pct_malo: bad, n: sc, importe: 0,
        detalle: `${sc} línea(s) de compra sin costo unitario (los detectores de precio no las ven).` }); }

    // frescura de la balanza
    const bal = await trx.raw(`SELECT COUNT(DISTINCT anio_mes)::int AS meses, MAX(anio_mes) AS ultimo FROM analytics.ledger_monthly WHERE tenant_id=?`, [tenantId]);
    { const r = bal.rows[0] || {}; const ultimo = r.ultimo as string | null;
      let gap = 0;
      if (ultimo) { const [y, m] = ultimo.split('-').map(Number); const now = new Date(); const nowY = now.getUTCFullYear(), nowM = now.getUTCMonth() + 1; gap = Math.max(0, (nowY - y) * 12 + (nowM - m) - 1); }
      const bad = ultimo ? Math.min(1, gap / 3) : 1;
      dims.push({ key: 'balanza_fresca', nombre: 'Balanza al día', weight: 2, score: pctScore(bad), pct_malo: bad, n: Number(r.meses) || 0, importe: 0,
        detalle: ultimo ? `Último mes cargado: ${ultimo} (${gap} mes(es) de rezago).` : 'No hay balanza cargada.' }); }

    return dims;
  }
}
