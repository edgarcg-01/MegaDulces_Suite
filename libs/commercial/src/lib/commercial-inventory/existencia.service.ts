import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { armarMatriz, ExistenciaCelda } from './existencia-agregado';

/**
 * EXISTENCIA — la matriz producto × almacén, derivada del ERP. Vive en DOS proyectos
 * (`/almacen/inventory/existencia` y `/compras/existencia`) con un solo permiso.
 *
 * POR QUÉ ES UN ARCHIVO APARTE y no un método de `commercial-inventory.service.ts`: ese servicio
 * ES el de la tabla transaccional `commercial.stock`. Esta pantalla lee a propósito OTRA fuente;
 * juntarlos invita a que alguien "unifique" los dos SELECT y devuelva la copia que miente.
 *
 * LA FUENTE — medido contra el POS en vivo (header de la mig 20260902170000, 22,090 SKUs):
 *
 *     commercial.stock            acierta  91.0%   (15,324 unidades de error)
 *     analytics.v_erp_stock_on_hand  "    100.0%   (3 unidades = ruido de timing)
 *
 * Ejemplo: SKU 88009 en almacén 01 → POS 2,485 · ODS 2,487 · tabla 3,547. La causa es que el
 * importer de la tabla es delta contra un snapshot en disco que se desincroniza y deja valores
 * fantasma para siempre. Por eso acá la VISTA MANDA y el fact sólo ENRIQUECE.
 *
 * ⛔ NO SE JOINEA `commercial.stock`. Ni por `reserved_quantity`: medido en prod, **1 fila de
 * 53,223 con 15 unidades apartadas** (almacén 02). Traer la tabla que miente para eso sería un
 * mal trato. La ausencia del apartado se DECLARA en la pantalla, no se disimula.
 *
 * ⭐ EL COSTO — KE.2 (2026-09-08): sale del MISMO ERP y del MISMO ALMACÉN que la cantidad.
 *
 * Hasta acá la existencia se valuaba con `COALESCE(p.cost_with_tax, p.cost_base, 0)`: un costo por
 * PRODUCTO, global, en la unidad en que el catálogo lo tenga. Kepler trae SU costo unitario por
 * **sucursal × SKU** (`kdik.c16`) — al mismo grano que la cantidad — y nadie lo usaba para esto.
 * Contrastados en prod sobre 16,391 filas comparables:
 *
 *     mediana cost_base     / kdik.c16 = 1.0000   pega ±2% en 11,877 (72.46%)
 *     mediana cost_with_tax / kdik.c16 = 1.0800   pega ±2% en  3,230 (19.71%)
 *
 * O sea `cost_base` ES el costo de Kepler, y esta pantalla publicaba **con impuesto**. Con la
 * mediana en 1.0000 exacto el agregado difería 13.2%, porque la discrepancia está CONCENTRADA:
 *
 *     el IMPUESTO, en las filas donde el costo YA coincide  $2,795,095   (razón 1.0983)
 *     el FACTOR DE CAJA, en 273 filas de granel            $2,025,427
 *     brecha total sobre $42.7M publicados                 $5,642,385   (13.21%)
 *
 * Las razones de esas 273 son 16.2 · 21.6 · 20.0 · 14.0 · 32.0 · 31.4 — factores, no precios. Y los
 * nombres cierran el caso: ROLLO GUAYABA CHICO GRANEL · CHOC HERSHEY BARRA GRANEL 14KG · TURIN
 * CONF SEMIAMARGO 16KG. `cost_base` viene por BULTO; `c16` por pieza o kilo (ADR-051, ADR-055).
 *
 * El costo se LEE de `analytics.v_kepler_unit_cost`, no se re-deriva acá: un primitivo con dos
 * implementaciones es un primitivo que va a divergir. Esa vista aplica el filtro que `kdik` exige
 * (3,667 de 31,084 filas son la RÉPLICA congelada de otra sucursal — probado por identidad
 * documental: 37,020 de 37,020 folios de suc03/almacén 02 existen idénticos en la sucursal 02, y
 * publicarlos sería doble conteo de 78,633 unidades). El veredicto por fila vive en
 * `analytics.v_erp_stock_truth`.
 *
 * ⭐⭐ KX (2026-09-09) — DOS COSAS QUE ESTA PANTALLA AHORA DECLARA, y antes daba por sentadas:
 *
 *  1. **El costo del ERP es un PROMEDIO PONDERADO HISTÓRICO, no el costo de hoy.** `kdik.c16` es
 *     `c8/c5`, y `c5` resultó ser las ENTRADAS ACUMULADAS: idéntico a `SUM(kdil.c8)` en **25,143
 *     de 25,143 pares (100.00%)**. O sea divide el valor acumulado de toda la historia de compras
 *     entre sus unidades. Contra el último costo conocido (`c18`) la mediana de `c16/c18` es
 *     **0.9805**: el inventario se valúa **~2% por debajo del costo de reposición**, de forma
 *     sistemática, y `c18` falta en el 56% de los pares. Valuar a promedio ponderado es legítimo;
 *     dejar que se lea como costo de reposición no. Por eso la respuesta trae `metodo_valuacion`.
 *  2. **El catálogo tiene 62 SKUs con sus dos columnas de costo en unidades distintas**, y al
 *     revés de lo que dicen sus nombres: `cost_with_tax < cost_base`, que ningún impuesto puede
 *     producir. Contra Kepler, en las 101 filas con existencia, `cost_with_tax / c16` pega en 60
 *     con mediana **1.000** y `cost_base / c16` en 21 con mediana **10.872** — `cost_base` trae el
 *     BULTO (`TURIN CONF BLANCO 16KG` $5,002.56 vs $152.11). El fallback va blindado con un LEAST
 *     y lo cuenta en `celdas_costo_invertido`. Hoy da 0 porque las 101 tienen costo del ERP: es
 *     una compuerta para el día que Kepler deje de traer una y se valúe ~10.9× arriba.
 *
 * ⚠️ WINCAJA NO CAMBIA — decisión explícita de Edgar ("solo hay que enfocarnos en kepler"). Sus
 * celdas siguen con `COALESCE(cost_with_tax, cost_base)`. Por eso las dos mitades del inventario
 * se valúan con criterios distintos HOY, y `celdas_sin_costo_erp` lo declara en vez de callarlo.
 *
 * ⚠️ EL COSTO DE ESTA CONSULTA YA SE PAGÓ UNA VEZ. El primer prototipo dio 4,435 ms; los joins
 * no eran el problema (332 ms los cuatro) sino el pivot `jsonb` sobre los 9,860 productos. La
 * receta que la baja a ~800 ms, y hay que respetarla:
 *
 *   1. UNA sola CTE MATERIALIZED con la vista + los joins (una pasada).
 *   2. Agregado por producto SIN jsonb + totales por window.
 *   3. El LIMIT de la página.
 *   4. El pivot AL FINAL, sólo sobre los productos de la página.
 *
 * Invertir 3 y 4 devuelve los 4.4 s.
 *
 * ⭐ [EX-PERF.3] Desde 2026-10-12 los pasos 2-4 ya no van en SQL: la consulta arma una FOTO de las
 * celdas una vez por minuto y el agregado/orden/página corre en memoria (existencia-agregado.ts).
 * La receta de arriba sigue explicando por qué el agregado no puede pedirse por página a la base.
 *
 * ⚠️ SIN BACKTICKS DENTRO DE LOS COMENTARIOS SQL de este archivo: van dentro de template literals
 * de JS y rompen el build (pasó 4 veces esta semana).
 */

