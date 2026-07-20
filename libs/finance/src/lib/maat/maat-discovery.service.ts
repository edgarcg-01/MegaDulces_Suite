import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * MAAT-IQ · MIQ.4 — Descubrimiento de detectores (ADR-028 + ADR-013 HITL).
 *
 * Propone TIPOS de problema que aún no tienen regla → bandeja de hipótesis que un
 * humano aprueba/rechaza (nunca crea reglas solo). Dos fuentes:
 *   - Mineros DETERMINISTAS (corren siempre): patrones estadísticamente
 *     sugestivos sobre analytics.* que hoy nadie vigila (montos redondos, gasto
 *     de proveedor creciente sostenido).
 *   - Proponedor AI (GATED por ANTHROPIC_API_KEY): un modelo analiza un resumen
 *     de la data y sugiere hipótesis nuevas. Degrada a no-op sin key (patrón del
 *     proyecto). El LLM PROPONE; el humano decide; el detector final es
 *     determinista. Cero números del LLM en producción.
 *
 * Aprobar = backlog de detector a codificar/activar (marca la decisión, auditable).
 */

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const AI_MODEL = process.env.MAAT_DISCOVERY_MODEL || process.env.MAAT_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const AI_TIMEOUT_MS = 30_000;
const norm = (s: any) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const slug = (s: any) => norm(s).replace(/[^A-Z0-9]+/g, '_').slice(0, 48);
const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

interface Hypothesis {
  source: 'deterministic' | 'ai';
  titulo: string; descripcion: string; clase: 'riesgo' | 'error_captura' | 'oportunidad';
  propuesta_rule_key?: string; propuesta_params?: any; evidencia?: any; score: number; dedup_key: string;
}

