/**
 * `[EX-PERF.3]` — El armado de la matriz de existencia EN MEMORIA, sobre una foto de las celdas.
 *
 * POR QUÉ EXISTE. Hasta acá cada teclazo, cada filtro y cada página re-ejecutaba la consulta
 * completa: la vista de existencia + 5 joins sobre ~30,600 celdas para devolver 50 filas. Medido
 * contra prod el 2026-10-12 (jit off, tenant puesto): **1,057–1,276 ms** por llamada, y forzar
 * hash joins sólo la baja ~10 % — el piso es armar el join, no el plan. La foto se arma UNA vez
 * por minuto en segundo plano (`ExistenciaService.foto`) y acá se filtra, agrega, ordena y pagina
 * en milisegundos.
 *
 * ⛔ ESTE ARCHIVO NO DECIDE NADA DE NEGOCIO: replica la semántica de los pasos 2–4 del SQL que
 * reemplaza (agregado por producto, totales de la red por window, totales por almacén sobre las
 * celdas filtradas, pivot de la página). La unidad, el costo y el veredicto siguen saliendo de la
 * base. Si se cambia una regla, se fija en `existencia-agregado.spec.ts`.
 *
 * PARIDAD MEDIDA contra prod el 2026-10-12 — el servicio viejo (SQL completo) y éste, sobre los
 * mismos datos, 9 combinaciones de filtros: filas, orden, celdas y totales idénticos, salvo
 *   - `celdas_sin_costo_erp`: el SQL viejo daba SIEMPRE 0 porque nunca seleccionaba la columna
 *     (sólo aparecía en el GROUP BY); acá da el valor real (34 celdas en la red).
 *   - total en cajas de 97244: 6,471 / 180 = 35.95 exacto; el SQL truncaba cada división a 16
 *     decimales y redondeaba a 35.9. Acá 36.0.
 *   - un producto con alias en el almacén 02: dos celdas para la misma columna y el pivot conserva
 *     una sola, en el orden que llegue (defecto previo, igual de arbitrario en el SQL).
 *
 * Reglas que se conservan tal cual (ver el encabezado de `existencia.service.ts`):
 *   - El valor y las cajas suman SÓLO lo medible (`rung_veredicto` nulo). Lo demás va como NULL
 *     con motivo, jamás como 0.
 *   - La cantidad nativa NO se suma entre almacenes: cada uno la guarda en su unidad.
 *   - Los totales por almacén salen de las celdas FILTRADAS, antes de `hide_zero`/`bucket` —
 *     exactamente como el CTE `tw` del SQL, que leía de `src` y no de `agg`.
 */

export interface ExistenciaCelda {
  /** Producto canónico (el alias ya plegado). */
  product_id: string;
  /** SKU y nombre del producto CRUDO: la búsqueda filtra por éstos, igual que el SQL. */
  sku: string;
  nombre: string;
  supplier_id: string | null;
  brand_id: string | null;
  category_id: string | null;
  warehouse_code: string;
  /** Cantidad en la unidad nativa del almacén. */
  nat: number;
  /** Unidades base por caja (divisor de presentación, ADR-055). */
  dbf: number;
  base_label: string | null;
  factor_source: string;
  is_weight: boolean;
  rung_veredicto: string | null;
  rung_arbitrado: number | null;
  bucket: string | null;
  /** Costo unitario y de dónde salió. */
  cu: number;
  cu_source: string;
  /**
   * `[EX.U2]` El peldaño intermedio (el PAQUETE) según la ficha de Kepler de ESE almacén:
   * unidades base por paquete y su rótulo. Nulo cuando no hay peldaño intermedio válido.
   */
  pf: number | null;
  pu: string | null;
}

export interface ExistenciaFiltrosMem {
  supplier_id?: string;
  brand_id?: string;
  category_id?: string;
  search?: string;
  codes: string[];
  bucket?: string;
  only_unverified: boolean;
  hide_zero: boolean;
  sort_by?: string;
  sort_dir?: string;
  page: number;
  pageSize: number;
}

const BUCKETS = ['agotado', 'bajo_minimo', 'bajo_reorden', 'sano', 'sobrestock'];

/**
 * Redondeo que reproduce el `round(numeric, n)` del SQL. La suma en float deja ruido en el
 * último dígito (887.55 llega como 887.5499999) y `Math.round` lo cortaba hacia abajo donde la
 * base redondeaba hacia arriba — medido en la paridad contra prod. `toPrecision(12)` limpia ese
 * ruido antes de redondear; 12 dígitos sobran para importes de la red (~$10^8 con centavos).
 */
const rn = (v: number, d: number) => { const k = 10 ** d; return Math.round(Number((v * k).toPrecision(12))) / k; };
const r1 = (v: number) => rn(v, 1);
const r2 = (v: number) => rn(v, 2);

const medible = (c: ExistenciaCelda) => c.rung_veredicto == null;

/** Misma expresión que `sinFactor()` del SQL. */
const sinFactor = (c: ExistenciaCelda) =>
  c.rung_veredicto == null
  && (c.factor_source === 'default' || c.factor_source === 'none'
      || (c.is_weight && c.factor_source !== 'wincaja_factor_venta'));

