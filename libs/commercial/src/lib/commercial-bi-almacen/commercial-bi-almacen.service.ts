import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ScopeService, branchKeySql, branchKeyFilterSql } from '@megadulces/platform-core';
import { CommercialMovementsService } from '../commercial-movements/commercial-movements.service';
import {
  BiCostDeviation,
  BiDocType,
  BiField,
  BiFiltersResponse,
  BiInventoryValuation,
  BiMovementCounts,
  BiMovementDetail,
  BiMovementPage,
  BiMovementRow,
  BiPage,
  BiProductOpt,
  BiSummaryResponse,
  BiTipoOperacion,
  BiUnitProvenance,
  BiWarehouseOpt,
  BiZoneGroup,
} from './commercial-bi-almacen.types';

/**
 * WMS-BI.1 — Análisis BI de Almacén (`/almacen/analisis-bi`). Backend.
 *
 * Este es el PRIMER endpoint real del módulo — hasta acá sólo existía la puerta
 * (WMS-BI.0: permiso `ALMACEN_BI_VER` + sidebar + ruta, sin ninguna cifra).
 *
 * ── Decisiones de fondo, para que el próximo que toque esto no las reabra ──
 *
 * 1. **El alcance por almacén NO es un mecanismo nuevo.** El pedido pedía "gerente de
 *    Morelia sólo ve sus dos almacenes / almacenista sin acceso a clientes" — y ya
 *    existe la Fase ID (ADR-050): `identity.role_scopes` + `identity.user_scopes` +
 *    `ScopeService`, con la dimensión `warehouse` YA CONFIGURADA para los 10 roles que
 *    tienen `ALMACEN_BI_VER` (medido en `platform_test`: `encargado_tienda`/`supervisor`
 *    = `own` — su única sucursal —, el resto = `all`). Inventar una segunda tabla de
 *    autorización habría sido exactamente el primitivo duplicado que ADR-056 prohíbe.
 *    Todo el filtrado por almacén de este archivo pasa por `resolveWarehouseIds()`.
 *
 * 2. **El costo NO se aproxima cuando falta el resolvedor.** El inventario valuado
 *    necesita el costo VERIFICADO por el mismo ERP que reporta la cantidad
 *    (`analytics.v_erp_unit_cost`, KE.3/ADR-059) — multiplicar la existencia por
 *    `catalog.products.cost_base` a secas ya causó un error real de $3.5M en Fase MR
 *    (ADR-051) porque esa columna viene por CAJA en buena parte del catálogo. Esa vista
 *    NO existe todavía en este entorno de desarrollo (`platform_test` está detrás de
 *    varias migraciones — confirmado con `to_regclass`), así que `hasErpCostView()`
 *    declara la ausencia en vez de calcular con un método que este mismo repo ya probó
 *    que se equivoca. Cuando la vista exista (ya está medida y aplicada en prod, ver su
 *    migración `20260910170000`), este código la usa sin cambios.
 *
 * 3. **El Diario de Movimientos (`analytics.stock_movements`, Fase DM) es SÓLO Kepler**
 *    (01-06): Morelia (MD-30/MD-32) y el CEDIS (00) no tienen este feed — son Wincaja.
 *    `BiMovementCounts.covers_all_scope` lo declara; no se inventa un cero disfrazado
 *    de "sin movimientos" para esas sucursales.
 *
 * 4. **`analytics.stock_movements` está VACÍA en `platform_test`** (verificado: 0 filas).
 *    Es una tabla existente (Fase DM, alimentada por `import-stock-movements.js`, ya
 *    poblada en prod donde el Diario de Movimientos opera desde 2026-08) — no una tabla
 *    nueva de este módulo. Las consultas de este archivo se ejercitaron contra un
 *    resultado vacío (0 filas, sin error), pero el camino "con datos reales" no se pudo
 *    verificar en esta sesión.
 *
 * 5. **Cantidad/unidad original + factor de conversión + unidad base NO están en el
 *    feed.** `import-stock-movements.js` guarda `qty` (la cantidad tal como Kepler la
 *    capturó, `kdm2.c9`) pero no el código de unidad ni el factor de esa línea. Pedirle
 *    a esas columnas un valor sería inventarlo — se DECLARAN no disponibles (`fields()`)
 *    en vez de fabricar "pz" / factor 1 por default.
 *
 * 6. **Redacción de destino por permiso** (`movementDetail`): un traspaso `TrsfShip` con
 *    destino "cliente/tienda" (no ruta, no otra sucursal) oculta `dest_label`/`dest_code`
 *    si el requester no tiene `COMMERCIAL_CUSTOMERS_VER` — el ejemplo textual del pedido
 *    ("un almacenista sin acceso a clientes no debe descubrirlos al abrir el documento").
 *    La clasificación es una heurística simple (no matchea "R.D./R.V./RUTA" ni "TI###");
 *    ver `clasificaDestino()`.
 */