@Injectable()
export class MaatDiscoveryService {
  private readonly logger = new Logger(MaatDiscoveryService.name);
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Corre mineros deterministas + (gated) proponedor AI, UPSERT idempotente. */
  async run(): Promise<{ deterministas: number; ai: number; total: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const det = [
        ...(await this.mineRoundNumbers(trx, tenantId)),
        ...(await this.mineGrowingSupplier(trx, tenantId)),
      ];
      let ai: Hypothesis[] = [];
      try { ai = await this.proposeWithAi(trx, tenantId); }
      catch (e: any) { this.logger.warn(`proponedor AI falló (gated/degrada): ${e?.message || e}`); }

      const all = [...det, ...ai];
      for (const h of all) {
        await trx.raw(
          `INSERT INTO finance.detector_hypotheses
             (tenant_id, source, titulo, descripcion, clase, propuesta_rule_key, propuesta_params, evidencia, score, dedup_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, now(), now())
           ON CONFLICT (tenant_id, dedup_key) DO UPDATE
             SET descripcion = EXCLUDED.descripcion, evidencia = EXCLUDED.evidencia, score = EXCLUDED.score, updated_at = now()
             WHERE finance.detector_hypotheses.status = 'propuesta'`,
          [tenantId, h.source, h.titulo, h.descripcion, h.clase, h.propuesta_rule_key || null,
            JSON.stringify(h.propuesta_params || {}), JSON.stringify(h.evidencia || {}), h.score, h.dedup_key],
        );
      }
      this.logger.log(`descubrimiento: ${det.length} deterministas + ${ai.length} AI = ${all.length} hipótesis.`);
      return { deterministas: det.length, ai: ai.length, total: all.length };
    });
  }

  async list(status = 'propuesta'): Promise<any[]> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) =>
      trx('finance.detector_hypotheses').where('tenant_id', trx.raw('public.current_tenant_id()'))
        .modify((q: any) => { if (status !== 'all') q.where('status', status); })
        .orderBy('score', 'desc').select('id', 'source', 'titulo', 'descripcion', 'clase', 'propuesta_rule_key', 'propuesta_params', 'evidencia', 'score', 'status', 'created_at', 'reviewed_by', 'reviewed_at'),
    );
  }

  async decide(id: string, aprobar: boolean, actor?: string): Promise<any> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.detector_hypotheses').where('id', id)
        .update({ status: aprobar ? 'aprobada' : 'rechazada', reviewed_by: actor || null, reviewed_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning(['id', 'status', 'titulo']);
      if (!row) throw new BadRequestException('hipótesis no encontrada');
      this.logger.log(`hipótesis ${id} → ${row.status}${actor ? ` por ${actor}` : ''}`);
      return { ...row, nota: aprobar ? 'Aprobada: queda en backlog para codificar/activar como detector (paso de código).' : 'Rechazada.' };
    });
  }

  // ── minero determinista: sesgo de montos redondos por sucursal (forense) ──
  private async mineRoundNumbers(trx: any, tenantId: string): Promise<Hypothesis[]> {
    const rows = await trx.raw(
      `SELECT sucursal, COUNT(*)::int AS n,
              (COUNT(*) FILTER (WHERE mod(round(importe)::numeric, 1000) = 0))::int AS redondos
         FROM analytics.expense_documents
        WHERE tenant_id = ? AND doc_tipo IN ('XA2001','XA1001') AND importe > 0
        GROUP BY sucursal`, [tenantId]);
    const totN = rows.rows.reduce((a: number, r: any) => a + Number(r.n), 0);
    const totR = rows.rows.reduce((a: number, r: any) => a + Number(r.redondos), 0);
    const global = totN > 0 ? totR / totN : 0;
    const umbral = Math.max(0.15, global * 1.5);
    const out: Hypothesis[] = [];
    for (const r of rows.rows) {
      const n = Number(r.n); if (n < 200) continue;
      const share = Number(r.redondos) / n;
      if (share < umbral) continue;
      out.push({
        source: 'deterministic', clase: 'riesgo',
        titulo: `Detector propuesto: sesgo de montos redondos (suc ${r.sucursal})`,
        descripcion: `La sucursal ${r.sucursal} tiene ${(share * 100).toFixed(0)}% de sus documentos en múltiplos exactos de $1,000 (global ${(global * 100).toFixed(0)}%). Un exceso de montos redondos sugiere capturas estimadas/fabricadas — vale la pena un detector sistemático de "sesgo de redondeo" (complementa Benford).`,
        propuesta_rule_key: 'sesgo_redondeo', propuesta_params: { min_docs: 200, umbral_share: +umbral.toFixed(3) },
        evidencia: { sucursal: r.sucursal, n, redondos: Number(r.redondos), share: +(share * 100).toFixed(1), global: +(global * 100).toFixed(1) },
        score: Math.min(1, share / (umbral * 2)), dedup_key: `round_number_bias|${r.sucursal}`,
      });
    }
    return out;
  }

  // ── minero determinista: proveedor con gasto mensual creciente sostenido ──
  private async mineGrowingSupplier(trx: any, tenantId: string): Promise<Hypothesis[]> {
    const rows = await trx.raw(
      `SELECT beneficiario, to_char(fecha, 'YYYY-MM') AS mes, SUM(importe)::numeric AS monto
         FROM analytics.expense_documents
        WHERE tenant_id = ? AND beneficiario IS NOT NULL AND importe > 0
          AND fecha >= (CURRENT_DATE - INTERVAL '7 months')
        GROUP BY beneficiario, to_char(fecha, 'YYYY-MM')`, [tenantId]);
    const byProv = new Map<string, { mes: string; v: number }[]>();
    for (const r of rows.rows) {
      if (!byProv.has(r.beneficiario)) byProv.set(r.beneficiario, []);
      byProv.get(r.beneficiario)!.push({ mes: r.mes, v: Number(r.monto) });
    }
    const out: Hypothesis[] = [];
    for (const [prov, pts] of byProv) {
      if (pts.length < 4) continue;
      pts.sort((a, b) => a.mes.localeCompare(b.mes));
      const last4 = pts.slice(-4);
      let creciente = true;
      for (let i = 1; i < last4.length; i++) if (last4[i].v <= last4[i - 1].v) { creciente = false; break; }
      if (!creciente) continue;
      const first = last4[0].v, last = last4[last4.length - 1].v;
      if (last < 30000 || first <= 0 || last / first < 1.5) continue;
      out.push({
        source: 'deterministic', clase: 'oportunidad',
        titulo: `Detector propuesto: gasto creciente sostenido — ${prov}`,
        descripcion: `${prov} lleva 4 meses de gasto mensual estrictamente creciente (${money(first)} → ${money(last)}, +${(((last / first) - 1) * 100).toFixed(0)}%). Un detector de "escalada de gasto por proveedor" ayudaría a renegociar o revisar antes de que se dispare.`,
        propuesta_rule_key: 'escalada_gasto_proveedor', propuesta_params: { meses: 4, min_monto: 30000, factor: 1.5 },
        evidencia: { proveedor: prov, serie: last4, factor: +(last / first).toFixed(2) },
        score: Math.min(1, (last / first) / 3), dedup_key: `proveedor_creciente|${slug(prov)}`,
      });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 20);
  }

  // ── proponedor AI (GATED): sugiere hipótesis desde un resumen; degrada sin key ──
  private async proposeWithAi(trx: any, tenantId: string): Promise<Hypothesis[]> {
    if (!this.apiKey) return [];
    // resumen compacto: top cuentas por gasto + reglas existentes (contexto, sin PII fina)
    const cuentas = await trx('analytics.ledger_monthly').where('tenant_id', tenantId).whereIn('familia', ['5', '6', '7'])
      .groupBy('cuenta_mayor', 'cuenta_mayor_nombre')
      .select('cuenta_mayor_nombre', trx.raw('SUM(cargos - abonos)::numeric AS neto'))
      .orderByRaw('SUM(cargos - abonos) DESC').limit(8);
    const reglas = await trx('finance.rule_registry').where('tenant_id', tenantId).select('rule_key', 'nombre');
    const prompt = `Eres un auditor forense de finanzas. Con este resumen de una distribuidora, propón hasta 4 TIPOS de problema (detectores) que NO estén cubiertos por las reglas existentes. Devuelve SOLO un array JSON: [{"titulo","descripcion","clase":"riesgo|error_captura|oportunidad","score":0..1}].
TOP CUENTAS DE GASTO: ${cuentas.map((c: any) => `${c.cuenta_mayor_nombre} (${money(Number(c.neto))})`).join('; ')}
REGLAS EXISTENTES: ${reglas.map((r: any) => r.rule_key).join(', ')}`;

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    let text = '';
    try {
      const resp = await fetch(CLAUDE_ENDPOINT, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!resp.ok) { this.logger.warn(`AI discovery HTTP ${resp.status}`); return []; }
      const data: any = await resp.json();
      text = data?.content?.[0]?.text || '';
    } finally { clearTimeout(to); }

    const parsed = safeArray(text);
    return parsed.slice(0, 4).map((h: any) => ({
      source: 'ai' as const,
      titulo: `[AI] ${String(h.titulo || 'Hipótesis').slice(0, 120)}`,
      descripcion: String(h.descripcion || '').slice(0, 600),
      clase: (['riesgo', 'error_captura', 'oportunidad'].includes(h.clase) ? h.clase : 'riesgo'),
      evidencia: { origen: 'ai', modelo: AI_MODEL }, score: clamp01(Number(h.score) || 0.5),
      dedup_key: `ai|${slug(h.titulo)}`,
    }));
  }
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function safeArray(text: string): any[] {
  try {
    const m = text.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : text);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
