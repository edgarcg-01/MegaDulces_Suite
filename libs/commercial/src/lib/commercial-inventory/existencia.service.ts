import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

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

  /** Whitelist de orden. NUNCA se interpola el input del usuario: sólo la llave decide. */
  private sortExpr(key?: string): string {
    const map: Record<string, string> = {
      valor: 'valor',
      sku: 'sku',
      nombre: 'nombre',
      existencia: 'total_cajas',
      almacenes: 'n_almacenes',
      sin_valuar: 'sin_valuar',
    };
    return map[key || ''] || 'valor';
  }

  async list(q: ExistenciaQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const cap = q.export ? 100000 : 500;
    const pageSize = Math.min(cap, Math.max(1, Number(q.pageSize) || (q.export ? cap : 50)));
    const binds: Record<string, unknown> = { t: tenantId };

    // ── Filtros. Todos van sobre el dataset COMPLETO, antes de paginar: si no, los totales
    // mienten (un footer que suma 50 de 9,860 no es un total).
    const filters: string[] = ['s.tenant_id = :t', 'p.activo = true', 'p.deleted_at IS NULL'];
    if (q.supplier_id && UUID_RX.test(q.supplier_id)) { filters.push('p.supplier_id = :sup'); binds.sup = q.supplier_id; }
    if (q.brand_id && UUID_RX.test(q.brand_id)) { filters.push('p.brand_id = :br'); binds.br = q.brand_id; }
    if (q.category_id && UUID_RX.test(q.category_id)) { filters.push('p.category_id = :cat'); binds.cat = q.category_id; }
    if (q.search && q.search.trim()) { filters.push('(p.sku ILIKE :s OR p.nombre ILIKE :s)'); binds.s = `%${q.search.trim()}%`; }

    // Recorte de columnas: acota el ANCHO del pivot, no sólo las filas.
    const codes = (q.warehouse_ids || '').split(',').map((c) => c.trim()).filter(Boolean);
    if (codes.length) {
      const inList = codes.map((_, i) => `:wc${i}`).join(',');
      codes.forEach((c, i) => { binds[`wc${i}`] = c; });
      filters.push(`s.warehouse_code IN (${inList})`);
    }

    // ── El divisor de presentación y el veredicto de unidad.
    // `display_bf` viene del fact (donde el nocturno ya lo resolvió leyendo el resolvedor
    // canónico); `vbf.box_factor` es el respaldo para las 603 filas de 52,340 (1.15%) que están
    // en la vista viva pero todavía no en el fact — un SKU que apareció HOY se muestra igual.
    const DBF = 'GREATEST(COALESCE(rp.display_bf, vbf.box_factor, 1), 1)';
    // Sólo los veredictos EN CONTRA se persisten en el fact, así que NULL = "nada me impide
    // convertir". `z_no_arbitrable` / `sin_dato` no entran: ausencia de árbitro no es veredicto.
    // ⚠️ SIN calificar la tabla: se usa leyendo DE `src`, donde la columna ya viene desnuda.
    // Calificarla con `rp.` reventaría con "missing FROM-clause entry for table rp".
    const MEDIBLE = 'rung_veredicto IS NULL';

    // `[W1.0/W1.3]` — La celda que se convierte SIN un factor con fuente. `factor_source` viene de
    // `analytics.v_warehouse_box_factor`; `'default'`/`'none'` significan que NINGUNA de las cuatro
    // fuentes declaró un factor, así que el divisor vale 1 y la cantidad nativa se publica en la
    // columna de CAJAS como si 1 unidad fuera 1 caja. Eso no está verificado para ninguna de ellas.
    // Y `is_weight` con un factor que NO vino de Wincaja es peor: el divisor cuenta PIEZAS por caja
    // y se le aplica a kilos.
    //
    // ⚠️ Esto NO entra en `MEDIBLE`: se DECLARA, no se descuenta. Medido en prod el 2026-09-07,
    // aplicar la regla estricta borraría entre 24% y 58% del total de cajas de CADA almacén
    // —Kepler incluido: `01` pasaría de 29,774 a 18,854— y eso es una decisión de negocio, no una
    // corrección técnica. Lo que sí corresponde es que el usuario VEA cuántas celdas del total
    // están sostenidas por un divisor sin fuente (mismo patrón que `sin_valuar`).
    // Dos formas del MISMO predicado, por la razón que ya documenta `MEDIBLE` unas líneas arriba:
    // dentro de las CTEs que leen `FROM src` las columnas van DESNUDAS, y en el SELECT final —que
    // hace `JOIN src`— hay que calificarlas o revienta con "missing FROM-clause entry".
    const sinFactor = (t = '') => `(${t}rung_veredicto IS NULL
        AND (${t}factor_source IN ('default','none')
             OR (${t}is_weight AND ${t}factor_source <> 'wincaja_factor_venta')))`;
    const SIN_FACTOR = sinFactor();
    const SIN_FACTOR_SRC = sinFactor('src.');

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

    return this.tk.run(async (trx) => {
      // PASO 1 — una sola pasada. MATERIALIZED es obligatorio: sin él, Postgres inlinea la CTE
      // y la vista se escanea dos veces (medido: 2,317 ms contra 809 ms).
      //
      // Los ALIAS se PLIEGAN, no se excluyen. El workbook de compras los excluye y ahí es
      // correcto ("qué comprar"), pero acá sería falso: un alias es mercancía en un anaquel.
      const src = `
        src AS MATERIALIZED (
          SELECT COALESCE(pa.canonical_product_id, s.product_id) AS product_id,
                 s.warehouse_code, s.warehouse_id,
                 s.qty_stock_units AS nat,
                 ${DBF} AS dbf,
                 vbf.base_label, vbf.erp,
                 COALESCE(vbf.factor_source, 'none') AS factor_source,
                 COALESCE(vbf.is_weight, false)      AS is_weight,
                 rp.rung_veredicto, rp.rung_bf_esperado, rp.rung_arbitrado,
                 ${BUCKET} AS bucket,
                 p.sku, p.nombre,
                 -- KE.2 — el costo sale del MISMO ERP y del MISMO almacen que la cantidad.
                 -- Ver la nota EL COSTO en el encabezado del archivo.
                 --
                 -- KX — el fallback del catalogo va BLINDADO con LEAST, y el motivo esta medido:
                 -- en 62 SKUs las dos columnas del catalogo estan en UNIDADES DISTINTAS y al reves
                 -- de lo que dicen sus nombres (cost_with_tax MENOR que cost_base, imposible para
                 -- un impuesto). Contra el costo de Kepler, en esas filas cost_with_tax pega en 60
                 -- de 101 con mediana 1.000 y cost_base solo en 21, con mediana 10.872: o sea
                 -- cost_base trae el BULTO. Un LEAST resuelve los dos casos con una expresion:
                 -- en el caso normal cost_with_tax >= cost_base y gana cost_base (el neto, que es
                 -- lo que KE.2 quiere); en el invertido gana cost_with_tax (la unidad chica).
                 -- Hoy ninguna de esas 101 filas llega hasta aca porque todas tienen costo del
                 -- ERP; esto existe para el dia que Kepler deje de traer una y el fallback la
                 -- valuaria ~10.9x arriba.
                 COALESCE(kc.costo_unitario,
                          CASE WHEN s.source = 'kepler_ods'
                               THEN CASE WHEN COALESCE(p.cost_with_tax, 0) > 0
                                          AND p.cost_with_tax < p.cost_base
                                         THEN p.cost_with_tax ELSE p.cost_base END
                               ELSE COALESCE(p.cost_with_tax, p.cost_base) END, 0) AS cu,
                 CASE WHEN kc.costo_unitario IS NOT NULL      THEN 'erp'
                      WHEN s.source = 'kepler_ods'
                       AND COALESCE(p.cost_with_tax, 0) > 0
                       AND p.cost_with_tax < p.cost_base      THEN 'catalogo_columnas_invertidas'
                      WHEN s.source = 'kepler_ods'            THEN 'catalogo_neto'
                      ELSE                                         'catalogo' END AS cu_source
            FROM analytics.v_erp_stock_on_hand s
            JOIN catalog.products p
                 ON p.tenant_id = s.tenant_id AND p.id = s.product_id
            LEFT JOIN commercial.product_aliases pa
                 ON pa.tenant_id = s.tenant_id AND pa.alias_product_id = s.product_id
                AND pa.deleted_at IS NULL
            -- ↑ el alias se PLIEGA al canónico (COALESCE arriba). Hoy hay 1 activo; la regla
            -- importa igual, porque el día que haya 50 la existencia no puede desaparecer.
            LEFT JOIN analytics.replenishment_plan rp
                 ON rp.tenant_id = s.tenant_id AND rp.warehouse_id = s.warehouse_id
                AND rp.product_id = s.product_id
            LEFT JOIN analytics.v_warehouse_box_factor vbf
                 ON vbf.tenant_id = s.tenant_id AND vbf.warehouse_id = s.warehouse_id
                AND vbf.product_id = s.product_id
            LEFT JOIN commercial.reorder_policy pol
                 ON pol.tenant_id = s.tenant_id AND pol.warehouse_id = s.warehouse_id
                AND pol.product_id = s.product_id
            -- KE.2 — el costo propio de Kepler por almacen x producto. Se LEE de la vista, no se
            -- re-deriva: un primitivo con dos implementaciones es un primitivo que va a divergir.
            -- Y ojo: se une por s.product_id (el CRUDO), NO por el canonico del alias — kdik
            -- mapea por el SKU real de la sucursal.
            LEFT JOIN analytics.v_kepler_unit_cost kc
                 ON kc.tenant_id = s.tenant_id AND kc.warehouse_id = s.warehouse_id
                AND kc.product_id = s.product_id
           WHERE ${filters.join(' AND ')}
        )`;

      // PASO 2 — agregado por producto SIN jsonb, con los totales de la RED por window.
      // El valor suma SÓLO lo medible: una celda cuyo peldaño el costo contradice no se valúa
      // (regla U.2b — NULL con motivo, jamás 0, porque 0 se lee "no cuesta nada").
      const aggFilters: string[] = [];
      if (q.bucket && ['agotado', 'bajo_minimo', 'bajo_reorden', 'sano', 'sobrestock'].includes(q.bucket)) {
        aggFilters.push('buckets @> to_jsonb(:bkt::text)'); binds.bkt = q.bucket;
      }
      if (q.only_unverified === '1') aggFilters.push('sin_valuar > 0');
      if (q.hide_zero === '1') aggFilters.push('hay_existencia');
      const having = aggFilters.length ? `WHERE ${aggFilters.join(' AND ')}` : '';
      const dir = (q.sort_dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

      const sql = `
        WITH ${src},
        agg0 AS (
          SELECT product_id, max(sku) AS sku, max(nombre) AS nombre,
                 sum(CASE WHEN ${MEDIBLE} THEN nat * cu END)              AS valor,
                 -- ⛔ NO sumar nat crudo: cada almacén lo guarda en SU unidad nativa (kg en un
                 -- granel de Kepler, paquetes en un multipack de Wincaja, piezas en el resto), y
                 -- sumarlos da un número que no está en ninguna unidad. Es exactamente la clase
                 -- de error que cerró U.2b. La CAJA es la única unidad que los dos ERPs declaran,
                 -- así que el total comparable va en cajas y SÓLO de las celdas medibles.
                 sum(CASE WHEN ${MEDIBLE} THEN nat / dbf END)             AS total_cajas,
                 -- Para "esconder los que no tienen nada" no hace falta sumar: basta preguntar.
                 bool_or(nat > 0)                                         AS hay_existencia,
                 count(*) FILTER (WHERE nat > 0)::int                     AS n_almacenes,
                 count(*) FILTER (WHERE NOT (${MEDIBLE}))::int            AS sin_valuar,
                 -- [W1.0/W1.3] celdas que SÍ entran al total de cajas pero con un divisor sin
                 -- fuente. No se descuentan: se cuentan, para que el total no se lea como si
                 -- todas sus celdas tuvieran un factor verificado.
                 count(*) FILTER (WHERE ${SIN_FACTOR})::int               AS sin_factor,
                 -- KE.2 — celdas valuadas con el catalogo porque el ERP no dio su costo. NO se
                 -- descuentan del valor (un costo del catalogo es mejor que ninguno): se CUENTAN,
                 -- para que el total no se lea como si todo estuviera valuado con el costo del ERP.
                 count(*) FILTER (WHERE cu_source <> 'erp' AND nat > 0)::int AS sin_costo_erp,
                 -- KX — celdas donde el fallback tuvo que corregir las columnas del catalogo
                 -- (cost_with_tax < cost_base). Hoy da 0 porque todas tienen costo del ERP; si
                 -- deja de dar 0, el catalogo empezo a valuar bultos como piezas en la pantalla.
                 count(*) FILTER (WHERE cu_source = 'catalogo_columnas_invertidas' AND nat > 0)::int
                   AS costo_invertido,
                 sum(rung_arbitrado) FILTER (WHERE NOT (${MEDIBLE}))      AS arbitrado,
                 jsonb_agg(DISTINCT bucket) FILTER (WHERE bucket IS NOT NULL) AS buckets
            FROM src GROUP BY product_id
        ),
        agg AS (
          SELECT *,
                 count(*) OVER()::int                        AS _skus,
                 sum(valor) OVER()                           AS _valor,
                 sum(sin_valuar) OVER()::int                 AS _celdas_sin_valuar,
                 sum(sin_factor) OVER()::int                 AS _celdas_sin_factor,
                 sum(sin_costo_erp) OVER()::int              AS _celdas_sin_costo_erp,
                 sum(costo_invertido) OVER()::int            AS _celdas_costo_invertido,
                 count(*) FILTER (WHERE sin_factor > 0) OVER()::int AS _skus_sin_factor,
                 sum(arbitrado) OVER()                       AS _arbitrado,
                 count(*) FILTER (WHERE sin_valuar > 0) OVER()::int AS _skus_sin_valuar
            FROM agg0 ${having}
        ),
        pg AS (
          SELECT * FROM agg
           ORDER BY ${this.sortExpr(q.sort_by)} ${dir} NULLS LAST, sku
           LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
        ),
        -- Los totales POR ALMACÉN (la fila congelada del pie, que O.2 exige) van en el MISMO
        -- statement a propósito: como una segunda consulta costaban una pasada entera de más
        -- (medido: 5,517 ms contra ~1 s). Acá reusan la materialización de src, que es justo
        -- para lo que MATERIALIZED está.
        tw AS (
          SELECT jsonb_agg(x ORDER BY x->>'code') AS per_warehouse FROM (
            SELECT jsonb_build_object(
                     'code', warehouse_code,
                     'valor', round(sum(CASE WHEN ${MEDIBLE} THEN nat * cu END)::numeric, 2),
                     'cajas', round(sum(CASE WHEN ${MEDIBLE} THEN nat / dbf END)::numeric, 1),
                     'sin_valuar', count(*) FILTER (WHERE NOT (${MEDIBLE}))::int,
                     'sin_factor', count(*) FILTER (WHERE ${SIN_FACTOR})::int,
                     'skus_con_existencia', count(*) FILTER (WHERE nat > 0)::int
                   ) AS x
              FROM src GROUP BY warehouse_code) z
        )
        -- PASO 4 — el pivot, SÓLO sobre la página. src ya está materializada: no re-escanea.
        -- Cada celda declara su propio veredicto: cuando el peldaño está en contra viaja la
        -- cantidad NATIVA con su rótulo del ERP y NO la cifra en cajas, que sería inventada.
        SELECT pg.product_id, pg.sku, pg.nombre,
               round(pg.valor::numeric, 2)      AS valor,
               round(pg.total_cajas::numeric, 1) AS total_cajas,
               pg.n_almacenes, pg.sin_valuar, pg.sin_factor,
               round(pg.arbitrado::numeric, 2)  AS arbitrado,
               pg.buckets,
               pg._skus, round(pg._valor::numeric, 2) AS _valor,
               pg._celdas_sin_valuar, round(pg._arbitrado::numeric, 2) AS _arbitrado,
               pg._skus_sin_valuar, pg._celdas_sin_factor, pg._skus_sin_factor,
               tw.per_warehouse AS _per_warehouse,
               jsonb_object_agg(src.warehouse_code, jsonb_strip_nulls(jsonb_build_object(
                 'q',    CASE WHEN src.rung_veredicto IS NULL THEN round((src.nat / src.dbf)::numeric, 1) END,
                 'val',  CASE WHEN src.rung_veredicto IS NULL THEN round((src.nat * src.cu)::numeric, 2) END,
                 'nat',  CASE WHEN src.rung_veredicto IS NOT NULL THEN round(src.nat::numeric, 0) END,
                 'natu', CASE WHEN src.rung_veredicto IS NOT NULL THEN src.base_label END,
                 'rung', src.rung_veredicto,
                 -- [W1.0/W1.3] la celda declara que su cifra en cajas se apoya en un divisor SIN
                 -- fuente. jsonb_strip_nulls borra la clave cuando no aplica, así que su sola
                 -- presencia es la señal y no engorda el payload de las ~6,600 celdas sanas.
                 -- (sin acentos graves acá: este SQL vive dentro de un template literal)
                 'nf',   CASE WHEN ${SIN_FACTOR_SRC}
                              THEN CASE WHEN src.is_weight THEN 'peso' ELSE 'sin_factor' END END,
                 'b',    src.bucket
               ))) AS cells
          FROM pg CROSS JOIN tw JOIN src ON src.product_id = pg.product_id
         GROUP BY pg.product_id, pg.sku, pg.nombre, pg.valor, pg.total_cajas, pg.n_almacenes,
                  pg.sin_valuar, pg.sin_factor, pg.arbitrado, pg.buckets, pg._skus, pg._valor,
                  pg._celdas_sin_valuar, pg._arbitrado, pg._skus_sin_valuar,
                  pg._celdas_sin_factor, pg._skus_sin_factor, pg._celdas_sin_costo_erp,
                  pg._celdas_costo_invertido, pg.costo_invertido,
                  pg.sin_costo_erp, tw.per_warehouse
         ORDER BY ${this.sortExpr(q.sort_by)} ${dir} NULLS LAST, pg.sku`;

      const rows = (await trx.raw(sql, binds)).rows;
      const agg: any = rows[0] || {};

      const totWh = agg._per_warehouse || [];

      return {
        rows,
        columns: await this.memoized(`cols:${tenantId}`, 60_000,
          () => this.columns(trx, tenantId, [], totWh.map((w: any) => w.code)))
          .then((all: any[]) => (codes.length ? all.filter((r) => codes.includes(r.code)) : all)),
        totals: {
          skus: Number(agg._skus || 0),
          valor: agg._valor == null ? null : Number(agg._valor),
          celdas_sin_valuar: Number(agg._celdas_sin_valuar || 0),
          skus_sin_valuar: Number(agg._skus_sin_valuar || 0),
          // [W1.0/W1.3] celdas que SÍ suman al total de cajas con un divisor sin fuente. Se
          // publican para que el total no se lea como si todo tuviera factor verificado.
          celdas_sin_factor: Number(agg._celdas_sin_factor || 0),
          skus_sin_factor: Number(agg._skus_sin_factor || 0),
          // KE.2 — celdas cuyo costo salio del CATALOGO y no del ERP. La procedencia del valor
          // se declara: sin esto, el total se lee como si todo estuviera valuado con el costo
          // del almacen (ADR-056).
          celdas_sin_costo_erp: Number(agg._celdas_sin_costo_erp || 0),
          // KX — el METODO con el que se valuo, dicho en vez de supuesto. El costo del ERP
          // (kdik.c16 = c8/c5) es un PROMEDIO PONDERADO HISTORICO: c5 son las entradas
          // acumuladas, identico a SUM(kdil.c8) en 25,143 de 25,143 pares (100.00%). Contra el
          // ultimo costo conocido (c18) la mediana es 0.9805, o sea el inventario se valua ~2%
          // por debajo del costo de reposicion, de forma sistematica. Publicarlo sin decirlo
          // seria hacerlo pasar por costo de reposicion.
          metodo_valuacion: 'erp_promedio_ponderado_historico',
          // KX — celdas donde el catalogo trae sus dos columnas de costo en unidades distintas
          // y el fallback tuvo que elegir la chica. Un 0 aca es la salud esperada.
          celdas_costo_invertido: Number(agg._celdas_costo_invertido || 0),
          // Lo que el árbitro (el costo pagado) SÍ puede afirmar de lo retenido. Es REFERENCIA
          // para revisar, no una cifra publicable — el front tiene que rotularla así.
          arbitrado: agg._arbitrado == null ? null : Number(agg._arbitrado),
          per_warehouse: totWh,
        },
        freshness: await this.memoized(`fresh:${tenantId}`, 30_000, () => this.freshness(trx, tenantId)),
        page, pageSize, total: Number(agg._skus || 0),
      };
    });
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
  private async freshness(trx: any, tenantId: string) {
    const out: any[] = [];
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
      const w = (await trx.raw(`
        SELECT max(imported_at) AS dato_al,
               round(EXTRACT(epoch FROM now() - max(imported_at)) / 60.0, 1) AS minutos
          FROM wincaja.existencias
         WHERE tenant_id = ? AND source_dataset = 'actual'
           AND source_branch IN ('00', '30', '32')`, [tenantId])).rows[0];
      if (w && w.dato_al) out.push({ rama: 'wincaja', label: 'Wincaja 00 / MD-30 / MD-32', dato_al: w.dato_al, minutos: Number(w.minutos) });
    } catch (e: any) {
      this.logger.warn(`frescura Wincaja no disponible: ${e.message}`);
    }
    return out;
  }

  /** Drill de un SKU: el desglose por almacén con la escalera de unidad y su procedencia. */
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