@Injectable()
export class CommercialBiAlmacenService {
  private readonly logger = new Logger(CommercialBiAlmacenService.name);
  private erpCostViewExists?: boolean;
  /** [WMS-BI.4.3] `undefined` = todavía no se preguntó. Ver `unitTruthRel()`. */
  private unitTruthMvExists?: boolean;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly movementsSvc: CommercialMovementsService,
  ) {}

  // ═══════════════════════════════════════════════════════════ alcance ════

  /**
   * Traduce el alcance de `warehouse` (códigos canónicos de 2 dígitos, ADR-050) a los
   * `warehouse_id` (uuid) que el resto de las consultas necesita. `null` = alcance
   * `all` sin recorte pedido → sin filtro. `[]` = alcance resuelto a CERO almacenes
   * (declarado, no se lee como "todos").
   */
  private async resolveWarehouseIds(
    trx: any,
    tenantId: string,
    query: Record<string, unknown>,
  ): Promise<string[] | null> {
    const codes = await this.scope.readParam(query, 'warehouse', 'commercial/bi-almacen');
    if (codes === null) return null;
    if (!codes.length) return [];
    const rows = await trx('commercial.warehouses as w')
      .where('w.tenant_id', tenantId).whereNull('w.deleted_at')
      .whereRaw(`(${branchKeySql('w')}) = ANY(?)`, [codes])
      .select('w.id');
    return rows.map((r: { id: string }) => r.id);
  }

  /**
   * ⚠️ [WMS-BI.4.2] **La ausencia NO se cachea para siempre.** Antes esto era
   * `if (this.erpCostViewExists !== undefined) return this.erpCostViewExists`, que guarda el "no
   * existe" con la misma fuerza que el "existe" — y las dos cosas no son simétricas:
   *
   *   · una vista que YA existe no desaparece sola ⇒ el `true` se puede cachear de por vida;
   *   · una que NO existe **aparece en cuanto corre su migración**, y este servicio es un
   *     singleton ⇒ el `false` quedaba congelado hasta que alguien reiniciara el proceso.
   *
   * Medido en PROD el 2026-09-14: `analytics.v_erp_unit_cost` **existe** (migración
   * `20260910170000`, aplicada el 2026-09-11 00:37), `app_runtime` la lee (USAGE + SELECT ✓), y
   * la consulta de valuación corre en **1,254 ms** devolviendo $71.96M catálogo vs $69.57M ERP
   * con 22,656 de 22,687 SKU con testigo (99.86%). O sea: un proceso arrancado antes de esa
   * fecha sigue publicando "no se puede valuar" sobre datos que están ahí.
   *
   * Un deploy que llega antes que su migración es normal; que su consecuencia sea permanente, no.
   */
  private static readonly ERP_VIEW_RECHECK_MS = 60_000;
  private erpCostViewCheckedAt = 0;

  private async hasErpCostView(trx: any): Promise<boolean> {
    if (this.erpCostViewExists === true) return true;
    if (this.erpCostViewExists === false
        && Date.now() - this.erpCostViewCheckedAt < CommercialBiAlmacenService.ERP_VIEW_RECHECK_MS) {
      return false;
    }
    const r = await trx.raw(`SELECT to_regclass('analytics.v_erp_unit_cost') IS NOT NULL AS ok`);
    this.erpCostViewExists = !!r.rows[0]?.ok;
    this.erpCostViewCheckedAt = Date.now();
    if (!this.erpCostViewExists) {
      this.logger.warn('analytics.v_erp_unit_cost no existe: el inventario no se valúa. '
        + `Se reintenta en ${CommercialBiAlmacenService.ERP_VIEW_RECHECK_MS / 1000}s (no se cachea la ausencia).`);
    }
    return this.erpCostViewExists;
  }

  /**
   * [WMS-BI.4.3] De dónde se lee la unidad base: la copia materializada si existe, la vista viva
   * si no.
   *
   * ⚠️ **Es la misma definición en los dos casos** — `analytics.mv_unit_truth` es `SELECT *` de
   * `analytics.v_unit_truth` (ADR-057 intacto: sigue habiendo un solo resolvedor). Lo único que
   * cambia es la EDAD del dato, y por eso la respuesta la declara (`unit_provenance`) en vez de
   * dejar al consumidor suponer que es en vivo.
   *
   * El fallback existe porque la migración `20260914130000_mv_unit_truth` puede no estar aplicada
   * todavía en un entorno donde el código sí está desplegado. Sin él, la pestaña entera tiraría
   * `relation does not exist` — un despliegue parcial no debe apagar la pantalla, debe degradarla
   * y decirlo.
   */
  private async unitTruthRel(trx: any): Promise<'analytics.mv_unit_truth' | 'analytics.v_unit_truth'> {
    if (this.unitTruthMvExists === undefined) {
      const r = await trx.raw(`SELECT to_regclass('analytics.mv_unit_truth') IS NOT NULL AS ok`);
      this.unitTruthMvExists = !!r.rows[0]?.ok;
      if (!this.unitTruthMvExists) {
        this.logger.warn(
          'analytics.mv_unit_truth no existe: se lee la vista viva (correcta pero ~8× más lenta). '
          + 'Falta aplicar la migración 20260914130000_mv_unit_truth.');
      }
    }
    return this.unitTruthMvExists ? 'analytics.mv_unit_truth' : 'analytics.v_unit_truth';
  }

  /**
   * `analytics.v_erp_stock_on_hand` (existencia derivada del ODS, ADR-055) se midió en esta
   * sesión en **71-82 s** para un `count(*)` sencillo contra `platform_test` — no es un typo,
   * es lo que tardó dos veces seguidas, fuera de este código, con `EXPLAIN` de por medio. Es un
   * hallazgo real (posiblemente carga del entorno compartido, no necesariamente prod), pero
   * arreglar la vista es de quien la dueña (Fase KE/ADR-055), no de este módulo. Lo que SÍ es
   * responsabilidad de acá: no colgar el endpoint entero por una vista lenta. `statement_timeout`
   * cancela la query en el SERVIDOR (no sólo deja de esperar del lado de Node, que dejaría la
   * query viva consumiendo el mismo recurso contendido) y se declara "No disponible", nunca un
   * número a medias.
   */
  private async withTimeout<T>(trx: any, ms: number, fn: () => Promise<T>): Promise<T | 'timeout'> {
    await trx.raw(`SET LOCAL statement_timeout = ${Number(ms) | 0}`);
    try {
      return await fn();
    } catch (e: any) {
      if (e?.code === '57014') return 'timeout'; // query_canceled (Postgres)
      throw e;
    }
    // Sin `finally` que resetee el timeout: una cancelación deja la TRANSACCIÓN abortada
    // (25P02) y cualquier comando posterior en ese mismo `trx` — el propio reset incluido —
    // fallaría también. Por diseño, quien llama a `withTimeout` es la ÚNICA query de su
    // transacción (`summary()` abre una `tk.run()` por pieza, ver el comentario ahí); no hay
    // nada más que corra después en el mismo `trx` a lo que el timeout le importe.
  }

  // ═══════════════════════════════════════════════════════════ filtros ════

  async filters(query: Record<string, unknown>): Promise<BiFiltersResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const ids = await this.resolveWarehouseIds(trx, tenantId, query);

      const whRows: Array<{
        id: string; code: string; name: string; zone_id: string | null; zone_name: string | null;
        zone_orden: number | null; has_movements_feed: boolean; display_order: number | null;
      }> = await trx('commercial.warehouses as w')
        .leftJoin('trade.zones as z', 'z.id', 'w.zone_id')
        .where('w.tenant_id', tenantId).whereNull('w.deleted_at')
        .whereRaw(branchKeyFilterSql('w'))
        .modify((qb: any) => { if (ids !== null) qb.whereIn('w.id', ids); })
        .select(
          'w.id', 'w.code', 'w.name', 'w.zone_id', 'z.name as zone_name', 'z.orden as zone_orden',
          'w.display_order', trx.raw(`(w.kepler_code IS NOT NULL) AS has_movements_feed`),
        )
        .orderByRaw('z.orden NULLS LAST, w.display_order NULLS LAST, w.code');

      const zonesMap = new Map<string, BiZoneGroup>();
      for (const w of whRows) {
        const key = w.zone_id ?? '(sin-zona)';
        if (!zonesMap.has(key)) {
          zonesMap.set(key, { zone_id: w.zone_id, zone_name: w.zone_name ?? '(sin zona)', warehouses: [] });
        }
        zonesMap.get(key)!.warehouses.push({
          id: w.id, code: w.code, name: w.name, zone_id: w.zone_id, zone_name: w.zone_name ?? null,
          has_movements_feed: w.has_movements_feed,
        } satisfies BiWarehouseOpt);
      }

      // [DB-MEM.12] Salto de índice sobre `ix_stockmov_code (tenant_id, warehouse_id, doc_code)`.
      //
      // Antes era un `DISTINCT` que barría `analytics.stock_movements` entera — 3.7 M filas /
      // 1,980 MB — para devolver **19 tipos de documento**. Medido en prod: 130,991 páginas
      // (1,023 MB) y 12,360 ms. Ahora salta de un `doc_code` al siguiente: 1,768 páginas (14 MB),
      // 184 ms. Mismas 19 filas, idénticas posición por posición.
      //
      // ⚠️ La semilla de almacenes NO puede salir de `whRows`: ése ya viene filtrado por
      // `deleted_at IS NULL` y por `branchKeyFilterSql`, mientras que el `DISTINCT` original
      // miraba TODOS los `warehouse_id` presentes en movimientos. Usar `whRows` achicaría el
      // alcance en silencio. Se siembra desde `commercial.warehouses` sin esos filtros, que es
      // equivalente porque está verificado que no hay `warehouse_id` huérfano (0 de 10).
      //
      // ⚠️ El desempate por `doc_code` no es cosmético: `ORDER BY movement_label` solo no
      // garantiza orden entre empates, y hay dos (`Sale1` y `WIN_V`, ambos "Venta").
      const filtroWh = ids !== null ? 'AND w.id = ANY(?::uuid[])' : '';
      const bindsDoc = ids !== null
        ? [tenantId, ids, tenantId, tenantId, tenantId]
        : [tenantId, tenantId, tenantId, tenantId];
      const docTypes: BiDocType[] = (await trx.raw(
        `WITH RECURSIVE wh AS (
           SELECT w.id FROM commercial.warehouses w
            WHERE EXISTS (SELECT 1 FROM analytics.stock_movements m
                           WHERE m.tenant_id = ? AND m.warehouse_id = w.id)
              ${filtroWh}
         ), saltos AS (
           SELECT wh.id AS warehouse_id,
                  (SELECT min(m.doc_code) FROM analytics.stock_movements m
                    WHERE m.tenant_id = ? AND m.warehouse_id = wh.id) AS doc_code
             FROM wh
           UNION ALL
           SELECT s.warehouse_id,
                  (SELECT min(m.doc_code) FROM analytics.stock_movements m
                    WHERE m.tenant_id = ? AND m.warehouse_id = s.warehouse_id
                      AND m.doc_code > s.doc_code)
             FROM saltos s WHERE s.doc_code IS NOT NULL
         )
         SELECT DISTINCT d.doc_code, d.movement_label, d.movement_kind
           FROM (SELECT DISTINCT warehouse_id, doc_code FROM saltos WHERE doc_code IS NOT NULL) s
           CROSS JOIN LATERAL (
             SELECT m.doc_code, m.movement_label, m.movement_kind
               FROM analytics.stock_movements m
              WHERE m.tenant_id = ? AND m.warehouse_id = s.warehouse_id
                AND m.doc_code = s.doc_code
              LIMIT 1) d
          ORDER BY d.movement_label ASC, d.doc_code ASC`,
        bindsDoc,
      )).rows;

      // [DB-MEM.12] Las tres medidas de frescura iban en UNA sola query, y salía 5× más caro que
      // pedirlas por separado: juntas 130,975 páginas (1,023 MB) / 15,737 ms · por separado
      // 9,052 + 17 + 24,902 = 33,971 páginas. Con las tres en el mismo SELECT, Postgres no puede
      // usar la optimización de cada una y cae a un único escaneo que las satisface a todas.
      // Es el mismo hallazgo que el sensor de `db-health` (923 ms → 0.049 ms al separarlas).
      const maxDocDate = (await trx.raw(
        // Salto por almacén: `ix_stockmov_date` es (tenant_id, warehouse_id, doc_date), así que
        // el `max()` global no lo puede usar de una. Medido: 9,029 → 295 páginas, mismo valor.
        `SELECT max(d.mx)::text AS v FROM commercial.warehouses w
           CROSS JOIN LATERAL (SELECT max(m.doc_date) AS mx FROM analytics.stock_movements m
                                WHERE m.tenant_id = ? AND m.warehouse_id = w.id) d`,
        [tenantId],
      )).rows[0]?.v ?? null;

      // Sale por `ix_stockmov_imported_at` (creado 2026-09-15): 17 páginas, 0.96 ms.
      const maxImportedAt = (await trx.raw(
        `SELECT max(imported_at)::text AS v FROM analytics.stock_movements WHERE tenant_id = ?`,
        [tenantId],
      )).rows[0]?.v ?? null;

      // ⚠️ ESTIMADO, y por eso se declara. El `count(*)` exacto cuesta 24,902 páginas (195 MB,
      // ~1.8 s) en CADA carga de la pantalla, y este número NO SE PINTA en ninguna parte: está
      // en el contrato y en el tipo del frontend, pero ninguna plantilla lo muestra. El
      // estimador de Postgres se desvía 0.14% (3,716,184 contra 3,711,041 exactas).
      // ⚠️ `reltuples` es de la TABLA, no del tenant: hoy coincide porque prod tiene un solo
      // tenant con movimientos. Si algún día hay más, este número deja de ser el del tenant —
      // por eso viaja marcado como estimado y nadie debería sumar con él.
      const totalRows = Number(
        (await trx.raw(`SELECT reltuples::bigint AS n FROM pg_class WHERE oid = to_regclass(?)`,
          ['analytics.stock_movements'])).rows[0]?.n ?? 0,
      );
      const fresh = {
        max_doc_date: maxDocDate,
        max_imported_at: maxImportedAt,
        total_rows: totalRows < 0 ? 0 : totalRows,
        total_rows_estimated: true,
      };

      const sc = await this.scope.current();
      const whDim = sc.dims['warehouse'];

      return {
        zones: [...zonesMap.values()],
        doc_types: docTypes,
        scope: {
          mode: whDim.mode,
          resolvable: whDim.resolvable !== false,
          warehouse_count: whDim.mode === 'all' ? null : whDim.values.length,
        },
        movements_as_of: {
          max_doc_date: fresh.max_doc_date, max_imported_at: fresh.max_imported_at,
          total_rows: fresh.total_rows, total_rows_estimated: fresh.total_rows_estimated,
        },
        inventory_as_of: new Date().toISOString(),
      };
    });
  }

  async productSearch(q: string, page: number, pageSize: number): Promise<BiPage<BiProductOpt>> {
    const tenantId = this.tenantCtx.requireTenantId();
    const p = Math.max(1, page || 1);
    const size = Math.min(50, Math.max(1, pageSize || 20));
    const term = (q || '').trim();
    return this.tk.run(async (trx) => {
      const base = trx('catalog.products as p')
        .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
        .where('p.tenant_id', tenantId).whereNull('p.deleted_at')
        .modify((qb: any) => {
          if (term) qb.andWhere((w: any) => w.whereILike('p.nombre', `%${term}%`).orWhereILike('p.sku', `%${term}%`));
        });
      const [{ count }] = await base.clone().count<{ count: string }[]>('p.id as count');
      const rows = await base.clone()
        .select('p.id', 'p.sku', 'p.nombre as name', 'b.nombre as brand_name')
        .orderBy('p.nombre').limit(size).offset((p - 1) * size);
      return { page: p, pageSize: size, total: Number(count), rows };
    });
  }

  // ═══════════════════════════════════════════════════════════ resumen ════

  async summary(query: Record<string, unknown>): Promise<BiSummaryResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const from = this.dateOr(query['from'], this.daysAgo(30));
    const to = this.dateOr(query['to'], this.today());
    const productId = this.uuidOr(query['product_id']);

    // TRES transacciones separadas, no una compartida. `statement_timeout` cancela la query
    // pero deja la TRANSACCIÓN abortada (Postgres 25P02): cualquier query siguiente en ese
    // mismo `trx` — aunque sea liviana, como movementCounts sobre stock_movements — fallaría
    // en cascada. Cada pieza abre su propia conexión vía `tk.run()`; si una se cancela, sólo
    // ESA transacción se pierde (rollback normal) y las otras dos siguen intactas. `ids` se
    // recalcula en cada una (una query rápida contra commercial.warehouses) en vez de
    // compartirse, precisamente para no acoplar sus transacciones.
    const inventory = await this.tk.run(async (trx) => {
      const ids = await this.resolveWarehouseIds(trx, tenantId, query);
      return this.inventoryValuation(trx, tenantId, ids, productId);
    });
    const movements = await this.tk.run(async (trx) => {
      const ids = await this.resolveWarehouseIds(trx, tenantId, query);
      return this.movementCounts(trx, tenantId, ids, from, to, productId);
    });
    const cost_deviation = await this.tk.run(async (trx) => {
      const ids = await this.resolveWarehouseIds(trx, tenantId, query);
      return this.costDeviation(trx, tenantId, ids);
    });
    return { from, to, inventory, movements, cost_deviation };
  }

  /** Tope duro sobre `analytics.v_erp_stock_on_hand`: medido en 71-82 s en esta sesión (ver el
   * comentario de `withTimeout`). 10 s alcanza en condiciones normales y evita colgar el resumen. */
  private static readonly INVENTORY_QUERY_TIMEOUT_MS = 10_000;

  private async inventoryValuation(
    trx: any, tenantId: string, ids: string[] | null, productId: string | null,
  ): Promise<BiInventoryValuation> {
    const hasErp = await this.hasErpCostView(trx);
    const as_of = new Date().toISOString();
    const timedOut = (): BiInventoryValuation => ({
      as_of, erp_cost_available: false,
      unavailable_reason: `La consulta de existencia (analytics.v_erp_stock_on_hand) tardó más de ${CommercialBiAlmacenService.INVENTORY_QUERY_TIMEOUT_MS / 1000}s y se canceló — el entorno está lento en este momento, no es un error de la pantalla.`,
      // null, no 0: el conteo real es desconocido (la query que lo daría es justo la que se
      // canceló), y 0 se leería como "no hay existencia" cuando en realidad no se pudo medir.
      sku_en_scope: null, valor_catalogo: null, valor_erp_verificado: null,
      valor_catalogo_mismo_subset: null, diferencia: null, cobertura_testigo_pct: null,
    });
    if (!hasErp) {
      // El conteo de SKU SÍ es real (v_erp_stock_on_hand no depende del resolvedor de costo):
      // declarar "0 SKU" cuando en realidad hay existencia sería la misma mentira que esta
      // rama existe para evitar del lado del dinero.
      const cnt = await this.withTimeout<any>(trx, CommercialBiAlmacenService.INVENTORY_QUERY_TIMEOUT_MS, () => trx.raw(
        `SELECT count(*)::int AS n FROM analytics.v_erp_stock_on_hand s
          WHERE s.tenant_id = ? AND s.qty_stock_units > 0
            ${ids !== null ? 'AND s.warehouse_id = ANY(?)' : ''}
            ${productId ? 'AND s.product_id = ?' : ''}`,
        [tenantId, ...(ids !== null ? [ids] : []), ...(productId ? [productId] : [])],
      ));
      if (cnt === 'timeout') return timedOut();
      return {
        as_of, erp_cost_available: false,
        unavailable_reason: 'analytics.v_erp_unit_cost no existe en este entorno (KE.3): sin el testigo de costo del ERP no se valúa — multiplicar por catalog.products.cost_base a secas ya causó un error medido de 3.5M en Fase MR (ADR-051).',
        sku_en_scope: Number(cnt.rows[0].n) || 0, valor_catalogo: null, valor_erp_verificado: null,
        valor_catalogo_mismo_subset: null, diferencia: null, cobertura_testigo_pct: null,
      };
    }
    const res = await this.withTimeout<any>(trx, CommercialBiAlmacenService.INVENTORY_QUERY_TIMEOUT_MS, () => trx.raw(
      `SELECT count(*)::int AS filas,
              count(*) FILTER (WHERE c.tiene_testigo)::int AS con_testigo,
              round(sum(s.qty_stock_units * coalesce(p.cost_base,0)))::numeric AS valor_catalogo,
              round(sum(s.qty_stock_units * c.costo_unitario) FILTER (WHERE c.tiene_testigo))::numeric AS valor_erp,
              round(sum(s.qty_stock_units * coalesce(p.cost_base,0)) FILTER (WHERE c.tiene_testigo))::numeric AS valor_catalogo_subset
         FROM analytics.v_erp_stock_on_hand s
         JOIN catalog.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id AND p.deleted_at IS NULL
         LEFT JOIN analytics.v_erp_unit_cost c
           ON c.tenant_id = s.tenant_id AND c.warehouse_id = s.warehouse_id AND c.product_id = s.product_id
        WHERE s.tenant_id = ? AND s.qty_stock_units > 0
          ${ids !== null ? 'AND s.warehouse_id = ANY(?)' : ''}
          ${productId ? 'AND s.product_id = ?' : ''}`,
      [tenantId, ...(ids !== null ? [ids] : []), ...(productId ? [productId] : [])],
    ));
    if (res === 'timeout') return timedOut();
    const row = res.rows[0];
    const filas = Number(row.filas) || 0;
    const conTestigo = Number(row.con_testigo) || 0;
    const valorErp = row.valor_erp == null ? null : Number(row.valor_erp);
    const valorCatSubset = row.valor_catalogo_subset == null ? null : Number(row.valor_catalogo_subset);
    return {
      as_of, erp_cost_available: true, unavailable_reason: null,
      sku_en_scope: filas,
      valor_catalogo: row.valor_catalogo == null ? null : Number(row.valor_catalogo),
      valor_erp_verificado: valorErp,
      valor_catalogo_mismo_subset: valorCatSubset,
      diferencia: valorErp != null && valorCatSubset != null ? Number((valorErp - valorCatSubset).toFixed(2)) : null,
      cobertura_testigo_pct: filas > 0 ? Number(((100 * conTestigo) / filas).toFixed(2)) : null,
    };
  }

  private async movementCounts(
    trx: any, tenantId: string, ids: string[] | null, from: string, to: string, productId: string | null,
  ): Promise<BiMovementCounts> {
    const base = () => trx('analytics.stock_movements as m')
      .where('m.tenant_id', tenantId)
      .whereBetween('m.doc_date', [from, to])
      .modify((qb: any) => {
        if (ids !== null) qb.whereIn('m.warehouse_id', ids);
        if (productId) qb.andWhere('m.product_id', productId);
      });

    const totals = (await base()
      .select(
        trx.raw(`count(*) FILTER (WHERE movement_kind = 'entrada')::int AS entradas`),
        trx.raw(`count(*) FILTER (WHERE movement_kind = 'salida')::int AS salidas`),
        trx.raw(`count(DISTINCT product_id)::int AS productos`),
      ))[0] ?? { entradas: 0, salidas: 0, productos: 0 };

    const daily = await base()
      .groupBy(trx.raw(`m.doc_date`))
      .select(
        trx.raw(`m.doc_date::text AS date`),
        trx.raw(`count(*) FILTER (WHERE movement_kind = 'entrada')::int AS entradas`),
        trx.raw(`count(*) FILTER (WHERE movement_kind = 'salida')::int AS salidas`),
      )
      .orderBy('date');

    const topSalida = await base()
      .andWhere('m.movement_kind', 'salida')
      .leftJoin('catalog.products as p', function (this: any) {
        this.on('p.id', 'm.product_id').andOn('p.tenant_id', 'm.tenant_id');
      })
      .groupBy('m.product_id', 'p.nombre', 'p.sku', 'm.sku')
      .select(
        trx.raw(`coalesce(p.sku, m.sku) AS sku`),
        trx.raw(`coalesce(p.nombre, '(sin catálogo)') AS product_name`),
        trx.raw(`round(sum(m.amount))::numeric AS valor`),
      )
      .orderBy('valor', 'desc').limit(10);

    // Kepler-only ⇒ declarado cuando el scope pedido incluye una sucursal Wincaja.
    let coversAll = true;
    if (ids !== null && ids.length) {
      const nonKepler = (await trx('commercial.warehouses').whereIn('id', ids).whereNull('kepler_code').count('* as n'))[0];
      coversAll = Number(nonKepler.n) === 0;
    }

    return {
      covers_all_scope: coversAll,
      entradas_lineas: Number(totals.entradas) || 0,
      salidas_lineas: Number(totals.salidas) || 0,
      productos_con_movimiento: Number(totals.productos) || 0,
      daily_series: daily,
      top_salida_valor: topSalida.map((r: any) => ({ sku: r.sku, product_name: r.product_name, valor: Number(r.valor) || 0 })),
    };
  }

  private async costDeviation(trx: any, tenantId: string, ids: string[] | null): Promise<BiCostDeviation> {
    const hasErp = await this.hasErpCostView(trx);
    if (!hasErp) {
      return {
        available: false,
        unavailable_reason: 'analytics.v_erp_unit_cost no existe en este entorno: sin ambos costos verificados no hay con qué comparar (nunca se aproxima con un solo lado).',
        rows: [],
      };
    }
    const res = await this.withTimeout<any>(trx, CommercialBiAlmacenService.INVENTORY_QUERY_TIMEOUT_MS, () => trx.raw(
      `SELECT c.warehouse_code, p.sku, p.nombre AS product_name,
              p.cost_base AS costo_catalogo, c.costo_unitario AS costo_erp,
              round(c.costo_unitario - p.cost_base, 4) AS diferencia,
              CASE WHEN p.cost_base > 0 THEN round(100.0 * (c.costo_unitario - p.cost_base) / p.cost_base, 2) END AS diferencia_pct
         FROM analytics.v_erp_unit_cost c
         JOIN catalog.products p ON p.tenant_id = c.tenant_id AND p.id = c.product_id AND p.deleted_at IS NULL
         JOIN analytics.v_erp_stock_on_hand s
           ON s.tenant_id = c.tenant_id AND s.warehouse_id = c.warehouse_id AND s.product_id = c.product_id AND s.qty_stock_units > 0
        WHERE c.tenant_id = ? AND c.tiene_testigo AND p.cost_base > 0
          ${ids !== null ? 'AND c.warehouse_id = ANY(?)' : ''}
        ORDER BY abs(c.costo_unitario - p.cost_base) DESC
        LIMIT 15`,
      [tenantId, ...(ids !== null ? [ids] : [])],
    ));
    if (res === 'timeout') {
      return {
        available: false,
        unavailable_reason: `La consulta tardó más de ${CommercialBiAlmacenService.INVENTORY_QUERY_TIMEOUT_MS / 1000}s y se canceló — el entorno está lento en este momento.`,
        rows: [],
      };
    }
    return { available: true, unavailable_reason: null, rows: res.rows };
  }

  // ═══════════════════════════════════════════════════════ movimientos ════

  /**
   * WMS-BI.2 (2026-09-15) — Documentos que representan VENTA (importe_venta/IVA/IEPS/venta neta)
   * contra los que representan COSTO (importe_costo: compras, ajustes, traspasos, devoluciones a
   * proveedor). Devoluciones DE VENTA (RtrnEn1/Rtrn1) entran del lado de venta —son la misma
   * operación en reversa—, devoluciones A PROVEEDOR (RtrnPrd1/RtrnPur1) del lado de costo.
   */
  private static readonly SALE_DOC_CODES = new Set(['Sale1', 'Sale2', 'Remiss1', 'RtrnEn1', 'Rtrn1']);

  /**
   * [WMS-BI.4.2] El catálogo COMPLETO de `doc_code`, medido contra PROD el 2026-09-14 (los 19 que
   * existen en `analytics.stock_movements`, 3,699,345 filas). Reemplaza a `SALE_DOC_CODES` +
   * `TRANSFER_DOC_CODES` + `ADJUSTMENT_DOC_CODES`, que entre las tres dejaban un **default
   * silencioso**: `tipoOperacion()` terminaba en `return 'Comercial'`, así que cualquier
   * `doc_code` que nadie hubiera listado se publicaba como Comercial sin una queja.
   *
   * ── Lo que ese default escondía, medido ───────────────────────────────────────────────────
   *
   * Los 9 `doc_code` de **Wincaja** (`WIN_*`) no estaban en ninguna de las tres listas, y son el
   * **89% de la tabla** (3,364,207 de 3,699,345):
   *
   *   · `WIN_V` "Venta" (2,993,472 filas) no era venta para este módulo ⇒ su importe se publicaba
   *     en **"Importe costo"** y las 4 columnas de venta quedaban vacías. En la ventana de 30 días
   *     eso son **62,144 líneas / $20,325,383** en la columna equivocada: el 94% de los pesos de
   *     venta del periodo.
   *   · `WIN_E`/`WIN_S`/`WIN_I`/`WIN_M` dicen "ajuste"/"Merma" en su PROPIO `movement_label` y
   *     caían en "Comercial" (163,109 filas).
   *
   * ── Y 3 de las 5 entradas de `SALE_DOC_CODES` estaban muertas ─────────────────────────────
   *
   * `Remiss1`, `RtrnEn1` y `Rtrn1`: **0 filas** en toda la tabla. Se conservan igual —son
   * doctypes válidos de Kepler que pueden aparecer— pero ahora se sabe que hoy no aportan nada.
   *
   * ⛔ **La regla nueva: lo que no está en este mapa NO se clasifica, se DECLARA.** Un
   * `doc_code` nuevo sale como `Sin clasificar` y se ve en pantalla, en vez de heredar en
   * silencio la etiqueta del vecino (ADR-056). Es lo único que evita que esto se repita.
   */
  private static readonly DOC_CATALOG: Readonly<Record<string, { op: BiTipoOperacion; venta: boolean }>> = {
    // ── Venta (y su reverso). `venta: true` habilita importe_venta / IVA / IEPS / venta neta.
    Sale1:     { op: 'Comercial', venta: true },   // U-D-5  "Venta"
    Sale2:     { op: 'Comercial', venta: true },   // U-D-5  "Venta contado"
    WIN_V:     { op: 'Comercial', venta: true },   // W-D-V  "Venta"          ← 2,993,472 filas
    WIN_D:     { op: 'Comercial', venta: true },   // W-A-D  "Devolución de venta"
    Remiss1:   { op: 'Comercial', venta: true },   // 0 filas hoy
    RtrnEn1:   { op: 'Comercial', venta: true },   // 0 filas hoy
    Rtrn1:     { op: 'Comercial', venta: true },   // 0 filas hoy
    // ── Compra / entrada de mercancía: el importe es COSTO, no venta.
    EntryOr1:  { op: 'Comercial', venta: false },  // X-A-40 "Orden de entrada"
    ApEntOr1:  { op: 'Comercial', venta: false },  // X-A-20 "Aplicación de orden de entrada"
    RtrnPur1:  { op: 'Comercial', venta: false },  // X-D-40 "Devolución de compra"
    WIN_C:     { op: 'Comercial', venta: false },  // W-A-C  "Compra"
    WIN_P:     { op: 'Comercial', venta: false },  // W-A-P  "Compra (pedido)"
    // ── Traspasos internos: ni venta ni compra, la mercancía sólo cambia de almacén.
    TrsfShip:  { op: 'Traspasos internos', venta: false },  // U-D-41 "Traspaso a sucursal"
    TrsfRcv:   { op: 'Traspasos internos', venta: false },  // U-A-50 "Recepción de traspaso"
    InvTrsf1:  { op: 'Traspasos internos', venta: false },  // 0 filas hoy
    TrsfInBr:  { op: 'Traspasos internos', venta: false },  // 0 filas hoy
    TrsfInWh:  { op: 'Traspasos internos', venta: false },  // 0 filas hoy
    TrsfOutBr: { op: 'Traspasos internos', venta: false },  // 0 filas hoy
    // ── Corrección de conteo / merma: no es una operación comercial (ADR-056: tercer valor
    //    declarado en vez de forzarlo a uno de los otros dos).
    InvIn1:    { op: 'Ajuste de inventario', venta: false },  // N-A-20 "Ajuste de entrada"
    InvOut1:   { op: 'Ajuste de inventario', venta: false },  // N-D-5  "Ajuste de salida"
    PhysInv1:  { op: 'Ajuste de inventario', venta: false },  // N-D-30 "Inventario físico"
    PhysInvIn: { op: 'Ajuste de inventario', venta: false },  // N-A-30 "Inventario físico (entrada)"
    WIN_E:     { op: 'Ajuste de inventario', venta: false },  // W-A-E  "Entrada (ajuste)"
    WIN_S:     { op: 'Ajuste de inventario', venta: false },  // W-D-S  "Salida (ajuste)"
    WIN_M:     { op: 'Ajuste de inventario', venta: false },  // W-A-M  "Ajuste (entrada)"
    WIN_I:     { op: 'Ajuste de inventario', venta: false },  // W-D-I  "Merma / baja"
  };

  /**
   * WMS-BI.3 (2026-09-15) — "Tipo de operación", a pedido del usuario. El pedido original era
   * 2 valores (comercial/traspasos internos); medido contra `import-stock-movements.js` hay un
   * TERCER grupo real que no es ninguno de los dos: `InvIn1`/`InvOut1`/`PhysInv1`/`PhysInvIn` son
   * correcciones de CONTEO (ajuste de inventario), no una venta/compra ni un traspaso entre
   * almacenes — forzarlos a "comercial" o "traspaso" sería inventar un hecho que el documento no
   * tiene (ADR-056). Se declara un tercer valor en vez de mentir en dos.
   */
  /** `undefined` = `doc_code` que no está en `DOC_CATALOG`. NO se adivina: ver `clasificar()`. */
  private static clasificar(docCode: string): { op: BiTipoOperacion; venta: boolean } {
    return CommercialBiAlmacenService.DOC_CATALOG[docCode]
      // Sin default silencioso: un doctype nuevo se DECLARA sin clasificar y se ve en pantalla.
      // `venta: false` acá no afirma que no sea venta — afirma que no lo sabemos, y por eso la
      // fila también sale con `aplica_venta: false` y la etiqueta lo dice.
      ?? { op: 'Sin clasificar', venta: false };
  }

  /**
   * WMS-BI.3 (2026-09-15) — "Canal", a pedido del usuario, confirmado el mapeo tras mostrarle los
   * hallazgos: `kduv.c3` (mismo campo de Vendedor) trae 3 familias de código reconocibles en el
   * texto — "... PISO"/"PV ..." (mostrador de sucursal) → Punto de Venta; "TLMK.../TLMKT..."
   * (telemarketing) → Mayoreo; el resto con nombre real (rutas RD/RV, sin prefijo TLMK) → Venta al
   * detalle. Códigos especiales que no son un canal de venta ("E-COMMERCE", "Otros Ingresos",
   * "TRASPASOS INTERNOS") se declaran `null`, no se fuerzan a uno de los 3. Sólo aplica a
   * documentos de venta (mismo alcance que Vendedor — ver nota en `enrichFromKdm`).
   */
  private static canalFromVendedor(vendedorName: string | null | undefined): 'Punto de Venta' | 'Mayoreo' | 'Venta al detalle' | null {
    if (!vendedorName) return null;
    const v = vendedorName.toUpperCase();
    if (/OTROS INGRESOS|E-COMMERCE|TRASPASOS/.test(v)) return null;
    if (/PISO|^PV /.test(v)) return 'Punto de Venta';
    if (/^TLMK/.test(v)) return 'Mayoreo';
    return 'Venta al detalle';
  }

  async movements(query: Record<string, unknown>): Promise<BiMovementPage> {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(query['page']) || 1);
    // El export pide TODA la consulta en UNA sola llamada (hasta EXPORT_ROW_CAP filas). Sin esto
    // se clampeaba a 200 y el export loopeaba ~500 veces (COUNT + 4 joins ODS + enrich por página):
    // 133,933 filas/30d medidas contra prod = ~371 s → timeout → el CSV nunca se generaba.
    // Un solo tiro con LIMIT 100k mide ~44 s (medido 2026-09-15).
    const cap = query['__export'] === true ? CommercialBiAlmacenService.EXPORT_ROW_CAP : 200;
    const pageSize = Math.min(cap, Math.max(1, Number(query['pageSize']) || 50));
    const from = this.dateOr(query['from'], this.daysAgo(30));
    const to = this.dateOr(query['to'], this.today());
    const docCode = this.strOr(query['doc_code']);
    const kind = ['entrada', 'salida'].includes(String(query['movement_kind'] || '')) ? String(query['movement_kind']) : null;
    const folio = this.strOr(query['folio']);
    const productId = this.uuidOr(query['product_id']);
    const sortField = ['doc_date', 'qty', 'amount'].includes(String(query['sort'] || '')) ? String(query['sort']) : 'doc_date';
    const sortDir = String(query['dir'] || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

    return this.tk.run(async (trx) => {
      const ids = await this.resolveWarehouseIds(trx, tenantId, query);
      const unitRel = await this.unitTruthRel(trx);
      const base = () => trx('analytics.stock_movements as m')
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        .leftJoin('trade.zones as z', 'z.id', 'w.zone_id')
        .leftJoin('catalog.products as p', function (this: any) {
          this.on('p.id', 'm.product_id').andOn('p.tenant_id', 'm.tenant_id');
        })
        .where('m.tenant_id', tenantId)
        .whereBetween('m.doc_date', [from, to])
        .modify((qb: any) => {
          if (ids !== null) qb.whereIn('m.warehouse_id', ids);
          if (docCode) qb.andWhere('m.doc_code', docCode);
          if (kind) qb.andWhere('m.movement_kind', kind);
          if (folio) qb.whereILike('m.folio', `%${folio}%`);
          if (productId) qb.andWhere('m.product_id', productId);
        });

      const [{ count }] = await base().count<{ count: string }[]>('m.folio as count');
      // Producto (línea/tipo/grupo) y unidad base: joins LIVE sobre el ODS, al grano PRODUCTO
      // (no por instancia de movimiento) — verificado 2026-09-15: kdii.c3→kdig (línea/fabricante,
      // 87.6% match), kdii.c4→kdie (tipo, 100%), kdii.c5→kdif (grupo, 99.5%). Se unen por
      // (sku, sucursal): kdii/kdie/kdif/kdig replican su catálogo por sucursal.
      const rowsRaw = await base()
        .leftJoin('kepler_ods.kdii as ii', function (this: any) {
          this.on(trx.raw('btrim(ii.c1)'), '=', trx.raw('btrim(coalesce(p.sku, m.sku))')).andOn('ii.sucursal', 'w.code');
        })
        .leftJoin('kepler_ods.kdie as tp', function (this: any) {
          this.on('tp.c1', '=', 'ii.c4').andOn('tp.sucursal', 'ii.sucursal');
        })
        .leftJoin('kepler_ods.kdif as gp', function (this: any) {
          this.on('gp.c1', '=', 'ii.c5').andOn('gp.sucursal', 'ii.sucursal');
        })
        .leftJoin('kepler_ods.kdig as lp', function (this: any) {
          this.on(trx.raw('btrim(lp.c1)'), '=', trx.raw('btrim(ii.c3::text)')).andOn('lp.sucursal', 'ii.sucursal');
        })
        .leftJoin(`${unitRel} as ut`, function (this: any) {
          this.on('ut.tenant_id', 'm.tenant_id').andOn('ut.warehouse_id', 'm.warehouse_id').andOn('ut.product_id', 'm.product_id');
        })
        .select(
          trx.raw(`m.doc_date::text AS doc_date`),
          'z.name as zone_name', 'w.code as warehouse_code', 'w.name as warehouse_name',
          'm.movement_kind', 'm.movement_label', 'm.doc_code', 'm.folio',
          'm.genero', 'm.naturaleza', 'm.doc_type', 'm.source_branch',
          trx.raw(`coalesce(p.sku, m.sku) AS sku`),
          trx.raw(`coalesce(p.nombre, '(sin catálogo)') AS product_name`),
          trx.raw(`nullif(btrim(lp.c2), '') AS linea_producto`),
          trx.raw(`nullif(btrim(tp.c2), '') AS tipo_producto`),
          trx.raw(`nullif(btrim(gp.c2), '') AS grupo_producto`),
          'm.qty', 'm.signed_qty', 'm.unit_cost', 'm.amount',
          'ut.base_label as unidad_base', 'ut.medible as unidad_base_medible_resolver',
          'p.iva_rate', 'p.ieps_rate',
          'p.cost_base as cost_base_hoy',
          trx.raw(`'kepler'::text AS source_system`),
        )
        .orderBy(sortField === 'doc_date' ? 'm.doc_date' : sortField === 'qty' ? 'm.qty' : 'm.amount', sortDir)
        .orderBy('m.folio', 'desc')
        .limit(pageSize).offset((page - 1) * pageSize);

      const rows = await this.enrichFromKdm(trx, tenantId, rowsRaw);

      // [WMS-BI.4.3] La edad del resolvedor de unidad va EN LA RESPUESTA, no en un comentario:
      // una copia que nadie fecha se lee igual que un dato en vivo (ADR-056). Se pregunta una vez
      // por página, no por fila — son 50 timestamps idénticos.
      const unit_provenance: BiUnitProvenance = unitRel === 'analytics.mv_unit_truth'
        ? {
            source: 'mv',
            // `LIMIT 1` y no `max()`: `now()` es el timestamp de la transacción del REFRESH, así
            // que las 179,824 filas traen el MISMO valor — agregarlas sería escanear la MV entera
            // para obtener un dato que está en cualquier fila.
            refreshed_at: (await trx.raw(
              `SELECT refreshed_at::text AS t FROM analytics.mv_unit_truth LIMIT 1`)).rows[0]?.t ?? null,
          }
        : { source: 'view', refreshed_at: null };

      return { page, pageSize, total: Number(count), rows, unit_provenance };
    });
  }

  /**
   * Enriquece la PÁGINA visible (≤200 filas) con lo que sólo vive en `kepler_ods.kdm1`/`kdm2` y
   * el Diario de Movimientos (Fase DM) no capturó: hora real (`kdm1.c69`, texto "HH:MM" — ver nota
   * abajo), vendedor (`kdm1.c12` → `kduv.c3`, sólo para documentos de venta), unidad de la línea
   * (`kdm2.c11`) y el costo REAL de la línea (`kdm2.c62`/`c63`, ~99.1% de cobertura en U-D-10/U-D-6
   * según MR.7.2 — no verificado para los demás doctypes de este módulo). Batch por VALUES (una
   * sola query, no N) — SIN `statement_timeout` a diferencia de `inventoryValuation`: el join es
   * por llave puntual (sucursal+doctype+folio+sku) sobre ≤200 filas, no un `count(*)` de toda la
   * vista; si falla, cada fila cae a "no disponible" — la pantalla sigue siendo útil con lo que YA
   * viene de `analytics.stock_movements`.
   *
   * ⚠️ **`c9` NO es la hora — corregido 2026-09-15.** El commit anterior de este módulo asumía
   * `kdm1.c9` como timestamp con hora real. Medido en vivo contra `kepler_ods.kdm1` (595,433 filas):
   * `c9` es SIEMPRE medianoche (0 filas con hora ≠ 00:00:00); `c69` (texto "HH:MM") está poblado en
   * el 99.98% y es la hora real (verificado contra varias filas: `c68`+`c69` = fecha+hora del
   * documento). Se corrige aquí sin esperar a que alguien lo reporte desde el navegador.
   *
   * ⚠️ **Vendedor sólo aplica a documentos de VENTA.** `kdm1.c12` se REUSA por tipo de documento
   * (patrón típico de Kepler): para género `U` (venta) resuelve casi siempre contra `kduv.c3`
   * (medido: Sale1 87.6% de match, 01-06); para género `X` (compra) el mismo campo NO resuelve
   * nunca (0/13,000+ medido) — ahí `c12` es otra cosa (probablemente referencia de proveedor), no
   * un vendedor. Se declara `null` fuera de `SALE_DOC_CODES` en vez de publicar un valor que
   * casualmente pudiera coincidir con un código de `kduv` sin significar lo mismo.
   *
   * ⚠️ **NO EJERCIDO CONTRA DATOS REALES DE ESTE MÓDULO**: `analytics.stock_movements` está vacía
   * en este entorno (Fase DM). El join reproduce EXACTO el de `import-stock-movements.js` (mismo
   * orden de columnas c1/c2/c3/c4/c6), y el decode de `c69`/`c12`→`kduv` SÍ se verificó por
   * separado contra `kepler_ods` en vivo (ver comentarios arriba), pero la correctitud fila-a-fila
   * del ENRIQUECIMIENTO completo no se pudo confirmar aquí por falta de datos en esta tabla.
   */
  private async enrichFromKdm(trx: any, tenantId: string, rows: any[]): Promise<BiMovementRow[]> {
    if (!rows.length) return [];
    let kdmRows: any[] = [];
    try {
      const branches = [...new Set(rows.map((r) => r.source_branch))];
      const folios = [...new Set(rows.map((r) => r.folio))];
      const res = await trx.raw(
        `SELECT h.sucursal, h.c2 genero, h.c3 naturaleza, h.c4::text doc_type, h.c6 folio, l.c8 sku,
                h.c69 AS hora, nullif(btrim(v.c3), '') AS vendedor_name,
                l.c11 AS unidad_operacion, l.c58 AS peldano, l.c62 AS costo62, l.c63 AS costo63
           FROM kepler_ods.kdm1 h
           JOIN kepler_ods.kdm2 l ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2
                                 AND l.c3 = h.c3 AND l.c4 = h.c4 AND l.c6 = h.c6
           LEFT JOIN kepler_ods.kduv v ON v.sucursal = h.sucursal AND btrim(v.c2) = btrim(h.c12)
          WHERE btrim(h.c1) = btrim(h.sucursal)
            AND h.sucursal = ANY(?) AND h.c6 = ANY(?)`,
        [branches, folios],
      );
      kdmRows = res.rows;
    } catch (e: any) {
      // Se declara vacío (todas las filas caen a "no disponible") en vez de tumbar el endpoint —
      // el resto de la página (fecha/sucursal/documento/folio/producto/cantidad/importe) sigue
      // siendo real y útil sin este enriquecimiento.
      this.logger.warn(`enrichFromKdm: no se pudo enriquecer contra kepler_ods (${e?.message}); se declara no disponible`);
    }
    const key = (r: { source_branch?: string; sucursal?: string; genero: string; naturaleza: string; doc_type: string; folio: string; sku: string | null }) =>
      `${r.source_branch ?? r.sucursal}|${r.genero}|${r.naturaleza}|${r.doc_type}|${r.folio}|${(r.sku ?? '').trim()}`;
    const kdmByKey = new Map(kdmRows.map((r) => [key(r), r]));

    return rows.map((r) => {
      const k = kdmByKey.get(key(r));
      const unidadOperacion: string | null = k?.unidad_operacion ? String(k.unidad_operacion).trim() : null;
      const unidadBase: string | null = r.unidad_base ?? null;
      let cantidadBase: number | null = null;
      let medible = false;
      if (unidadOperacion && unidadBase) {
        if (unidadOperacion === unidadBase) { cantidadBase = Number(r.qty); medible = true; }
        else if (k?.peldano != null && Number(k.peldano) > 0) { cantidadBase = Number(r.qty) * Number(k.peldano); medible = true; }
      }

      const clase = CommercialBiAlmacenService.clasificar(r.doc_code);
      const isSale = clase.venta;
      // [WMS-BI.4.2] `importe_costo` ya NO intenta leer `kdm2.c62`/`c63`. Medido contra prod por
      // doctype: esas dos columnas están pobladas SÓLO en `U-D-5/10/12` —documentos de VENTA,
      // donde `isSale` corta antes de leerlas— y al **0%** en todos los doctypes de costo
      // (`X-A-20/30/35/37/40`, `N-A-20`, `X-D-40`). Además son `text`: `''` no lo atrapa el `??`,
      // lo atrapa `Number('') = 0 || r.amount`. O sea que la rama nunca se ejecutó y el valor
      // publicado siempre fue `r.amount`. Se retira el teatro y se dice lo que es.
      // ⚠️ Y si algún día se poblaran, `c62` es un costo UNITARIO por peldaño, no un importe
      // extendido: publicarlo bajo "Importe costo" mezclaría unidad con extensión (ADR-051).
      const importeCosto = !isSale ? r.amount : null;
      const importeVenta = isSale ? r.amount : null;
      let ivaValor: number | null = null, iepsValor: number | null = null, ventaNeta: number | null = null;
      if (importeVenta != null && r.iva_rate != null && r.ieps_rate != null) {
        const ivaRate = Number(r.iva_rate), iepsRate = Number(r.ieps_rate);
        const divisor = 1 + ivaRate + iepsRate;
        ventaNeta = divisor > 0 ? Number((Number(importeVenta) / divisor).toFixed(2)) : null;
        ivaValor = ventaNeta != null ? Number((ventaNeta * ivaRate).toFixed(2)) : null;
        iepsValor = ventaNeta != null ? Number((ventaNeta * iepsRate).toFixed(2)) : null;
      }

      return {
        doc_date: r.doc_date, hora: k?.hora ? String(k.hora).trim() || null : null,
        zone_name: r.zone_name, warehouse_code: r.warehouse_code, warehouse_name: r.warehouse_name,
        almacen: 'Disponible',
        movement_kind: r.movement_kind, movement_label: r.movement_label,
        tipo_operacion: clase.op,
        // [WMS-BI.4.2] Para que la pantalla pueda distinguir "falta el dato" de "no corresponde a
        // este documento". Sin esto, Canal / Vendedor / IVA / IEPS / Venta neta salían todas como
        // "No disponible" en una orden de compra, que es una respuesta falsa: ahí no hay canal ni
        // vendedor ni base gravable que buscar. Ausencias distintas, etiquetas distintas
        // (ADR-059 regla 4).
        aplica_venta: isSale,
        doc_code: r.doc_code, folio: r.folio,
        vendedor: isSale ? (k?.vendedor_name ?? null) : null,
        canal: isSale ? CommercialBiAlmacenService.canalFromVendedor(k?.vendedor_name) : null,
        sku: r.sku, product_name: r.product_name,
        linea_producto: r.linea_producto, tipo_producto: r.tipo_producto, grupo_producto: r.grupo_producto,
        qty: Number(r.qty), signed_qty: Number(r.signed_qty),
        unidad_operacion: unidadOperacion, unidad_base: unidadBase, cantidad_base: cantidadBase, unidad_base_medible: medible,
        unit_cost: r.unit_cost, amount: r.amount,
        importe_costo: importeCosto, importe_venta: importeVenta,
        iva_valor: ivaValor, ieps_valor: iepsValor, venta_neta: ventaNeta,
        cost_base_hoy: r.cost_base_hoy,
        // [WMS-BI.4.2] El origen REAL, no el literal `'kepler'` que estaba acá y mentía en el 89%
        // de la tabla. `source_branch` con prefijo `W` es Wincaja — es el mismo criterio que usa
        // `import-wincaja-stock-movements.js` al escribirlo (`source_branch = 'W'||unidad`), y el
        // que el feed de Kepler usa para excluirlas de su DELETE.
        // ⚠️ Es una DERIVACIÓN, no una columna: la columna propia llega en WMS-BI.4.1.
        source_branch: r.source_branch,
        source_system: String(r.source_branch ?? '').startsWith('W') ? 'wincaja' : 'kepler',
      } satisfies BiMovementRow;
    });
  }

  /**
   * Detalle de UN documento. Delega en `CommercialMovementsService.document()` (misma
   * tabla, mismo código — no se duplica la lógica de armar header/líneas/contraparte) y
   * le agrega DOS cosas propias de BI: (a) verificar que el almacén del documento está
   * dentro del alcance del requester —403 explícito si no— y (b) redactar el destino
   * cuando es un cliente/tienda y falta `COMMERCIAL_CUSTOMERS_VER`.
   */
  async movementDetail(
    params: { warehouse_id: string; doc_code?: string; folio: string; doc_serie?: string },
    permissions: Record<string, boolean> | undefined,
  ): Promise<BiMovementDetail> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (params.warehouse_id) {
        const ids = await this.resolveWarehouseIds(trx, tenantId, {});
        if (ids !== null && !ids.includes(params.warehouse_id)) {
          throw new ForbiddenException('Ese almacén no está en tu alcance de datos.');
        }
      }
      const doc = await this.movementsSvc.document(params);
      let destRedacted = false;
      const canSeeClientes = permissions?.['COMMERCIAL_CUSTOMERS_VER'] === true;
      if (doc.header && this.clasificaDestino((doc.header as any).dest_label, (doc.header as any).dest_code) === 'cliente' && !canSeeClientes) {
        (doc.header as any).dest_label = '(restringido)';
        (doc.header as any).dest_code = null;
        (doc.header as any).dest_warehouse_name = null;
        destRedacted = true;
      }
      return { ...doc, dest_redacted: destRedacted } as BiMovementDetail;
    });
  }

  /** Heurística simple: no es cliente si parece ruta de reparto o traspaso a otra sucursal (TI###). */
  private clasificaDestino(label: string | null | undefined, code: string | null | undefined): 'ruta' | 'sucursal' | 'cliente' | null {
    if (!label && !code) return null;
    const s = `${label ?? ''} ${code ?? ''}`.trim();
    if (/^\s*(R\.[DV]|R[DV]|RUTA)/i.test(s)) return 'ruta';
    if (/^TI\d/i.test(code ?? '')) return 'sucursal';
    return 'cliente';
  }

  // ═══════════════════════════════════════════════════════ explorar ════

  /**
   * Subquery correlacionada hacia `kepler_ods.kdm1`⋈`kdm2` — el MISMO join que
   * `enrichFromKdm()`, pero como expresión SQL para el picker libre de "Explorar datos" (que arma
   * el SELECT dinámicamente, columna por columna, y no puede pasar por el batch de `movements()`).
   * `LIMIT 1`: por diseño hay una sola línea por (documento, sku) — si hubiera dos, cualquiera de
   * las dos es la misma cantidad/unidad real, así que no hace falta desambiguar más.
   */
  private static readonly KDM_SUBQ = (col: string) => `(SELECT ${col} FROM kepler_ods.kdm1 h
     JOIN kepler_ods.kdm2 l ON l.sucursal=h.sucursal AND l.c1=h.c1 AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4=h.c4 AND l.c6=h.c6
    WHERE btrim(h.c1)=btrim(h.sucursal) AND h.sucursal=m.source_branch AND h.c2=m.genero AND h.c3=m.naturaleza
      AND h.c4::text=m.doc_type AND h.c6=m.folio AND btrim(l.c8)=btrim(coalesce(p.sku,m.sku)) LIMIT 1)`;

  /** Mismo join que `KDM_SUBQ` + `kduv` para el vendedor (`kdm1.c12`) — ver nota en `enrichFromKdm`
   * sobre por qué sólo aplica a documentos de venta (`SALE_DOC_CODES`). */
  private static readonly KDM_SUBQ_VENDEDOR = `(SELECT nullif(btrim(v.c3), '') FROM kepler_ods.kdm1 h
     JOIN kepler_ods.kdm2 l ON l.sucursal=h.sucursal AND l.c1=h.c1 AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4=h.c4 AND l.c6=h.c6
     LEFT JOIN kepler_ods.kduv v ON v.sucursal=h.sucursal AND btrim(v.c2)=btrim(h.c12)
    WHERE btrim(h.c1)=btrim(h.sucursal) AND h.sucursal=m.source_branch AND h.c2=m.genero AND h.c3=m.naturaleza
      AND h.c4::text=m.doc_type AND h.c6=m.folio AND btrim(l.c8)=btrim(coalesce(p.sku,m.sku)) LIMIT 1)`;

  /** Mismo join + el mapeo de `canalFromVendedor()` calcado en SQL — ver la nota junto a ese método
   * (confirmado con el usuario 2026-09-15). */
  private static readonly KDM_SUBQ_CANAL = `(SELECT CASE
         WHEN nullif(btrim(v.c3), '') IS NULL THEN NULL
         WHEN v.c3 ~* 'OTROS INGRESOS|E-COMMERCE|TRASPASOS' THEN NULL
         WHEN v.c3 ~* 'PISO|^PV ' THEN 'Punto de Venta'
         WHEN v.c3 ~* '^TLMK' THEN 'Mayoreo'
         ELSE 'Venta al detalle' END
       FROM kepler_ods.kdm1 h
       JOIN kepler_ods.kdm2 l ON l.sucursal=h.sucursal AND l.c1=h.c1 AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4=h.c4 AND l.c6=h.c6
       LEFT JOIN kepler_ods.kduv v ON v.sucursal=h.sucursal AND btrim(v.c2)=btrim(h.c12)
      WHERE btrim(h.c1)=btrim(h.sucursal) AND h.sucursal=m.source_branch AND h.c2=m.genero AND h.c3=m.naturaleza
        AND h.c4::text=m.doc_type AND h.c6=m.folio AND btrim(l.c8)=btrim(coalesce(p.sku,m.sku)) LIMIT 1)`;

  /**
   * [WMS-BI.4.2] ⚠️ **La misma regla estaba escrita DOS veces**: en TypeScript para la pestaña
   * Movimientos y otra vez, a mano, en el `CASE` de SQL de "Explorar datos". Así que los mismos
   * 3.36M de movimientos de Wincaja salían mal clasificados en las DOS pestañas, y arreglar una
   * habría dejado la otra mintiendo — con la agravante de que el `CASE` de SQL también terminaba
   * en `ELSE 'Comercial'`, el mismo default silencioso.
   *
   * Ahora las dos listas se DERIVAN de `DOC_CATALOG`: una sola definición, dos consumidores.
   * Agregar un `doc_code` es tocar un solo lugar (ADR-056: el primitivo vive en un lado).
   */
  private static docsSql(pred: (v: { op: BiTipoOperacion; venta: boolean }) => boolean): string {
    const codes = Object.entries(CommercialBiAlmacenService.DOC_CATALOG)
      .filter(([, v]) => pred(v)).map(([k]) => `'${k}'`);
    // ARRAY[] vacío no tipa en Postgres; con un centinela imposible el predicado da false y punto.
    return codes.length ? codes.join(',') : `'__ninguno__'`;
  }
  private static readonly SALE_DOC_CODES_SQL_LIST = CommercialBiAlmacenService.docsSql((v) => v.venta);
  private static readonly TRANSFER_DOC_CODES_SQL_LIST = CommercialBiAlmacenService.docsSql((v) => v.op === 'Traspasos internos');
  private static readonly ADJUSTMENT_DOC_CODES_SQL_LIST = CommercialBiAlmacenService.docsSql((v) => v.op === 'Ajuste de inventario');
  private static readonly COMERCIAL_DOC_CODES_SQL_LIST = CommercialBiAlmacenService.docsSql((v) => v.op === 'Comercial');

  private readonly EXPLORE_FIELDS: Array<{ key: string; label: string; group: string; sql: string; requires?: string; numeric?: true }> = [
    { key: 'doc_date', label: 'Fecha', group: 'Fechas y documentos', sql: `m.doc_date::text` },
    { key: 'hora', label: 'Hora', group: 'Fechas y documentos', sql: `btrim(${CommercialBiAlmacenService.KDM_SUBQ('h.c69')})` },
    { key: 'folio', label: 'Folio', group: 'Fechas y documentos', sql: `m.folio` },
    { key: 'doc_code', label: 'Documento (código)', group: 'Fechas y documentos', sql: `m.doc_code` },
    { key: 'movement_label', label: 'Documento', group: 'Fechas y documentos', sql: `m.movement_label` },
    { key: 'movement_kind_label', label: 'Tipo (entrada/salida)', group: 'Fechas y documentos', sql: `CASE m.movement_kind WHEN 'entrada' THEN 'Entrada' WHEN 'salida' THEN 'Salida' ELSE 'Informativo' END` },
    {
      key: 'tipo_operacion', label: 'Tipo de operación', group: 'Fechas y documentos',
      // Sin `ELSE 'Comercial'`: un doc_code desconocido se DECLARA, igual que en la pestaña
      // Movimientos. El default silencioso es lo que hizo que 163,109 ajustes de Wincaja se
      // publicaran como operación comercial sin que nada lo dijera.
      sql: `CASE WHEN m.doc_code = ANY(ARRAY[${CommercialBiAlmacenService.TRANSFER_DOC_CODES_SQL_LIST}]) THEN 'Traspasos internos'
                 WHEN m.doc_code = ANY(ARRAY[${CommercialBiAlmacenService.ADJUSTMENT_DOC_CODES_SQL_LIST}]) THEN 'Ajuste de inventario'
                 WHEN m.doc_code = ANY(ARRAY[${CommercialBiAlmacenService.COMERCIAL_DOC_CODES_SQL_LIST}]) THEN 'Comercial'
                 ELSE 'Sin clasificar' END`,
    },
    {
      key: 'vendedor', label: 'Vendedor', group: 'Fechas y documentos',
      sql: `CASE WHEN m.doc_code = ANY(ARRAY[${CommercialBiAlmacenService.SALE_DOC_CODES_SQL_LIST}]) THEN ${CommercialBiAlmacenService.KDM_SUBQ_VENDEDOR} ELSE NULL END`,
    },
    { key: 'source_branch', label: 'Sucursal origen (Kepler)', group: 'Fechas y documentos', sql: `m.source_branch` },
    { key: 'zone_name', label: 'Zona', group: 'Organización y almacenes', sql: `z.name` },
    { key: 'warehouse_code', label: 'Sucursal (código)', group: 'Organización y almacenes', sql: `w.code` },
    { key: 'warehouse_name', label: 'Sucursal (nombre)', group: 'Organización y almacenes', sql: `w.name` },
    { key: 'almacen', label: 'Almacén (disponible/dañado/caduco)', group: 'Organización y almacenes', sql: `'Disponible'` },
    {
      key: 'canal', label: 'Canal (Punto de Venta/Mayoreo/Detalle)', group: 'Organización y almacenes',
      sql: `CASE WHEN m.doc_code = ANY(ARRAY[${CommercialBiAlmacenService.SALE_DOC_CODES_SQL_LIST}]) THEN ${CommercialBiAlmacenService.KDM_SUBQ_CANAL} ELSE NULL END`,
    },
    { key: 'sku', label: 'Código de producto', group: 'Productos', sql: `coalesce(p.sku, m.sku)` },
    { key: 'product_name', label: 'Nombre del producto', group: 'Productos', sql: `coalesce(p.nombre, '(sin catálogo)')` },
    { key: 'brand_name', label: 'Marca', group: 'Productos', sql: `b.nombre` },
    { key: 'linea_producto', label: 'Línea (fabricante)', group: 'Productos', sql: `nullif(btrim(lp.c2), '')` },
    { key: 'tipo_producto', label: 'Tipo de producto', group: 'Productos', sql: `nullif(btrim(tp.c2), '')` },
    { key: 'grupo_producto', label: 'Grupo de producto', group: 'Productos', sql: `nullif(btrim(gp.c2), '')` },
    { key: 'qty', label: 'Cantidad', group: 'Cantidades y conversiones', sql: `m.qty`, numeric: true },
    { key: 'signed_qty', label: 'Efecto en inventario (+entrada/−salida)', group: 'Cantidades y conversiones', sql: `m.signed_qty`, numeric: true },
    { key: 'unidad_operacion', label: 'Unidad de la operación', group: 'Cantidades y conversiones', sql: `btrim(${CommercialBiAlmacenService.KDM_SUBQ('l.c11')})` },
    { key: 'unidad_base', label: 'Unidad base', group: 'Cantidades y conversiones', sql: `ut.base_label` },
    { key: 'unit_cost', label: 'Costo del movimiento (histórico)', group: 'Costos', sql: `m.unit_cost`, numeric: true },
    { key: 'amount', label: 'Importe', group: 'Costos', sql: `m.amount`, numeric: true },
    { key: 'cost_base_hoy', label: 'Costo de catálogo (vigente hoy)', group: 'Costos', sql: `p.cost_base`, numeric: true },
    { key: 'iva_rate', label: 'Tasa de IVA del producto', group: 'Costos', sql: `p.iva_rate`, numeric: true },
    { key: 'ieps_rate', label: 'Tasa de IEPS del producto', group: 'Costos', sql: `p.ieps_rate`, numeric: true },
    { key: 'dest_label', label: 'Destino del traspaso', group: 'Datos comerciales', sql: `m.dest_label`, requires: 'COMMERCIAL_CUSTOMERS_VER' },
  ];

  /**
   * Lo que sigue sin poder calcularse SIN INVENTAR: la cantidad en unidad base y el desglose de
   * importe costo/venta/IVA/IEPS/venta neta dependen de un cruce por-instancia (kdm1/kdm2 +
   * `analytics.v_unit_truth`) que sí vive en `movements()`/`enrichFromKdm()` pero es demasiado
   * grande para expresarse como una columna suelta del picker libre de Explorar — quedan sólo en
   * la pestaña Movimientos. La desviación de costo POR LÍNEA (comparar el costo de ESE momento
   * contra un segundo costo capturado en ese mismo momento) no existe en ningún feed: el proyecto
   * prohíbe reconstruirla con el costo de catálogo de HOY (sería aplicar un factor actual a una
   * operación pasada). Esa desviación real se mide por SKU en el Resumen (catálogo vs. ERP).
   */
  private readonly UNAVAILABLE_FIELDS: BiField[] = [
    { key: 'cantidad_base', label: 'Cantidad en unidad base', group: 'Cantidades y conversiones', available: false, reason: 'Sólo en la pestaña Movimientos: requiere resolver el peldaño cobrado por línea, no expresable como columna suelta aquí.' },
    { key: 'importe_costo', label: 'Importe costo', group: 'Costos', available: false, reason: 'Sólo en la pestaña Movimientos (depende de clasificar cada documento como costo o venta).' },
    { key: 'importe_venta', label: 'Importe venta', group: 'Costos', available: false, reason: 'Mismo motivo que Importe costo.' },
    { key: 'iva_valor', label: 'IVA valor', group: 'Costos', available: false, reason: 'Sólo en la pestaña Movimientos (se deriva de Importe venta).' },
    { key: 'ieps_valor', label: 'IEPS valor', group: 'Costos', available: false, reason: 'Sólo en la pestaña Movimientos (se deriva de Importe venta).' },
    { key: 'venta_neta', label: 'Venta neta', group: 'Costos', available: false, reason: 'Sólo en la pestaña Movimientos (se deriva de Importe venta).' },
    { key: 'cost_deviation_line', label: 'Desviación de costo (por línea)', group: 'Costos', available: false, reason: 'No hay un segundo costo capturado AL MOMENTO del movimiento para comparar — comparar contra el costo de catálogo de HOY reconstruiría la operación con un factor actual, que el proyecto prohíbe. La desviación de costo real se mide por SKU en el Resumen (catálogo vs. ERP, ambos vigentes).' },
  ];

  async fields(permissions: Record<string, boolean> | undefined): Promise<BiField[]> {
    const real: BiField[] = this.EXPLORE_FIELDS.map((f) => ({
      key: f.key, label: f.label, group: f.group,
      available: !f.requires || permissions?.[f.requires] === true,
      reason: f.requires && permissions?.[f.requires] !== true ? 'No disponible para tu perfil.' : undefined,
    }));
    return [...real, ...this.UNAVAILABLE_FIELDS];
  }

  async explore(
    query: Record<string, unknown>,
    fieldsReq: string[],
    permissions: Record<string, boolean> | undefined,
  ): Promise<BiPage<Record<string, unknown>>> {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(query['page']) || 1);
    // Igual que movements(): el export trae todo en una llamada (ver nota de EXPORT_ROW_CAP).
    const cap = query['__export'] === true ? CommercialBiAlmacenService.EXPORT_ROW_CAP : 200;
    const pageSize = Math.min(cap, Math.max(1, Number(query['pageSize']) || 50));
    const from = this.dateOr(query['from'], this.daysAgo(30));
    const to = this.dateOr(query['to'], this.today());
    const resolved = this.resolveExploreFields(fieldsReq, permissions);
    const cols = resolved.map((f) => f.key);
    const fieldMap = new Map(this.EXPLORE_FIELDS.map((f) => [f.key, f]));

    return this.tk.run(async (trx) => {
      const ids = await this.resolveWarehouseIds(trx, tenantId, query);
      const unitRel = await this.unitTruthRel(trx);
      const base = () => trx('analytics.stock_movements as m')
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        .leftJoin('trade.zones as z', 'z.id', 'w.zone_id')
        .leftJoin('catalog.products as p', function (this: any) {
          this.on('p.id', 'm.product_id').andOn('p.tenant_id', 'm.tenant_id');
        })
        .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
        // Línea/tipo/grupo de producto: mismos joins verificados que en movements() — al grano
        // PRODUCTO (no por instancia de movimiento), así que no pesan como las subqueries de kdm1/kdm2.
        .leftJoin('kepler_ods.kdii as ii', function (this: any) {
          this.on(trx.raw('btrim(ii.c1)'), '=', trx.raw('btrim(coalesce(p.sku, m.sku))')).andOn('ii.sucursal', 'w.code');
        })
        .leftJoin('kepler_ods.kdie as tp', function (this: any) {
          this.on('tp.c1', '=', 'ii.c4').andOn('tp.sucursal', 'ii.sucursal');
        })
        .leftJoin('kepler_ods.kdif as gp', function (this: any) {
          this.on('gp.c1', '=', 'ii.c5').andOn('gp.sucursal', 'ii.sucursal');
        })
        .leftJoin('kepler_ods.kdig as lp', function (this: any) {
          this.on(trx.raw('btrim(lp.c1)'), '=', trx.raw('btrim(ii.c3::text)')).andOn('lp.sucursal', 'ii.sucursal');
        })
        .leftJoin(`${unitRel} as ut`, function (this: any) {
          this.on('ut.tenant_id', 'm.tenant_id').andOn('ut.warehouse_id', 'm.warehouse_id').andOn('ut.product_id', 'm.product_id');
        })
        .where('m.tenant_id', tenantId)
        .whereBetween('m.doc_date', [from, to])
        .modify((qb: any) => { if (ids !== null) qb.whereIn('m.warehouse_id', ids); });

      const [{ count }] = await base().count<{ count: string }[]>('m.folio as count');
      // `k` sólo puede venir del whitelist `EXPLORE_FIELDS` (filtrado arriba con `allowed`),
      // así que es seguro usarlo como identificador de columna sin bindear — no es input libre.
      const selectExprs = cols.map((k) => trx.raw(`${fieldMap.get(k)!.sql} AS "${k}"`));
      const rows = await base().select(selectExprs).orderBy('m.doc_date', 'desc').limit(pageSize).offset((page - 1) * pageSize);
      return { page, pageSize, total: Number(count), rows };
    });
  }

  /** El servidor NUNCA confía en la lista del cliente: se recorta contra el whitelist + el
   * permiso real de la sesión. Un campo restringido pedido a mano no llega ni deshabilitado.
   * Compartido por `explore()` y `exportExplore()` — un solo lugar decide qué campo es válido. */
  private resolveExploreFields(fieldsReq: string[], permissions: Record<string, boolean> | undefined) {
    const DEFAULTS = ['doc_date', 'warehouse_code', 'sku', 'product_name', 'signed_qty', 'amount'];
    const allowed = new Set(
      this.EXPLORE_FIELDS.filter((f) => !f.requires || permissions?.[f.requires] === true).map((f) => f.key),
    );
    const selected = (fieldsReq.length ? fieldsReq : DEFAULTS).filter((k) => allowed.has(k));
    const cols = selected.length ? selected : DEFAULTS;
    const fieldMap = new Map(this.EXPLORE_FIELDS.map((f) => [f.key, f]));
    return cols.map((k) => fieldMap.get(k)!);
  }

  /**
   * WMS-BI.5 (2026-09-15) — Exportar TODA la consulta filtrada, no sólo la página cargada en
   * el navegador (pedido explícito del usuario). Reusa `movements()`/`explore()` en un LOOP
   * paginado — mismo patrón ya establecido en el módulo hermano `commercial-movements`
   * (`CommercialMovementsService.exportData()`, tope 5,000/500×10) — así que hereda gratis
   * el alcance por almacén, los permisos de Explorar, y el enriquecimiento kdm1/kdm2 sin
   * duplicar una sola línea de esa lógica. Tope más alto que el hermano (100,000 filas,
   * 200×500) porque el destino ya no es Excel/CSV en pantalla sino también SQLite, que no
   * sufre el límite práctico de filas de una hoja de cálculo — igual se declara `truncated`
   * si el resultado real excede el tope, nunca se recorta en silencio.
   */
  private static readonly EXPORT_ROW_CAP = 100000; // tope de filas del export, en UNA sola query

  /** Columnas del export de Movimientos — TODAS las de `BiMovementRow` (no sólo las que el
   * usuario tiene visibles en pantalla en ese momento: el export es el volcado completo). */
  static readonly MOVEMENT_EXPORT_COLUMNS: Array<{ key: string; label: string; numeric?: true }> = [
    { key: 'doc_date', label: 'Fecha' }, { key: 'hora', label: 'Hora' }, { key: 'zone_name', label: 'Zona' },
    { key: 'warehouse_code', label: 'Sucursal' }, { key: 'warehouse_name', label: 'Sucursal (nombre)' },
    { key: 'almacen', label: 'Almacén' }, { key: 'canal', label: 'Canal' },
    { key: 'movement_kind', label: 'Tipo' }, { key: 'tipo_operacion', label: 'Tipo de operación' },
    { key: 'movement_label', label: 'Documento' }, { key: 'doc_code', label: 'Código doc.' }, { key: 'folio', label: 'Folio' },
    { key: 'vendedor', label: 'Vendedor' }, { key: 'sku', label: 'Código' }, { key: 'product_name', label: 'Producto' },
    { key: 'linea_producto', label: 'Línea' }, { key: 'tipo_producto', label: 'Tipo producto' }, { key: 'grupo_producto', label: 'Grupo' },
    { key: 'qty', label: 'Cantidad', numeric: true }, { key: 'unidad_operacion', label: 'Unidad operación' },
    { key: 'unidad_base', label: 'Unidad base' }, { key: 'cantidad_base', label: 'Cantidad en unidad base', numeric: true },
    { key: 'unidad_base_medible', label: 'Unidad base medible' },
    { key: 'signed_qty', label: 'Efecto en inventario', numeric: true }, { key: 'unit_cost', label: 'Costo del movimiento', numeric: true },
    { key: 'amount', label: 'Importe', numeric: true }, { key: 'importe_costo', label: 'Importe costo', numeric: true },
    { key: 'importe_venta', label: 'Importe venta', numeric: true }, { key: 'iva_valor', label: 'IVA valor', numeric: true },
    { key: 'ieps_valor', label: 'IEPS valor', numeric: true }, { key: 'venta_neta', label: 'Venta neta', numeric: true },
    { key: 'cost_base_hoy', label: 'Costo catálogo (hoy)', numeric: true }, { key: 'source_system', label: 'Sistema' },
  ];

  // UNA sola query (no un loop de ~500 páginas): pasa `__export` para que movements() suba el
  // clamp a EXPORT_ROW_CAP y traiga todo de un tiro. `truncated` avisa si se alcanzó el tope.
  async exportMovements(query: Record<string, unknown>): Promise<{ rows: BiMovementRow[]; total: number; truncated: boolean; from: string; to: string }> {
    const from = this.dateOr(query['from'], this.daysAgo(30));
    const to = this.dateOr(query['to'], this.today());
    const res = await this.movements({ ...query, page: 1, pageSize: CommercialBiAlmacenService.EXPORT_ROW_CAP, __export: true });
    return { rows: res.rows, total: res.total, truncated: res.total > res.rows.length, from, to };
  }

  async exportExplore(
    query: Record<string, unknown>, fieldsReq: string[], permissions: Record<string, boolean> | undefined,
  ): Promise<{
    rows: Array<Record<string, unknown>>; total: number; truncated: boolean;
    columns: Array<{ key: string; label: string; numeric?: true }>; from: string; to: string;
  }> {
    const from = this.dateOr(query['from'], this.daysAgo(30));
    const to = this.dateOr(query['to'], this.today());
    const columns = this.resolveExploreFields(fieldsReq, permissions).map((f) => ({ key: f.key, label: f.label, numeric: f.numeric }));
    const res = await this.explore({ ...query, page: 1, pageSize: CommercialBiAlmacenService.EXPORT_ROW_CAP, __export: true }, fieldsReq, permissions);
    return { rows: res.rows, total: res.total, truncated: res.total > res.rows.length, columns, from, to };
  }

  // ═══════════════════════════════════════════════════════════ helpers ════

  private today(): string { return new Date().toISOString().slice(0, 10); }
  private daysAgo(n: number): string { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
  private dateOr(v: unknown, fallback: string): string {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
  }
  private strOr(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null; }
  private uuidOr(v: unknown): string | null {
    return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
  }
}
