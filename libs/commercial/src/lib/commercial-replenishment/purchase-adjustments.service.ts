import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase RE.10 — Ajustes de compra (X-D-40 "Devolución compra" + X-D-55 "Nota crédito").
 *
 * Lee `analytics.erp_purchase_adjustments` (espejo Kepler, poblado por
 * `import-purchase-adjustments.js`). Hace VISIBLE lo que el Excel no veía:
 *   - descuentos de proveedor (pronto pago / comercial / apoyo de marca) ≈ $8.2M/2026
 *   - facturas DUPLICADAS revertidas por NC (error de captura, NO descuento) $6.7M
 *   - devoluciones/faltantes operacionales
 * La causa se lee del motivo `c24` (ya clasificado en `categoria` por el importer).
 * analytics.* NO tiene RLS → filtro `tenant_id` EXPLÍCITO (patrón de la casa).
 * Motor lee/agrega; LLM afinará el tail `sin_motivo` en un paso posterior.
 */

export interface AdjustmentsQuery {
  doctype?: string;    // XD40 | XD55
  categoria?: string;  // faltante | apoyo_marca | descuento_comercial | factura_duplicada | ...
  grupo?: string;      // comercial | operacional | error | sin_clasificar
  search?: string;     // proveedor (nombre/código) o motivo
  date_from?: string;
  date_to?: string;
  page?: number;
  pageSize?: number;
}

// Agrupación de categorías para el resumen (comercial vs operacional vs error de captura).
const GRUPO: Record<string, string> = {
  pronto_pago: 'comercial', apoyo_marca: 'comercial', descuento_comercial: 'comercial', saldo_favor: 'comercial',
  faltante: 'operacional', no_solicitado: 'operacional', mal_estado: 'operacional', cambiada: 'operacional', devolucion_otra: 'operacional',
  factura_duplicada: 'error', diferencia_monto: 'error',
  otro: 'sin_clasificar',
};
const grupoOf = (cat: string | null): string => (cat ? (GRUPO[cat] || 'sin_clasificar') : 'sin_clasificar');

