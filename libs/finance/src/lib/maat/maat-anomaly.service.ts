import { Injectable, Logger } from '@nestjs/common';

/**
 * MAAT-IQ · MIQ.1 — Detección estadística (ADR-028). El motor de reglas
 * encuentra lo que YA sabemos buscar; esta capa encuentra lo que NADIE escribió:
 * anomalías de forma estadística sobre la data curada (analytics.*).
 *
 * 3 detectores nuevos, complementarios a los de MaatDetectorService:
 *   benford_importes   — Ley de Benford (1er dígito significativo) por sucursal.
 *                        MAD de Nigrini → montos fabricados/redondeados (forense).
 *   peer_group_outlier — corte TRANSVERSAL: una sucursal gasta muy por encima de
 *                        sus pares en la MISMA cuenta el MISMO mes (robusto:
 *                        mediana + MAD, no promedio ± σ). Los detectores previos
 *                        son serie-de-tiempo; este es entre-sucursales.
 *   nivel_nuevo_serie  — cambio de NIVEL sostenido (no un pico): un costo
 *                        recurrente que subió y se quedó arriba (gasto_atipico
 *                        caza picos de 1 mes, no mesetas nuevas).
 *
 * SIN LLM. Persiste `finance.baselines` (lo "normal") para explicabilidad y reuso.
 * Devuelve findings con la misma forma que MaatDetectorService → los UPSERTea el
 * mismo camino idempotente (scanAll), integrado al feedback L2.
 */

interface AnomalyFinding {
  rule_key: string;
  severity: 'info' | 'warn' | 'critical';
  score: number;
  titulo: string;
  resumen: string;
  entity: Record<string, any>;
  periodo: string | null;
  importe: number;
  evidencia: Record<string, any>;
  dedup_key: string;
}

const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const norm = (s: any) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
/** MAD robusto → σ equivalente (constante 1.4826 para normal). */
const madSigma = (a: number[], med: number) => 1.4826 * median(a.map((x) => Math.abs(x - med)));

@Injectable()
export class MaatAnomalyService {
  private readonly logger = new Logger(MaatAnomalyService.name);

  private async saveBaseline(trx: any, tenantId: string, scope: string, key: Record<string, any>, stats: Record<string, any>) {
    await trx.raw(
      `INSERT INTO finance.baselines (tenant_id, scope, key_text, key, stats, computed_at)
       VALUES (?, ?, ?, ?::jsonb, ?::jsonb, now())
       ON CONFLICT (tenant_id, scope, key_text) DO UPDATE SET key = EXCLUDED.key, stats = EXCLUDED.stats, computed_at = now()`,
      [tenantId, scope, JSON.stringify(key), JSON.stringify(key), JSON.stringify(stats)],
    );
  }

