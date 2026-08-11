import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ObjectStorageService } from '@megadulces/platform-core';

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

// Predicado SQL: CONSERVA solo referencias EXTERNAS (deja pasar NULL / '(sin referencia)') y
// descarta las cuentas INTERNAS de la 201:
//   · traspasos inter-sucursal (SUCURSAL *)
//   · caja chica / gastos internos (GASTOS GENERALES / GASTOS CAJA CHICA / CAJA CHICA)
//   · viáticos y comisiones internas (VIATICOS, COMISION Y VIATICOS, COMISIONES RUTAS)
//   · nómina / mano de obra propia (NOMINA, AGUINALDO, FINIQUITO, PTU, SUELDO)
// OJO: usa prefijos ANCLADOS (^) y NUNCA 'COMISION' a secas → así NO esconde a "COMISION FEDERAL
// DE ELECTRICIDAD" (CFE, proveedor/servicio REAL). Bancos e instituciones externas quedan visibles.
// `~*` = regex case-insensitive de Postgres; sin bindings (?), string literal → seguro con knex.raw.
const INTERNAL_REF_KEEP =
  `(referencia IS NULL OR referencia !~* '^(SUCURSAL |GASTOS GENERALES|GASTOS CAJA CHICA|CAJA CHICA|VIATICOS|COMISION Y VIATICOS|COMISIONES RUTAS|NOMINA|AGUINALDO|FINIQUITO|PTU|SUELDO)')`;

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
    private readonly storage: ObjectStorageService,
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

      // Array.from (NO spread [...]): webpack downlevela [...map.values()] → [iterator] en el bundle del API. Ver feedback_webpack_set_spread_downlevel.
      let rows = Array.from(map.values()).filter((e) => e.desc_pago > 0 || e.desc_nota > 0);
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

  /**
   * RE.10 — "Descuento NO capturado" por proveedor (pronto pago dejado en la mesa).
   * Cruza pagos (`erp_supplier_payments`) contra la política (`supplier_discount_policy`,
   * tasa esperada): los pagos con `descuento = 0` de un proveedor que SÍ da descuento son
   * fuga = `tasa_esperada × monto`. Runner = trx app_runtime (request, RLS filtra policy)
   * o KNEX_NEW_DB (cron, superuser); en ambos el filtro `tenant_id` va explícito.
   */
  async leakageGroups(runner: Knex, tenantId: string): Promise<any[]> {
    const res: any = await runner.raw(
      `SELECT p.proveedor_code, max(p.proveedor_nombre) AS proveedor_nombre,
              pol.expected_discount_rate AS rate,
              count(*)::int AS n_total,
              count(*) FILTER (WHERE p.descuento > 0)::int AS n_captured,
              count(*) FILTER (WHERE p.descuento = 0)::int AS n_uncaptured,
              COALESCE(sum(p.monto) FILTER (WHERE p.descuento = 0), 0)::numeric AS monto_uncaptured,
              round(pol.expected_discount_rate * COALESCE(sum(p.monto) FILTER (WHERE p.descuento = 0), 0), 2) AS lost
         FROM analytics.erp_supplier_payments p
         JOIN commercial.supplier_discount_policy pol
           ON pol.tenant_id = p.tenant_id AND pol.proveedor_code = p.proveedor_code
        WHERE p.tenant_id = ? AND pol.active AND pol.expected_discount_rate > 0
        GROUP BY p.proveedor_code, pol.expected_discount_rate
       HAVING count(*) FILTER (WHERE p.descuento = 0) > 0
        ORDER BY lost DESC
        LIMIT 300`,
      [tenantId],
    );
    return res.rows || res;
  }

  async discountLeakage(q: { search?: string } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      let rows = await this.leakageGroups(trx as unknown as Knex, tenantId);
      if (q.search && q.search.trim()) {
        const s = q.search.trim().toLowerCase();
        rows = rows.filter((r: any) => (r.proveedor_nombre || '').toLowerCase().includes(s) || (r.proveedor_code || '').toLowerCase().includes(s));
      }
      const rowsOut = rows.map((r: any) => ({
        proveedor_code: r.proveedor_code, proveedor_nombre: r.proveedor_nombre,
        rate: Number(r.rate) || 0,
        n_total: Number(r.n_total) || 0, n_captured: Number(r.n_captured) || 0, n_uncaptured: Number(r.n_uncaptured) || 0,
        monto_uncaptured: Number(r.monto_uncaptured) || 0, lost: Number(r.lost) || 0,
      }));
      const total_lost = rowsOut.reduce((s, r) => s + r.lost, 0);
      return { summary: { total_lost, suppliers: rowsOut.length }, rows: rowsOut };
    });
  }

  /**
   * CXP.3 — "Compras 360": el Excel de recepciones en una vista. Fila = orden de
   * entrada / factura (`analytics.erp_goods_receipts`) con su OC (`oc_folio`), el ajuste
   * LIGADO EXACTO por `entrada_folio` (devoluciones/notas confirmadas) y el neto. Los
   * ajustes heurísticos (proveedor+fecha) NO se suman aquí para no inflar el neto — viven
   * en el detalle (`forEntrada`). El join a.entrada_folio=c.folio es 1:0..1 (no infla).
   * analytics.* sin RLS → filtro `tenant_id` explícito.
   */
  async compras360(q: { search?: string; sucursal?: string; proveedor_code?: string; date_from?: string; date_to?: string; con_ajuste?: boolean; ajuste?: string; con_oc?: string; comprobante?: string; monto_min?: number; monto_max?: number; page?: number; pageSize?: number; all?: boolean } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, q.page || 1);
    const pageSize = q.all ? 5000 : Math.min(200, Math.max(1, q.pageSize || 50));
    // Ajuste: enum 'con'|'sin' (nuevo), con back-compat del boolean con_ajuste.
    const ajusteMode: 'con' | 'sin' | undefined =
      q.ajuste === 'con' ? 'con' : q.ajuste === 'sin' ? 'sin' : (q.con_ajuste ? 'con' : undefined);
    return this.tk.run(async (trx) => {
      const adj = trx('analytics.erp_purchase_adjustments')
        .select('entrada_folio').sum({ ajuste: 'monto' }).count({ n_ajuste: '*' })
        .where('tenant_id', tenantId).whereNotNull('entrada_folio')
        .groupBy('entrada_folio').as('a');
      // RE.9 — estado del comprobante adjunto por entrada (finance.goods_receipt_proofs; RLS
      // satisfecho por tk.run). Agregado por (sucursal, folio): último estado + cuadre OCR.
      const dep = trx('finance.goods_receipt_proofs')
        .select('sucursal', 'folio').count('* as n')
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .select(trx.raw(`bool_or(monto_match) AS any_match`))
        .groupBy('sucursal', 'folio').as('d');
      const base = () => {
        const b = trx('analytics.erp_goods_receipts as c')
          .leftJoin(adj, 'a.entrada_folio', 'c.folio')
          .leftJoin(dep, (j: any) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
          .where('c.tenant_id', tenantId);
        if (q.sucursal) b.where('c.sucursal', q.sucursal);
        if (q.proveedor_code) b.where('c.proveedor_code', q.proveedor_code);
        if (q.date_from) b.where('c.receipt_date', '>=', q.date_from);
        if (q.date_to) b.where('c.receipt_date', '<=', q.date_to);
        if (q.monto_min != null && !Number.isNaN(q.monto_min)) b.where('c.monto', '>=', q.monto_min);
        if (q.monto_max != null && !Number.isNaN(q.monto_max)) b.where('c.monto', '<=', q.monto_max);
        if (q.con_oc === 'con') b.whereRaw("COALESCE(c.oc_folio,'') <> ''");
        else if (q.con_oc === 'sin') b.whereRaw("COALESCE(c.oc_folio,'') = ''");
        if (q.comprobante === 'sin') b.whereRaw('d.n IS NULL');
        else if (q.comprobante === 'con') b.whereRaw('d.n > 0');
        else if (q.comprobante === 'validado') b.whereRaw(`d.last_status = 'validado'`);
        else if (q.comprobante === 'por_validar') b.whereRaw(`d.last_status = 'recibido'`);
        else if (q.comprobante === 'rechazado') b.whereRaw(`d.last_status = 'rechazado'`);
        if (q.search && q.search.trim()) {
          const s = `%${q.search.trim()}%`;
          b.where((w: any) => w.where('c.proveedor_nombre', 'ilike', s).orWhere('c.proveedor_code', 'ilike', s).orWhere('c.oc_folio', 'ilike', s).orWhere('c.folio', 'ilike', s).orWhere('c.vale_folio', 'ilike', s).orWhere('c.concepto', 'ilike', s));
        }
        if (ajusteMode === 'con') b.whereRaw('COALESCE(a.ajuste,0) <> 0');
        else if (ajusteMode === 'sin') b.whereRaw('COALESCE(a.ajuste,0) = 0');
        return b;
      };
      const [{ count }]: any = await base().count({ count: '*' });
      const [tot]: any = await base().sum({ factura: 'c.monto' })
        .select(trx.raw('COALESCE(sum(a.ajuste),0) AS ajuste'), trx.raw('COUNT(d.n)::int AS con_comprobante'));
      const rows: any[] = await base()
        .select('c.sucursal', 'c.folio', 'c.receipt_date', 'c.proveedor_code', 'c.proveedor_nombre', 'c.oc_folio', 'c.vale_folio',
          trx.raw('c.monto::numeric AS factura'),
          trx.raw('COALESCE(a.ajuste,0)::numeric AS ajuste'),
          trx.raw('COALESCE(a.n_ajuste,0)::int AS n_ajuste'),
          trx.raw('COALESCE(d.n,0)::int AS deposits'),
          trx.raw('d.last_status AS deposit_status'),
          trx.raw('COALESCE(d.any_match, false) AS monto_match'))
        .orderBy('c.receipt_date', 'desc').orderBy('c.monto', 'desc')
        .limit(pageSize).offset(q.all ? 0 : (page - 1) * pageSize);
      const factura = Number(tot?.factura) || 0, ajuste = Number(tot?.ajuste) || 0;
      return {
        total: Number(count), page, pageSize,
        totals: { factura, ajuste, neto: factura - ajuste, con_comprobante: Number(tot?.con_comprobante) || 0 },
        rows: rows.map((r) => ({ ...r, factura: Number(r.factura), ajuste: Number(r.ajuste), neto: Number(r.factura) - Number(r.ajuste), deposits: Number(r.deposits) || 0, monto_match: r.monto_match === true })),
      };
    });
  }

  /** CXP.3 — catálogo para los filtros de Compras 360: sucursales + proveedores (con conteo) + monto máximo. */
  async compras360Filters() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // Mapa código→nombre (Kepler '00'..'05' + Wincaja '30'/'32'/'50'). El código crudo no dice
      // nada al comprador; se muestra el nombre en el filtro y la tabla de Compras 360 (RE.0).
      const NOMBRES: Record<string, string> = {
        '00': 'CEDIS Irapuato', '01': 'Padre Hidalgo', '02': 'La Piedad Abastos',
        '03': '8 Esquinas', '04': 'Yurécuaro', '05': 'Zamora Centro',
        '30': 'Morelia Abastos', '32': 'Morelia Madero', '50': 'Canindo',
      };
      const sucs: any[] = await trx('analytics.erp_goods_receipts')
        .where('tenant_id', tenantId).whereNotNull('sucursal')
        .groupBy('sucursal').select('sucursal').count({ n: '*' }).orderBy('sucursal', 'asc');
      const provs: any[] = await trx('analytics.erp_goods_receipts')
        .where('tenant_id', tenantId).whereNotNull('proveedor_code')
        .groupBy('proveedor_code')
        .select('proveedor_code', trx.raw('max(proveedor_nombre) AS proveedor_nombre'))
        .count({ n: '*' })
        .orderByRaw('max(proveedor_nombre) asc nulls last');
      const [mx]: any = await trx('analytics.erp_goods_receipts').where('tenant_id', tenantId).max({ m: 'monto' });
      return {
        sucursales: sucs.map((r) => ({ code: r.sucursal as string, name: NOMBRES[r.sucursal as string] || (r.sucursal as string), n: Number(r.n) || 0 })),
        proveedores: provs.map((r) => ({ code: r.proveedor_code as string, nombre: (r.proveedor_nombre as string) || null, n: Number(r.n) || 0 })),
        monto_max: Number(mx?.m) || 0,
      };
    });
  }

  /**
   * RE.9 — evidencia (comprobante) adjunta a una orden de entrada, para el visor
   * lado-a-lado en el detalle de Compras 360. Reusa `finance.goods_receipt_proofs`
   * (RLS satisfecho por tk.run) con URL de lectura PREFIRMADA (bucket privado). Solo
   * lectura, gateado por COMPRAS_360_VER (la propia pantalla) → sin acoplar el permiso
   * de Entradas. Las líneas ya vienen del row; acá solo la evidencia + OCR.
   */
  async receiptEvidence(sucursal: string, folio: string) {
    this.tenantCtx.requireTenantId();
    if (!sucursal || !folio) return { deposits: [] as any[] };
    return this.tk.run(async (trx) => {
      const deposits = await trx('finance.goods_receipt_proofs')
        .where({ sucursal, folio })
        .orderBy('created_at', 'desc')
        .select('id', 'files', 'ocr_folio', 'ocr_fecha', 'ocr_proveedor', 'ocr_rfc',
          trx.raw('ocr_subtotal::numeric AS ocr_subtotal'), trx.raw('ocr_iva::numeric AS ocr_iva'),
          trx.raw('ocr_monto::numeric AS ocr_monto'), 'ocr_status', 'monto_match',
          'discrepancy_kind', trx.raw('discrepancy_amount::numeric AS discrepancy_amount'), 'status',
          'comentarios', 'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');
      const depSigned = await Promise.all(deposits.map(async (d: any) => {
        const files = typeof d.files === 'string' ? JSON.parse(d.files || '[]') : (d.files || []);
        return {
          ...d,
          ocr_subtotal: d.ocr_subtotal != null ? Number(d.ocr_subtotal) : null,
          ocr_iva: d.ocr_iva != null ? Number(d.ocr_iva) : null,
          ocr_monto: d.ocr_monto != null ? Number(d.ocr_monto) : null,
          discrepancy_amount: d.discrepancy_amount != null ? Number(d.discrepancy_amount) : null,
          files: await this.storage.signFiles(files), // URL prefirmada (legacy Cloudinary http se deja tal cual)
        };
      }));
      return { deposits: depSigned };
    });
  }

  /**
   * CXP.6 — Póliza contable (Kepler) de una recepción/factura. Confirma que el documento
   * se ASENTÓ en libros: header (¿cuadra? Σcargos−Σabonos≈0) + las patas (102 Bancos /
   * 201 Proveedores / gasto). Join a `analytics.gl_polizas`/`gl_poliza_lines` por
   * `(source='kepler', sucursal, tipo_pol, folio)` — el folio de la póliza = folio del doc
   * (verificado 96.7% de cobertura para XA2001). analytics.* sin RLS → tenant explícito.
   */
  async polizaForReceipt(q: { sucursal: string; folio: string; tipo_pol?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const tipo = q.tipo_pol || 'XA2001';
    if (!q.sucursal || !q.folio) return { found: false, cuadra: false, polizas: [], lines: [] };
    return this.tk.run(async (trx) => {
      const key = { tenant_id: tenantId, source: 'kepler', sucursal: q.sucursal, tipo_pol: tipo, folio: q.folio };
      const polizas: any[] = await trx('analytics.gl_polizas').where(key)
        .select('ejercicio', 'periodo', 'anio_mes', 'fecha', 'concepto',
          trx.raw('cargos::numeric AS cargos'), trx.raw('abonos::numeric AS abonos'), trx.raw('neto::numeric AS neto'), 'num_lines')
        .orderBy('anio_mes', 'asc');
      const lines: any[] = await trx('analytics.gl_poliza_lines').where(key)
        .select('ejercicio', 'periodo', 'num_movto', 'cuenta', 'cuenta_nombre', 'cuenta_afectable', 'cargo_abono',
          trx.raw('importe::numeric AS importe'))
        .orderBy([{ column: 'ejercicio' }, { column: 'periodo' }, { column: 'num_movto' }]);
      const cuadra = polizas.length > 0 && polizas.every((p) => Math.abs(Number(p.neto) || 0) < 0.01);
      return {
        found: polizas.length > 0,
        cuadra,
        polizas: polizas.map((p) => ({ ...p, cargos: Number(p.cargos) || 0, abonos: Number(p.abonos) || 0, neto: Number(p.neto) || 0 })),
        lines: lines.map((l) => ({ ...l, importe: Number(l.importe) || 0 })),
      };
    });
  }

  /**
   * CXP.7 — "Cuadre contable por proveedor": estado de cuenta de la 201 (Proveedores)
   * a partir de las pólizas de Kepler. Por proveedor (referencia = beneficiario en la pata
   * 201): facturado (abono XA2001/XA1001) vs pagado (cargo XD2601/XD2501) vs notas (XD5501)
   * vs devoluciones (XD4001) → Δ del periodo (movimiento neto de la deuda; NO saldo absoluto,
   * no hay apertura). Kepler-only: es el detalle por-sucursal con semántica por tipo de doc
   * (ContPAQi consolida con tipo_pol genérico). Filtra por anio_mes derivado del rango de fecha.
   * analytics.* sin RLS → tenant explícito.
   */
  async supplierLedger(q: { date_from?: string; date_to?: string; search?: string; include_internal?: boolean } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const fromM = q.date_from ? q.date_from.slice(0, 7) : undefined; // 'YYYY-MM'
    const toM = q.date_to ? q.date_to.slice(0, 7) : undefined;
    return this.tk.run(async (trx) => {
      let b = trx('analytics.gl_poliza_lines')
        .where('tenant_id', tenantId).where('source', 'kepler').where('cuenta_mayor', '201');
      if (fromM) b = b.where('anio_mes', '>=', fromM);
      if (toM) b = b.where('anio_mes', '<=', toM);
      if (q.search && q.search.trim()) b = b.where('referencia', 'ilike', `%${q.search.trim()}%`);
      // Por default OCULTA las cuentas INTERNAS (no son proveedores externos): traspasos inter-sucursal
      // (SUCURSAL *), caja chica y gastos internos (GASTOS GENERALES/CAJA CHICA), viáticos y comisiones.
      // La 201 las asienta con el mismo doctype que una compra (XA2001) → inflaban el cuadre con
      // movimiento que se netea al consolidar. include_internal=true las trae de vuelta.
      if (!q.include_internal) b = b.whereRaw(INTERNAL_REF_KEEP);
      const rows: any[] = await b
        .select('referencia', 'tipo_pol', 'cargo_abono')
        .sum({ monto: 'importe' }).count({ n: '*' })
        .groupBy('referencia', 'tipo_pol', 'cargo_abono');

      const map = new Map<string, any>();
      for (const r of rows) {
        const key = (r.referencia as string) || '(sin referencia)';
        let e = map.get(key);
        if (!e) { e = { proveedor: (r.referencia as string) || null, facturado: 0, pagado: 0, notas: 0, devoluciones: 0, otros: 0, n: 0 }; map.set(key, e); }
        const monto = Number(r.monto) || 0; e.n += Number(r.n) || 0;
        if (r.cargo_abono === 'A') { e.facturado += monto; }         // abono → sube la deuda (factura/comprobación)
        else if (r.tipo_pol === 'XD2601' || r.tipo_pol === 'XD2501') e.pagado += monto;   // cargo → pago
        else if (r.tipo_pol === 'XD5501') e.notas += monto;          // cargo → nota de crédito
        else if (r.tipo_pol === 'XD4001') e.devoluciones += monto;   // cargo → devolución
        else e.otros += monto;                                       // otros cargos a 201
      }
      const out = Array.from(map.values());
      for (const e of out) e.delta = e.facturado - e.pagado - e.notas - e.devoluciones - e.otros;
      out.sort((a, b2) => b2.facturado - a.facturado);
      const totals = out.reduce((a, e) => ({
        facturado: a.facturado + e.facturado, pagado: a.pagado + e.pagado,
        notas: a.notas + e.notas, devoluciones: a.devoluciones + e.devoluciones, otros: a.otros + e.otros,
      }), { facturado: 0, pagado: 0, notas: 0, devoluciones: 0, otros: 0 });
      const delta = totals.facturado - totals.pagado - totals.notas - totals.devoluciones - totals.otros;
      return { source: 'kepler', total: out.length, totals: { ...totals, delta }, rows: out.slice(0, 500) };
    });
  }

  /**
   * CXP.7 — DESGLOSE (auxiliar de la 201) de UN proveedor: los movimientos individuales que
   * forman el agregado — factura / pago / nota / devolución — con folio, fecha, importe (con
   * signo: abono sube deuda, cargo la baja) y SALDO CORRIDO. Une la pata 201 a su cabecera
   * (gl_polizas) para fecha + concepto. Kepler-only; respeta el mismo rango de fecha que el cuadre.
   */
  async supplierLedgerDetail(q: { proveedor?: string; date_from?: string; date_to?: string } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const fromM = q.date_from ? q.date_from.slice(0, 7) : undefined;
    const toM = q.date_to ? q.date_to.slice(0, 7) : undefined;
    const TIPO_LABEL: Record<string, string> = {
      XA2001: 'Factura', XA1001: 'Comprobación', XD2601: 'Pago (transferencia)',
      XD2501: 'Pago (cheque)', XD5501: 'Nota de crédito', XD4001: 'Devolución',
    };
    const catOf = (tipo: string, ca: string): string =>
      ca === 'A' ? 'facturado'
      : tipo === 'XD2601' || tipo === 'XD2501' ? 'pagado'
      : tipo === 'XD5501' ? 'nota'
      : tipo === 'XD4001' ? 'devolucion' : 'otro';
    return this.tk.run(async (trx) => {
      let b = trx('analytics.gl_poliza_lines as l')
        .leftJoin('analytics.gl_polizas as h', function (this: any) {
          this.on('h.tenant_id', 'l.tenant_id').andOn('h.source', 'l.source')
            .andOn('h.ejercicio', 'l.ejercicio').andOn('h.periodo', 'l.periodo')
            .andOn('h.tipo_pol', 'l.tipo_pol').andOn('h.folio', 'l.folio').andOn('h.sucursal', 'l.sucursal');
        })
        .where('l.tenant_id', tenantId).where('l.source', 'kepler').where('l.cuenta_mayor', '201');
      if (q.proveedor) b = b.where('l.referencia', q.proveedor);
      else b = b.whereNull('l.referencia');
      if (fromM) b = b.where('l.anio_mes', '>=', fromM);
      if (toM) b = b.where('l.anio_mes', '<=', toM);
      const rows: any[] = await b
        .select('l.anio_mes', 'l.tipo_pol', 'l.folio', 'l.sucursal', 'l.cargo_abono',
          trx.raw('l.importe::numeric AS importe'), trx.raw('h.fecha AS fecha'), trx.raw('h.concepto AS concepto'))
        .orderByRaw('h.fecha asc nulls last, l.folio asc')
        .limit(1000);
      let saldo = 0;
      const out = rows.map((r) => {
        const imp = Number(r.importe) || 0;
        const signed = r.cargo_abono === 'A' ? imp : -imp; // abono sube deuda, cargo la baja
        saldo += signed;
        return {
          fecha: r.fecha, anio_mes: r.anio_mes, tipo_pol: r.tipo_pol, tipo_label: TIPO_LABEL[r.tipo_pol] || r.tipo_pol,
          folio: r.folio, sucursal: r.sucursal, cargo_abono: r.cargo_abono,
          importe: imp, signed, saldo, categoria: catOf(r.tipo_pol, r.cargo_abono), concepto: r.concepto || null,
        };
      });
      return { proveedor: q.proveedor || null, total: out.length, saldo_final: saldo, rows: out };
    });
  }

  /**
   * CXP.8 — CUADRE POR FACTURA (documental) de un proveedor: cada entrada/factura real
   * (`erp_goods_receipts`) con su ajuste estructural ligado (por `entrada_folio`) y su
   * ESTADO DE PAGO estimado FIFO — los pagos (XD2601 batcheados) consumen las facturas más
   * antiguas primero, porque el link factura↔pago NO es estructural en Kepler. El header
   * compara el saldo DOCUMENTAL (facturas − pagos) vs el CONTABLE (201) para exponer cuándo
   * la póliza Kepler está incompleta. Llave = `proveedor_code` (la misma en los 3 feeds:
   * facturas/pagos/201). Histórico completo (FIFO necesita apertura). analytics.* sin RLS →
   * tenant explícito. El link por-factura es una ESTIMACIÓN (FIFO), no un match estructural.
   */
  async supplierInvoiceLedger(q: { proveedor_code?: string; proveedor?: string } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // 1. resolver proveedor_code (el drill llega por nombre de la 201, que == proveedor_nombre del feed)
      let code = (q.proveedor_code || '').trim() || null;
      let nombre = (q.proveedor || '').trim() || null;
      if (!code && nombre) {
        // el nombre llega de la 201 (referencia) y a veces viene TRUNCADO vs el feed
        // ("…N.C DE" vs "…N.C DE CV") → intento exacto y luego por PREFIJO, en pagos y facturas.
        const resolve = async (table: string, mode: 'exact' | 'prefix'): Promise<string | null> => {
          let qb = trx(table).where('tenant_id', tenantId);
          qb = mode === 'exact' ? qb.where('proveedor_nombre', nombre) : qb.where('proveedor_nombre', 'ilike', `${nombre}%`);
          const r: any[] = await qb.groupBy('proveedor_code').select('proveedor_code').sum({ t: 'monto' }).orderByRaw('sum(monto) desc').limit(1);
          return r[0]?.proveedor_code || null;
        };
        code = (await resolve('analytics.erp_supplier_payments', 'exact'))
          || (await resolve('analytics.erp_goods_receipts', 'exact'))
          || (await resolve('analytics.erp_supplier_payments', 'prefix'))
          || (await resolve('analytics.erp_goods_receipts', 'prefix'));
      }
      if (!code) return { found: false, proveedor_code: null, proveedor_nombre: nombre, totals: null, rows: [] as any[] };

      // 2. facturas (entradas reales) — histórico, asc para FIFO
      const facts: any[] = await trx('analytics.erp_goods_receipts')
        .where('tenant_id', tenantId).where('proveedor_code', code)
        .select('folio', 'sucursal', 'oc_folio', 'concepto',
          trx.raw('receipt_date::date AS receipt_date'), trx.raw('monto::numeric AS monto'))
        .orderByRaw('receipt_date asc nulls last, folio asc');
      if (!nombre) {
        const nm: any[] = await trx('analytics.erp_goods_receipts').where('tenant_id', tenantId).where('proveedor_code', code).select('proveedor_nombre').limit(1);
        nombre = nm[0]?.proveedor_nombre || null;
      }

      // 3. ajustes estructurales ligados por entrada_folio (devolución/nota → reducen lo adeudado)
      const adjRows: any[] = await trx('analytics.erp_purchase_adjustments')
        .where('tenant_id', tenantId).where('proveedor_code', code)
        .whereNotNull('entrada_folio').whereRaw("entrada_folio <> ''")
        .groupBy('entrada_folio').select('entrada_folio').sum({ m: 'monto' });
      const adjByFolio = new Map<string, number>();
      for (const a of adjRows) adjByFolio.set(String(a.entrada_folio), Number(a.m) || 0);

      // 4. total pagado (histórico) + conteo
      const payAgg: any[] = await trx('analytics.erp_supplier_payments')
        .where('tenant_id', tenantId).where('proveedor_code', code)
        .select(trx.raw('COALESCE(sum(monto),0)::numeric AS total'), trx.raw('count(*)::int AS n'));
      const totalPagado = Number(payAgg[0]?.total) || 0;
      const nPagos = Number(payAgg[0]?.n) || 0;

      // 5. FIFO: el pago acumulado consume las facturas más antiguas primero
      let cum = 0, nPagadas = 0, nParciales = 0, nPendientes = 0;
      const all = facts.map((f) => {
        const bruto = Number(f.monto) || 0;
        const ajuste = adjByFolio.get(String(f.folio)) || 0;
        const neto = bruto - ajuste;
        const prev = cum; cum += neto;
        let pagado = 0; let estado = 'pendiente';
        if (cum <= totalPagado) { pagado = neto; estado = 'pagada'; nPagadas++; }
        else if (prev >= totalPagado) { pagado = 0; estado = 'pendiente'; nPendientes++; }
        else { pagado = totalPagado - prev; estado = 'parcial'; nParciales++; }
        return {
          folio: f.folio, sucursal: f.sucursal, oc_folio: f.oc_folio || null, concepto: f.concepto || null,
          fecha: f.receipt_date, bruto, ajuste, neto, pagado, pendiente: neto - pagado, estado,
        };
      });
      const facturado = all.reduce((s, r) => s + r.neto, 0);
      const pendiente_total = all.reduce((s, r) => s + r.pendiente, 0);
      const anticipo = totalPagado > facturado ? totalPagado - facturado : 0;

      // 6. cross-check CONTABLE (201, por nombre) — expone si la póliza Kepler está incompleta
      let contable: { facturado: number; pagado: number; saldo: number } | null = null;
      if (nombre) {
        const l2: any[] = await trx('analytics.gl_poliza_lines')
          .where('tenant_id', tenantId).where('source', 'kepler').where('cuenta_mayor', '201').where('referencia', nombre)
          .select('cargo_abono', 'tipo_pol').sum({ m: 'importe' }).groupBy('cargo_abono', 'tipo_pol');
        let f201 = 0; let p201 = 0;
        for (const r of l2) {
          const m = Number(r.m) || 0;
          if (r.cargo_abono === 'A') f201 += m;
          else if (r.tipo_pol === 'XD2601' || r.tipo_pol === 'XD2501') p201 += m;
        }
        contable = { facturado: f201, pagado: p201, saldo: f201 - p201 };
      }

      const rows = all.slice().reverse().slice(0, 300); // más reciente primero, cap 300
      return {
        found: true, proveedor_code: code, proveedor_nombre: nombre,
        totals: {
          facturado, pagado: totalPagado, saldo: facturado - totalPagado, anticipo,
          n_facturas: all.length, n_pagadas: nPagadas, n_parciales: nParciales, n_pendientes: nPendientes,
          pendiente_total, n_pagos: nPagos, contable,
        },
        rows,
      };
    });
  }

  /** Resuelve el código Kepler de un proveedor por su nombre (exacto → prefijo, en pagos y facturas). */
  private async resolveProveedorCode(trx: Knex, tenantId: string, nombre: string): Promise<string | null> {
    const q = async (table: string, mode: 'exact' | 'prefix'): Promise<string | null> => {
      let qb = trx(table).where('tenant_id', tenantId);
      qb = mode === 'exact' ? qb.where('proveedor_nombre', nombre) : qb.where('proveedor_nombre', 'ilike', `${nombre}%`);
      const r: any[] = await qb.groupBy('proveedor_code').select('proveedor_code').sum({ t: 'monto' }).orderByRaw('sum(monto) desc').limit(1);
      return r[0]?.proveedor_code || null;
    };
    return (await q('analytics.erp_supplier_payments', 'exact')) || (await q('analytics.erp_goods_receipts', 'exact'))
      || (await q('analytics.erp_supplier_payments', 'prefix')) || (await q('analytics.erp_goods_receipts', 'prefix'));
  }

  /**
   * CXP.9 — TERCERA lente del cuadre: FISCAL (ContPAQi). Compara al mismo proveedor en los TRES
   * libros: Kepler operativo (facturas/pagos reales) vs Kepler contable (201) vs ContPAQi fiscal
   * (SoR, cuenta de proveedores 2120*, ya filtrada Afectable=1 al importar). ContPAQi segmenta por
   * proveedor en la CUENTA (`cuenta_nombre`), no en `referencia` (que trae folios). El match
   * Kepler↔ContPAQi es por NOMBRE NORMALIZADO (mayúsculas, sin acentos ni signos, igualdad o
   * prefijo) porque los nombres difieren en puntuación/acentos ("CANEL'S" vs "CANEL?S", doble
   * espacio, truncados) — el prefijo CRUDO producía falsos positivos ($185k en vez de $34M). Los
   * tres libros NO atan al peso: distinto alcance/periodo/filtro fiscal → sirve para ver
   * DIVERGENCIA, no cuadre exacto. analytics.* sin RLS → tenant explícito.
   */
  async supplierFiscalLedger(q: { proveedor?: string } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const nombre = (q.proveedor || '').trim();
    if (!nombre) return { proveedor: null, contpaqi: { matched: false }, operativo: null, contable: null, rows: [] as any[] };
    const norm = (s: string) => (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
    const target = norm(nombre);
    return this.tk.run(async (trx) => {
      // ContPAQi desde la BALANZA (`contpaqi_ledger_monthly`, con saldo de APERTURA): saldo REAL
      // ("lo que se debe") + evolución mensual del último ejercicio. `gl_poliza_lines` solo tenía
      // movimientos parciales sin apertura → daba saldo engañoso. Match por nombre normalizado
      // sobre la cuenta de proveedores 2120*.
      const cpqAccs: any[] = await trx('analytics.contpaqi_ledger_monthly')
        .where('tenant_id', tenantId).where('cuenta', 'like', '2120%')
        .distinct('cuenta', 'cuenta_nombre');
      let hits = target.length >= 4 ? cpqAccs.filter((a) => norm(a.cuenta_nombre) === target) : [];
      if (!hits.length && target.length >= 8) {
        hits = cpqAccs.filter((a) => { const rn = norm(a.cuenta_nombre); return rn.length >= 8 && (rn.startsWith(target) || target.startsWith(rn)); });
      }
      let contpaqi: any;
      let rows: any[] = [];
      if (hits.length) {
        const cuentas = hits.map((h) => h.cuenta);
        const [ejr]: any = await trx('analytics.contpaqi_ledger_monthly').where('tenant_id', tenantId).whereIn('cuenta', cuentas).max({ ej: 'ejercicio' });
        const ej = Number(ejr?.ej) || null;
        // meses del último ejercicio (sum agrega si el proveedor tuviera >1 cuenta 2120)
        const mens: any[] = ej ? await trx('analytics.contpaqi_ledger_monthly')
          .where('tenant_id', tenantId).whereIn('cuenta', cuentas).where('ejercicio', ej)
          .groupBy('anio_mes', 'periodo')
          .select('anio_mes', 'periodo',
            trx.raw('COALESCE(sum(abonos::numeric),0) AS abonos'),
            trx.raw('COALESCE(sum(cargos::numeric),0) AS cargos'),
            trx.raw('COALESCE(sum(saldo_ini::numeric),0) AS saldo_ini'))
          .orderBy('periodo') : [];
        const saldoIni = mens.length ? Number(mens[0].saldo_ini) || 0 : 0; // apertura del ejercicio (acreedor = se debe)
        let running = saldoIni;
        rows = mens.map((m) => {
          const ab = Number(m.abonos) || 0; const cg = Number(m.cargos) || 0;
          running += ab - cg; // abono sube la deuda, cargo (pago) la baja
          return { anio_mes: m.anio_mes, abonos: ab, cargos: cg, saldo: running };
        });
        const facturado = rows.reduce((s, r) => s + r.abonos, 0);
        const pagado = rows.reduce((s, r) => s + r.cargos, 0);
        contpaqi = { matched: true, cuentas, cuenta_nombre: hits[0].cuenta_nombre, facturado, pagado, saldo: running, saldo_ini: saldoIni, ejercicio: ej, n: rows.length };
      } else {
        contpaqi = { matched: false, cuentas: [], cuenta_nombre: null, facturado: 0, pagado: 0, saldo: 0, saldo_ini: 0, ejercicio: null, n: 0 };
      }

      // Kepler operativo (facturas/pagos reales, histórico completo).
      const code = await this.resolveProveedorCode(trx as unknown as Knex, tenantId, nombre);
      let operativo: any = null;
      if (code) {
        const [rc]: any = await trx('analytics.erp_goods_receipts').where('tenant_id', tenantId).where('proveedor_code', code).select(trx.raw('COALESCE(sum(monto),0)::numeric AS f'));
        const [pc]: any = await trx('analytics.erp_supplier_payments').where('tenant_id', tenantId).where('proveedor_code', code).select(trx.raw('COALESCE(sum(monto),0)::numeric AS p'));
        const f = Number(rc?.f) || 0; const p = Number(pc?.p) || 0;
        operativo = { facturado: f, pagado: p, saldo: f - p, proveedor_code: code };
      }

      // Kepler contable (201, por nombre, histórico completo).
      const l2: any[] = await trx('analytics.gl_poliza_lines')
        .where('tenant_id', tenantId).where('source', 'kepler').where('cuenta_mayor', '201').where('referencia', nombre)
        .select('cargo_abono', 'tipo_pol').sum({ m: 'importe' }).groupBy('cargo_abono', 'tipo_pol');
      let cf = 0; let cp = 0;
      for (const r of l2) { const m = Number(r.m) || 0; if (r.cargo_abono === 'A') cf += m; else if (r.tipo_pol === 'XD2601' || r.tipo_pol === 'XD2501') cp += m; }
      const contable = { facturado: cf, pagado: cp, saldo: cf - cp };

      return { proveedor: nombre, contpaqi, operativo, contable, rows };
    });
  }

  /**
   * CXP.10 — "Lo que se debe" a proveedores según ContPAQi (SoR fiscal): saldo REAL de la cuenta
   * de proveedores 2120* desde la BALANZA (`contpaqi_ledger_monthly`, que trae saldo de APERTURA
   * del ejercicio). saldo = apertura(último ejercicio cargado) + Σ(abonos − cargos) del año. `stale`
   * = la cuenta no movió en el último mes global (saldo viejo colgado → aging/riesgo). NO usa
   * `gl_poliza_lines` (movimientos parciales sin apertura → saldo engañoso, daba total negativo).
   * Read-only; analytics.* sin RLS → tenant explícito (named binding, evita el gotcha del `?`).
   * Filtros: search, only_stale.
   */
  async contpaqiPayables(q: { search?: string; only_stale?: boolean } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const res: any = await trx.raw(
        `WITH ly AS (
           SELECT cuenta, MAX(ejercicio) ej FROM analytics.contpaqi_ledger_monthly
            WHERE tenant_id = :tenant AND cuenta LIKE '2120%' GROUP BY cuenta)
         SELECT l.cuenta,
                max(l.cuenta_nombre) AS proveedor,
                max(l.saldo_ini::numeric) AS saldo_ini,
                sum(l.abonos::numeric - l.cargos::numeric) AS mov,
                max(l.anio_mes) AS hasta
           FROM analytics.contpaqi_ledger_monthly l
           JOIN ly ON ly.cuenta = l.cuenta AND ly.ej = l.ejercicio
          WHERE l.tenant_id = :tenant
          GROUP BY l.cuenta`,
        { tenant: tenantId },
      );
      const agg: any[] = res.rows || res;
      const globalHasta = agg.reduce((m, r) => (r.hasta && r.hasta > m ? r.hasta : m), '');
      const mkey = (am: string) => { const [y, mo] = String(am || '').split('-').map(Number); return (y || 0) * 12 + (mo || 0); };
      const gk = mkey(globalHasta);
      // Mapa inverso ContPAQi→Kepler por nombre normalizado: para que el drill (que resuelve las lentes
      // Kepler por nombre) funcione al abrir desde una fila ContPAQi con grafía distinta (CANEL'S vs CANEL?S).
      const norm = (s: string) => (s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
      const knP: any[] = await trx('analytics.erp_supplier_payments').where('tenant_id', tenantId).distinct('proveedor_nombre');
      const knR: any[] = await trx('analytics.erp_goods_receipts').where('tenant_id', tenantId).distinct('proveedor_nombre');
      const keplerByNorm = new Map<string, string>();
      for (const k of knP.concat(knR)) { const nm = k.proveedor_nombre as string; if (nm) { const key = norm(nm); if (key && !keplerByNorm.has(key)) keplerByNorm.set(key, nm); } }
      let rows = agg.map((r) => {
        const saldo = (Number(r.saldo_ini) || 0) + (Number(r.mov) || 0);
        // stale = sin movimiento en 3+ meses (saldo colgado/aging), no solo "le falta el último mes".
        return { cuenta: r.cuenta, proveedor: r.proveedor, proveedor_kepler: keplerByNorm.get(norm(r.proveedor)) || null, saldo, hasta: r.hasta, stale: !!(r.hasta && gk - mkey(r.hasta) >= 3) };
      }).filter((r) => Math.abs(r.saldo) >= 1);
      if (q.search && q.search.trim()) { const s = q.search.trim().toLowerCase(); rows = rows.filter((r) => (r.proveedor || '').toLowerCase().includes(s)); }
      if (q.only_stale) rows = rows.filter((r) => r.stale);
      rows.sort((a, b) => b.saldo - a.saldo);
      const total_debe = rows.filter((r) => r.saldo > 0).reduce((s, r) => s + r.saldo, 0);
      const total_favor = rows.filter((r) => r.saldo < 0).reduce((s, r) => s + r.saldo, 0);
      const n_stale = rows.filter((r) => r.stale && r.saldo > 0).length;
      return { as_of: globalHasta, total_debe, total_favor, neto: total_debe + total_favor, n: rows.length, n_stale, rows: rows.slice(0, 1000) };
    });
  }

  /**
   * CXP.4 — Costo neto (landed cost) por proveedor: el costo REAL de comprarle a cada
   * proveedor = compras − descuentos efectivos (pronto pago c84 + notas comerciales).
   * `rate` = desc/compras; `costo_neto` = compras − desc. Le dice al comprador que su
   * costo con X es ~rate% menor que la lista → decidir el reabasto con el costo verdadero,
   * no el bruto. `anomalo` = rate>20%: probablemente incluye devoluciones/errores, no solo
   * descuento (HITL: no confiar ciego). analytics.* sin RLS → tenant_id explícito.
   */
  async landedCost(q: { min_compras?: number; search?: string; date_from?: string; date_to?: string; only_anomalo?: boolean } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const minCompras = Number(q.min_compras) || 0;
    // Cada tabla filtra por SU propia columna de fecha (pago/ajuste/recepción).
    const byDate = (col: string) => (b: any) => { if (q.date_from) b.where(col, '>=', q.date_from); if (q.date_to) b.where(col, '<=', q.date_to); };
    return this.tk.run(async (trx) => {
      const pay: any[] = await trx('analytics.erp_supplier_payments').where('tenant_id', tenantId).modify(byDate('pago_date'))
        .groupBy('proveedor_code').select('proveedor_code', trx.raw('max(proveedor_nombre) AS nombre'), trx.raw('COALESCE(sum(descuento),0)::numeric AS desc_pago'));
      const nota: any[] = await trx('analytics.erp_purchase_adjustments').where('tenant_id', tenantId)
        .whereIn('categoria', ['pronto_pago', 'descuento_comercial', 'apoyo_marca']).modify(byDate('adjustment_date'))
        .groupBy('proveedor_code').select('proveedor_code', trx.raw('max(proveedor_nombre) AS nombre'), trx.raw('COALESCE(sum(monto),0)::numeric AS desc_nota'));
      const comp: any[] = await trx('analytics.erp_goods_receipts').where('tenant_id', tenantId).modify(byDate('receipt_date'))
        .groupBy('proveedor_code').select('proveedor_code', trx.raw('max(proveedor_nombre) AS nombre'), trx.raw('COALESCE(sum(monto),0)::numeric AS compras'));

      const map = new Map<string, any>();
      const get = (code: string | null, nombre?: string) => {
        const k = code || '(sin código)';
        let e = map.get(k);
        if (!e) { e = { proveedor_code: code, proveedor_nombre: nombre || null, compras: 0, desc_pago: 0, desc_nota: 0 }; map.set(k, e); }
        if (!e.proveedor_nombre && nombre) e.proveedor_nombre = nombre;
        return e;
      };
      for (const r of comp) { const e = get(r.proveedor_code, r.nombre); e.compras = Number(r.compras) || 0; }
      for (const r of pay) { const e = get(r.proveedor_code, r.nombre); e.desc_pago = Number(r.desc_pago) || 0; }
      for (const r of nota) { const e = get(r.proveedor_code, r.nombre); e.desc_nota = Number(r.desc_nota) || 0; }

      // Array.from (NO spread): webpack rompe [...map.values()] en el bundle del API → suppliers:0. Ver feedback_webpack_set_spread_downlevel.
      let rows = Array.from(map.values()).filter((e) => e.compras > 0 && e.compras >= minCompras);
      if (q.search && q.search.trim()) {
        const s = q.search.trim().toLowerCase();
        rows = rows.filter((e) => (e.proveedor_nombre || '').toLowerCase().includes(s) || (e.proveedor_code || '').toLowerCase().includes(s));
      }
      for (const e of rows) {
        e.descuento = e.desc_pago + e.desc_nota;
        e.rate = e.compras > 0 ? e.descuento / e.compras : 0;
        e.costo_neto = e.compras - e.descuento;
        e.anomalo = e.rate > 0.2; // >20% probablemente incluye devoluciones/errores, no solo descuento
      }
      if (q.only_anomalo) rows = rows.filter((e) => e.anomalo); // filtro "solo anómalos" tras calcular rate
      rows.sort((a, b) => b.compras - a.compras);
      const compras = rows.reduce((s, r) => s + r.compras, 0), descuento = rows.reduce((s, r) => s + r.descuento, 0);
      return {
        summary: { compras, descuento, costo_neto: compras - descuento, rate: compras > 0 ? descuento / compras : 0, suppliers: rows.length },
        rows: rows.slice(0, 200),
      };
    });
  }
}