/**
 * Comparación de texto para el orden. ⚠️ No es byte a byte la collation de Postgres; para SKUs
 * numéricos y nombres en mayúsculas da el mismo orden, y el desempate por SKU lo vuelve estable.
 */
const cmpTxt = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Agg {
  product_id: string;
  sku: string;
  nombre: string;
  valor: number | null;
  total_cajas: number | null;
  hay_existencia: boolean;
  n_almacenes: number;
  sin_valuar: number;
  sin_factor: number;
  // `[U.VA.1]` El balde "sin factor" tiene DOS causas y el total las perdía.
  // Medido contra prod el 2026-10-15 sobre las celdas con existencia: de 1,833 celdas,
  // **1,335 (73 %) son de PESO** y sólo 498 son "ninguna fuente declara el factor". El banner
  // publicaba la segunda redacción para las dos, o sea nombraba mal la causa en 3 de cada 4.
  // La celda SÍ las distinguía (`nf: 'peso' | 'sin_factor'`, con dos tooltips distintos); se
  // perdía justo en la frase que todo el mundo lee. Son problemas distintos y se arreglan
  // distinto: el de peso necesita vender por kilo, el otro necesita que alguien declare el factor.
  sin_factor_peso: number;
  sin_costo_erp: number;
  costo_invertido: number;
  arbitrado: number | null;
  buckets: Set<string>;
  celdas: ExistenciaCelda[];
}