  // ── Ley de Benford (1er dígito significativo) por sucursal ──
  async detBenford(trx: any, tenantId: string, p: any): Promise<AnomalyFinding[]> {
    const minDocs = Number(p.min_docs) || 300;
    const madWarn = Number(p.mad_warn) || 0.012;   // Nigrini: >0.012 marginal, >0.015 no-conforme
    const madCrit = Number(p.mad_crit) || 0.015;
    const rows = await trx.raw(
      `SELECT sucursal,
              substring(regexp_replace(round(abs(importe),2)::text, '[^1-9]', '', 'g') from 1 for 1) AS d,
              count(*)::int AS n
         FROM analytics.expense_documents
        WHERE tenant_id = ? AND importe > 0 AND doc_tipo IN ('XA2001','XA1001')
        GROUP BY sucursal, d`,
      [tenantId],
    );
    const bySuc = new Map<string, number[]>();  // sucursal → counts[1..9] (idx 0 = dígito 1)
    for (const r of rows.rows) {
      const d = Number(r.d);
      if (!d || d < 1 || d > 9) continue;
      const suc = r.sucursal || '?';
      if (!bySuc.has(suc)) bySuc.set(suc, new Array(9).fill(0));
      bySuc.get(suc)![d - 1] += Number(r.n);
    }
    const expected = Array.from({ length: 9 }, (_, i) => Math.log10(1 + 1 / (i + 1)));
    const out: AnomalyFinding[] = [];
    for (const [suc, counts] of bySuc) {
      const n = counts.reduce((a, b) => a + b, 0);
      if (n < minDocs) continue;
      const obs = counts.map((c) => c / n);
      const mad = mean(obs.map((o, i) => Math.abs(o - expected[i])));
      const dist = counts.map((c, i) => ({ d: i + 1, obs: +(obs[i] * 100).toFixed(1), esp: +(expected[i] * 100).toFixed(1) }));
      await this.saveBaseline(trx, tenantId, 'benford_sucursal', { sucursal: suc }, { mad: +mad.toFixed(4), n, dist });
      if (mad < madWarn) continue;
      const peor = dist.map((x) => ({ ...x, gap: x.obs - x.esp })).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
      out.push({
        rule_key: 'benford_importes',
        severity: mad >= madCrit ? 'critical' : 'warn',
        score: Math.min(1, mad / (madCrit * 2)),
        titulo: `Distribución de montos anómala (Benford) — suc ${suc}`,
        resumen: `Los importes de la sucursal ${suc} se desvían de la Ley de Benford (MAD ${mad.toFixed(4)}, ${n} docs). El dígito ${peor.d} aparece ${peor.obs}% vs ${peor.esp}% esperado — señal forense de montos fabricados/redondeados. Revisar capturas manuales.`,
        entity: { sucursal: suc },
        periodo: null,
        importe: 0,
        evidencia: { mad: +mad.toFixed(4), n, distribucion: dist, umbral: madWarn },
        dedup_key: `benford_importes|${suc}`,
      });
    }
    return out;
  }

  // ── peer-group: sucursal outlier vs pares en la misma cuenta, último mes ──
  async detPeerGroup(trx: any, tenantId: string, p: any): Promise<AnomalyFinding[]> {
    const z = Number(p.z) || 2.5;
    const minPeers = Number(p.min_peers) || 3;
    const minMonto = Number(p.min_monto) || 20000;
    // último mes cerrado disponible en el ledger
    const maxRow = await trx('analytics.ledger_monthly').where('tenant_id', tenantId).max('anio_mes as m').first();
    const mes = maxRow?.m;
    if (!mes) return [];
    const rows = await trx('analytics.ledger_monthly')
      .where('tenant_id', tenantId).where('anio_mes', mes).whereIn('familia', ['5', '6', '7'])
      .select('sucursal', 'cuenta_mayor', 'cuenta_mayor_nombre', trx.raw('(cargos - abonos)::numeric AS neto'));
    const byCuenta = new Map<string, { nombre: string; pts: { suc: string; v: number }[] }>();
    for (const r of rows) {
      if (!byCuenta.has(r.cuenta_mayor)) byCuenta.set(r.cuenta_mayor, { nombre: r.cuenta_mayor_nombre, pts: [] });
      byCuenta.get(r.cuenta_mayor)!.pts.push({ suc: r.sucursal, v: Number(r.neto) });
    }
    const out: AnomalyFinding[] = [];
    for (const [cuenta, g] of byCuenta) {
      if (g.pts.length < minPeers) continue;
      const vals = g.pts.map((x) => x.v);
      const med = median(vals);
      const sigma = madSigma(vals, med);
      if (sigma <= 0) continue;
      await this.saveBaseline(trx, tenantId, 'peer_cuenta_mes', { cuenta_mayor: cuenta, anio_mes: mes }, { median: Math.round(med), mad_sigma: Math.round(sigma), pares: g.pts.length });
      for (const pt of g.pts) {
        const rz = (pt.v - med) / sigma;
        if (rz < z || Math.abs(pt.v) < minMonto) continue;   // solo por ENCIMA de pares (gasto excesivo)
        out.push({
          rule_key: 'peer_group_outlier',
          severity: rz >= z + 2 ? 'critical' : 'warn',
          score: Math.min(1, rz / (z * 2)),
          titulo: `Sucursal fuera de rango vs pares — ${g.nombre || cuenta} (suc ${pt.suc})`,
          resumen: `${g.nombre || cuenta} (suc ${pt.suc}) en ${mes}: ${money(pt.v)} vs mediana de pares ${money(med)} (${rz.toFixed(1)}σ robusta, ${g.pts.length} sucursales). Gasta muy por encima de sucursales comparables.`,
          entity: { sucursal: pt.suc, cuenta_mayor: cuenta },
          periodo: mes,
          importe: Math.abs(pt.v - med),
          evidencia: { valor: Math.round(pt.v), mediana_pares: Math.round(med), z_robusto: +rz.toFixed(2), pares: g.pts.length },
          dedup_key: `peer_group_outlier|${pt.suc}|${cuenta}|${mes}`,
        });
      }
    }
    return out;
  }