@Injectable()
export class PurchaseAdjustmentsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Base con filtros comunes (tenant_id explícito + doctype/categoría/fecha/search). */
  private base(trx: any, tenantId: string, q: AdjustmentsQuery) {
    let b = trx('analytics.erp_purchase_adjustments').where('tenant_id', tenantId);
    if (q.doctype) b = b.where('doctype', q.doctype);
    if (q.categoria) b = b.where('categoria', q.categoria);
    if (q.date_from) b = b.where('adjustment_date', '>=', q.date_from);
    if (q.date_to) b = b.where('adjustment_date', '<=', q.date_to);
    if (q.search && q.search.trim()) {
      const s = `%${q.search.trim()}%`;
      b = b.where((w: any) => w.where('proveedor_nombre', 'ilike', s).orWhere('proveedor_code', 'ilike', s).orWhere('motivo', 'ilike', s));
    }
    if (q.grupo) {
      const cats = Object.entries(GRUPO).filter(([, g]) => g === q.grupo).map(([c]) => c);
      if (q.grupo === 'sin_clasificar') b = b.where((w: any) => w.whereNull('categoria').orWhereIn('categoria', cats));
      else b = b.whereIn('categoria', cats);
    }
    return b;
  }

  /** RE.10 — resumen: total + por grupo (comercial/operacional/error) + por categoría. */
  async summary(q: AdjustmentsQuery = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows: any[] = await this.base(trx, tenantId, q)
        .select('doctype', 'categoria')
        .count({ n: '*' })
        .sum({ monto: 'monto' })
        .groupBy('doctype', 'categoria');

      const byCat: Record<string, { n: number; monto: number }> = {};
      const byGrupo: Record<string, { n: number; monto: number }> = {};
      const byDoctype: Record<string, { n: number; monto: number }> = {};
      let totalN = 0, totalMonto = 0;
      for (const r of rows) {
        const n = Number(r.n) || 0, monto = Number(r.monto) || 0;
        const cat = (r.categoria as string) || 'sin_motivo';
        const g = grupoOf(r.categoria as string);
        const acc = (o: any, k: string) => { o[k] = o[k] || { n: 0, monto: 0 }; o[k].n += n; o[k].monto += monto; };
        acc(byCat, cat); acc(byGrupo, g); acc(byDoctype, r.doctype as string);
        totalN += n; totalMonto += monto;
      }
      const toArr = (o: any) => Object.entries(o).map(([key, v]: any) => ({ key, n: v.n, monto: v.monto })).sort((a, b) => b.monto - a.monto);
      return { total: { n: totalN, monto: totalMonto }, by_grupo: toArr(byGrupo), by_doctype: toArr(byDoctype), by_categoria: toArr(byCat) };
    });
  }

  /** RE.10 — lista paginada (para la tabla). */
  async list(q: AdjustmentsQuery = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, q.page || 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize || 50));
    return this.tk.run(async (trx) => {
      const b = this.base(trx, tenantId, q);
      const [{ count }]: any = await b.clone().count({ count: '*' });
      const rows: any[] = await b
        .select('doctype', 'folio', 'adjustment_date', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc', 'factura_ref', 'entrada_folio', 'monto', 'iva', 'motivo', 'categoria')
        .orderBy('adjustment_date', 'desc').orderBy('monto', 'desc')
        .limit(pageSize).offset((page - 1) * pageSize);
      return { total: Number(count), page, pageSize, rows: rows.map((r) => ({ ...r, grupo: grupoOf(r.categoria) })) };
    });
  }

  /**
   * RE.10 — POSIBLES facturas duplicadas (control proactivo): entradas del mismo
   * proveedor con el MISMO monto exacto (a los centavos) repetido dentro de una ventana
   * (default 30 días). Señal fuerte de captura doble del mismo comprobante. HITL: el
   * humano confirma (un pedido estándar idéntico repetido puede ser legítimo). Sobre
   * `analytics.erp_goods_receipts` (las entradas reales), tenant explícito.
   */
  /**
   * Grupos de posibles duplicados (mismo proveedor + monto exacto en ≤ win días).
   * Recibe el `runner` (trx `app_runtime` en request, o `KNEX_NEW_DB` en el cron del
   * bridge de hallazgos): `analytics.*` no tiene RLS → el filtro `tenant_id` va
   * explícito en el SQL y funciona con ambos. Una sola copia del SQL para los dos.
   */
  async duplicateGroups(runner: Knex, tenantId: string, windowDays = 30): Promise<any[]> {
    const win = Math.min(180, Math.max(1, Number(windowDays) || 30));
    const res: any = await runner.raw(
      `SELECT proveedor_code, max(proveedor_nombre) AS proveedor_nombre, monto,
              count(*)::int AS veces, (count(*)-1)::int AS copias_extra,
              round((count(*)-1)*monto, 2) AS monto_riesgo,
              min(receipt_date) AS desde, max(receipt_date) AS hasta,
              (max(receipt_date)-min(receipt_date))::int AS span_dias,
              array_agg(folio ORDER BY receipt_date) AS folios,
              array_agg(sucursal ORDER BY receipt_date) AS sucursales
         FROM analytics.erp_goods_receipts
        WHERE tenant_id = ? AND monto > 0
        GROUP BY proveedor_code, monto
       HAVING count(*) > 1 AND (max(receipt_date)-min(receipt_date)) <= ?
        ORDER BY (count(*)-1)*monto DESC
        LIMIT 200`,
      [tenantId, win],
    );
    return res.rows || res;
  }

  async potentialDuplicates(windowDays = 30) {
    const tenantId = this.tenantCtx.requireTenantId();
    const win = Math.min(180, Math.max(1, Number(windowDays) || 30));
    return this.tk.run(async (trx) => {
      const rows = await this.duplicateGroups(trx as unknown as Knex, tenantId, win);
      const total_riesgo = rows.reduce((s, r) => s + Number(r.monto_riesgo || 0), 0);
      return { window_days: win, groups: rows.length, total_riesgo, rows };
    });
  }

  /**
   * RE.2 — ajustes que EXPLICAN el descuadre de una entrada. Link: `entrada_folio`
   * exacto cuando existe (~12/132); si no, heurístico por proveedor + ventana de fecha
   * (Kepler no liga la nota a la entrada estructuralmente — igual que el pago). Etiqueta
   * cada match como 'exacto' | 'proveedor+fecha' para ser honestos con la precisión.
   */
  async forEntrada(p: { proveedor_code?: string; entrada_folio?: string; date?: string; window_days?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const win = Math.min(90, Math.max(0, Number(p.window_days) || 15));
    if (!p.proveedor_code && !p.entrada_folio) return { rows: [], total_monto: 0 };
    return this.tk.run(async (trx) => {
      let b = trx('analytics.erp_purchase_adjustments').where('tenant_id', tenantId);
      b = b.andWhere((w: any) => {
        if (p.entrada_folio) w.orWhere('entrada_folio', p.entrada_folio);
        if (p.proveedor_code && p.date) {
          w.orWhere((ww: any) => ww.where('proveedor_code', p.proveedor_code)
            .andWhereRaw(`adjustment_date BETWEEN ?::date - ?::int AND ?::date + ?::int`, [p.date, win, p.date, win]));
        } else if (p.proveedor_code) {
          w.orWhere('proveedor_code', p.proveedor_code);
        }
      });
      const rows: any[] = await b
        .select('doctype', 'folio', 'adjustment_date', 'proveedor_code', 'proveedor_nombre', 'factura_ref', 'entrada_folio', 'monto', 'iva', 'motivo', 'categoria')
        .orderBy('adjustment_date', 'desc').limit(50);
      const out = rows.map((r) => ({
        ...r, grupo: grupoOf(r.categoria),
        match: (p.entrada_folio && r.entrada_folio === p.entrada_folio) ? 'exacto' : 'proveedor+fecha',
      }));
      return { rows: out, total_monto: out.reduce((s, r) => s + Number(r.monto || 0), 0) };
    });
  }

  /** RE.10 — top proveedores por $ de ajustes (¿quién da más apoyos / quién duplica facturas?). */
  async bySupplier(q: AdjustmentsQuery = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows: any[] = await this.base(trx, tenantId, q)
        .select('proveedor_code', 'proveedor_nombre')
        .count({ n: '*' })
        .sum({ monto: 'monto' })
        .groupBy('proveedor_code', 'proveedor_nombre')
        .orderBy('monto', 'desc')
        .limit(50);
      return rows.map((r) => ({ proveedor_code: r.proveedor_code, proveedor_nombre: r.proveedor_nombre, n: Number(r.n) || 0, monto: Number(r.monto) || 0 }));
    });
  }

  /**
   * RE.10 — Reconciliación de los DOS canales de descuento de proveedor:
   *   (a) capturado AL PAGAR   → `erp_supplier_payments.descuento` (kdm1.c84, pronto pago)
   *   (b) vía NOTA DE CRÉDITO  → `erp_purchase_adjustments` X-D-55 comercial (c24)
   * Por proveedor: cuánto por canal, total, % vs compras (`erp_goods_receipts`) y el
   * CANAL (pago / nota / ambos). "ambos" = el proveedor usa las dos vías → posible
   * solapamiento del mismo descuento en el análisis (HITL: el humano revisa). Todo
   * `analytics.*` (sin RLS) → filtro `tenant_id` explícito. Aggregados por proveedor
   * (≤~739 filas) → se cruzan en JS, sin raw-binding.
   */
  async discountReconciliation(q: { date_from?: string; date_to?: string; search?: string } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const df = q.date_from || null, dt = q.date_to || null;
    return this.tk.run(async (trx) => {
      const dateMod = (col: string) => (qb: any) => { if (df) qb.where(col, '>=', df); if (dt) qb.where(col, '<=', dt); };

      const pay: any[] = await trx('analytics.erp_supplier_payments')
        .where('tenant_id', tenantId).modify(dateMod('pago_date'))
        .groupBy('proveedor_code')
        .select('proveedor_code',
          trx.raw('max(proveedor_nombre) AS nombre'),
          trx.raw('COALESCE(sum(descuento),0)::numeric AS desc_pago'),
          trx.raw('count(*) FILTER (WHERE descuento > 0)::int AS n_desc'));

      const nota: any[] = await trx('analytics.erp_purchase_adjustments')
        .where('tenant_id', tenantId)
        .whereIn('categoria', ['pronto_pago', 'descuento_comercial', 'apoyo_marca'])
        .modify(dateMod('adjustment_date'))
        .groupBy('proveedor_code')
        .select('proveedor_code',
          trx.raw('max(proveedor_nombre) AS nombre'),
          trx.raw('COALESCE(sum(monto),0)::numeric AS desc_nota'),
          trx.raw('count(*)::int AS n_nota'));

      const comp: any[] = await trx('analytics.erp_goods_receipts')
        .where('tenant_id', tenantId).modify(dateMod('receipt_date'))
        .groupBy('proveedor_code')
        .select('proveedor_code', trx.raw('COALESCE(sum(monto),0)::numeric AS compras'));

      const map = new Map<string, any>();
      const get = (code: string | null, nombre?: string) => {
        const k = code || '(sin código)';
        let e = map.get(k);
        if (!e) { e = { proveedor_code: code, proveedor_nombre: nombre || null, desc_pago: 0, desc_nota: 0, compras: 0, n_pagos_desc: 0, n_notas: 0 }; map.set(k, e); }
        if (!e.proveedor_nombre && nombre) e.proveedor_nombre = nombre;
        return e;
      };
      for (const r of pay) { const e = get(r.proveedor_code, r.nombre); e.desc_pago = Number(r.desc_pago) || 0; e.n_pagos_desc = Number(r.n_desc) || 0; }
      for (const r of nota) { const e = get(r.proveedor_code, r.nombre); e.desc_nota = Number(r.desc_nota) || 0; e.n_notas = Number(r.n_nota) || 0; }
      for (const r of comp) { const e = get(r.proveedor_code); e.compras = Number(r.compras) || 0; }

      let rows = [...map.values()].filter((e) => e.desc_pago > 0 || e.desc_nota > 0);
      if (q.search && q.search.trim()) {
        const s = q.search.trim().toLowerCase();
        rows = rows.filter((e) => (e.proveedor_nombre || '').toLowerCase().includes(s) || (e.proveedor_code || '').toLowerCase().includes(s));
      }
      for (const e of rows) {
        e.total_desc = e.desc_pago + e.desc_nota;
        e.pct_vs_compras = e.compras > 0 ? e.total_desc / e.compras : null;
        e.canal = e.desc_pago > 0 && e.desc_nota > 0 ? 'ambos' : e.desc_pago > 0 ? 'pago' : 'nota';
      }
      rows.sort((a, b) => b.total_desc - a.total_desc);

      const sum = (k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
      return {
        summary: {
          total_desc_pago: sum('desc_pago'),
          total_desc_nota: sum('desc_nota'),
          total_desc: sum('total_desc'),
          suppliers: rows.length,
          suppliers_ambos: rows.filter((r) => r.canal === 'ambos').length,
        },
        rows,
      };
    });
  }
}
