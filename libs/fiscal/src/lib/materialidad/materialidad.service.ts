import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * FISCAL.10.1 — Expediente de materialidad de un proveedor.
 *
 * Amarra el cumplimiento: para un RFC arma el expediente de defensa (clave cuando
 * el proveedor es EFOS/lista negra). Reúne, determinista:
 *   - estatus en listas SAT (EFOS 69-B / Art. 69) — fiscal.sat_list_matches
 *   - CFDIs recibidos + cuántos cancelados — fiscal.cfdis
 *   - cadena de suministro (orden→recepción→factura→pago) — analytics.expense_doc_chain
 *     La RECEPCIÓN física es la evidencia más fuerte de que la operación fue real.
 *   - operaciones y monto — analytics.expense_documents
 * Emite un veredicto heurístico de solidez de la materialidad.
 *
 * fiscal.* con RLS (tk.run); analytics.* sin RLS (filtro de tenant explícito).
 */
@Injectable()
export class MaterialidadService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async buildDossier(rfcInput: string) {
    const rfc = (rfcInput || '').trim().toUpperCase();
    if (!/^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(rfc)) throw new BadRequestException('RFC inválido');
    const tid = this.tenantCtx.requireTenantId();

    // fiscal.* (RLS)
    const { listas, cfdis } = await this.tk.run(async (trx) => {
      const listas = await trx('fiscal.sat_list_matches').where({ rfc })
        .select('lista', 'situacion', 'nombre', 'doc_count', 'importe_total', 'estado');
      const [cf] = await trx('fiscal.cfdis').where({ emisor_rfc: rfc, rol: 'recibidas' })
        .select(
          trx.raw('count(*)::int as total'),
          trx.raw("count(*) FILTER (WHERE estatus_sat='cancelado')::int as cancelados"),
          trx.raw('COALESCE(SUM(total),0) as monto'),
        );
      return { listas, cfdis: cf };
    });

    // analytics.* (filtro tenant explícito)
    const docs = await this.tk.run(async (trx) => {
      const [resumen] = await trx('analytics.expense_documents').where({ tenant_id: tid }).andWhereRaw('UPPER(rfc)=?', [rfc])
        .select(
          trx.raw('MAX(beneficiario) as beneficiario'),
          trx.raw('count(*)::int as ops'),
          trx.raw('COALESCE(SUM(importe),0) as total'),
          trx.raw('MIN(fecha) as desde'), trx.raw('MAX(fecha) as hasta'),
        );
      const [chain] = await trx('analytics.expense_doc_chain as ch')
        .join('analytics.expense_documents as e', (j) => j.on('e.tenant_id', 'ch.tenant_id').andOn('e.sucursal', 'ch.sucursal').andOn('e.doc_folio', 'ch.factura_folio'))
        .where('e.tenant_id', tid).andWhere('e.doc_tipo', 'XA2001').andWhereRaw('UPPER(e.rfc)=?', [rfc])
        .select(
          trx.raw('count(*)::int as cadenas'),
          trx.raw('count(*) FILTER (WHERE ch.orden_folio IS NOT NULL)::int as con_orden'),
          trx.raw('count(*) FILTER (WHERE ch.recepcion_folio IS NOT NULL)::int as con_recepcion'),
          trx.raw('count(*) FILTER (WHERE ch.pago_folio IS NOT NULL)::int as con_pago'),
        );
      return { resumen, chain };
    });

    const cadenas = Number(docs.chain?.cadenas || 0);
    const conRecep = Number(docs.chain?.con_recepcion || 0);
    const recepPct = cadenas ? conRecep / cadenas : 0;
    const enLista = listas.some((l: any) => this.esRiesgo(l.lista, l.situacion));

