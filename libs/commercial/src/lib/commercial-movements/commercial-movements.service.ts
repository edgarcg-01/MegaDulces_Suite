import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * DM.1 — Diario de movimientos (mejora del reporte Kepler homónimo).
 *
 * Lee analytics.stock_movements (feed line-level de import-stock-movements.js).
 * Diseño: **agregación primero, folio a folio bajo demanda** (ver ERP_KEPLER_SCHEMA
 * §"Reporte Diario de movimientos" #7):
 *   - summary()   → KPIs por dirección + desglose por tipo de documento.
 *   - aggregate() → vista DEFAULT: totales agrupados (producto|tipo|día|almacén),
 *                   con entradas/salidas/neto/valorizado. Re-agrupable con group_by.
 *   - lines()     → DRILL: folios individuales de una rama (producto/tipo/fecha).
 *
 * analytics.* sin RLS → filtro tenant_id EXPLÍCITO. Todo dentro de tk.run().
 */

const GROUPS = ['product', 'doc_code', 'day', 'warehouse'] as const;
type GroupBy = (typeof GROUPS)[number];
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Docs informativos (k_binv=0, movement_kind='info' en el feed): solo visibles con filtro explícito
const INFO_DOC_CODES = ['ApEntOr1'];
// DM.11b — clasifica el DESTINO de un traspaso (dest_label/dest_code) como RUTA de reparto.
// Cubre "R.D. 28", "RD MORELIA", "R.V. …", "RV-PH-01", "RUTA 501". Sucursal = todo lo demás
// (TI### traspaso a sucursal, P.V. piso, TLMKT). Sin `?` a propósito → seguro inline en raw.
const ROUTE_RX = '^\\s*(R\\.[DV]|R[DV]|RUTA)';

export interface MovementsQuery {
  warehouse_id?: string;
  warehouse_ids?: string; // CSV multi-almacén
  from?: string;
  to?: string;
  doc_code?: string;      // filtra por tipo de documento (Sale1/Purchas1…)
  movement_kind?: string; // 'entrada' | 'salida'
  product_id?: string;
  search?: string;        // nombre/sku producto
  folio?: string;         // filtra un folio exacto (drill al documento)
  estado?: string;        // estado de traspaso: en_transito | completado | diferencia
  transfer_wh_ids?: string; // CSV UUIDs — traspasos cuyo ORIGEN o DESTINO ∈ selección (propio o contraparte)
  dest_kinds?: string;    // CSV 'sucursal'|'ruta'|'cliente' — destino de traspasos; default 'sucursal'
  group_by?: string;
  page?: number;
  pageSize?: number;
}

type TransferDocStatus = 'en_transito' | 'completado' | 'diferencia';

/** DM.12 — filtros de la vista del detalle 515 (no afectan el pareo, solo qué se devuelve). */
export interface LedgerDetailFilters {
  bucket?: string;      // exacto | costo | sin_rastro
  kind?: string;        // entrada | salida
  sucursal?: string;    // 00..05
  search?: string;      // folio / referencia (ILIKE contains)
  min_amount?: string | number;
}

@Injectable()
export class CommercialMovementsService {
  private readonly logger = new Logger(CommercialMovementsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private group(v?: string): GroupBy {
    return (GROUPS as readonly string[]).includes(v || '') ? (v as GroupBy) : 'product';
  }

  private whIds(q: MovementsQuery): string[] {
    return (q.warehouse_ids || q.warehouse_id || '')
      .split(',').map((s) => s.trim()).filter((s) => UUID_RX.test(s));
  }

  private transferWhIds(q: MovementsQuery): string[] {
    return (q.transfer_wh_ids || '')
      .split(',').map((s) => s.trim()).filter((s) => UUID_RX.test(s));
  }

  /**
   * DM.11b — tipos de destino de traspaso a mostrar (default 'sucursal'). Un TrsfShip va a:
   *   sucursal → otra sucursal (dest_code 'TI###'; el traspaso interno "primordial")
   *   ruta     → ruta de reparto (R.D./R.V./RUTA)
   *   cliente  → tienda/cliente u otro (resto: ABARROTES…, TLMKT, códigos sueltos)
   */
  private destKinds(q: MovementsQuery): ('sucursal' | 'ruta' | 'cliente')[] {
    const ks = (q.dest_kinds || '').split(',').map((s) => s.trim().toLowerCase())
      .filter((s) => s === 'sucursal' || s === 'ruta' || s === 'cliente') as ('sucursal' | 'ruta' | 'cliente')[];
    // DM.11c — sin parámetro ⇒ MOSTRAR TODO (no ocultar movimientos por default). El scope
    // "solo sucursal" es opt-in explícito desde el front. Los 3 ⇒ destBucketSql='' ⇒ sin filtro.
    // Dedup con filter+indexOf (NO `[...new Set()]`): el bundle webpack de la API downlevelea
    // mal el spread de Set → devolvía `[Set]` en vez de los valores → destBucketSql='false' →
    // el filtro Destino no arrojaba nada (bug prod diagnosticado 2026-08). Ver [[feedback_...]].
    const uniq = ks.filter((v, i) => ks.indexOf(v) === i);
    return uniq.length ? uniq : ['sucursal', 'ruta', 'cliente'];
  }

  /** SQL por bucket de destino (sobre m.dest_code/m.dest_label). */
  private destBucketSql(kinds: ('sucursal' | 'ruta' | 'cliente')[], tenantId: string): string {
    if (kinds.length === 3) return ''; // todos = sin filtro
    const isRoute = `(coalesce(m.dest_label,'') ~* '${ROUTE_RX}' OR coalesce(m.dest_code,'') ~* '${ROUTE_RX}')`;
    // Sucursal = traspaso interno cuyo destino RESUELVE a un almacén (no ruta). Tres caminos,
    // cualquiera basta (tenantId viene de requireTenantId() → UUID, inline seguro):
    //   1) patrón histórico CEDIS 'TI###'.
    //   2) mapa CURADO transfer_dest_map (warehouse_id NO nulo).
    //   3) el dest_code coincide con el `code` de un almacén: prod usa el nº de sucursal
    //      ('01'..'05'), local usa 'MD-NN' → probamos dest_code y 'MD-'||dest_code.
    // Antes solo (1)+(2): los traspasos con dest_code = nº de sucursal ('04','05'…) NO
    // matcheaban y caían en el bucket "cliente" → al filtrar Sucursal DESAPARECÍAN (bug
    // reportado: "solo los veo si deselecciono el destino"). El nº de cliente ('45','103')
    // no resuelve a ningún almacén → sigue en "cliente", que es lo correcto.
    const resolvesWh = `EXISTS (
      SELECT 1 FROM commercial.warehouses sw
      WHERE sw.tenant_id = '${tenantId}'::uuid AND sw.deleted_at IS NULL AND sw.code NOT ILIKE 'RUTA%'
        AND upper(sw.code) IN (upper(coalesce(m.dest_code,'')), 'MD-' || upper(coalesce(m.dest_code,''))))`;
    const isSuc = `(NOT ${isRoute} AND (
      m.dest_code ILIKE 'TI%'
      OR EXISTS (SELECT 1 FROM analytics.transfer_dest_map dm
                 WHERE dm.tenant_id = '${tenantId}'::uuid AND dm.dest_code = m.dest_code AND dm.warehouse_id IS NOT NULL)
      OR ${resolvesWh}))`;
    const conds: string[] = [];
    if (kinds.includes('sucursal')) conds.push(isSuc);
    if (kinds.includes('ruta')) conds.push(isRoute);
    if (kinds.includes('cliente')) conds.push(`(NOT ${isSuc} AND NOT ${isRoute})`);
    return conds.length ? `(${conds.join(' OR ')})` : `false`;
  }

  /** WHERE de destino: acota los TrsfShip por bucket; no toca el resto de docs. */
  private applyDestFilter(b: any, q: MovementsQuery, tenantId: string) {
    const sql = this.destBucketSql(this.destKinds(q), tenantId);
    if (sql) b.whereRaw(`(m.doc_code <> 'TrsfShip' OR ${sql})`);
  }

  /** Rango por default: últimos 30 días. */
  private range(q: MovementsQuery): { from: string; to: string } {
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : new Date().toISOString().slice(0, 10);
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)
      ? q.from
      : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    return { from, to };
  }

  /** WHERE base reutilizable (tenant + rango + filtros). */
  private base(trx: any, tenantId: string, q: MovementsQuery) {
    const { from, to } = this.range(q);
    const b = trx('analytics.stock_movements as m')
      .where('m.tenant_id', tenantId)
      .andWhere('m.doc_date', '>=', from)
      .andWhere('m.doc_date', '<=', to);
    const whs = this.whIds(q);
    if (whs.length) b.whereIn('m.warehouse_id', whs);
    if (q.doc_code) b.where('m.doc_code', q.doc_code);
    if (q.movement_kind === 'entrada' || q.movement_kind === 'salida') b.where('m.movement_kind', q.movement_kind);
    if (q.product_id && UUID_RX.test(q.product_id)) b.where('m.product_id', q.product_id);
    if (q.folio) b.where('m.folio', q.folio);
    // Tipos INFORMATIVOS (k_binv=0, ej. Aplicación de orden de entrada XA20): espejan las
    // líneas de su doc padre → fuera de KPIs y listado, salvo filtro explícito por ese tipo
    if (!INFO_DOC_CODES.includes(q.doc_code || '')) b.whereNot('m.movement_kind', 'info');
    // estado y origen/destino solo aplican a traspasos → todo (summary/aggregate/lines) se acota a ellos
    if (['en_transito', 'completado', 'diferencia'].includes(q.estado || '') || this.transferWhIds(q).length) {
      b.whereIn('m.doc_code', ['TrsfShip', 'TrsfRcv']);
    }
    // DM.11b — destino: por defecto oculta traspasos a rutas de reparto (no primordial)
    this.applyDestFilter(b, q, tenantId);
    if (q.search) {
      b.whereIn('m.product_id',
        trx('public.products').select('id').where('tenant_id', tenantId)
          .andWhere((w: any) => w.whereILike('nombre', `%${q.search}%`).orWhereILike('sku', `%${q.search}%`)));
    }
    return b;
  }

  private entradas = `SUM(CASE WHEN m.signed_qty > 0 THEN m.qty ELSE 0 END)`;
  private salidas = `SUM(CASE WHEN m.signed_qty < 0 THEN m.qty ELSE 0 END)`;

  /** KPIs de cabecera + desglose por tipo de documento. */
  async summary(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [tot] = await this.base(trx, tenantId, q).select(
        trx.raw(`${this.entradas} AS entradas`),
        trx.raw(`${this.salidas} AS salidas`),
        trx.raw(`SUM(m.signed_qty) AS neto`),
        trx.raw(`SUM(m.amount) AS valor`),
        trx.raw(`COUNT(*)::int AS lineas`),
        trx.raw(`COUNT(DISTINCT m.folio)::int AS documentos`),
      );
      const byType = await this.base(trx, tenantId, q)
        .select('m.doc_code', 'm.movement_label', 'm.movement_kind')
        .select(
          trx.raw(`SUM(m.qty) AS piezas`),
          trx.raw(`SUM(m.amount) AS valor`),
          trx.raw(`COUNT(*)::int AS lineas`),
        )
        .groupBy('m.doc_code', 'm.movement_label', 'm.movement_kind')
        .orderBy('lineas', 'desc');
      const { from, to } = this.range(q);
      return { range: { from, to }, totals: tot, by_type: byType };
    });
  }

  /** Vista DEFAULT agregada. group_by = product | doc_code | day | warehouse. */
  async aggregate(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const g = this.group(q.group_by);
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));

    return this.tk.run(async (trx) => {
      const build = () => {
        const b = this.base(trx, tenantId, q);
        if (g === 'product') {
          b.leftJoin('public.products as p', function (this: any) {
            this.on('p.id', 'm.product_id').andOn('p.tenant_id', 'm.tenant_id');
          }).groupBy('m.product_id', 'p.nombre', 'p.sku')
            .select('m.product_id as key', 'p.nombre as label', 'p.sku as sku');
        } else if (g === 'doc_code') {
          b.groupBy('m.doc_code', 'm.movement_label', 'm.movement_kind')
            .select('m.doc_code as key', 'm.movement_label as label', 'm.movement_kind');
        } else if (g === 'day') {
          b.groupBy('m.doc_date').select('m.doc_date as key', 'm.doc_date as label');
        } else {
          b.leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
            .groupBy('m.warehouse_id', 'w.name', 'w.code')
            .select('m.warehouse_id as key', 'w.name as label', 'w.code as code');
        }
        return b.select(
          trx.raw(`${this.entradas} AS entradas`),
          trx.raw(`${this.salidas} AS salidas`),
          trx.raw(`SUM(m.signed_qty) AS neto`),
          trx.raw(`SUM(m.amount) AS valor`),
          trx.raw(`COUNT(*)::int AS lineas`),
          trx.raw(`COUNT(DISTINCT m.folio)::int AS documentos`),
        );
      };

      // Conteo sobre el subquery agrupado (NO materializar todas las filas dos veces).
      const countRows: any[] = await trx.count('* as count').from(build().as('g'));
      const total = Number(countRows[0]?.count ?? 0);
      // Vista 'day' ordena cronológicamente: con pageSize cap, page 1 = los días MÁS RECIENTES
      // (ordenar por valor truncaría días recientes de bajo monto en rangos > pageSize).
      const orderSql = g === 'day' ? 'm.doc_date DESC' : 'SUM(m.amount) DESC NULLS LAST';
      const rows = await build()
        .orderByRaw(orderSql)
        .limit(pageSize).offset((page - 1) * pageSize);

      return { group_by: g, page, pageSize, total, rows };
    });
  }

  /**
   * DRILL: folios de una rama, ENGLOBADOS — una fila por documento (folio×tipo×almacén),
   * no por línea. `lineas` dice cuántos productos trae; el detalle lo da document().
   * Para traspasos anota `transfer_status` (en_transito|completado|diferencia); con
   * `?estado=` filtra por ese estado (restringe a docs de traspaso y pagina en memoria).
   */
  async lines(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 100));
    const estado = ['en_transito', 'completado', 'diferencia'].includes(q.estado || '') ? (q.estado as TransferDocStatus) : null;
    const transferWhs = this.transferWhIds(q);
    return this.tk.run(async (trx) => {
      // base() ya acota a docs de traspaso cuando hay estado u origen/destino
      const grouped = () => this.base(trx, tenantId, q)
        .groupBy('m.warehouse_id', 'm.folio', 'm.doc_code', 'm.doc_serie', 'm.movement_label', 'm.movement_kind', 'm.source_branch');
      const fetch = (limit: number, offset: number) => grouped()
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        // DM.4 — marca humana "auditado" (identidad doc = warehouse+doc_code+serie+folio)
        .leftJoin('commercial.stock_movement_audits as a', function (this: any) {
          this.on('a.tenant_id', 'm.tenant_id').andOn('a.warehouse_id', 'm.warehouse_id')
            .andOn('a.doc_code', 'm.doc_code').andOn('a.folio', 'm.folio')
            .andOn(trx.raw(`a.doc_serie = coalesce(m.doc_serie,'')`));
        })
        .groupBy('w.code', 'w.name')
        .select(
          'm.warehouse_id', 'm.folio', 'm.doc_code', 'm.doc_serie', 'm.movement_label', 'm.movement_kind',
          'm.source_branch', 'w.code as warehouse_code', 'w.name as warehouse_name',
        )
        .select(
          trx.raw(`MIN(m.doc_date) AS doc_date`),
          trx.raw(`COUNT(*)::int AS lineas`),
          trx.raw(`SUM(m.signed_qty) AS signed_qty`),
          trx.raw(`SUM(m.qty) AS qty`),
          trx.raw(`SUM(m.amount) AS amount`),
          trx.raw(`MAX(m.parent_group) AS parent_group`),
          trx.raw(`MAX(m.parent_serie) AS parent_serie`),
          trx.raw(`MAX(m.parent_folio) AS parent_folio`),
          trx.raw(`COUNT(a.id) > 0 AS audited`),
          trx.raw(`MAX(a.audited_by) AS audited_by`),
          trx.raw(`MAX(a.created_at) AS audited_at`),
          // DM.11 — destino del traspaso (kdm1.c10 → kdud); dest por-doc, MAX es el valor único
          trx.raw(`MAX(m.dest_code) AS dest_code`),
          trx.raw(`MAX(m.dest_label) AS dest_label`),
        )
        .orderByRaw('MIN(m.doc_date) DESC, m.folio DESC')
        .limit(limit).offset(offset);

      if (estado || transferWhs.length) {
        // estado y origen/destino requieren el PAREO (la contraparte no es columna):
        // computar sobre TODOS los traspasos del rango (cap 2000) y paginar en memoria
        const all = await fetch(2000, 0);
        await this.annotateTransferStatus(trx, tenantId, all);
        const filtered = all.filter((r: any) =>
          (!estado || r.transfer_status === estado) &&
          (!transferWhs.length || transferWhs.includes(r.warehouse_id) || transferWhs.includes(r.cp_warehouse_id)));
        const rows = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
        await this.annotateDest(trx, tenantId, rows);
        return { page, pageSize, total: filtered.length, rows };
      }

      const countRows: any[] = await trx.count('* as count').from(grouped().select('m.folio').as('g'));
      const count = countRows[0]?.count ?? 0;
      const rows = await fetch(pageSize, (page - 1) * pageSize);
      await this.annotateTransferStatus(trx, tenantId, rows);
      await this.annotateDest(trx, tenantId, rows);
      return { page, pageSize, total: Number(count), rows };
    });
  }

  /**
   * DM.3 — anota `transfer_status` + `cp_warehouse_id` (almacén de la contraparte, para el
   * filtro origen/destino) en filas de traspaso (mismo ranking que transfersCheck:
   * candidato con cantidad más cercana, luego fecha). Ship sin recepción = en_transito;
   * recepción sin origen visible = diferencia (a revisar).
   */
  private async annotateTransferStatus(trx: any, tenantId: string, rows: any[]): Promise<void> {
    const ships = rows.filter((r) => r.doc_code === 'TrsfShip');
    const rcvs = rows.filter((r) => r.doc_code === 'TrsfRcv');
    const near = (cands: any[], qty: number, date: any) => {
      if (!cands.length) return null;
      const t = new Date(date).getTime();
      return [...cands].sort((a, b) =>
        Math.abs(Number(a.q) - qty) - Math.abs(Number(b.q) - qty) ||
        Math.abs(new Date(a.d).getTime() - t) - Math.abs(new Date(b.d).getTime() - t))[0];
    };
    if (ships.length) {
      const cands = await trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId).andWhere('m.doc_code', 'TrsfRcv').andWhere('m.parent_group', '41')
        .whereIn('m.parent_folio', ships.map((s) => s.folio))
        .groupBy('m.parent_folio', 'm.parent_serie', 'm.warehouse_id')
        .select('m.parent_folio as pf', 'm.warehouse_id as wh')
        .select(trx.raw(`coalesce(m.parent_serie,'') AS ps`), trx.raw(`SUM(m.qty) AS q`), trx.raw(`MIN(m.doc_date) AS d`));
      for (const s of ships) {
        const sd = new Date(s.doc_date).getTime();
        const mine = cands.filter((c: any) => c.pf === s.folio && c.ps === (s.doc_serie ?? '') && c.wh !== s.warehouse_id
          && new Date(c.d).getTime() >= sd && new Date(c.d).getTime() <= sd + 15 * 864e5); // recepción ≥ salida, tope 15d
        const best = near(mine, Number(s.qty), s.doc_date);
        s.transfer_status = !best ? 'en_transito' : Math.abs(Number(best.q) - Number(s.qty)) < 0.01 ? 'completado' : 'diferencia';
        s.cp_warehouse_id = best ? best.wh : null;
      }
    }
    if (rcvs.length) {
      const cands = await trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId).andWhere('m.doc_code', 'TrsfShip')
        .whereIn('m.folio', rcvs.map((r) => r.parent_folio).filter(Boolean))
        .groupBy('m.folio', 'm.doc_serie', 'm.warehouse_id')
        .select('m.folio as f', 'm.warehouse_id as wh')
        .select(trx.raw(`coalesce(m.doc_serie,'') AS s`), trx.raw(`SUM(m.qty) AS q`), trx.raw(`MIN(m.doc_date) AS d`));
      for (const r of rcvs) {
        if (r.parent_group !== '41' || !r.parent_folio) { r.transfer_status = 'diferencia'; continue; }
        const rd = new Date(r.doc_date).getTime();
        const mine = cands.filter((c: any) => c.f === r.parent_folio && c.s === (r.parent_serie ?? '') && c.wh !== r.warehouse_id
          && new Date(c.d).getTime() <= rd && new Date(c.d).getTime() >= rd - 15 * 864e5); // salida ≤ recepción, tope 15d
        const best = near(mine, Number(r.qty), r.doc_date);
        r.transfer_status = !best ? 'diferencia' : Math.abs(Number(best.q) - Number(r.qty)) < 0.01 ? 'completado' : 'diferencia';
        r.cp_warehouse_id = best ? best.wh : null;
      }
    }
  }

  /**
   * DM.11 — resuelve el DESTINO de los traspasos (TrsfShip): dest_label ya viene denormalizado;
   * acá se le agrega dest_warehouse_id + nombre curado vía analytics.transfer_dest_map (para
   * el filtro Origen/Destino y para nombrar "a quién va" cuando NO hay recepción). No mapeado
   * ⇒ solo dest_label (el nombre igual responde la pregunta).
   */
  private async annotateDest(trx: any, tenantId: string, rows: any[]): Promise<void> {
    // Dedup sin `[...new Set()]` (el bundle webpack de la API lo downlevelea mal → `[Set]`).
    const codesAll = rows.filter((r) => r.doc_code === 'TrsfShip' && r.dest_code).map((r) => r.dest_code);
    const codes = codesAll.filter((v, i) => codesAll.indexOf(v) === i);
    if (!codes.length) return;
    const map = await trx('analytics.transfer_dest_map as dm')
      .where('dm.tenant_id', tenantId).whereIn('dm.dest_code', codes)
      .leftJoin('commercial.warehouses as w', 'w.id', 'dm.warehouse_id')
      .select('dm.dest_code', 'dm.warehouse_id as dest_warehouse_id', 'dm.dest_label as map_label',
        trx.raw(`coalesce(w.name, w.code) AS dest_warehouse_name`));
    const byCode = new Map(map.map((m: any) => [m.dest_code, m]));
    for (const r of rows) {
      if (r.doc_code !== 'TrsfShip' || !r.dest_code) continue;
      const m: any = byCode.get(r.dest_code);
      r.dest_label = r.dest_label || m?.map_label || r.dest_code;
      r.dest_warehouse_id = m?.dest_warehouse_id ?? null;
      r.dest_warehouse_name = m?.dest_warehouse_name ?? null;
    }
  }

  /** DM.4 — marca/desmarca un documento como auditado. Identidad = wh+doc_code+serie+folio. */
  async setAudit(dto: { warehouse_id: string; doc_code: string; doc_serie?: string | null; folio: string; audited: boolean; note?: string | null }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const username = this.tenantCtx.get()?.username || null;
    if (!dto?.warehouse_id || !UUID_RX.test(dto.warehouse_id) || !dto.doc_code || !dto.folio) {
      throw new BadRequestException('warehouse_id, doc_code y folio son requeridos');
    }
    const serie = dto.doc_serie ?? '';
    return this.tk.run(async (trx) => {
      if (dto.audited === false) {
        const n = await trx('commercial.stock_movement_audits')
          .where({ tenant_id: tenantId, warehouse_id: dto.warehouse_id, doc_code: dto.doc_code, doc_serie: serie, folio: dto.folio })
          .delete();
        return { audited: false, removed: n };
      }
      await trx.raw(`
        INSERT INTO commercial.stock_movement_audits (tenant_id, warehouse_id, doc_code, doc_serie, folio, audited_by, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, warehouse_id, doc_code, doc_serie, folio)
        DO UPDATE SET audited_by = EXCLUDED.audited_by, note = EXCLUDED.note, updated_at = now()`,
        [tenantId, dto.warehouse_id, dto.doc_code, serie, dto.folio, username, dto.note ?? null]);
      return { audited: true, audited_by: username };
    });
  }

  /** DRILL 3: documento completo — TODAS las líneas de un folio (sin filtrar por producto). */
  async document(p: { folio: string; warehouse_id: string; doc_code?: string; doc_serie?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const q = trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId)
        .andWhere('m.folio', p.folio)
        .leftJoin('public.products as p', function (this: any) {
          this.on('p.id', 'm.product_id').andOn('p.tenant_id', 'm.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id');
      if (p.warehouse_id && UUID_RX.test(p.warehouse_id)) q.where('m.warehouse_id', p.warehouse_id);
      if (p.doc_code) q.where('m.doc_code', p.doc_code);
      if (p.doc_serie != null && p.doc_serie !== '') q.whereRaw(`coalesce(m.doc_serie,'') = ?`, [p.doc_serie]);
      const lines = await q.select(
        'm.warehouse_id', 'm.doc_date', 'm.folio', 'm.doc_code', 'm.movement_label', 'm.movement_kind',
        'm.genero', 'm.naturaleza', 'm.doc_type', 'm.doc_serie', 'm.signed_qty', 'm.qty',
        'm.unit_cost', 'm.amount', 'm.parent_group', 'm.parent_serie', 'm.parent_folio', 'm.source_branch',
        'm.dest_code', 'm.dest_label',
        'w.code as warehouse_code', 'w.name as warehouse_name',
      )
        // SKU fuera de catálogo: sin product_name pero el sku denormalizado siempre está
        .select(trx.raw(`coalesce(p.nombre, '(sin catálogo)') AS product_name`), trx.raw(`coalesce(p.sku, m.sku) AS sku`))
        .orderByRaw(`coalesce(p.nombre, '(sin catálogo)')`);
      if (!lines.length) return { header: null, lines: [], totals: { qty: 0, amount: 0, lineas: 0 }, counterpart: null };
      const h = lines[0];
      // DM.4 — estado de auditoría humana del documento
      const auditRow = await trx('commercial.stock_movement_audits')
        .where({ tenant_id: tenantId, warehouse_id: h.warehouse_id, doc_code: h.doc_code, folio: h.folio })
        .andWhereRaw(`doc_serie = coalesce(?, '')`, [h.doc_serie])
        .first('audited_by', 'note', 'created_at');
      // DM.11 — destino del traspaso (solo TrsfShip); nombre curado vía transfer_dest_map
      let destWarehouseId: string | null = null, destWarehouseName: string | null = null, destLabel: string | null = h.dest_label ?? null;
      if (h.doc_code === 'TrsfShip' && h.dest_code) {
        const dm = await trx('analytics.transfer_dest_map as dm')
          .where('dm.tenant_id', tenantId).andWhere('dm.dest_code', h.dest_code)
          .leftJoin('commercial.warehouses as w', 'w.id', 'dm.warehouse_id')
          .first('dm.warehouse_id', 'dm.dest_label', trx.raw(`coalesce(w.name, w.code) AS dest_warehouse_name`));
        destWarehouseId = dm?.warehouse_id ?? null;
        destWarehouseName = dm?.dest_warehouse_name ?? null;
        destLabel = destLabel || dm?.dest_label || h.dest_code;
      }
      const header = {
        folio: h.folio, doc_code: h.doc_code, doc_serie: h.doc_serie, movement_label: h.movement_label, movement_kind: h.movement_kind,
        doc_date: h.doc_date, genero: h.genero, naturaleza: h.naturaleza, doc_type: h.doc_type,
        warehouse_id: h.warehouse_id, warehouse_code: h.warehouse_code, warehouse_name: h.warehouse_name, source_branch: h.source_branch,
        parent_group: h.parent_group, parent_folio: h.parent_folio,
        dest_code: h.dest_code ?? null, dest_label: destLabel, dest_warehouse_id: destWarehouseId, dest_warehouse_name: destWarehouseName,
        audited: !!auditRow, audited_by: auditRow?.audited_by ?? null, audited_at: auditRow?.created_at ?? null,
      };
      // docs informativos: signed=0 por diseño → el total útil es la cantidad AMPARADA (qty)
      const isInfo = h.movement_kind === 'info';
      const totals = {
        qty: lines.reduce((s: number, l: any) => s + Number((isInfo ? l.qty : l.signed_qty) || 0), 0),
        amount: lines.reduce((s: number, l: any) => s + Number(l.amount || 0), 0),
        lineas: lines.length,
      };
      // Contraparte de traspaso (salida↔recepción por tipo41+serie+folio, distinta sucursal).
      // Los folios son secuencias POR SUCURSAL → puede haber varios candidatos; se elige el
      // MEJOR por cantidad más cercana y luego fecha más cercana (mismo ranking que transfersCheck).
      let counterpart: any = null;
      const sentQty = lines.reduce((s: number, l: any) => s + Number(l.qty || 0), 0);
      const findCp = async (docCode: string, folioCol: string, folioVal: string, serieCol: string, serieVal: string | null) => {
        if (!folioVal) return null;
        const cp = await trx('analytics.stock_movements as m')
          .where('m.tenant_id', tenantId).andWhere('m.doc_code', docCode)
          .andWhere(`m.${folioCol}`, folioVal)
          .andWhereRaw(`coalesce(m.${serieCol},'') = coalesce(?, '')`, [serieVal])
          // física: recepción nunca anterior a la salida + tope de tránsito 15d (folios colisionan entre sucursales)
          .andWhereRaw(docCode === 'TrsfRcv'
            ? `m.doc_date >= ?::date AND m.doc_date <= ?::date + 15`
            : `m.doc_date <= ?::date AND m.doc_date >= ?::date - 15`, [h.doc_date, h.doc_date])
          .whereNot('m.warehouse_id', h.warehouse_id ?? p.warehouse_id)
          .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
          .groupBy('m.folio', 'm.warehouse_id', 'w.code', 'w.name')
          .select('m.folio', 'm.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name')
          .select(trx.raw(`MIN(m.doc_date) AS doc_date`), trx.raw(`MAX(m.doc_code) AS doc_code`), trx.raw(`MAX(m.doc_serie) AS doc_serie`), trx.raw(`SUM(m.qty) AS qty`), trx.raw(`COUNT(*)::int AS lineas`))
          .orderByRaw(`abs(SUM(m.qty) - ?) ASC, abs(MIN(m.doc_date) - ?::date) ASC`, [sentQty, h.doc_date])
          .limit(1);
        if (!cp.length) return null;
        const cpQty = Number(cp[0].qty || 0);
        return { docs: cp, qty: cpQty, delta: cpQty - sentQty, status: Math.abs(cpQty - sentQty) < 0.01 ? 'ok' : 'diferencia' };
      };
      if (h.doc_code === 'TrsfShip') {
        counterpart = { kind: 'recepcion', ...(await findCp('TrsfRcv', 'parent_folio', h.folio, 'parent_serie', h.doc_serie) || { docs: [], qty: 0, delta: -sentQty, status: 'sin_recepcion' }) };
        // DM.11 — a quién va dirigido (crítico cuando status='sin_recepcion')
        counterpart.dest_label = destLabel;
        counterpart.dest_warehouse_id = destWarehouseId;
        counterpart.dest_warehouse_name = destWarehouseName;
      } else if (h.doc_code === 'TrsfRcv' && h.parent_group === '41') {
        counterpart = { kind: 'origen', ...(await findCp('TrsfShip', 'folio', h.parent_folio, 'doc_serie', h.parent_serie) || { docs: [], qty: 0, delta: sentQty, status: 'sin_origen' }) };
      }
      return { header, lines, totals, counterpart };
    });
  }

  /**
   * DM.3 — Validación de traspasos: parea cada salida (TrsfShip, UD41) con su recepción
   * (TrsfRcv, UA50) vía el back-pointer de Kepler (parent = tipo 41 + SERIE + folio; la
   * serie desambigua folios repetidos entre sucursales). Estados:
   *   ok            → recepción existe y las piezas cuadran
   *   diferencia    → recepción existe pero las piezas NO cuadran (merma/sobrante en tránsito)
   *   sin_recepcion → salió y nadie lo ha recibido (en tránsito o perdido)
   *   sin_origen    → recepción sin salida visible (origen fuera de ventana o no registrado)
   */
  async transfersCheck(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const whs = this.whIds(q);
    const twhs = this.transferWhIds(q);
    // DM.11b — mismo filtro de destino que el listado: por defecto solo sucursal (evita que
    // rutas/clientes aparezcan como falsos "sin recepción"). ROUTE_RX sin `?` → seguro inline.
    const destSql = this.destBucketSql(this.destKinds(q), tenantId);
    const shpDestSql = destSql ? ` AND ${destSql}` : '';
    return this.tk.run(async (trx) => {
      // Folios Kepler son secuencias POR SUCURSAL → un (serie, folio) puede existir en varias
      // sucursales de origen. Ranking LATERAL: para cada recepción se elige el candidato de
      // salida con cantidad más cercana (y luego fecha más cercana). c10/c11 no discriminan
      // (verificado 2026-07-10: par real con TI001≠TI002).
      const rows = (await trx.raw(`
        WITH shp AS (
          SELECT m.warehouse_id, coalesce(w.name, w.code) AS wh_code, m.folio, m.doc_serie,
                 MIN(m.doc_date) AS doc_date, SUM(m.qty) AS qty, SUM(m.amount) AS amount, COUNT(*)::int AS lineas,
                 max(m.dest_code) AS dest_code, max(m.dest_label) AS dest_label  -- DM.11 destino
          FROM analytics.stock_movements m
          LEFT JOIN commercial.warehouses w ON w.id = m.warehouse_id
          WHERE m.tenant_id = ? AND m.doc_code = 'TrsfShip' AND m.doc_date BETWEEN ? AND ?${shpDestSql}
          GROUP BY m.warehouse_id, w.code, w.name, m.folio, m.doc_serie
        ), rcv AS (
          SELECT m.warehouse_id, coalesce(w.name, w.code) AS wh_code, m.folio, m.parent_serie, m.parent_folio,
                 MIN(m.doc_date) AS doc_date, SUM(m.qty) AS qty, COUNT(*)::int AS lineas
          FROM analytics.stock_movements m
          LEFT JOIN commercial.warehouses w ON w.id = m.warehouse_id
          WHERE m.tenant_id = ? AND m.doc_code = 'TrsfRcv' AND m.parent_group = '41' AND m.doc_date BETWEEN ? AND ?
          GROUP BY m.warehouse_id, w.code, w.name, m.folio, m.parent_serie, m.parent_folio
        ), paired AS (
          SELECT s.warehouse_id AS origin_wh_id, s.wh_code AS origin_wh, s.folio AS origin_folio,
                 s.doc_serie, s.doc_date AS ship_date, s.qty AS qty_sent, s.amount, s.lineas AS ship_lines,
                 r.warehouse_id AS dest_wh_id, r.wh_code AS dest_wh, r.folio AS rcv_folio,
                 r.doc_date AS rcv_date, r.qty AS qty_received, r.lineas AS rcv_lines
          FROM rcv r
          LEFT JOIN LATERAL (
            SELECT * FROM shp s
            WHERE s.folio = r.parent_folio
              AND coalesce(s.doc_serie,'') = coalesce(r.parent_serie,'')
              AND s.warehouse_id <> r.warehouse_id
              AND s.doc_date <= r.doc_date  -- física: la recepción nunca es anterior a la salida (folios colisionan entre sucursales)
              AND s.doc_date >= r.doc_date - 15  -- tope de tránsito 15d (99.4% de los pareos exactos ≤11d); más viejo = coincidencia de folio
            ORDER BY abs(coalesce(s.qty,0) - coalesce(r.qty,0)) ASC, abs(s.doc_date - r.doc_date) ASC
            LIMIT 1
          ) s ON true
        ), unreceived AS (
          SELECT s.* FROM shp s
          WHERE NOT EXISTS (
            SELECT 1 FROM rcv r
            WHERE r.parent_folio = s.folio AND coalesce(r.parent_serie,'') = coalesce(s.doc_serie,'')
              AND r.warehouse_id <> s.warehouse_id
              AND r.doc_date >= s.doc_date AND r.doc_date <= s.doc_date + 15)
        )
        SELECT * FROM (
          SELECT origin_wh_id, origin_wh, origin_folio, doc_serie, ship_date, qty_sent, amount, ship_lines,
                 dest_wh_id, dest_wh, rcv_folio, rcv_date, qty_received, rcv_lines,
                 CASE
                   WHEN origin_folio IS NULL THEN 'sin_origen'
                   WHEN abs(coalesce(qty_sent,0) - coalesce(qty_received,0)) < 0.01 THEN 'ok'
                   ELSE 'diferencia'
                 END AS status,
                 coalesce(qty_received,0) - coalesce(qty_sent,0) AS delta
          FROM paired
          UNION ALL
          SELECT u.warehouse_id, u.wh_code, u.folio, u.doc_serie, u.doc_date, u.qty, u.amount, u.lineas,
                 dm.warehouse_id, coalesce(dw.name, dw.code, u.dest_label), NULL, NULL, NULL, NULL, 'sin_recepcion', -u.qty
          FROM unreceived u
          LEFT JOIN analytics.transfer_dest_map dm ON dm.tenant_id = ? AND dm.dest_code = u.dest_code
          LEFT JOIN commercial.warehouses dw ON dw.id = dm.warehouse_id
        ) t
        WHERE 1=1 ${whs.length ? `AND (t.origin_wh_id = ANY(?) OR t.dest_wh_id = ANY(?))` : ''}
                  ${twhs.length ? `AND (t.origin_wh_id = ANY(?) OR t.dest_wh_id = ANY(?))` : ''}
        ORDER BY CASE t.status WHEN 'diferencia' THEN 0 WHEN 'sin_recepcion' THEN 1 WHEN 'sin_origen' THEN 2 ELSE 4 END,
                 coalesce(t.ship_date, t.rcv_date) DESC
        LIMIT 500
      `, [tenantId, from, to, tenantId, from, to, tenantId,
          ...(whs.length ? [whs, whs] : []),
          ...(twhs.length ? [twhs, twhs] : [])])).rows;
      const totals = { ok: 0, diferencia: 0, sin_recepcion: 0, sin_origen: 0 };
      for (const r of rows) totals[r.status as keyof typeof totals]++;
      return { range: { from, to }, totals, rows };
    });
  }

  /**
   * DM.12 — Conciliación CONTABLE de traspasos (mayor 515 "AJUSTE TRASPASO INTERNOS").
   *
   * Contracara monetaria del transfersCheck físico: lee la balanza analytics.ledger_monthly.
   *   515-001 = TRASPASO ENTRADA (una sucursal recibe → neto +)
   *   515-002 = TRASPASO SALIDA  (una sucursal envía  → neto −)
   * Es cuenta PUENTE: cada salida debe tener su entrada ⇒ el mayor debe netear ≈ $0 por mes.
   * Δ = entrada_neto + salida_neto (≠0 ⇒ traspasos sin cuadrar / en tránsito al corte).
   *
   * Vista de RED (por mes y por sucursal): ledger_monthly se llavea por `sucursal`+`anio_mes`,
   * no por warehouse_id → honra el rango de fechas pero ignora el filtro de almacén (UUID).
   */
  async transfersLedger(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const fromYm = from.slice(0, 7);
    const toYm = to.slice(0, 7);
    // FILTER por prefijo de subcuenta; excluye la fila del mayor exacto ('515') → sin doble conteo.
    const ent = `SUM(neto) FILTER (WHERE cuenta LIKE '515-001%')`;
    const sal = `SUM(neto) FILTER (WHERE cuenta LIKE '515-002%')`;
    const entM = `SUM(movs) FILTER (WHERE cuenta LIKE '515-001%')`;
    const salM = `SUM(movs) FILTER (WHERE cuenta LIKE '515-002%')`;
    return this.tk.run(async (trx) => {
      const baseWhere = (b: any) => b
        .where('tenant_id', tenantId)
        .whereRaw(`cuenta LIKE '515-%'`)
        .andWhere('anio_mes', '>=', fromYm)
        .andWhere('anio_mes', '<=', toYm);

      const months = await baseWhere(trx('analytics.ledger_monthly'))
        .groupBy('anio_mes')
        .orderBy('anio_mes')
        .select('anio_mes')
        .select(
          trx.raw(`${ent} AS entrada`), trx.raw(`${sal} AS salida`),
          trx.raw(`${entM} AS movs_entrada`), trx.raw(`${salM} AS movs_salida`),
        );

      const bySucursal = await baseWhere(trx('analytics.ledger_monthly'))
        .groupBy('sucursal')
        .orderByRaw(`abs(coalesce(${ent},0) + coalesce(${sal},0)) DESC`)
        .select('sucursal')
        .select(trx.raw(`${ent} AS entrada`), trx.raw(`${sal} AS salida`));

      const rows = months.map((m: any) => ({
        anio_mes: m.anio_mes,
        entrada: Number(m.entrada) || 0,
        salida: Number(m.salida) || 0,
        delta: (Number(m.entrada) || 0) + (Number(m.salida) || 0),
        movs_entrada: Number(m.movs_entrada) || 0,
        movs_salida: Number(m.movs_salida) || 0,
      }));
      const sucursales = bySucursal.map((s: any) => ({
        sucursal: s.sucursal,
        entrada: Number(s.entrada) || 0,
        salida: Number(s.salida) || 0,
        delta: (Number(s.entrada) || 0) + (Number(s.salida) || 0),
      }));
      const totals = {
        entrada: rows.reduce((a: number, r: any) => a + r.entrada, 0),
        salida: rows.reduce((a: number, r: any) => a + r.salida, 0),
        delta: rows.reduce((a: number, r: any) => a + r.delta, 0),
      };
      return { range: { from: fromYm, to: toYm }, totals, rows, by_sucursal: sucursales };
    });
  }

  /**
   * DM.12 — MATRIZ origen → destino (FÍSICA, sobre analytics.stock_movements). Mismo pareo
   * LATERAL que transfersCheck (salida TrsfShip ⇄ recepción TrsfRcv por serie+folio), pero
   * AGREGADO por par (origen, destino): cuánto se envió vs cuánto se recibió + Δ + conteo por
   * estado. Complementa el cuadre CONTABLE (transfersLedger, mayor 515) poniéndole cara a las
   * sucursales entre las que no cuadra. Honra rango de fechas + destino; ignora filtro de almacén.
   */
  async transfersMatrix(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const destSql = this.destBucketSql(this.destKinds(q), tenantId);
    const shpDestSql = destSql ? ` AND ${destSql}` : '';
    return this.tk.run(async (trx) => {
      const rows = (await trx.raw(`
        WITH shp AS (
          SELECT m.warehouse_id, coalesce(w.name, w.code) AS wh_code, m.folio, m.doc_serie,
                 SUM(m.qty) AS qty, SUM(m.amount) AS amount, max(m.dest_code) AS dest_code, max(m.dest_label) AS dest_label,
                 MIN(m.doc_date) AS doc_date
          FROM analytics.stock_movements m
          LEFT JOIN commercial.warehouses w ON w.id = m.warehouse_id
          WHERE m.tenant_id = ? AND m.doc_code = 'TrsfShip' AND m.doc_date BETWEEN ? AND ?${shpDestSql}
          GROUP BY m.warehouse_id, w.code, w.name, m.folio, m.doc_serie
        ), rcv AS (
          SELECT m.warehouse_id, coalesce(w.name, w.code) AS wh_code, m.folio, m.parent_serie, m.parent_folio,
                 MIN(m.doc_date) AS doc_date, SUM(m.qty) AS qty
          FROM analytics.stock_movements m
          LEFT JOIN commercial.warehouses w ON w.id = m.warehouse_id
          WHERE m.tenant_id = ? AND m.doc_code = 'TrsfRcv' AND m.parent_group = '41' AND m.doc_date BETWEEN ? AND ?
          GROUP BY m.warehouse_id, w.code, w.name, m.folio, m.parent_serie, m.parent_folio
        ), paired AS (
          SELECT s.warehouse_id AS origin_wh_id, s.wh_code AS origin_wh, s.qty AS qty_sent, s.amount,
                 r.warehouse_id AS dest_wh_id, r.wh_code AS dest_wh, r.qty AS qty_received,
                 CASE WHEN abs(coalesce(s.qty,0) - coalesce(r.qty,0)) < 0.01 THEN 'ok' ELSE 'diferencia' END AS status
          FROM rcv r
          JOIN LATERAL (
            SELECT * FROM shp s WHERE s.folio = r.parent_folio
              AND coalesce(s.doc_serie,'') = coalesce(r.parent_serie,'')
              AND s.warehouse_id <> r.warehouse_id
              AND s.doc_date <= r.doc_date AND s.doc_date >= r.doc_date - 15
            ORDER BY abs(coalesce(s.qty,0) - coalesce(r.qty,0)) ASC, abs(s.doc_date - r.doc_date) ASC
            LIMIT 1
          ) s ON true
        ), unreceived AS (
          SELECT s.warehouse_id AS origin_wh_id, s.wh_code AS origin_wh, s.qty AS qty_sent, s.amount,
                 dm.warehouse_id AS dest_wh_id, coalesce(dw.name, dw.code, s.dest_label, s.dest_code) AS dest_wh,
                 0::numeric AS qty_received, 'sin_recepcion' AS status
          FROM shp s
          LEFT JOIN analytics.transfer_dest_map dm ON dm.tenant_id = ? AND dm.dest_code = s.dest_code
          LEFT JOIN commercial.warehouses dw ON dw.id = dm.warehouse_id
          WHERE NOT EXISTS (
            SELECT 1 FROM rcv r WHERE r.parent_folio = s.folio
              AND coalesce(r.parent_serie,'') = coalesce(s.doc_serie,'')
              AND r.warehouse_id <> s.warehouse_id
              AND r.doc_date >= s.doc_date AND r.doc_date <= s.doc_date + 15)
        )
        SELECT origin_wh_id, origin_wh, dest_wh_id, dest_wh,
               SUM(qty_sent)::numeric AS qty_sent, SUM(qty_received)::numeric AS qty_received,
               SUM(amount)::numeric AS amount, (SUM(qty_received) - SUM(qty_sent))::numeric AS delta_qty,
               count(*) FILTER (WHERE status='ok')::int AS n_ok,
               count(*) FILTER (WHERE status='diferencia')::int AS n_diferencia,
               count(*) FILTER (WHERE status='sin_recepcion')::int AS n_sin_recepcion
        FROM (SELECT * FROM paired UNION ALL SELECT * FROM unreceived) t
        GROUP BY origin_wh_id, origin_wh, dest_wh_id, dest_wh
        ORDER BY SUM(amount) DESC NULLS LAST
        LIMIT 300
      `, [tenantId, from, to, tenantId, from, to, tenantId])).rows;
      const totals = {
        qty_sent: 0, qty_received: 0, amount: 0,
        n_ok: 0, n_diferencia: 0, n_sin_recepcion: 0,
      };
      for (const r of rows) {
        totals.qty_sent += Number(r.qty_sent) || 0;
        totals.qty_received += Number(r.qty_received) || 0;
        totals.amount += Number(r.amount) || 0;
        totals.n_ok += r.n_ok; totals.n_diferencia += r.n_diferencia; totals.n_sin_recepcion += r.n_sin_recepcion;
      }
      return { range: { from, to }, totals, rows };
    });
  }

  /**
   * DM.12 — DETALLE por póliza del descuadre (mayor 515) sobre `analytics.gl_poliza_lines`
   * (partida doble por póliza, source='kepler', ADR-041).
   *
   * Pareo TOLERANTE (no exacto): origen y destino registran el traspaso con importes CASI
   * iguales (diferencia de costo/valuación) → el match exacto pierde la contraparte. Verificado
   * en mayo-2026: exacto marcaba $15.9M "sin contraparte" con Δ real de solo $358k; con ±2% el
   * 85% parea. Estrategia: greedy por importe más cercano dentro de ±TOL, con ventana ±1 mes
   * (captura traspasos en tránsito al corte). 3 baldes:
   *   - exacto     → |Δ| < $0.01 (misma valuación).
   *   - costo      → 0 < |Δ| ≤ TOL·importe: MISMA transferencia, distinta valuación (informativo;
   *                  el par revela DÓNDE está la contraparte).
   *   - sin_rastro → sin contraparte ni con tolerancia ni en la ventana ⇒ LO ACCIONABLE.
   * Solo reporta pólizas DENTRO del rango; los meses de padding solo son candidatos.
   */
  async transfersLedgerDetail(q: MovementsQuery, f: LedgerDetailFilters = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const fromYm = from.slice(0, 7), toYm = to.slice(0, 7);
    const TOL = 0.02; // ±2% (diferencia de costo origen↔destino)
    const CAP = 1000;
    const addMonth = (ym: string, d: number) => {
      const [y, m] = ym.split('-').map(Number);
      const dt = new Date(y, m - 1 + d, 1);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    };
    const padFrom = addMonth(fromYm, -1), padTo = addMonth(toYm, 1);
    const inRange = (ym: string) => ym >= fromYm && ym <= toYm;
    // filtros de la vista (no afectan el pareo; solo qué se DEVUELVE)
    const fBucket = ['exacto', 'costo', 'sin_rastro'].includes(f.bucket || '') ? f.bucket : null;
    const fKind = f.kind === 'entrada' || f.kind === 'salida' ? f.kind : null;
    const fSuc = (f.sucursal || '').trim() || null;
    const fSearch = (f.search || '').trim().toLowerCase() || null;
    const fMin = Number(f.min_amount) > 0 ? Number(f.min_amount) : 0;

    return this.tk.run(async (trx) => {
      const rows: any[] = await trx('analytics.gl_poliza_lines')
        .where('tenant_id', tenantId).andWhere('source', 'kepler')
        .andWhereRaw(`cuenta LIKE '515-%'`)
        .andWhere('anio_mes', '>=', padFrom).andWhere('anio_mes', '<=', padTo)
        .andWhereRaw('COALESCE(importe,0) <> 0')
        .select('anio_mes', 'sucursal', 'cuenta', 'importe', 'referencia', 'tipo_pol', 'folio');

      const entradas: any[] = [], salidas: any[] = [];
      for (const r of rows) {
        const o = { ...r, importe: Number(r.importe) || 0, paired: false, delta: null as number | null, cp: null as any };
        (String(r.cuenta).startsWith('515-001') ? entradas : salidas).push(o);
      }
      salidas.sort((a, b) => a.importe - b.importe);
      const amts = salidas.map((s) => s.importe);
      const lowerBound = (target: number) => {
        let lo = 0, hi = amts.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (amts[mid] < target) lo = mid + 1; else hi = mid; }
        return lo;
      };
      // Greedy: entradas de mayor a menor; la salida NO usada de importe más cercano en ±TOL.
      const costPairs: any[] = [];
      for (const e of [...entradas].sort((a, b) => b.importe - a.importe)) {
        const lo = e.importe * (1 - TOL), hi = e.importe * (1 + TOL);
        let i = lowerBound(lo), best = -1, bd = Infinity;
        for (; i < salidas.length && amts[i] <= hi; i++) {
          if (salidas[i].paired) continue;
          const d = Math.abs(amts[i] - e.importe);
          if (d < bd) { bd = d; best = i; }
        }
        if (best < 0) continue;
        const s = salidas[best]; s.paired = true; e.paired = true;
        const delta = e.importe - s.importe; e.delta = delta; s.delta = delta;
        e.cp = s; s.cp = e; // contraparte cruzada (dónde está)
        if (Math.abs(delta) >= 0.01 && (inRange(e.anio_mes) || inRange(s.anio_mes))) {
          costPairs.push({
            anio_mes: inRange(e.anio_mes) ? e.anio_mes : s.anio_mes,
            sucursal_entrada: e.sucursal, sucursal_salida: s.sucursal,
            entrada_importe: e.importe, salida_importe: s.importe, delta,
            entrada_ref: e.referencia || null, salida_ref: s.referencia || null,
          });
        }
      }

      // Baldes: SOLO pólizas dentro del rango (el padding solo aportó candidatos).
      const inEnt = entradas.filter((e) => inRange(e.anio_mes));
      const inSal = salidas.filter((s) => inRange(s.anio_mes));
      const entTot = inEnt.reduce((a, e) => a + e.importe, 0);
      const salTot = inSal.reduce((a, s) => a + s.importe, 0);
      const bucketOf = (x: any) => !x.paired ? 'sin_rastro' : (Math.abs(x.delta || 0) < 0.01 ? 'exacto' : 'costo');

      // Lista CLASIFICADA unificada (para la tabla filtrable de la vista).
      const entries = [...inEnt, ...inSal].map((r) => ({
        anio_mes: r.anio_mes, kind: String(r.cuenta).startsWith('515-001') ? 'entrada' : 'salida',
        cuenta: r.cuenta, sucursal: r.sucursal, importe: r.importe,
        referencia: r.referencia || null, tipo_pol: r.tipo_pol || null, folio: r.folio || null,
        bucket: bucketOf(r), delta: r.paired ? r.delta : null,
        cp_ref: r.cp?.referencia || null, cp_importe: r.cp ? r.cp.importe : null, cp_sucursal: r.cp?.sucursal || null,
      }));

      // Totales por balde (SIN filtrar → alimentan las tarjetas de resumen).
      let nExact = 0;
      for (const x of [...inEnt, ...inSal]) if (x.paired && Math.abs(x.delta || 0) < 0.01) nExact++;
      const srAll = entries.filter((e) => e.bucket === 'sin_rastro');
      const srEnt = srAll.filter((r) => r.kind === 'entrada');
      const srSal = srAll.filter((r) => r.kind === 'salida');
      const costDiffTotal = costPairs.reduce((a, p) => a + Math.abs(p.delta), 0);
      costPairs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      // Aplica los filtros de la vista a la lista clasificada.
      const filtered = entries.filter((e) =>
        (!fBucket || e.bucket === fBucket) &&
        (!fKind || e.kind === fKind) &&
        (!fSuc || String(e.sucursal) === fSuc) &&
        (fMin <= 0 || e.importe >= fMin) &&
        (!fSearch || `${e.referencia || ''} ${e.tipo_pol || ''} ${e.folio || ''} ${e.cp_ref || ''}`.toLowerCase().includes(fSearch)),
      ).sort((a, b) => b.importe - a.importe);

      return {
        range: { from: fromYm, to: toYm }, tolerance_pct: TOL * 100, window_months: 1,
        totals: {
          entrada: entTot, salida: salTot, delta: entTot - salTot,
          n_exact: nExact,
          cost: { n: costPairs.length, diff_total: costDiffTotal },
          sin_rastro: {
            n_entrada: srEnt.length, amt_entrada: srEnt.reduce((a, r) => a + r.importe, 0),
            n_salida: srSal.length, amt_salida: srSal.reduce((a, r) => a + r.importe, 0),
          },
        },
        // vista filtrable (una tabla clasificada) + compat PDF (rows=sin_rastro, cost_pairs)
        entries: filtered.slice(0, CAP), entries_total: filtered.length, entries_truncated: filtered.length > CAP,
        rows: srAll.slice(0, CAP), total: srAll.length, truncated: srAll.length > CAP,
        cost_pairs: costPairs.slice(0, CAP), cost_total: costPairs.length, cost_truncated: costPairs.length > CAP,
      };
    });
  }

  /**
   * DM.13 — Cuadre traspasos KEPLER → WINCAJA (tiendas solo-Wincaja 30/32/50, que NO están
   * en Kepler → sus recepciones no aparecen en el 515). Cuadre por TOTALES de control por
   * tienda×mes: Σ salida CEDIS (Kepler 515-002, mapeada por nombre de destino) vs Σ recepción
   * CEDIS (Wincaja tipo C / tercero 0 / obs 'A0 …', costo). NO folio-a-folio (no hay llave).
   *
   * Estructura Kepler (2026-08): las pólizas viven en 6 DBs de sucursal md_00..md_05
   * (00=CEDIS, 01=Padre Hidalgo, 02=Piedad, 03=8 Esquinas, 04=Yurécuaro, 05=Zamora) →
   * `gl_poliza_lines.sucursal` = branch de origen. El 98% del 515-002 se contabiliza en
   * suc=00 (CEDIS es el origen de todo traspaso saliente); el DESTINO solo está en el texto
   * libre `referencia`, con MUCHAS variantes por captura manual.
   *
   * Mapa nombre Kepler → tienda Wincaja (verificado vs data 2026-08):
   *   30 Morelia Abastos ← 'M.A' + 'ABASTOS' pelón (misma serie de folio T-79XX). OJO: excluir
   *       'ABASTOS LA PIEDAD'/'L.P'/'LP' → esa es La Piedad (suc 02, NO Wincaja) y va ANTES.
   *   32 Morelia Madero ← 'M.M' (con puntos, no 'MM') / 'MADERO'.
   *   50 Canindo ← 'CANINDO' / 'CAN …'.
   * Se descartan 'TRASPASO A CEDIS T99-…' (retorno inverso, no despacho a tienda).
   *
   * Caveats estructurales (NO son bug del cuadre — así abastece el negocio):
   *  · CANINDO se surte casi NADA por traspaso CEDIS (515-002 ~$1.9M/trim); su entrada real
   *    es COMPRA de zona ('COMPRA ZAM CANINDO' en 515-001 ~$23M/trim) → el Δ negativo grande
   *    es esperado, este cuadre solo mide el canal CEDIS.
   *  · MADERO recibe poco directo del CEDIS (Wincaja tercero='0' chico); se resurte vía
   *    Morelia Abastos (Wincaja tercero='30') → tercero='0' subcuenta su recepción real.
   * Cobertura Wincaja por tienda varía → `last_date` avisa meses parciales. Unidad Wincaja ≠
   * piezas Kepler → comparar $ (costo), no piezas.
   */
  async transfersWincajaCheck(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const fromYm = from.slice(0, 7), toYm = to.slice(0, 7);
    const STORES = [
      { code: '30', name: 'Morelia Abastos' },
      { code: '32', name: 'Morelia Madero' },
      { code: '50', name: 'Canindo' },
    ];
    const classify = (ref: string | null): string | null => {
      const s = (ref || '').toUpperCase();
      if (/T99/.test(s) && /CEDIS/.test(s)) return null;                    // retorno a CEDIS (reverso)
      if (/CANINDO|\bCAN\b/.test(s)) return '50';
      if (/M\.?M\b|MORELIA MADERO|\bMADERO\b/.test(s)) return '32';
      if (/ABASTOS L\.?P|LA PIEDAD|\bL\.?P\b|\bLP\b/.test(s)) return null;  // La Piedad (suc 02), NO tienda Wincaja
      if (/M\.?A\b|MORELIA ABAST|\bABASTOS\b/.test(s)) return '30';         // M.A + 'ABASTOS' pelón (misma serie T-79XX)
      return null;
    };
    const months: string[] = [];
    for (let [y, m] = fromYm.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= toYm;) {
      months.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; }
    }
    return this.tk.run(async (trx) => {
      const sal: any[] = await trx('analytics.gl_poliza_lines')
        .where('tenant_id', tenantId).andWhere('source', 'kepler')
        .andWhereRaw(`cuenta LIKE '515-002%'`)
        .andWhere('anio_mes', '>=', fromYm).andWhere('anio_mes', '<=', toYm)
        .andWhereRaw('COALESCE(importe,0)<>0')
        .select('anio_mes', 'importe', 'referencia');
      // Canal COMPRA de zona (515-001 'COMPRA … CANINDO') — abastece Canindo casi por completo,
      // NO es traspaso CEDIS. Se muestra como contexto para explicar el Δ negativo, fuera del cuadre.
      const compra: any[] = await trx('analytics.gl_poliza_lines')
        .where('tenant_id', tenantId).andWhere('source', 'kepler')
        .andWhereRaw(`cuenta LIKE '515-001%'`)
        .andWhereRaw(`UPPER(referencia) LIKE '%CANINDO%'`)
        .andWhere('anio_mes', '>=', fromYm).andWhere('anio_mes', '<=', toYm)
        .andWhereRaw('COALESCE(importe,0)<>0')
        .groupBy('anio_mes').select('anio_mes').sum({ v: 'importe' });
      const compraMap = new Map<string, number>(compra.map((r) => [r.anio_mes, Number(r.v) || 0]));
      const rec: any[] = await trx('wincaja.maestro_mov_almacen as m')
        .join('wincaja.detalles_mov_almacen as d', function (this: any) {
          this.on('d.tenant_id', 'm.tenant_id').andOn('d.source_branch', 'm.source_branch')
            .andOn('d.source_dataset', 'm.source_dataset').andOn('d.consecutivo', 'm.consecutivo');
        })
        // recepción del CEDIS = tipo C + tercero '0' (almacén origen 00). El obs 'A0 T99…' solo
        // existe en el dataset 'actual'; en 'concentrada' viene vacío → NO filtrar por obs.
        .where('m.tenant_id', tenantId).whereIn('m.source_branch', STORES.map((s) => s.code))
        .andWhere('m.tipo', 'C').andWhere('m.tercero', '0')
        .andWhereRaw(`to_char(m.fecha,'YYYY-MM') >= ?`, [fromYm]).andWhereRaw(`to_char(m.fecha,'YYYY-MM') <= ?`, [toYm])
        .groupByRaw(`m.source_branch, to_char(m.fecha,'YYYY-MM')`)
        .select(trx.raw(`m.source_branch AS code`), trx.raw(`to_char(m.fecha,'YYYY-MM') AS ym`),
          trx.raw(`SUM(ABS(COALESCE(d.valor_costo,0))) AS costo`), trx.raw(`COUNT(DISTINCT m.consecutivo) AS docs`));
      const cov: any[] = await trx('wincaja.maestro_mov_almacen')
        .where('tenant_id', tenantId).whereIn('source_branch', STORES.map((s) => s.code))
        .groupBy('source_branch').select('source_branch').max('fecha as last_date');

      // Kepler mapeado por (store, mes)
      const kMap = new Map<string, number>();
      let keplerUnmapped = 0;
      for (const r of sal) {
        const code = classify(r.referencia);
        if (!code) { keplerUnmapped += Number(r.importe) || 0; continue; }
        const k = `${code}|${r.anio_mes}`;
        kMap.set(k, (kMap.get(k) || 0) + (Number(r.importe) || 0));
      }
      const wMap = new Map<string, { costo: number; docs: number }>();
      for (const r of rec) wMap.set(`${r.code}|${r.ym}`, { costo: Number(r.costo) || 0, docs: Number(r.docs) || 0 });
      const lastByCode = new Map(cov.map((c) => [c.source_branch, c.last_date]));

      const rows: any[] = [];
      const totals = { kepler: 0, wincaja: 0, delta: 0 };
      for (const st of STORES) {
        for (const ym of months) {
          const kepler = kMap.get(`${st.code}|${ym}`) || 0;
          const w = wMap.get(`${st.code}|${ym}`) || { costo: 0, docs: 0 };
          const compraZona = st.code === '50' ? (compraMap.get(ym) || 0) : 0;
          if (kepler === 0 && w.costo === 0 && compraZona === 0) continue;
          const delta = kepler - w.costo;
          rows.push({
            code: st.code, name: st.name, anio_mes: ym,
            kepler_envio: kepler, wincaja_recibido: w.costo, docs: w.docs, delta,
            kepler_compra_zona: compraZona, // solo Canindo: 515-001 COMPRA (canal real, no CEDIS)
          });
          totals.kepler += kepler; totals.wincaja += w.costo; totals.delta += delta;
        }
      }
      const stores = STORES.map((st) => ({ ...st, last_date: lastByCode.get(st.code) || null }));
      return { range: { from: fromYm, to: toYm }, stores, rows, totals, kepler_unmapped: keplerUnmapped };
    });
  }

  /** DM.12 — junta los lentes del cuadre (contable + matriz física + folios + detalle) para el PDF. */
  async exportCuadreData(q: MovementsQuery) {
    const [ledger, matrix, check, detail] = await Promise.all([
      this.transfersLedger(q), this.transfersMatrix(q), this.transfersCheck(q), this.transfersLedgerDetail(q),
    ]);
    return { range: this.range(q), ledger, matrix, check, detail };
  }

  /** DM.6 — junta todo lo que necesita el export (docs englobados + totales + traspasos). */
  async exportData(q: MovementsQuery) {
    const PAGE = 500, MAX_PAGES = 10; // cap 5,000 docs por export
    const first = await this.lines({ ...q, page: 1, pageSize: PAGE });
    const docs = [...first.rows];
    const pages = Math.min(Math.ceil(first.total / PAGE), MAX_PAGES);
    for (let p = 2; p <= pages; p++) docs.push(...(await this.lines({ ...q, page: p, pageSize: PAGE })).rows);
    const s = await this.summary(q);
    const t = await this.transfersCheck(q);
    return {
      range: s.range,
      totals: {
        entradas: Number(s.totals?.entradas) || 0,
        salidas: Number(s.totals?.salidas) || 0,
        valor: Number(s.totals?.valor) || 0,
        documentos: Number(s.totals?.documentos) || 0,
      },
      docs,
      transfers: t.rows,
      truncated: first.total > docs.length,
    };
  }

  /** Almacenes + tipos de documento presentes (para los selects del frontend). */
  async filters() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const warehouses = await trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId)
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        .distinct('m.warehouse_id as id', 'w.code', 'w.name')
        .orderBy('w.code');
      const doc_types = await trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId)
        .distinct('m.doc_code', 'm.movement_label', 'm.movement_kind')
        .orderBy('m.movement_label');
      return { warehouses, doc_types };
    });
  }
}