export function armarMatriz(celdas: ExistenciaCelda[], f: ExistenciaFiltrosMem) {
  // ── PASO 1 — el WHERE del CTE src, sobre la foto.
  const q = f.search?.trim().toLowerCase();
  const codes = f.codes.length ? new Set(f.codes) : null;
  const src = celdas.filter((c) =>
    (!f.supplier_id || c.supplier_id === f.supplier_id)
    && (!f.brand_id || c.brand_id === f.brand_id)
    && (!f.category_id || c.category_id === f.category_id)
    && (!codes || codes.has(c.warehouse_code))
    && (!q || c.sku.toLowerCase().includes(q) || c.nombre.toLowerCase().includes(q)));

  // ── PASO 2 — agregado por producto.
  const porProducto = new Map<string, Agg>();
  for (const c of src) {
    let a = porProducto.get(c.product_id);
    if (!a) {
      a = {
        product_id: c.product_id, sku: c.sku, nombre: c.nombre, valor: null, total_cajas: null,
        hay_existencia: false, n_almacenes: 0, sin_valuar: 0, sin_factor: 0, sin_factor_peso: 0, sin_costo_erp: 0,
        costo_invertido: 0, arbitrado: null, buckets: new Set(), celdas: [],
      };
      porProducto.set(c.product_id, a);
    }
    // max(sku) / max(nombre): con un alias plegado, el canónico y el alias pueden diferir.
    if (cmpTxt(c.sku, a.sku) > 0) a.sku = c.sku;
    if (cmpTxt(c.nombre, a.nombre) > 0) a.nombre = c.nombre;
    if (medible(c)) {
      a.valor = (a.valor ?? 0) + c.nat * c.cu;
      a.total_cajas = (a.total_cajas ?? 0) + c.nat / c.dbf;
    } else {
      a.sin_valuar++;
      if (c.rung_arbitrado != null) a.arbitrado = (a.arbitrado ?? 0) + c.rung_arbitrado;
    }
    if (c.nat > 0) {
      a.hay_existencia = true;
      a.n_almacenes++;
      if (c.cu_source !== 'erp') a.sin_costo_erp++;
      if (c.cu_source === 'catalogo_columnas_invertidas') a.costo_invertido++;
    }
    if (sinFactor(c)) { a.sin_factor++; if (c.is_weight) a.sin_factor_peso++; }
    if (c.bucket) a.buckets.add(c.bucket);
    a.celdas.push(c);
  }

  // ── El HAVING de agregados.
  const bkt = f.bucket && BUCKETS.includes(f.bucket) ? f.bucket : null;
  const agg = [...porProducto.values()].filter((a) =>
    (!bkt || a.buckets.has(bkt))
    && (!f.only_unverified || a.sin_valuar > 0)
    && (!f.hide_zero || a.hay_existencia));

  // ── Totales de la RED (los window del SQL, sobre `agg`).
  let valor: number | null = null;
  let arbitrado: number | null = null;
  let celdasSinValuar = 0, celdasSinFactor = 0, celdasSinCostoErp = 0, celdasCostoInvertido = 0;
  let celdasSinFactorPeso = 0, skusSinFactorPeso = 0;
  let skusSinValuar = 0, skusSinFactor = 0;
  for (const a of agg) {
    if (a.valor != null) valor = (valor ?? 0) + a.valor;
    if (a.arbitrado != null) arbitrado = (arbitrado ?? 0) + a.arbitrado;
    celdasSinValuar += a.sin_valuar;
    celdasSinFactor += a.sin_factor;
    celdasSinFactorPeso += a.sin_factor_peso;
    celdasSinCostoErp += a.sin_costo_erp;
    celdasCostoInvertido += a.costo_invertido;
    if (a.sin_valuar > 0) skusSinValuar++;
    if (a.sin_factor > 0) skusSinFactor++;
    if (a.sin_factor_peso > 0) skusSinFactorPeso++;
  }

  // ── PASO 3 — orden + página. NULLS LAST en las dos direcciones, desempate por SKU.
  const key = ({ valor: 'valor', sku: 'sku', nombre: 'nombre', existencia: 'total_cajas',
    almacenes: 'n_almacenes', sin_valuar: 'sin_valuar' } as Record<string, keyof Agg>)[f.sort_by || ''] || 'valor';
  const dir = (f.sort_dir || '').toLowerCase() === 'asc' ? 1 : -1;
  agg.sort((x, y) => {
    const a = x[key] as any, b = y[key] as any;
    if (a == null || b == null) {
      if (a == null && b != null) return 1;
      if (b == null && a != null) return -1;
    } else {
      const c = typeof a === 'string' ? cmpTxt(a, b) : a - b;
      if (c !== 0) return c * dir;
    }
    return cmpTxt(x.sku, y.sku);
  });
  const pagina = agg.slice((f.page - 1) * f.pageSize, f.page * f.pageSize);

  // ── Totales POR ALMACÉN: sobre `src` (celdas filtradas), no sobre `agg`. Igual que el CTE tw.
  const porAlmacen = new Map<string, { valor: number | null; cajas: number | null; sin_valuar: number; sin_factor: number; skus: number }>();
  for (const c of src) {
    let w = porAlmacen.get(c.warehouse_code);
    if (!w) { w = { valor: null, cajas: null, sin_valuar: 0, sin_factor: 0, skus: 0 }; porAlmacen.set(c.warehouse_code, w); }
    if (medible(c)) {
      w.valor = (w.valor ?? 0) + c.nat * c.cu;
      w.cajas = (w.cajas ?? 0) + c.nat / c.dbf;
    } else w.sin_valuar++;
    if (sinFactor(c)) w.sin_factor++;
    if (c.nat > 0) w.skus++;
  }
  const perWarehouse = [...porAlmacen.entries()]
    .sort(([a], [b]) => cmpTxt(a, b))
    .map(([code, w]) => ({
      code,
      valor: w.valor == null ? null : r2(w.valor),
      cajas: w.cajas == null ? null : r1(w.cajas),
      sin_valuar: w.sin_valuar,
      sin_factor: w.sin_factor,
      skus_con_existencia: w.skus,
    }));

  // ── PASO 4 — el pivot, sólo de la página.
  const rows = pagina.map((a) => {
    const cells: Record<string, Record<string, unknown>> = {};
    for (const c of a.celdas) {
      const m = medible(c);
      const cell: Record<string, unknown> = {
        q: m ? r1(c.nat / c.dbf) : undefined,
        val: m ? r2(c.nat * c.cu) : undefined,
        nat: r2(c.nat),
        natu: c.base_label ?? undefined,
        // [EX.U2] el divisor y el paquete viajan para que la pantalla desglose cj / paq / pz
        // sin inventar nada: son los mismos números con los que se calculó `q`.
        bf: c.dbf,
        pf: c.pf ?? undefined,
        pu: c.pu ?? undefined,
        rung: c.rung_veredicto ?? undefined,
        nf: sinFactor(c) ? (c.is_weight ? 'peso' : 'sin_factor') : undefined,
        b: c.bucket ?? undefined,
      };
      for (const k of Object.keys(cell)) if (cell[k] === undefined) delete cell[k];
      // jsonb_object_agg: si un alias y su canónico caen en el mismo almacén, gana el último.
      cells[c.warehouse_code] = cell;
    }
    return {
      product_id: a.product_id,
      sku: a.sku,
      nombre: a.nombre,
      valor: a.valor == null ? null : r2(a.valor),
      total_cajas: a.total_cajas == null ? null : r1(a.total_cajas),
      n_almacenes: a.n_almacenes,
      sin_valuar: a.sin_valuar,
      sin_factor: a.sin_factor,
      arbitrado: a.arbitrado == null ? null : r2(a.arbitrado),
      buckets: a.buckets.size ? [...a.buckets].sort() : null,
      cells,
    };
  });

  return {
    rows,
    totals: {
      skus: agg.length,
      valor: valor == null ? null : r2(valor),
      celdas_sin_valuar: celdasSinValuar,
      skus_sin_valuar: skusSinValuar,
      celdas_sin_factor: celdasSinFactor,
      skus_sin_factor: skusSinFactor,
      // [U.VA.1] el desglose por CAUSA: lo de PESO es el 73 % y no es "falta el factor".
      celdas_sin_factor_peso: celdasSinFactorPeso,
      skus_sin_factor_peso: skusSinFactorPeso,
      celdas_sin_costo_erp: celdasSinCostoErp,
      celdas_costo_invertido: celdasCostoInvertido,
      arbitrado: arbitrado == null ? null : r2(arbitrado),
      per_warehouse: perWarehouse,
    },
    total: agg.length,
  };
}