    return {
      rfc,
      beneficiario: docs.resumen?.beneficiario ?? listas[0]?.nombre ?? null,
      operaciones: Number(docs.resumen?.ops || 0),
      monto_total: Number(docs.resumen?.total || 0),
      periodo: { desde: docs.resumen?.desde ?? null, hasta: docs.resumen?.hasta ?? null },
      listas_negras: listas,
      en_lista_riesgo: enLista,
      cfdis: { total: Number(cfdis?.total || 0), cancelados: Number(cfdis?.cancelados || 0), monto: Number(cfdis?.monto || 0) },
      cadena_suministro: {
        cadenas, con_orden: Number(docs.chain?.con_orden || 0), con_recepcion: conRecep, con_pago: Number(docs.chain?.con_pago || 0),
        recepcion_pct: Math.round(recepPct * 100),
      },
      veredicto: this.veredicto(enLista, recepPct, cadenas, Number(cfdis?.cancelados || 0)),
    };
  }

  /**
   * MAT — Descubrimiento de proveedores: índice para EXPLORAR sin teclear el RFC
   * exacto. Agrega analytics.expense_documents por RFC + cadena (recepción) + cruce
   * con listas negras (fiscal.sat_list_matches, RLS), rankeado por RIESGO
   * (en lista → baja recepción → monto). Filtros: search (RFC/nombre) + riesgo.
   */
  async providers(opts: { search?: string; riesgo?: string; limit?: number } = {}) {
    const tid = this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 200));
    const q = (opts.search || '').trim().toUpperCase();
    const riesgo = opts.riesgo || 'all';
    const rows = await this.tk.run(async (trx) => {
      const res = await trx.raw(
        `WITH base AS (
           SELECT UPPER(rfc) AS rfc, MAX(beneficiario) AS beneficiario, COUNT(*)::int AS ops,
                  COALESCE(SUM(importe),0)::numeric AS monto, MIN(fecha) AS desde, MAX(fecha) AS hasta
             FROM analytics.expense_documents
            WHERE tenant_id = :tid AND rfc IS NOT NULL AND btrim(rfc) <> ''
            GROUP BY UPPER(rfc)
         ),
         chain AS (
           SELECT UPPER(e.rfc) AS rfc, COUNT(*)::int AS cadenas,
                  COUNT(*) FILTER (WHERE ch.recepcion_folio IS NOT NULL)::int AS con_recepcion
             FROM analytics.expense_doc_chain ch
             JOIN analytics.expense_documents e
               ON e.tenant_id = ch.tenant_id AND e.sucursal = ch.sucursal AND e.doc_folio = ch.factura_folio
            WHERE e.tenant_id = :tid AND e.doc_tipo = 'XA2001' AND e.rfc IS NOT NULL
            GROUP BY UPPER(e.rfc)
         ),
         lista AS (
           SELECT UPPER(rfc) AS rfc, bool_or(true) AS en_lista,
                  bool_or(
                    (lista='69B' AND (lower(situacion) LIKE '%definitivo%' OR lower(situacion) LIKE '%presunto%'))
                 OR (lista='69'  AND (lower(situacion) LIKE '%firme%' OR lower(situacion) LIKE '%no localizado%' OR lower(situacion) LIKE '%cancelado%' OR lower(situacion) LIKE '%exigible%'))
                  ) AS en_riesgo
             FROM fiscal.sat_list_matches WHERE rfc IS NOT NULL GROUP BY UPPER(rfc)
         )
         SELECT b.rfc, b.beneficiario, b.ops, b.monto, b.desde, b.hasta,
                COALESCE(c.cadenas,0)::int AS cadenas, COALESCE(c.con_recepcion,0)::int AS con_recepcion,
                COALESCE(l.en_lista,false) AS en_lista, COALESCE(l.en_riesgo,false) AS en_riesgo
           FROM base b
           LEFT JOIN chain c ON c.rfc = b.rfc
           LEFT JOIN lista l ON l.rfc = b.rfc
          WHERE (:q = '' OR b.rfc LIKE :qlike OR UPPER(COALESCE(b.beneficiario,'')) LIKE :qlike)
            AND (CASE :riesgo
                  WHEN 'lista' THEN COALESCE(l.en_lista,false)
                  WHEN 'riesgo' THEN COALESCE(l.en_riesgo,false)
                  WHEN 'sin_recepcion' THEN (COALESCE(c.cadenas,0) > 0 AND COALESCE(c.con_recepcion,0)::numeric / NULLIF(c.cadenas,0) < 0.5)
                  ELSE true END)
          ORDER BY COALESCE(l.en_riesgo,false) DESC, COALESCE(l.en_lista,false) DESC,
                   (CASE WHEN COALESCE(c.cadenas,0) > 0 THEN c.con_recepcion::numeric / c.cadenas ELSE 1 END) ASC,
                   b.monto DESC
          LIMIT :limit`,
        { tid, q, qlike: `%${q}%`, riesgo, limit },
      );
      return res.rows;
    });
    return rows.map((r: any) => {
      const cadenas = Number(r.cadenas) || 0;
      return {
        rfc: r.rfc, beneficiario: r.beneficiario ?? null,
        ops: Number(r.ops) || 0, monto: Number(r.monto) || 0,
        desde: r.desde ?? null, hasta: r.hasta ?? null,
        cadenas, con_recepcion: Number(r.con_recepcion) || 0,
        recepcion_pct: cadenas > 0 ? Math.round((Number(r.con_recepcion) / cadenas) * 100) : null,
        en_lista: !!r.en_lista, en_riesgo: !!r.en_riesgo,
      };
    });
  }

  /**
   * MAT.2 — Desglose de la cadena de suministro: una fila por factura de compra
   * (XA2001) con sus documentos relacionados (orden XA3501 → recepción XA3701 →
   * factura → pago programado XA4001), fechas y confianza del enlace. Es el drill
   * detrás de la "Cadena de suministro" del expediente. analytics.* sin RLS →
   * filtro de tenant explícito.
   */
  async chains(rfcInput: string) {
    const rfc = (rfcInput || '').trim().toUpperCase();
    if (!/^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(rfc)) throw new BadRequestException('RFC inválido');
    const tid = this.tenantCtx.requireTenantId();
    const rows = await this.tk.run(async (trx) =>
      trx('analytics.expense_doc_chain as ch')
        .join('analytics.expense_documents as e', (j) =>
          j.on('e.tenant_id', 'ch.tenant_id').andOn('e.sucursal', 'ch.sucursal').andOn('e.doc_folio', 'ch.factura_folio'))
        .where('e.tenant_id', tid).andWhere('e.doc_tipo', 'XA2001').andWhereRaw('UPPER(e.rfc)=?', [rfc])
        .select(
          'ch.sucursal', 'ch.factura_folio', 'ch.factura_fecha',
          'ch.orden_folio', 'ch.orden_fecha', 'ch.recepcion_folio', 'ch.recepcion_fecha',
          'ch.pago_folio', 'ch.pago_fecha',
          trx.raw('ch.total::numeric AS total'),
          'ch.lead_days', 'ch.pago_days', 'ch.match_confidence',
        )
        .orderBy('ch.factura_fecha', 'desc')
        .limit(1000));
    return rows.map((r: any) => ({
      key: `${r.sucursal}|${r.factura_folio}`,
      sucursal: r.sucursal,
      factura_folio: r.factura_folio, factura_fecha: r.factura_fecha,
      orden_folio: r.orden_folio, orden_fecha: r.orden_fecha,
      recepcion_folio: r.recepcion_folio, recepcion_fecha: r.recepcion_fecha,
      pago_folio: r.pago_folio, pago_fecha: r.pago_fecha,
      total: Number(r.total || 0),
      lead_days: r.lead_days != null ? Number(r.lead_days) : null,
      pago_days: r.pago_days != null ? Number(r.pago_days) : null,
      match_confidence: r.match_confidence,
      completa: !!(r.orden_folio && r.recepcion_folio),
    }));
  }

  private esRiesgo(lista: string, situacion: string): boolean {
    const s = String(situacion || '').toLowerCase();
    if (lista === '69B') return s.includes('definitivo') || s.includes('presunto');
    if (lista === '69') return s.includes('firme') || s.includes('no localizado') || s.includes('cancelado') || s.includes('exigible');
    return false;
  }

  private veredicto(enLista: boolean, recepPct: number, cadenas: number, cancelados: number): { nivel: string; mensaje: string } {
    if (enLista && recepPct < 0.5) return { nivel: 'critico', mensaje: 'Proveedor en lista negra y baja evidencia de recepción física — riesgo alto de no deducibilidad; reunir evidencia adicional (entradas de almacén, fotos, contratos).' };
    if (enLista) return { nivel: 'revisar', mensaje: 'Proveedor en lista negra pero con evidencia de recepción — documentar la materialidad para defender la deducción.' };
    if (cancelados > 0) return { nivel: 'revisar', mensaje: `${cancelados} CFDI cancelado(s) ante el SAT — revertir si se dedujeron.` };
    if (cadenas === 0) return { nivel: 'parcial', mensaje: 'Sin cadena de suministro reconstruida — no hay evidencia de orden/recepción/pago para estas operaciones.' };
    if (recepPct >= 0.8) return { nivel: 'solida', mensaje: 'Alta evidencia de recepción física: materialidad sólida.' };
    return { nivel: 'parcial', mensaje: 'Evidencia de recepción parcial — completar el expediente.' };
  }
}