  // ── cambio de nivel sostenido en una serie (cuenta×sucursal) ──
  async detNivelNuevo(trx: any, tenantId: string, p: any): Promise<AnomalyFinding[]> {
    const minMeses = Number(p.min_meses) || 8;
    const cambio = Number(p.cambio_pct) || 0.5;   // ≥50% de cambio sostenido
    const minMonto = Number(p.min_monto) || 15000;
    const recientes = Number(p.ventana_reciente) || 3;
    const rows = await trx('analytics.ledger_monthly')
      .where('tenant_id', tenantId).whereIn('familia', ['5', '6', '7'])
      .select('sucursal', 'cuenta_mayor', 'cuenta_mayor_nombre', 'anio_mes', trx.raw('(cargos - abonos)::numeric AS neto'));
    const groups = new Map<string, { suc: string; mayor: string; nombre: string; pts: { mes: string; v: number }[] }>();
    for (const r of rows) {
      const k = `${r.sucursal}|${r.cuenta_mayor}`;
      if (!groups.has(k)) groups.set(k, { suc: r.sucursal, mayor: r.cuenta_mayor, nombre: r.cuenta_mayor_nombre, pts: [] });
      groups.get(k)!.pts.push({ mes: r.anio_mes, v: Number(r.neto) });
    }
    const out: AnomalyFinding[] = [];
    for (const g of groups.values()) {
      if (g.pts.length < minMeses) continue;
      g.pts.sort((a, b) => a.mes.localeCompare(b.mes));
      const rec = g.pts.slice(-recientes);
      const prev = g.pts.slice(0, -recientes);
      if (prev.length < 3) continue;
      const priorMed = median(prev.map((x) => x.v));
      const recMean = mean(rec.map((x) => x.v));
      if (Math.abs(priorMed) < 1 || Math.abs(recMean) < minMonto) continue;
      const delta = (recMean - priorMed) / Math.abs(priorMed);
      if (delta < cambio) continue;                               // solo subidas sostenidas
      const sostenido = rec.every((x) => x.v > priorMed);          // los N recientes por encima del nivel previo
      if (!sostenido) continue;
      await this.saveBaseline(trx, tenantId, 'serie_nivel', { sucursal: g.suc, cuenta_mayor: g.mayor }, { prior_median: Math.round(priorMed), recent_mean: Math.round(recMean), delta_pct: +(delta * 100).toFixed(0), meses: g.pts.length });
      const ultMes = rec[rec.length - 1].mes;
      out.push({
        rule_key: 'nivel_nuevo_serie',
        severity: delta >= cambio * 2 ? 'critical' : 'warn',
        score: Math.min(1, delta / (cambio * 2)),
        titulo: `Costo subió y se quedó arriba — ${g.nombre || g.mayor} (suc ${g.suc})`,
        resumen: `${g.nombre || g.mayor} (suc ${g.suc}): los últimos ${recientes} meses promedian ${money(recMean)} vs nivel previo ${money(priorMed)} (+${(delta * 100).toFixed(0)}% sostenido). No es un pico: es un nivel nuevo — revisar contrato/tarifa.`,
        entity: { sucursal: g.suc, cuenta_mayor: g.mayor },
        periodo: ultMes,
        importe: Math.round((recMean - priorMed) * recientes),
        evidencia: { nivel_previo: Math.round(priorMed), nivel_nuevo: Math.round(recMean), delta_pct: +(delta * 100).toFixed(0), meses: g.pts.length },
        dedup_key: `nivel_nuevo_serie|${g.suc}|${g.mayor}|${ultMes}`,
      });
    }
    return out;
  }
}