export interface ExistenciaQuery {
  warehouse_ids?: string;  // CSV de códigos de almacén — recorta el ANCHO del pivot
  supplier_id?: string;
  brand_id?: string;
  category_id?: string;
  search?: string;
  bucket?: string;         // agotado | bajo_minimo | bajo_reorden | sano | sobrestock
  only_unverified?: string; // '1' → sólo los que no se pueden convertir a cajas
  hide_zero?: string;      // '1' → esconde los que no tienen existencia en ningún almacén
  sort_by?: string;
  sort_dir?: string;
  page?: number;
  pageSize?: number;
  export?: boolean;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ExistenciaService {
  private readonly logger = new Logger(ExistenciaService.name);

  /**
   * Memo corto de lo que NO cambia entre teclazos. Medido: la consulta principal es 1,596 ms
   * warm (piso 717 ms = la vista viva + 4 joins sobre 52,340 filas), y encima iban en serie el
   * catálogo de almacenes y las dos lecturas de frescura. El catálogo de almacenes casi nunca
   * cambia y la frescura se mueve cada varios minutos, así que sacarlas del camino caliente es
   * gratis: filtrar y paginar ya no las vuelve a pagar.
   *
   * No se puede paralelizar dentro de `tk.run()`: una transacción de knex es UNA conexión y las
   * consultas se serializan igual.
   */
  private memo = new Map<string, { at: number; v: any }>();
  private async memoized<Tv>(key: string, ttlMs: number, fn: () => Promise<Tv>): Promise<Tv> {
    const hit = this.memo.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.v as Tv;
    const v = await fn();
    this.memo.set(key, { at: Date.now(), v });
    return v;
  }

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * `[EX-PERF.3]` La FOTO de las celdas (producto × almacén) del tenant, ya unidas con su factor,
   * su costo, su veredicto y su política. Es el CTE `src` de siempre, SIN los filtros de la
   * pantalla: los filtros, el agregado, el orden y la página se resuelven en memoria
   * (`existencia-agregado.ts`).
   *
   * Por qué: la consulta completa costaba 1.1–1.3 s en prod POR LLAMADA (medido 2026-10-12), y la
   * pantalla la pagaba en cada teclazo, cada filtro y cada página. El piso es armar el join de
   * ~30,600 celdas, no el plan — forzar hash joins sólo ganaba ~10 %. Armado una vez por minuto,
   * cada interacción baja a milisegundos.
   *
   * Política de frescura (stale-while-revalidate, una sola recarga a la vez por tenant):
   *   - foto de menos de FOTO_RECARGAR_MS → se sirve tal cual;
   *   - entre eso y FOTO_VENCE_MS → se sirve y se recarga en segundo plano;
   *   - más vieja, o no hay → se espera la recarga.
   * ⛔ La edad de la foto se DECLARA en `freshness` (rama `foto`): la existencia es volátil y una
   * tabla calculada hace un minuto no puede rotularse como si fuera de este segundo.
   */
  private static readonly FOTO_RECARGAR_MS = 45_000;
  private static readonly FOTO_VENCE_MS = 5 * 60_000;
  private fotos = new Map<string, { at: number; celdas: ExistenciaCelda[]; auxListo: boolean }>();
  private recargas = new Map<string, Promise<{ at: number; celdas: ExistenciaCelda[]; auxListo: boolean }>>();

  private async foto(tenantId: string) {
    const f = this.fotos.get(tenantId);
    const edad = f ? Date.now() - f.at : Infinity;
    if (f && edad < ExistenciaService.FOTO_RECARGAR_MS) return f;
    if (f && edad < ExistenciaService.FOTO_VENCE_MS) {
      // Se sirve la que hay y se recarga detrás. Un error en segundo plano NO tumba la pantalla:
      // la foto vieja sigue declarando su edad, y vencida se vuelve a intentar en primer plano.
      this.recargar(tenantId).catch((e) => this.logger.warn(`recarga de la foto de existencia falló: ${e.message}`));
      return f;
    }
    return this.recargar(tenantId);
  }

  private recargar(tenantId: string) {
    const enCurso = this.recargas.get(tenantId);
    if (enCurso) return enCurso;
    const p = this.armarFoto(tenantId)
      .then((v) => { this.fotos.set(tenantId, v); return v; })
      .finally(() => this.recargas.delete(tenantId));
    this.recargas.set(tenantId, p);
    return p;
  }

  private async armarFoto(tenantId: string) {
    const t0 = Date.now();
    // El divisor de presentación y el veredicto de unidad.
    // `display_bf` viene del fact (donde el nocturno ya lo resolvió leyendo el resolvedor
    // canónico); `vbf.box_factor` es el respaldo para las filas que están en la vista viva pero
    // todavía no en el fact — un SKU que apareció HOY se muestra igual.
    const DBF = 'GREATEST(COALESCE(rp.display_bf, vbf.box_factor, 1), 1)';

    // El bucket se compara contra la cantidad NATIVA a propósito: los umbrales de
    // `commercial.reorder_policy` se derivan de la misma vista de existencia SIN convertir, así
    // que viven en la unidad nativa del almacén. Convertir un lado solo los descuadraría.
    const BUCKET = `CASE
        WHEN pol.product_id IS NULL              THEN NULL
        WHEN s.qty_stock_units <= 0              THEN 'agotado'
        WHEN s.qty_stock_units <= pol.min_stock  THEN 'bajo_minimo'
        WHEN s.qty_stock_units <= pol.reorder_point THEN 'bajo_reorden'
        WHEN pol.max_stock > 0 AND s.qty_stock_units > pol.max_stock THEN 'sobrestock'
        ELSE 'sano' END`;

    return this.tk.run(tenantId, async (trx) => {
      // ⭐ [EX-PERF.2] Las dos vistas más caras del join, leídas de su copia materializada.
      //
      // Medido contra prod: de las 939,977 páginas que costaba devolver 50 filas,
      // `v_warehouse_box_factor` aportaba 194,173 y `v_kepler_unit_cost` 87,557 — se calculaban
      // ENTERAS en cada carga sólo para armar el hash del join. Con las dos materializadas, la
      // consulta real bajó de **4,910 a 1,353 ms (3.6x)**.
      //
      // Se pregunta si EXISTEN en vez de asumirlo por la fecha de la migración: el código y el
      // DDL viajan por caminos distintos y llegan desordenados.
      //
      // ⛔ Que existan NO se confunde con que estén frescos: la edad la declara `freshness()`.
      const ax = await trx.raw(`SELECT to_regclass('analytics.mv_warehouse_box_factor') AS a,
                                       to_regclass('analytics.mv_kepler_unit_cost')     AS b`);
      const auxListo = !!(ax.rows?.[0]?.a && ax.rows?.[0]?.b);   // o las DOS, o ninguna
      const FUENTE_VBF = auxListo ? 'analytics.mv_warehouse_box_factor' : 'analytics.v_warehouse_box_factor';
      const FUENTE_KC = auxListo ? 'analytics.mv_kepler_unit_cost' : 'analytics.v_kepler_unit_cost';

      // Los ALIAS se PLIEGAN, no se excluyen. El workbook de compras los excluye y ahí es
      // correcto ("qué comprar"), pero acá sería falso: un alias es mercancía en un anaquel.
      //
      // [EX.U2] El PAQUETE sale de la ficha de Kepler de ESE almacén (`v_kepler_unit_ladder`:
      // `c80`/`c81` = rótulo y unidades base del peldaño 2). Sólo se toma cuando de verdad es un
      // peldaño INTERMEDIO: más de 1 unidad base y menos que la caja que ya divide la cantidad.
      // Si no, la celda se desglosa en cajas + unidad base, sin paquete inventado.
      const sql = `
        SELECT COALESCE(pa.canonical_product_id, s.product_id) AS product_id,
               s.warehouse_code,
               s.qty_stock_units::float8 AS nat,
               ${DBF}::float8 AS dbf,
               vbf.base_label,
               COALESCE(vbf.factor_source, 'none') AS factor_source,
               COALESCE(vbf.is_weight, false)      AS is_weight,
               rp.rung_veredicto, rp.rung_arbitrado::float8 AS rung_arbitrado,
               ${BUCKET} AS bucket,
               p.sku, p.nombre, p.supplier_id, p.brand_id, p.category_id,
               -- KE.2 — el costo sale del MISMO ERP y del MISMO almacen que la cantidad.
               -- KX — el fallback del catalogo va BLINDADO (ver la nota EL COSTO arriba).
               COALESCE(kc.costo_unitario,
                        CASE WHEN s.source = 'kepler_ods'
                             THEN CASE WHEN COALESCE(p.cost_with_tax, 0) > 0
                                        AND p.cost_with_tax < p.cost_base
                                       THEN p.cost_with_tax ELSE p.cost_base END
                             ELSE COALESCE(p.cost_with_tax, p.cost_base) END, 0)::float8 AS cu,
               CASE WHEN kc.costo_unitario IS NOT NULL      THEN 'erp'
                    WHEN s.source = 'kepler_ods'
                     AND COALESCE(p.cost_with_tax, 0) > 0
                     AND p.cost_with_tax < p.cost_base      THEN 'catalogo_columnas_invertidas'
                    WHEN s.source = 'kepler_ods'            THEN 'catalogo_neto'
                    ELSE                                         'catalogo' END AS cu_source,
               CASE WHEN lad.f2_cap > 1 AND lad.f2_cap < ${DBF}
                     AND lad.u2_label IS DISTINCT FROM lad.u1_label
                    THEN lad.f2_cap::float8 END AS pf,
               CASE WHEN lad.f2_cap > 1 AND lad.f2_cap < ${DBF}
                     AND lad.u2_label IS DISTINCT FROM lad.u1_label
                    THEN lad.u2_label END AS pu
          FROM analytics.v_erp_stock_on_hand s
          JOIN catalog.products p
               ON p.tenant_id = s.tenant_id AND p.id = s.product_id
          LEFT JOIN commercial.product_aliases pa
               ON pa.tenant_id = s.tenant_id AND pa.alias_product_id = s.product_id
              AND pa.deleted_at IS NULL
          LEFT JOIN analytics.replenishment_plan rp
               ON rp.tenant_id = s.tenant_id AND rp.warehouse_id = s.warehouse_id
              AND rp.product_id = s.product_id
          LEFT JOIN ${FUENTE_VBF} vbf
               ON vbf.tenant_id = s.tenant_id AND vbf.warehouse_id = s.warehouse_id
              AND vbf.product_id = s.product_id
          LEFT JOIN commercial.reorder_policy pol
               ON pol.tenant_id = s.tenant_id AND pol.warehouse_id = s.warehouse_id
              AND pol.product_id = s.product_id
          -- KE.2 — se une por s.product_id (el CRUDO), NO por el canonico del alias.
          LEFT JOIN ${FUENTE_KC} kc
               ON kc.tenant_id = s.tenant_id AND kc.warehouse_id = s.warehouse_id
              AND kc.product_id = s.product_id
          LEFT JOIN commercial.warehouses w
               ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
          LEFT JOIN analytics.v_kepler_unit_ladder lad
               ON s.source = 'kepler_ods' AND lad.sucursal = w.kepler_code AND lad.sku = s.sku
         WHERE s.tenant_id = :t AND p.activo = true AND p.deleted_at IS NULL`;

      // ⭐ [EX-PERF.1] JIT apagado: compilaba 821 funciones para una consulta de lectura
      // (medido 5,812 → 4,757 ms). Mismo remedio que `[RA-PERF]`.
      await trx.raw('SET LOCAL jit = off');
      const celdas: ExistenciaCelda[] = (await trx.raw(sql, { t: tenantId })).rows.map((r: any) => ({
        ...r,
        nat: Number(r.nat) || 0,
        dbf: Number(r.dbf) || 1,
        cu: Number(r.cu) || 0,
        rung_arbitrado: r.rung_arbitrado == null ? null : Number(r.rung_arbitrado),
        pf: r.pf == null ? null : Number(r.pf),
        sku: r.sku ?? '',
        nombre: r.nombre ?? '',
      }));
      this.logger.log(`foto de existencia: ${celdas.length} celdas en ${Date.now() - t0} ms`);
      return { at: Date.now(), celdas, auxListo };
    });
  }

  async list(q: ExistenciaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const cap = q.export ? 100000 : 500;
    const pageSize = Math.min(cap, Math.max(1, Number(q.pageSize) || (q.export ? cap : 50)));
    const codes = (q.warehouse_ids || '').split(',').map((c) => c.trim()).filter(Boolean);

    const foto = await this.foto(tenantId);
    // Los filtros van sobre el dataset COMPLETO, antes de paginar: si no, los totales mienten
    // (un footer que suma 50 de 9,860 no es un total).
    const m = armarMatriz(foto.celdas, {
      supplier_id: q.supplier_id && UUID_RX.test(q.supplier_id) ? q.supplier_id : undefined,
      brand_id: q.brand_id && UUID_RX.test(q.brand_id) ? q.brand_id : undefined,
      category_id: q.category_id && UUID_RX.test(q.category_id) ? q.category_id : undefined,
      search: q.search,
      codes,
      bucket: q.bucket,
      only_unverified: q.only_unverified === '1',
      hide_zero: q.hide_zero === '1',
      sort_by: q.sort_by, sort_dir: q.sort_dir,
      page, pageSize,
    });
    const totWh = m.totals.per_warehouse;

    return this.tk.run(async (trx) => ({
      rows: m.rows,
      columns: await this.memoized(`cols:${tenantId}`, 60_000,
        () => this.columns(trx, tenantId, [], totWh.map((w) => w.code)))
        .then((all: any[]) => (codes.length ? all.filter((r) => codes.includes(r.code)) : all)),
      totals: {
        ...m.totals,
        // KX — el METODO con el que se valuo, dicho en vez de supuesto. El costo del ERP
        // (kdik.c16 = c8/c5) es un PROMEDIO PONDERADO HISTORICO: contra el ultimo costo conocido
        // (c18) la mediana es 0.9805, o sea ~2% por debajo del costo de reposicion.
        metodo_valuacion: 'erp_promedio_ponderado_historico',
      },
      // [EX-PERF.2] auxListo entra en la LLAVE del memo: un cache que devuelve la procedencia de
      // la otra ruta es peor que no tenerlo.
      freshness: [
        ...(await this.memoized(`fresh:${tenantId}:${foto.auxListo ? 'mv' : 'vivo'}`, 30_000,
          () => this.freshness(trx, tenantId, foto.auxListo))),
        // [EX-PERF.3] el tramo nuevo: la tabla se calcula sobre una foto de hasta un minuto.
        { rama: 'foto', label: 'Tabla calculada', dato_al: new Date(foto.at).toISOString(),
          minutos: Math.round((Date.now() - foto.at) / 6000) / 10 },
      ],
      page, pageSize, total: m.total,
    }));
  }

  /**
   * Las columnas del pivot son DINÁMICAS: salen del catálogo de almacenes, nunca de una lista
   * hardcodeada. Si mañana entra una sucursal, la columna aparece sola.
   *
   * El ORDEN también sale de la tabla (`display_order`, mig 20260907210000) y no de un array acá:
   * es un atributo del almacén y lo tienen que ver todos los consumidores igual. Ordenar por
   * `code` ponía el CEDIS primero y separaba las dos Morelia del resto por venir con prefijo
   * `MD-` — un artefacto de cómo se codificó la fuente, no de cómo se opera la red.
   * `NULLS LAST`: un almacén sin orden asignado (las RUTA-*, o uno nuevo) va al final.
   */
  private async columns(trx: any, tenantId: string, codes: string[], present: string[]) {
    // ⚠️ SIN el EXISTS sobre la vista: costaba 335 ms contra 79 ms. Las columnas que de verdad
    // tienen dato ya vienen en `totals.per_warehouse` (salen de la misma pasada), así que el
    // filtrado se hace acá en memoria sobre una tabla de 22 filas.
    const rows = (await trx.raw(`
      SELECT w.code, w.name, COALESCE(w.short_label, w.code) AS label,
             w.source_warehouse_id IS NULL AS es_hub
        FROM commercial.warehouses w
       WHERE w.tenant_id = ? AND w.deleted_at IS NULL
       ORDER BY w.display_order NULLS LAST, w.code`, [tenantId])).rows;
    const conDato = new Set(present);
    return rows.filter((r: any) => conDato.has(r.code) && (!codes.length || codes.includes(r.code)));
  }

  /**
   * FRESCURA POR RAMA, no una sola cifra. Las dos ramas del ODS se mueven a ritmos distintos y
   * promediarlas mentiría sobre las dos.
   *
   * ⚠️ Medido 2026-09-04, y contradice lo que dice el header de la mig 20260902170000
   * ("Kepler fresco por CDC, ~min"): `kdil` estaba **13 h** atrás y Wincaja **6 h**. Los 7
   * carriles cdc_wal_* estaban en `error` con slot LOST desde el 2-sep y `kdil` viaja por el
   * carril hash. O sea: Wincaja estaba MÁS FRESCA que Kepler. Por eso la pantalla no promete
   * "en vivo" — publica la edad real de cada rama y deja que el operador juzgue.
   *
   * Kepler sale del resolvedor canónico (`analytics.v_feed_freshness`, origen `ods_table`).
   * Wincaja NO está ahí (hueco declarado: ningún sensor mide `wincaja.v_stock`, sólo la venta),
   * así que su edad se lee del propio dato — `imported_at` — hasta que tenga sensor.
   */
  private async freshness(trx: any, tenantId: string, auxListo = false) {
    const out: any[] = [];
    // [EX-PERF.2] EL TRAMO NUEVO, y es el que hay que declarar.
    //
    // Desde que el factor de caja y el costo del ERP salen de una copia materializada, la
    // cadena tiene un eslabon mas: por fresco que este Kepler, la CANTIDAD se convierte a cajas
    // con un factor de hace hasta 5 minutos y se valua con un costo de hace hasta 5 minutos.
    // Sin este renglon la pantalla seguiria rotulando solo "Kepler hace 2 min" -- el carril
    // fresco prestandole su pulso al que quiza se congelo.
    //
    // Es lo mismo que [CXC.20] tuvo que arreglar en la cartera, y lo que la Fase VP midio: la
    // frescura llegaba a 4 de 171 endpoints. Una cadena es tan fresca como su PEOR tramo.
    if (auxListo) {
      try {
        const f = (await trx.raw(`
          SELECT max(finished_at) AS dato_al,
                 round(EXTRACT(epoch FROM now() - max(finished_at)) / 60.0, 1) AS minutos
            FROM analytics.cron_run_log
           WHERE job_key = 'mv_existencia_aux_refresh' AND status = 'ok'`)).rows[0];
        // Sin latido NO se calla: se declara desconocido. Un null silencioso se lee igual que
        // "recien refrescado", que es la lectura opuesta a la verdadera.
        out.push(f && f.dato_al
          ? { rama: 'factor_costo', label: 'Factor de caja y costo', dato_al: f.dato_al, minutos: Number(f.minutos) }
          : { rama: 'factor_costo', label: 'Factor de caja y costo', dato_al: null, minutos: null, nota: 'sin latido del refresco' });
      } catch (e: any) {
        this.logger.warn(`edad del factor/costo no disponible: ${e.message}`);
        out.push({ rama: 'factor_costo', label: 'Factor de caja y costo', dato_al: null, minutos: null, nota: 'no medida' });
      }
    }
    try {
      const k = (await trx.raw(`
        SELECT dato_al, round(edad_seg / 60.0, 1) AS minutos
          FROM analytics.v_feed_freshness
         WHERE (tenant_id = ? OR tenant_id IS NULL) AND feed = 'kdil' LIMIT 1`, [tenantId])).rows[0];
      if (k) out.push({ rama: 'kepler', label: 'Kepler 01-06', dato_al: k.dato_al, minutos: Number(k.minutos) });
    } catch (e: any) {
      this.logger.warn(`frescura Kepler no disponible: ${e.message}`);
    }
    try {
      // Las ramas NO van hardcodeadas: se derivan de las que siguen alimentándose de un `.mdb`
      // vivo. Estaba fijo en ('00','30','32') y desde que Abastos migró a Kepler (2026-09-18) y
      // se fusionó su almacén (09-21), medir la '30' era medir un archivo que ya nadie escribe:
      // la etiqueta decía "Wincaja" y el minutero contaba una rama muerta, o sea una frescura
      // que no es la de nadie. Mismo criterio que el sensor `wincaja_existencias_entrega`.
      const w = (await trx.raw(`
        SELECT max(e.imported_at) AS dato_al,
               round(EXTRACT(epoch FROM now() - max(e.imported_at)) / 60.0, 1) AS minutos,
               string_agg(DISTINCT e.source_branch, ' / ' ORDER BY e.source_branch) AS ramas
          FROM wincaja.existencias e
          JOIN wincaja.branches b ON b.source_branch = e.source_branch
         WHERE e.tenant_id = ? AND e.source_dataset = 'actual'
           AND b.status = 'live_on_wincaja'`, [tenantId])).rows[0];
      if (w && w.dato_al) out.push({ rama: 'wincaja', label: `Wincaja ${w.ramas || '—'}`, dato_al: w.dato_al, minutos: Number(w.minutos) });
    } catch (e: any) {
      this.logger.warn(`frescura Wincaja no disponible: ${e.message}`);
    }
    return out;
  }

  /** Drill de un SKU: el desglose por almacén con la escalera de unidad y su procedencia. */
  /**
   * `[EX.7]` Los proveedores que alimentan el buscador de la pantalla.
   *
   * Sólo los que tienen al menos un producto ACTIVO: en prod son **375 de 1,321**, y ofrecer los
   * 946 restantes es ruido que no puede dar resultado. Viene con su conteo de SKUs para que el
   * selector pueda ordenarlos o mostrarlos, y porque un proveedor con 1 SKU y uno con 400 no se
   * eligen igual.
   *
   * ⚠️ **La cobertura se declara, no se esconde:** `sin_proveedor` dice cuántos productos activos
   * NO tienen proveedor asignado — medido el 2026-10-08, **1,617 de 11,090 (14.6 %)**. Son los que
   * desaparecen de la tabla en cuanto alguien filtra por proveedor, y la pantalla tiene que poder
   * decirlo. Sin este número, filtrar se lee como "esto es todo lo que hay de ese proveedor"
   * cuando en realidad también se fue lo que nadie clasificó.
   *
   * Medido contra prod: 18 ms.
   */
  async filtros() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const suppliers = (await trx.raw(
        `SELECT s.id, s.name, count(DISTINCT p.id)::int AS skus
           FROM catalog.suppliers s
           JOIN catalog.products p ON p.tenant_id = s.tenant_id AND p.supplier_id = s.id AND p.activo = true
          WHERE s.tenant_id = ? AND s.deleted_at IS NULL
          GROUP BY s.id, s.name
          ORDER BY s.name`, [tenantId])).rows;
      const cob = (await trx.raw(
        `SELECT count(*) FILTER (WHERE supplier_id IS NULL)::int AS sin_proveedor,
                count(*)::int                                   AS activos
           FROM catalog.products WHERE tenant_id = ? AND activo = true`, [tenantId])).rows[0];
      return {
        suppliers,
        sin_proveedor: Number(cob?.sin_proveedor || 0),
        productos_activos: Number(cob?.activos || 0),
      };
    });
  }

  async detail(productId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(productId)) return { product: null, rows: [] };
    return this.tk.run(async (trx) => {
      const product = (await trx.raw(
        `SELECT id, sku, nombre, cost_with_tax, cost_base FROM catalog.products
          WHERE tenant_id = ? AND id = ?`, [tenantId, productId])).rows[0] || null;
      const rows = (await trx.raw(`
        SELECT w.code AS warehouse_code, w.name AS warehouse_name,
               round(s.qty_stock_units::numeric, 2)                    AS nat,
               vbf.base_label, vbf.box_label, vbf.erp, vbf.factor_source, vbf.is_weight,
               round(GREATEST(COALESCE(rp.display_bf, vbf.box_factor, 1), 1)::numeric, 4) AS dbf,
               round(rp.rung_bf_esperado::numeric, 4)                  AS dbf_esperado,
               rp.rung_veredicto,
               round(rp.rung_arbitrado::numeric, 2)                    AS arbitrado,
               round(rp.caja_cost::numeric, 2)                         AS caja_cost,
               pol.min_stock, pol.reorder_point, pol.max_stock, pol.safety_stock, pol.xyz_class
          FROM analytics.v_erp_stock_on_hand s
          JOIN commercial.warehouses w ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
          -- [EX-PERF.2] Acá se lee la VISTA VIVA a propósito, no el materializado: esto es el
          -- detalle de UN producto, así que el join no pesa (la pantalla lo paga sobre 39 mil
          -- filas; esto sobre ~9) y a cambio el detalle sale siempre fresco. La regla es
          -- materializar donde DUELE, no en todos lados por simetría.
          LEFT JOIN analytics.v_warehouse_box_factor vbf
                 ON vbf.tenant_id = s.tenant_id AND vbf.warehouse_id = s.warehouse_id
                AND vbf.product_id = s.product_id
          LEFT JOIN analytics.replenishment_plan rp
                 ON rp.tenant_id = s.tenant_id AND rp.warehouse_id = s.warehouse_id
                AND rp.product_id = s.product_id
          LEFT JOIN commercial.reorder_policy pol
                 ON pol.tenant_id = s.tenant_id AND pol.warehouse_id = s.warehouse_id
                AND pol.product_id = s.product_id
         WHERE s.tenant_id = ? AND s.product_id = ?
         ORDER BY w.display_order NULLS LAST, w.code`, [tenantId, productId])).rows;
      return { product, rows };
    });
  }
}
