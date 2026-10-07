import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Análisis SEMANAL (proyecto Tienda, /tienda/analisis-semanal).
 *
 * Agrega on-the-fly datos DIARIOS que ya existen (feeds nightly Kepler) a semana
 * ISO (lunes–domingo, `date_trunc('week', ...)`). No hay tablas ni MVs nuevas.
 *
 * Fuentes ("ambas"):
 *  - `analytics.sales_daily` (ventana 13 meses) → venta $, margen, unidades. Base de
 *    la tendencia (tiene historia) y de todos los KPIs/desgloses monetarios.
 *  - `analytics.product_sales_daily` → unidades OFICIALES (cuadran con el mensual);
 *    se muestran como cifra de reconciliación de la semana + por producto.
 *
 * OJO: `sales_daily.tickets = count(DISTINCT folio)` es por LÍNEA de producto →
 * NO es sumable a nivel semana/sucursal (sobrecuenta). Por eso no se expone tickets.
 *
 * Scoping por sucursal: el controller fuerza `warehouseCode` del usuario (@ReqUser)
 * igual que el resto de /tienda. RLS forzado → todo dentro de `tk.run()` + tenant
 * explícito (analytics.* no tiene RLS).
 */

export interface WeeklyQuery {
  /** Cualquier día de la semana objetivo (ISO 'YYYY-MM-DD'). Default: semana actual MX. */
  week?: string;
  /** Nº de semanas de la tendencia (default 12, máx 26). */
  weeks?: number;
  /**
   * Sucursales visibles, YA resueltas por `ScopeService` en el controller
   * (`[ID.4]` / ADR-050). `null`/ausente = sin filtro (alcance `all`); lista
   * vacía = no ve ninguna. Es lista y no un solo código porque el alcance
   * permite "la suya + la 03".
   */
  warehouse_codes?: string[] | null;
}

export interface RangeQuery {
  /** Inicio del rango (ISO 'YYYY-MM-DD', inclusivo). */
  from?: string;
  /** Fin del rango (ISO 'YYYY-MM-DD', inclusivo). */
  to?: string;
  /** Sucursales visibles ya resueltas por `ScopeService`. Ver `WeeklyQuery`. */
  warehouse_codes?: string[] | null;
  /**
   * `[TDA.A1]` ¿Incluir el top de productos? Default `true` (contrato viejo intacto).
   *
   * La sección de Tráfico ya no dibuja esa tabla —se mudó a la pestaña «Productos y
   * proveedores»— y es la consulta cara del método: agrupa por producto sobre toda la
   * ventana. Con rangos de hasta 2 años, pedirla cuando nadie la va a mirar es pagar
   * el escaneo dos veces.
   */
  with_products?: boolean;
}

/* ───────────────────────── `[TDA.A1]` Cascada por período ─────────────────────────
 * Tipos del segundo bloque de `/tienda/analisis-semanal`: la MISMA fotografía repetida
 * hacia abajo en el grano que se elija. Ver `WeeklyAnalyticsService.breakdown()`.
 */

/** Grano de la cascada. Whitelist CERRADA: la llave entra a un `date_trunc` por concatenación. */
export type BreakdownGrain = 'week' | 'weekday' | 'month' | 'quarter' | 'year';
/** Grano del segundo nivel — el que se despliega al abrir una fila. */
export type BreakdownChildGrain = 'day' | 'month' | 'quarter';

export interface BreakdownQuery {
  from?: string;
  to?: string;
  /** Uno de `BreakdownGrain`. Cualquier otra cosa cae a `month`. */
  grain?: string;
  /** Sucursales visibles ya resueltas por `ScopeService`. Ver `WeeklyQuery`. */
  warehouse_codes?: string[] | null;
  /**
   * `[TDA.A2]` Acota la cascada a UNA línea (el proveedor del catálogo). `''`/ausente =
   * toda la tienda. La llave especial `__SIN_LINEA__` acota a los productos sin línea
   * asignada, que existen y no se pueden mirar de otra forma.
   */
  supplier_code?: string;
  /**
   * `[TDA.A3]` Acota la cascada a UN producto. Excluyente con `supplier_code`; si vienen
   * los dos gana el producto, por ser el más específico.
   *
   * ⚠️ Igual que la línea, prende el **modo acotado**, que publica MENOS columnas a
   * propósito — ver `BreakdownReport.scope`.
   */
  product_id?: string;
}

/**
 * Una fila de la cascada — el mismo juego de indicadores que la fotografía de arriba,
 * para que leer hacia abajo sea leer la misma medida en otro período.
 *
 * Toda RAZÓN vuelve `number | null`: `null` = no se pudo medir, y en pantalla se pinta
 * «—». Un período sin tickets NO tiene un ticket promedio de $0 (ADR-056). Esto se
 * aparta a propósito de `range()`, donde `avg_ticket`/`basket` conservan su 0 histórico:
 * ahí cambiarlo es parte del arreglo de cobertura; acá la superficie es nueva y no lo
 * arrastra.
 */
export interface BreakdownRow {
  /** Llave del bucket: fecha ISO de su inicio — o '1'..'7' en grano `weekday`. */
  key: string;
  label: string;
  /** Segunda línea del rótulo: el tramo que el bucket cubre de verdad. */
  sub: string;
  /** Tramo REALMENTE cubierto dentro del rango pedido (un mes a medias dice hasta dónde llegó). */
  from: string;
  to: string;
  /** Días del bucket con venta registrada — cobertura del fact. */
  fact_days: number;
  /**
   * Días del bucket con tickets del POS — cobertura del mostrador. `null` en modo línea:
   * ahí no se preguntó, y un 0 se leería como «el POS no cubrió nada».
   */
  pos_days: number | null;
  revenue: number;
  margin: number;
  margin_pct: number | null;
  units: number;
  /** `null` en modo línea: un ticket no pertenece a una línea (ver `supplier_scope`). */
  tickets: number | null;
  avg_ticket: number | null;
  basket: number | null;
  avg_line: number | null;
  units_per_ticket: number | null;
  avg_unit: number | null;
  /** `null` en modo línea: la factura es del cliente, no de la línea. */
  customers: number | null;
  revenue_per_customer: number | null;
  /** Participación en la venta de SU nivel (padres: la ventana · hijos: su padre). */
  share_pct: number | null;
  /**
   * Δ% de la venta contra el bucket ANTERIOR del mismo tipo. `null` cuando no hay
   * anterior — y siempre en los padres del grano `weekday`: comparar el lunes contra
   * el domingo no dice nada, y publicarlo sería un número inventado con cara de medido.
   */
  delta_pct: number | null;
  children: BreakdownRow[];
}

export interface BreakdownReport {
  period: { from: string; to: string; days: number };
  grain: BreakdownGrain;
  child_grain: BreakdownChildGrain;
  /** Totales de la ventana: denominador de `share_pct` y cuadre contra la fotografía. */
  totals: { revenue: number; margin: number; units: number; tickets: number | null };
  rows: BreakdownRow[];
  as_of: { fact: string | null; customers: string | null };
  /**
   * `[TDA.A2]`/`[TDA.A3]` A qué está acotada la cascada, o `null` = toda la tienda.
   *
   * Cuando viene, **la mitad de los indicadores NO se publica**, y no por falta de ganas:
   * un ticket lleva productos de varias líneas y de varios productos, así que *tickets*,
   * *partidas por ticket*, *ticket promedio*, *$/partida*, *unidades por ticket* y
   * *clientes* **no son atribuibles** ni a una línea ni a un producto. Repartirlos sería
   * inventar; dejar el número de la tienda entera sería peor, porque se leería como si
   * fuera de lo seleccionado. Vuelven `null` y la pantalla esconde esas columnas diciendo
   * por qué.
   */
  scope: { kind: 'linea' | 'producto'; code: string; name: string } | null;
}

/* ───────────────── `[TDA.A2]` Línea = el proveedor del catálogo ─────────────────
 * «Línea» es como el negocio llama al proveedor al que pertenece un producto, y vive en
 * `catalog.products.supplier_id` → `catalog.suppliers`. No hay un campo `linea` aparte:
 * se buscó y no existe.
 *
 * Es la ÚNICA atribución de venta por proveedor con definición estable, y está medido
 * (2026-09-20, 12 meses de tienda sin ruta):
 *   · cubre el **100.0 %** de la venta ($105.14M de $105.17M) y es **1:1** (9,541 SKUs
 *     con una línea, 2 con dos);
 *   · coincide con Kepler (`kdpv_prov_prod`) en **8,936 de 8,957 SKUs = 99.77 %**;
 *   · **11 líneas explican el 50 %** de la venta y 45 el 80 %, de 301 con venta.
 *
 * ⛔ La alternativa —atribuir la venta a QUIÉN ENTREGÓ, desde las recepciones— se midió y
 * se descartó: el **94.8 %** de la venta viene de SKUs recibidos de más de un proveedor
 * real, y en la misma ventana se compró $521M contra $94M vendidos a costo, porque el
 * CEDIS surte a toda la red y la tienda es una parte. No son el mismo universo, y una
 * venta no sabe de qué entrega salió: no hay trazabilidad de lote.
 *
 * ⚠️ Lo que hay que DECLARAR en pantalla: la línea es un atributo de HOY y no tiene
 * historia (el hueco VP.3 del proyecto). Si mañana le cambian la línea a un producto,
 * la venta del año pasado se re-atribuye sola.
 */

/** Llave del cajón «sin línea asignada». Existe y se muestra; esconderlo sería perderlo. */
export const SIN_LINEA = '__SIN_LINEA__';

export interface SupplierQuery {
  from?: string;
  to?: string;
  warehouse_codes?: string[] | null;
  /** Sólo para `supplierProducts()`: la línea cuyos productos se piden. */
  supplier_code?: string;
}

export interface SupplierRow {
  /** Código de la línea, o `SIN_LINEA`. */
  code: string;
  name: string;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  margin: number;
  margin_pct: number | null;
  units: number;
  /** SKUs de la línea CON VENTA en el período (no los del catálogo). */
  skus: number;
  /** Participación en la venta de la ventana. */
  share_pct: number | null;
}

export interface SupplierReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  totals: { revenue: number; margin: number; units: number };
  rows: SupplierRow[];
  /** Cuántas líneas explican la mitad y el 80 % de la venta. Se calcula, no se adivina. */
  concentracion: { lineas: number; para_50: number | null; para_80: number | null };
  as_of: { fact: string | null };
}

export interface SupplierProductRow {
  product_id: string;
  sku: string;
  nombre: string;
  brand: string | null;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  margin: number;
  margin_pct: number | null;
  units: number;
  /** Participación dentro de SU línea (no de la tienda). */
  share_pct: number | null;
}

export interface SupplierProductsReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  supplier: { code: string; name: string };
  totals: { revenue: number; margin: number; units: number };
  rows: SupplierProductRow[];
}

/* ───────────── `[TDA.A3]` Productos TOP — la lectura de Pareto ─────────────
 * El producto mirado con sus TRES etiquetas del ERP —Línea (proveedor) · Tipo (categoría)
 * · Grupo (subcategoría)— ordenado por venta y con el **acumulado**, que es lo que
 * convierte una lista larga en una decisión: cuántos productos hay que no perder de vista.
 *
 * Medido en prod (12 meses de tienda, sin ruta): de **5,744 productos con venta**, **249
 * hacen el 50 %**, **1,012 el 80 %** y 2,422 el 95 %. Por eso el corte de Pareto no es
 * decorativo: deja fuera 4,732 renglones que entre todos pesan una quinta parte.
 *
 * Tipo y Grupo salen de `analytics.v_product_taxonomy` (vista derivada del ODS, ver su
 * migración). ⚠️ **NO son jerarquía** —86 de 241 grupos aparecen bajo más de un tipo— así
 * que se ofrecen como dos filtros independientes, nunca como un árbol.
 */

/* ───────────── `[TDA.A4]` Clientes — la cartera, y su techo ─────────────
 * El cliente con su ficha del ERP (Grupo · Zona · Vendedor · Límite · Plazo, de
 * `analytics.v_customer_master`) más recencia, frecuencia y valor.
 *
 * ⭐ **Esta sección se abre DECLARANDO su techo, y no es una formalidad.** Medido en prod
 * (12 meses): la facturación a nombre son $23.1M contra **$105.2M** del fact, el 62 % de
 * eso es televenta, y con el recorte de la pantalla quedan $7.96M de 284 clientes — de los
 * cuales **$6.48M son DOS cuentas del propio piso de venta**. Clientes externos de verdad:
 * ~$1.5M = **1.4 % de la venta**. El mostrador es anónimo; eso no es un hueco del dato, es
 * el negocio. Una pestaña de clientes que no lo diga primero es un tablero que miente.
 *
 * ⚠️ **La llave es (sucursal, clave)** — ver `v_customer_master`: 141 de 1,574 claves son
 * un cliente distinto según la plaza, y el mismo cliente real puede tener claves distintas
 * en plazas distintas y comprarle a varios vendedores. Por eso **no se suman clientes entre
 * plazas** y la pantalla lo dice.
 */

export interface CustomersQuery {
  from?: string;
  to?: string;
  warehouse_codes?: string[] | null;
  /** `externos` (default) · `internos` · `todos`. Ver `es_interno` de la vista. */
  segmento?: string;
  /** Texto libre sobre nombre y clave. */
  q?: string;
}

/** En qué punto de la relación está el cliente. Se deriva de fechas, no se declara a mano. */
export type CustomerEstado = 'nuevo' | 'activo' | 'dormido';

export interface CustomerRow {
  sucursal: string;
  cliente_code: string;
  nombre: string;
  grupo: string | null;
  zona: string | null;
  vendedor: string | null;
  limite_credito: number | null;
  plazo_dias: number | null;
  es_interno: boolean;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  /** Documentos del período. Es la «frecuencia» — con cuántas compras juntó esa venta. */
  docs: number;
  ticket_prom: number | null;
  primera_compra: string | null;
  ultima_compra: string | null;
  /** Días desde la última compra, contra el fin del período. Es la «recencia». */
  dias_sin_comprar: number | null;
  estado: CustomerEstado;
  share_pct: number | null;
}

export interface CustomerGrupoRow {
  code: string;
  name: string;
  es_interno: boolean;
  clientes: number;
  revenue: number;
  share_pct: number | null;
}

export interface CustomersReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  /**
   * EL TECHO, medido y publicado arriba de todo. `venta_fact` es la venta real de la
   * tienda; el resto es lo poco de ella que tiene nombre.
   */
  techo: {
    venta_fact: number;
    venta_facturada: number;
    venta_interna: number;
    venta_clientes: number;
    /** Qué parte de la venta de la tienda explica la cartera de clientes externos. */
    pct_identificado: number | null;
  };
  /** Segmentación por el Grupo del ERP, con los internos marcados y NO escondidos. */
  grupos: CustomerGrupoRow[];
  totals: { revenue: number; clientes: number };
  rows: CustomerRow[];
  resumen: {
    nuevos: number;
    activos: number;
    dormidos: number;
    /**
     * Desde cuándo hay facturación EN ABSOLUTO. Si el período arranca en esa fecha o
     * antes, «nuevo» no se puede distinguir de «no tenemos historia previa» y la pantalla
     * lo dice en vez de publicar un número de altas que sería el padrón entero.
     */
    historia_desde: string | null;
    nuevos_confiable: boolean;
  };
  as_of: { facturacion: string | null };
}

export interface TopProductsQuery {
  from?: string;
  to?: string;
  warehouse_codes?: string[] | null;
  /** Código de Tipo (`kdie`). */
  tipo?: string;
  /** Código de Grupo (`kdif`). */
  grupo?: string;
  /** Código de línea/proveedor, o `SIN_LINEA`. */
  supplier_code?: string;
  /** Texto libre sobre nombre y SKU. Va en el SERVIDOR a propósito — ver `TopProductsReport`. */
  q?: string;
  /** `pareto` (default) corta al llegar al 80 % acumulado; `all` devuelve hasta el tope. */
  mode?: string;
}

export interface TopProductRow {
  rank: number;
  product_id: string;
  sku: string;
  nombre: string;
  brand: string | null;
  linea_code: string | null;
  linea: string | null;
  tipo: string | null;
  grupo: string | null;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  margin: number;
  margin_pct: number | null;
  units: number;
  /** Venta ÷ unidades. Fuente única (el fact), así que no pasa por la compuerta del POS. */
  avg_unit: number | null;
  /**
   * Días del período en los que ESTE producto vendió. El KPI que la vista de proveedores
   * no da: dos productos con la misma venta, uno vendiendo todos los días y el otro en un
   * pico, no son el mismo producto ni se reponen igual.
   */
  sale_days: number;
  /** Participación en la venta del universo filtrado. */
  share_pct: number | null;
  /** Acumulado de participación hasta esta fila, inclusive. Es la lectura de Pareto. */
  cum_pct: number | null;
}

export interface TopFacet { code: string; name: string; revenue: number; skus: number; }

export interface TopProductsReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  /**
   * El universo COMPLETO que cumple los filtros — no lo que se devolvió. El acumulado y el
   * Pareto se calculan sobre esto, así que `mostrados < productos` es normal y esperado.
   */
  universo: { productos: number; venta: number };
  /** Cuántos productos hacen el 50 / 80 / 95 % del universo filtrado. Calculado, no supuesto. */
  pareto: { para_50: number | null; para_80: number | null; para_95: number | null };
  mode: 'pareto' | 'all';
  /** Cuántas filas trae esta respuesta, y si se topó el límite duro. */
  mostrados: number;
  topado: boolean;
  rows: TopProductRow[];
  /**
   * Opciones de los filtros con su peso. Se calculan SIN los filtros de taxonomía (sólo
   * período y sucursal) para que el desplegable no se vacíe a sí mismo: si las facetas se
   * filtraran con la selección puesta, elegir un tipo dejaría la lista con un solo tipo y
   * no habría forma de cambiarlo.
   */
  facets: { tipos: TopFacet[]; grupos: TopFacet[]; lineas: TopFacet[] };
  as_of: { fact: string | null };
}

/**
 * [SD.3] Fuente de la venta: el twin ODS-derivado `analytics.mv_sales_blended` en vez de la
 * tabla imperativa `analytics.sales_daily` (3.76 GB, poblada por importer). Misma constante y
 * mismo patrón que el motor de margen (`commercial-profitability`). Medido contra PROD read-only
 * (jul+ago 2026, non-RUTA): revenue Δ 0.098% · margen Δ 0.118% · units Δ 0.454% — dentro del
 * ≤0.5% del candado de paridad SD.1, y el corrimiento es HACIA la verdad del ODS.
 * ⚠️ El twin NO tiene columna `margin` (a diferencia de la tabla): se DERIVA `revenue - cost`,
 * que en prod es idéntico al peso (0 de 498,256 filas difieren). El grano del twin incluye
 * `unit_kind`; `sum(units)` mezcla peldaños igual que ya lo hacía `sales_daily.units`.
 * `product_sales_daily` (unidades oficiales) NO se toca: es otra tabla, fuera de SD.
 */
const SALES_FACT = 'analytics.mv_sales_blended';

const MX_TZ = 'America/Mexico_City';
const pct = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;
/** Δ% tolerante a razones NO MEDIDAS: si falta cualquiera de los dos lados, no hay delta. */
const pctN = (cur: number | null, prev: number | null): number | null =>
  cur != null && prev != null ? pct(cur, prev) : null;
/**
 * Razón que se DECLARA no medida en vez de imprimir 0 (ADR-056). Sin denominador
 * —p. ej. una sucursal/período sin cobertura de tickets— `0` se lee en pantalla
 * como "el ticket promedio fue de cero", que es una afirmación falsa; `null` se
 * pinta como «—». Las razones viejas (`avg_ticket`, `basket`) conservan su 0 a
 * propósito: cambiarlas es parte del arreglo de cobertura, no de este item.
 */
const ratio = (num: number, den: number): number | null => (num > 0 && den > 0 ? num / den : null);
/**
 * Porcentaje sobre un total. A diferencia de `ratio()`, el numerador SÍ puede ser
 * ≤ 0 y sigue siendo un hecho: un margen negativo (vender bajo costo) es justo lo
 * que hay que ver, no algo que ocultar. Lo que no puede faltar es el total.
 */
const ratioPct = (num: number, total: number): number | null =>
  total > 0 ? Math.round((num / total) * 1000) / 10 : null;
const addDays = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * `[TDA.A1]` Tope del rango, compartido por `range()` y `breakdown()` — son **un solo
 * control de tiempo** en la pantalla, así que un tope distinto en cada uno dejaría la
 * fotografía en blanco con la cascada llena (o al revés).
 *
 * 760 días ≈ 2 años, elegido por la HISTORIA QUE HAY, no por gusto: la pierna Kepler de
 * `mv_sales_blended` arranca 2025-10 para la 02 y 2026-07 para la 01, así que más atrás
 * se pintarían años vacíos que parecen caída de venta. Alcanza para que el grano `year`
 * tenga con qué comparar, que era el motivo de subirlo desde los 400 de antes.
 */
const MAX_RANGE_DAYS = 760;

/**
 * Bucket de la cascada, **definido una sola vez y en SQL**. La expresión se aplica tanto
 * al mapa del calendario (`generate_series`) como al `GROUP BY` de clientes, así que las
 * llaves de los dos lados son las mismas por construcción. Si el bucket se calculara
 * además en JS, un `date_trunc('week')` que no coincidiera con el lunes de JS metería los
 * clientes de un período en el renglón del otro y nadie lo notaría.
 */
const GRAIN_SQL: Record<BreakdownGrain, { expr: (col: string) => string; child: BreakdownChildGrain }> = {
  week: { expr: (c) => `date_trunc('week', ${c})::date::text`, child: 'day' },
  weekday: { expr: (c) => `EXTRACT(isodow FROM ${c})::int::text`, child: 'day' },
  month: { expr: (c) => `date_trunc('month', ${c})::date::text`, child: 'day' },
  quarter: { expr: (c) => `date_trunc('quarter', ${c})::date::text`, child: 'month' },
  year: { expr: (c) => `date_trunc('year', ${c})::date::text`, child: 'quarter' },
};
const CHILD_SQL: Record<BreakdownChildGrain, (col: string) => string> = {
  day: (c) => `${c}::date::text`,
  month: (c) => `date_trunc('month', ${c})::date::text`,
  quarter: (c) => `date_trunc('quarter', ${c})::date::text`,
};

/**
 * Nombres en DURO, no por `toLocaleDateString`: el rótulo viaja al cliente y no puede
 * depender del ICU que tenga instalada la imagen del servidor.
 */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS_SEMANA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const DIAS_CORTO = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

@Injectable()
export class WeeklyAnalyticsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * ⚠️ `[TDA.A1]` SIN CONSUMIDOR desde 2026-09-19. La pantalla retiró el modo «Semana»:
   * `breakdown()` con grano `week` da las mismas semanas y con el juego completo de
   * indicadores (éste sólo publica venta, margen y unidades). Se DECLARA en vez de
   * borrarse: el endpoint `/store/analytics/weekly` sigue publicado y no hay forma de
   * saber desde acá si alguien lo pega desde afuera. Retirarlo es un item aparte, con
   * su medición.
   */
  async weekly(q: WeeklyQuery): Promise<any> {
    const tenantId = this.tenantCtx.requireTenantId();
    const weeks = Math.min(26, Math.max(4, Number(q.weeks) || 12));
    // `null` = sin filtro (alcance `all`). Array vacío = no ve ninguna sucursal,
    // que NO es lo mismo: se respeta y devuelve series en cero.
    const whs = q.warehouse_codes == null ? null : q.warehouse_codes.map((c) => String(c).trim()).filter(Boolean);
    const week = q.week && /^\d{4}-\d{2}-\d{2}$/.test(q.week) ? q.week : null;

    return this.tk.run(async (trx) => {
      // 1) Resolver semana de referencia (lunes ISO) + etiqueta, en TZ MX.
      const refRes: any = await trx.raw(
        `SELECT date_trunc('week', COALESCE(?::date, (now() AT TIME ZONE ?)::date))::date AS ws`,
        [week, MX_TZ],
      );
      const refStart: string = (refRes.rows[0].ws instanceof Date)
        ? refRes.rows[0].ws.toISOString().slice(0, 10)
        : String(refRes.rows[0].ws).slice(0, 10);
      const refEnd = addDays(refStart, 7);            // exclusivo
      const prevStart = addDays(refStart, -7);
      const windowStart = addDays(refStart, -(weeks - 1) * 7);
      const label = (ws: string) => this.isoWeekLabel(ws);

      // TIENDA = tienda: se sacan las camionetas de ruta (almacenes RUTA-%), que en sales_daily vienen
      // mal-etiquetadas con canal 'tienda'/'credito' (~8.2% = $4.43M en ago-2026). Una ruta no es una
      // tienda. La venta de ruta sigue VIVA en la tabla para el blend/Command Center (mv_sales_blended
      // leg RUTA-%); acá sólo se excluye de la vista de tienda. Aplica a todos los reads de sales_daily
      // y product_sales_daily de este método (usan whClause); la query de tickets ya excluía ruta.
      const whClause = (whs ? `AND w.code = ANY(?)` : ``) + ` AND w.code NOT LIKE 'RUTA-%'`;
      const whBind = whs ? [whs] : [];

      // 2) Serie de tendencia (sales_daily, historia completa).
      const seriesRes: any = await trx.raw(
        `SELECT date_trunc('week', sd.sale_date)::date AS ws,
                COALESCE(sum(sd.revenue),0)::float AS revenue,
                COALESCE(sum(sd.revenue - sd.cost),0)::float  AS margin,
                COALESCE(sum(sd.units),0)::float   AS units
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY 1 ORDER BY 1`,
        [tenantId, windowStart, refEnd, ...whBind],
      );
      const series = seriesRes.rows.map((r: any) => {
        const ws = r.ws instanceof Date ? r.ws.toISOString().slice(0, 10) : String(r.ws).slice(0, 10);
        return { week_start: ws, label: label(ws), revenue: +r.revenue, margin: +r.margin, units: +r.units };
      });

      // 3) KPIs semana ref vs previa (totales scoped). SD = $ + margen + unidades; PSD = unidades oficiales.
      const kpiSd: any = await trx.raw(
        `SELECT COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_cur,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_prev,
                COALESCE(sum(sd.revenue - sd.cost)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_cur,
                COALESCE(sum(sd.revenue - sd.cost)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_prev,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_cur,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_prev
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}`,
        [refStart, refEnd, prevStart, refStart, refStart, refEnd, prevStart, refStart,
         refStart, refEnd, prevStart, refStart, tenantId, prevStart, refEnd, ...whBind],
      );
      const kpiPsd: any = await trx.raw(
        `SELECT COALESCE(sum(psd.units) FILTER (WHERE psd.sale_date >= ? AND psd.sale_date < ?),0)::float AS off_cur,
                COALESCE(sum(psd.units) FILTER (WHERE psd.sale_date >= ? AND psd.sale_date < ?),0)::float AS off_prev
           FROM analytics.product_sales_daily psd
           JOIN commercial.warehouses w ON w.id = psd.warehouse_id
          WHERE psd.tenant_id = ? AND psd.sale_date >= ? AND psd.sale_date < ? ${whClause}`,
        [refStart, refEnd, prevStart, refStart, tenantId, prevStart, refEnd, ...whBind],
      );
      const s = kpiSd.rows[0], p = kpiPsd.rows[0];
      const kpis = {
        revenue: { cur: +s.rev_cur, prev: +s.rev_prev, delta_pct: pct(+s.rev_cur, +s.rev_prev) },
        margin: { cur: +s.mar_cur, prev: +s.mar_prev, delta_pct: pct(+s.mar_cur, +s.mar_prev) },
        units: { cur: +s.uni_cur, prev: +s.uni_prev, delta_pct: pct(+s.uni_cur, +s.uni_prev) },
        units_official: { cur: +p.off_cur, prev: +p.off_prev, delta_pct: pct(+p.off_cur, +p.off_prev) },
      };

      // 4) Desglose por sucursal (ref vs previa).
      const branchRes: any = await trx.raw(
        `SELECT w.code, w.name,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_cur,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_prev,
                COALESCE(sum(sd.revenue - sd.cost)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_cur,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_cur,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_prev
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY w.code, w.name
          ORDER BY rev_cur DESC`,
        [refStart, refEnd, prevStart, refStart, refStart, refEnd, refStart, refEnd, prevStart, refStart,
         tenantId, prevStart, refEnd, ...whBind],
      );
      const by_branch = branchRes.rows.map((r: any) => ({
        code: r.code, name: r.name,
        revenue: +r.rev_cur, revenue_prev: +r.rev_prev, revenue_delta_pct: pct(+r.rev_cur, +r.rev_prev),
        margin: +r.mar_cur, units: +r.uni_cur, units_prev: +r.uni_prev, units_delta_pct: pct(+r.uni_cur, +r.uni_prev),
      }));

      // 5) Top productos por venta $ (ref vs previa) + unidades oficiales (PSD) para esos SKUs.
      const prodRes: any = await trx.raw(
        `SELECT sd.product_id, pr.sku, pr.nombre, b.nombre AS brand,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_cur,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_prev,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_cur
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN catalog.brands b ON b.id = pr.brand_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY sd.product_id, pr.sku, pr.nombre, b.nombre
         HAVING COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0) > 0
          ORDER BY rev_cur DESC
          LIMIT 25`,
        [refStart, refEnd, prevStart, refStart, refStart, refEnd,
         tenantId, prevStart, refEnd, ...whBind, refStart, refEnd],
      );
      const by_product = prodRes.rows.map((r: any) => ({
        product_id: r.product_id, sku: r.sku, nombre: r.nombre, brand: r.brand || null,
        revenue: +r.rev_cur, revenue_prev: +r.rev_prev, revenue_delta_pct: pct(+r.rev_cur, +r.rev_prev),
        units: +r.uni_cur,
      }));

      return {
        ref_week: { start: refStart, label: label(refStart) },
        prev_week: { start: prevStart, label: label(prevStart) },
        weeks, scoped_warehouses: whs,
        series, kpis, by_branch, by_product,
      };
    });
  }

  /**
   * Análisis por RANGO PERSONALIZADO para el encargado de sucursal (/tienda/analisis-semanal).
   *
   * A diferencia de weekly(): rango libre [from,to] + métricas de operación de tienda que la
   * vista semanal no daba: **tickets**, **ticket promedio ($/ticket)**, **partidas por ticket**
   * (renglones/ticket), **valor por partida ($/renglón)**, **unidades por ticket** y **valor
   * unitario promedio ($/unidad)**. Compara contra el período INMEDIATAMENTE anterior del MISMO
   * tamaño. Los rótulos son los de `[TDA.P]` en `/tienda/live`: misma palanca, otra ventana.
   *
   * Fuentes:
   *  - `analytics.sales_daily` → venta $, margen, unidades (Kepler+Wincaja).
   *  - `analytics.product_sales_daily` → unidades oficiales + top productos.
   *  - `wincaja.maestro_mov_almacen` (grano DOCUMENTO=ticket, tipo='V', no cancelado) +
   *    `detalles_mov_almacen` (líneas) → tickets y líneas reales. Mapea a la sucursal vía
   *    `wincaja.branches.warehouse_code`. Es Wincaja-only (el POS de la tienda); sucursales/
   *    períodos sin Wincaja muestran tickets=0 (los KPIs $ igual salen de sales_daily).
   *
   * analytics.* sin RLS → tenant explícito, todo en tk.run(). SET LOCAL statement_timeout
   * como en sell-out: acota el toque a maestro/detalles y protege el pool.
   */
  async range(q: RangeQuery): Promise<any> {
    const tenantId = this.tenantCtx.requireTenantId();
    // `null` = sin filtro (alcance `all`). Array vacío = no ve ninguna sucursal,
    // que NO es lo mismo: se respeta y devuelve series en cero.
    const whs = q.warehouse_codes == null ? null : q.warehouse_codes.map((c) => String(c).trim()).filter(Boolean);
    const iso = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
    const from = iso(q.from);
    const to = iso(q.to);
    if (!from || !to) throw new BadRequestException('from/to requeridos (YYYY-MM-DD)');
    if (from > to) throw new BadRequestException('from posterior a to');
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (days > MAX_RANGE_DAYS) throw new BadRequestException(`rango máximo ${MAX_RANGE_DAYS} días`);
    // `[TDA.A1]` El top de productos se mudó a su propia pestaña; quien sólo quiere la
    // fotografía se ahorra la consulta cara. Default `true` = contrato viejo intacto.
    const withProducts = q.with_products !== false;
    const toExcl = addDays(to, 1);            // exclusivo (sale_date < toExcl)
    const prevFrom = addDays(from, -days);    // período previo del mismo tamaño
    const prevToExcl = from;                  // exclusivo = from (previo termina el día antes)

    // TIENDA = tienda: se sacan las camionetas de ruta (almacenes RUTA-%), mal-etiquetadas canal
    // 'tienda'/'credito' en sales_daily. Una ruta no es una tienda. La venta de ruta sigue viva en la
    // tabla para el blend/Command Center; acá sólo se excluye de la vista de tienda. (ver método weekly)
    const whClause = (whs ? `AND w.code = ANY(?)` : ``) + ` AND w.code NOT LIKE 'RUTA-%'`;
    const whBind = whs ? [whs] : [];

    return this.tk.run(async (trx) => {
      await trx.raw(`SET LOCAL statement_timeout = '30s'`);

      // 1) KPIs $ / margen / unidades (sales_daily), cur vs previo.
      const sd: any = await trx.raw(
        `SELECT COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_cur,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_prev,
                COALESCE(sum(sd.revenue - sd.cost)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_cur,
                COALESCE(sum(sd.revenue - sd.cost)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_prev,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_cur,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_prev
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}`,
        [from, toExcl, prevFrom, prevToExcl, from, toExcl, prevFrom, prevToExcl,
         from, toExcl, prevFrom, prevToExcl, tenantId, prevFrom, toExcl, ...whBind],
      );
      // 2) Unidades oficiales (product_sales_daily).
      const psd: any = await trx.raw(
        `SELECT COALESCE(sum(psd.units) FILTER (WHERE psd.sale_date >= ? AND psd.sale_date < ?),0)::float AS off_cur,
                COALESCE(sum(psd.units) FILTER (WHERE psd.sale_date >= ? AND psd.sale_date < ?),0)::float AS off_prev
           FROM analytics.product_sales_daily psd
           JOIN commercial.warehouses w ON w.id = psd.warehouse_id
          WHERE psd.tenant_id = ? AND psd.sale_date >= ? AND psd.sale_date < ? ${whClause}`,
        [from, toExcl, prevFrom, prevToExcl, tenantId, prevFrom, toExcl, ...whBind],
      );
      /**
       * 2b) CLIENTES CON REGISTRO que compraron en el período — el mostrador es
       * mayormente anónimo, así que ésta es la única cifra que dice *quién* compró.
       *
       * Fuente: `analytics.erp_sales_invoices` (vista viva sobre `kepler_ods`, Fase AX).
       * Es un universo DISTINTO del fact: son los documentos emitidos a nombre de un
       * cliente, no la venta agregada — no cuadra contra `revenue` y no debe cuadrar.
       *
       * Dos exclusiones, las dos verificadas contra la base (2026-09-10):
       *  · `cliente_code='CONTADO'` es literalmente el mostrador anónimo (1,129 docs).
       *    Se excluye ESE código y nada más: los códigos numéricos ('45', '103', '10448')
       *    NO son anónimos — son clientes con nombre ("ABARROTES ROSY", "PATRICIA PEREZ")
       *    de sucursales que usan otra numeración. Filtrar por "código que empieza con C"
       *    habría borrado la cartera entera de la 02.
       *  · `canal='TELEMARK'` es TELEVENTA, otro equipo con su propio módulo. Decisión de
       *    negocio (2026-09-10): esta pantalla cuenta mostrador. Pesa: en la 01 son 220
       *    clientes con televenta y 125 sin ella.
       *
       * `as_of` = último día CON documento dentro del período. La vista tiene su propia
       * frescura, distinta de la del fact, y sin declararla un feed atrasado se lee como
       * "no vino nadie".
       */
      const cliWh = whs ? `AND sucursal = ANY(?)` : ``;
      const cli: any = await trx.raw(
        `SELECT count(DISTINCT cliente_code) FILTER (WHERE fecha >= ? AND fecha < ?)::int AS cli_cur,
                count(DISTINCT cliente_code) FILTER (WHERE fecha >= ? AND fecha < ?)::int AS cli_prev,
                COALESCE(sum(total) FILTER (WHERE fecha >= ? AND fecha < ?),0)::float AS rev_cur,
                COALESCE(sum(total) FILTER (WHERE fecha >= ? AND fecha < ?),0)::float AS rev_prev,
                max(fecha) FILTER (WHERE fecha >= ? AND fecha < ?)::text AS as_of
           FROM analytics.erp_sales_invoices
          WHERE tenant_id = ? AND NOT cancelada
            AND cliente_code <> 'CONTADO' AND COALESCE(canal,'') <> 'TELEMARK'
            AND fecha >= ? AND fecha < ? ${cliWh}`,
        [from, toExcl, prevFrom, prevToExcl, from, toExcl, prevFrom, prevToExcl, from, toExcl,
         tenantId, prevFrom, toExcl, ...(whs ? [whs] : [])],
      );
      const cl = cli.rows[0];

      // 3) Tickets de TIENDA (mostrador, NO ruta) + líneas, por (sucursal, día) para [previo..to].
      //    Fuente unificada por CÓDIGO COMERCIAL, disjunta (sin doble conteo):
      //      · analytics.store_live_tickets → stores '01'–'05' (POS en vivo = lo que ve /tienda/live;
      //        Wincaja está congelado para esas plazas, que ya migraron a Kepler).
      //      · wincaja.maestro_mov_almacen (is_route=false, kepler_code IS NULL) → MD-30/32/50/00.
      //    Excluye rutas (is_route) y evita el desfase branches.warehouse_code('MD-10') vs código '01'
      //    (esos van por kepler_code, que aquí se excluyen del lado Wincaja y se cubren con el POS).
      const prevTo = addDays(prevToExcl, -1);
      // store_live_tickets.warehouse_code YA es el código comercial ('01'..'05'), idéntico a
      // commercial.warehouses.code y al lado maestro ('MD-30'…) → se filtra y agrupa DIRECTO,
      // sin traducir. (Un JOIN a branches.kepler_code lo convertía a 'MD-54' y luego filtraba
      // b2.warehouse_code='05' → 0 filas: ese era el bug de "ticket promedio $0" en sucursales
      // Kepler. El código comercial ya coincide en ambos lados, no hay nada que traducir.)
      const bWh = whs ? `AND warehouse_code = ANY(?)` : ``;
      const mWh = whs ? `AND b.warehouse_code = ANY(?)` : ``;
      const tkDaily: any = await trx.raw(
        `WITH tk AS (
           SELECT warehouse_code, ticket_ts::date AS d, count(*)::int AS tickets,
                  COALESCE(sum(jsonb_array_length(items)), 0)::int AS lines
             FROM analytics.store_live_tickets
            WHERE tenant_id = ? AND ticket_ts::date >= ? AND ticket_ts::date <= ? ${bWh}
            GROUP BY 1, 2
           UNION ALL
           SELECT b.warehouse_code, m.fecha::date AS d,
                  count(DISTINCT (m.source_branch || '|' || m.consecutivo))::int AS tickets,
                  count(dt.*)::int AS lines
             FROM wincaja.maestro_mov_almacen m
             JOIN wincaja.branches b ON b.tenant_id = m.tenant_id AND b.source_branch = m.source_branch
                                    AND b.is_route = false AND b.kepler_code IS NULL
             LEFT JOIN wincaja.detalles_mov_almacen dt
               ON dt.tenant_id = m.tenant_id AND dt.source_branch = m.source_branch
              AND dt.source_dataset = m.source_dataset AND dt.consecutivo = m.consecutivo AND dt.tipo = 'V'
            WHERE m.tenant_id = ? AND m.tipo = 'V' AND COALESCE(m.cancelado, false) = false
              -- SOLO ventas de PDV (mostrador): se excluyen las cajas con canal especial en
              -- caja_channels — mayoreo_credito(70), preventa_vecinal(15), ruta_bordo(98),
              -- traspaso_almacen(99), almacen(90), compras(95/96). Las cajas de mostrador no
              -- están en esa tabla → se conservan. Consistente con el poller live.
              AND NOT EXISTS (
                SELECT 1 FROM wincaja.caja_channels k
                 WHERE k.tenant_id = m.tenant_id AND k.caja = m.caja
                   AND (k.source_branch = m.source_branch OR k.source_branch = '*'))
              AND m.fecha::date >= ? AND m.fecha::date <= ? ${mWh}
            GROUP BY 1, 2
         )
         SELECT warehouse_code, d, sum(tickets)::int AS tickets, sum(lines)::int AS lines
           FROM tk GROUP BY 1, 2`,
        [tenantId, prevFrom, to, ...(whs ? [whs] : []), tenantId, prevFrom, to, ...(whs ? [whs] : [])],
      );
      const inCur = (d: string) => d >= from && d <= to;
      const inPrev = (d: string) => d >= prevFrom && d <= prevTo;
      let tkCur = 0, tkPrev = 0, lnCur = 0, lnPrev = 0;
      const tkByDay = new Map<string, number>();
      const brAgg = new Map<string, { tickets: number; lines: number }>();
      // Días DISTINTOS con ticket, por período: es la cobertura real del POS, que no se
      // puede deducir del total (105 tickets pueden ser 15 días o uno solo).
      const posDaysCur = new Set<string>(), posDaysPrev = new Set<string>();
      for (const r of tkDaily.rows) {
        const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
        const tks = Number(r.tickets) || 0, lns = Number(r.lines) || 0;
        if (inCur(d)) {
          tkCur += tks; lnCur += lns;
          tkByDay.set(d, (tkByDay.get(d) || 0) + tks);
          if (tks > 0) posDaysCur.add(d);
          const a = brAgg.get(r.warehouse_code) || { tickets: 0, lines: 0 };
          a.tickets += tks; a.lines += lns; brAgg.set(r.warehouse_code, a);
        } else if (inPrev(d)) { tkPrev += tks; lnPrev += lns; if (tks > 0) posDaysPrev.add(d); }
      }

      // 4) Serie DIARIA del fact (venta + unidades). Se pide sobre [previo..to] —no sólo el
      //    período actual— porque de acá sale también la COBERTURA del período previo, que
      //    es la que decide si el Δ% de las razones cruzadas significa algo.
      const dailySd: any = await trx.raw(
        `SELECT sd.sale_date::date AS d, sum(sd.revenue)::float AS revenue, sum(sd.revenue - sd.cost)::float AS margin, sum(sd.units)::float AS units
           FROM ${SALES_FACT} sd JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY 1 ORDER BY 1`,
        [tenantId, prevFrom, toExcl, ...whBind],
      );
      const factDaysCur = new Set<string>(), factDaysPrev = new Set<string>();
      const series: { date: string; revenue: number; margin: number; units: number; tickets: number }[] = [];
      for (const r of dailySd.rows) {
        const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
        const rev = +r.revenue;
        if (inCur(d)) {
          if (rev > 0) factDaysCur.add(d);
          series.push({ date: d, revenue: rev, margin: +r.margin, units: +r.units, tickets: tkByDay.get(d) || 0 });
        } else if (inPrev(d) && rev > 0) { factDaysPrev.add(d); }
      }

      /**
       * COBERTURA MEDIDA, no supuesta. Las razones que cruzan las dos fuentes (venta del
       * fact ÷ tickets/partidas del POS) sólo son comparables si ambas cubren los MISMOS
       * días. Un denominador que existe pero cubre 2 de 15 días NO da cero: da un número
       * absurdo —venta de 15 días entre tickets de 2— y eso es peor que el cero, porque
       * parece medido. Medido en `platform_test` el 2026-09-10: el fact traía 15 días y el
       * POS 2 → "valor por partida" salía $6,180.66. Se declara no medido.
       */
      const cubre = (pos: Set<string>, fact: Set<string>) => fact.size > 0 && pos.size >= fact.size;
      const crossCur = cubre(posDaysCur, factDaysCur);
      const crossPrev = cubre(posDaysPrev, factDaysPrev);
      const cross = (num: number, den: number, ok: boolean) => (ok ? ratio(num, den) : null);

      const s = sd.rows[0], p = psd.rows[0];
      const avg = (rev: number, n: number) => (n > 0 ? rev / n : 0);
      const basket = (ln: number, n: number) => (n > 0 ? ln / n : 0);
      const kpis = {
        revenue: { cur: +s.rev_cur, prev: +s.rev_prev, delta_pct: pct(+s.rev_cur, +s.rev_prev) },
        margin: { cur: +s.mar_cur, prev: +s.mar_prev, delta_pct: pct(+s.mar_cur, +s.mar_prev) },
        /**
         * Margen como % de la venta — la cifra que se compara contra el objetivo del
         * negocio (~11.5%), porque el margen en pesos sube y baja con el volumen.
         * Fuente única (`sales_daily`), así que no pasa por la compuerta de cobertura.
         *
         * ⚠️ ADR-051 (enmendado): el costo del fact NO es homogéneo — en la mitad
         * Wincaja es `ValorCosto` real y en la mitad Kepler es `revenue/(1+markup_pct)`,
         * que es álgebra ciega al precio. O sea que en esa mitad el % tiende a
         * reproducir el markup configurado en vez de medir el margen realizado.
         * Medido en las 5 tiendas (30 d): 10.24% mostrador / 10.69% crédito, contra
         * el ~11.5% que reporta el negocio. Sirve para mirar tendencia, no para cerrar.
         */
        margin_pct: { cur: ratioPct(+s.mar_cur, +s.rev_cur), prev: ratioPct(+s.mar_prev, +s.rev_prev), delta_pct: null },
        units: { cur: +s.uni_cur, prev: +s.uni_prev, delta_pct: pct(+s.uni_cur, +s.uni_prev) },
        units_official: { cur: +p.off_cur, prev: +p.off_prev, delta_pct: pct(+p.off_cur, +p.off_prev) },
        tickets: { cur: tkCur, prev: tkPrev, delta_pct: pct(tkCur, tkPrev) },
        avg_ticket: { cur: avg(+s.rev_cur, tkCur), prev: avg(+s.rev_prev, tkPrev), delta_pct: pct(avg(+s.rev_cur, tkCur), avg(+s.rev_prev, tkPrev)) },
        /** Partidas por ticket = RENGLONES del ticket (no piezas). Antes se rotulaba
         *  "productos/ticket", que se confundía con unidades; el cálculo no cambió. */
        basket: { cur: basket(lnCur, tkCur), prev: basket(lnPrev, tkPrev), delta_pct: pct(basket(lnCur, tkCur), basket(lnPrev, tkPrev)) },
        /**
         * Descomposición del ticket, de lo grueso a lo fino: cuánto vale el ticket →
         * cuánto vale cada partida → cuántas unidades se lleva → cuánto vale la unidad.
         *
         * OJO con el universo de cada razón:
         *  · `avg_line` y `units_per_ticket` dividen venta/unidades de TODOS los canales de
         *    la sucursal (incluye `credito` = mayoreo, 13–22% de la venta según plaza) entre
         *    partidas/tickets que son SOLO mostrador → quedan sobrestimadas mientras eso no
         *    se empareje. Misma deuda que `avg_ticket`, no una nueva.
         *  · `avg_unit` es el único limpio: numerador y denominador salen ambos de
         *    `analytics.sales_daily`, mismo universo y misma fila.
         */
        avg_line: { cur: cross(+s.rev_cur, lnCur, crossCur), prev: cross(+s.rev_prev, lnPrev, crossPrev), delta_pct: pctN(cross(+s.rev_cur, lnCur, crossCur), cross(+s.rev_prev, lnPrev, crossPrev)) },
        units_per_ticket: { cur: cross(+s.uni_cur, tkCur, crossCur), prev: cross(+s.uni_prev, tkPrev, crossPrev), delta_pct: pctN(cross(+s.uni_cur, tkCur, crossCur), cross(+s.uni_prev, tkPrev, crossPrev)) },
        avg_unit: { cur: ratio(+s.rev_cur, +s.uni_cur), prev: ratio(+s.rev_prev, +s.uni_prev), delta_pct: pctN(ratio(+s.rev_cur, +s.uni_cur), ratio(+s.rev_prev, +s.uni_prev)) },
        /**
         * Clientes con registro (ver 2b) y lo que compró cada uno en promedio. El
         * promedio se calcula con la venta DE ESOS DOCUMENTOS, no con la venta total
         * de la tienda: dividir la venta de mostrador entre los clientes con nombre
         * daría un número inflado y sin significado.
         */
        customers: { cur: +cl.cli_cur, prev: +cl.cli_prev, delta_pct: pct(+cl.cli_cur, +cl.cli_prev) },
        revenue_per_customer: {
          cur: ratio(+cl.rev_cur, +cl.cli_cur), prev: ratio(+cl.rev_prev, +cl.cli_prev),
          delta_pct: pctN(ratio(+cl.rev_cur, +cl.cli_cur), ratio(+cl.rev_prev, +cl.cli_prev)),
        },
      };

      // 5) Por sucursal (si el user ve más de una): venta/margen/unidades + tickets.
      const branchRes: any = await trx.raw(
        `SELECT w.code, w.name,
                sum(sd.revenue)::float AS revenue, sum(sd.revenue - sd.cost)::float AS margin, sum(sd.units)::float AS units
           FROM ${SALES_FACT} sd JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY w.code, w.name ORDER BY revenue DESC`,
        [tenantId, from, toExcl, ...whBind],
      );
      const by_branch = branchRes.rows.map((r: any) => {
        const tks = brAgg.get(r.code)?.tickets || 0;
        return {
          code: r.code, name: r.name, revenue: +r.revenue, margin: +r.margin, units: +r.units,
          tickets: tks, avg_ticket: avg(+r.revenue, tks),
        };
      });

      // 6) Top productos por venta $ + unidades oficiales. Se OMITE si el llamador
      //    no la va a dibujar (`with_products=0`): es la consulta cara del método.
      const prodRes: any = withProducts
        ? await trx.raw(
            `SELECT sd.product_id, pr.sku, pr.nombre, b.nombre AS brand,
                sum(sd.revenue)::float AS revenue, sum(sd.revenue - sd.cost)::float AS margin, sum(sd.units)::float AS units
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN catalog.brands b ON b.id = pr.brand_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY sd.product_id, pr.sku, pr.nombre, b.nombre
         HAVING sum(sd.revenue) > 0
          ORDER BY revenue DESC LIMIT 50`,
            [tenantId, from, toExcl, ...whBind],
          )
        : { rows: [] };
      const by_product = prodRes.rows.map((r: any) => ({
        product_id: r.product_id, sku: r.sku, nombre: r.nombre, brand: r.brand || null,
        revenue: +r.revenue, margin: +r.margin, units: +r.units,
      }));

      return {
        period: { from, to, days },
        prev_period: { from: prevFrom, to: addDays(prevToExcl, -1) },
        scoped_warehouses: whs,
        /**
         * Hasta qué día alcanza cada fuente DENTRO del período. Van juntas y por
         * separado a propósito: el fact y la facturación se atrasan distinto, y un
         * solo "actualizado hace X" para toda la pantalla sería mentira (ADR-056).
         * `null` = esa fuente no trajo nada en el período.
         */
        as_of: {
          fact: series.length ? series[series.length - 1].date : null,
          customers: cl.as_of || null,
        },
        kpis, series, by_branch, by_product,
      };
    });
  }

  /**
   * `[TDA.A1]` CASCADA POR PERÍODO — la misma fotografía, repetida hacia abajo.
   *
   * `range()` contesta "cómo vengo". Ésta contesta "cómo vengo COMPARADO CONMIGO
   * MISMO": parte el MISMO rango en buckets del grano pedido (semana · día de la
   * semana · mes · trimestre · año) y publica en cada uno el mismo juego de
   * indicadores. Cada fila abre a un segundo nivel —la «cascada»—: la semana abre a
   * sus días, el lunes abre a cada lunes, el trimestre a sus meses.
   *
   * ⚠️ **Un solo control de tiempo.** El rango de la pantalla manda; el grano sólo
   * agrupa. Por eso no hay un "últimos N períodos" propio: dos controles de tiempo en
   * la misma pantalla obligan al que la mira a adivinar cuál ganó.
   *
   * ⚠️ **El bucket se define una sola vez, en SQL** (`GRAIN_SQL`). `generate_series`
   * devuelve el mapa `día → bucket padre → bucket hijo` y todo se agrupa con ese mapa:
   * el fact, el POS y —sobre todo— los clientes, que se cuentan con `count(DISTINCT)`
   * y por eso NO se pueden rodar desde el grano diario (el mismo cliente que vino
   * lunes y martes es uno en la semana, no dos).
   *
   * Fuentes y compuertas: las mismas de `range()`. La de cobertura se evalúa **por
   * bucket**, no para el rango entero: un mes donde el POS cubrió 3 de 30 días declara
   * sus razones cruzadas como no medidas aunque el rango completo sí alcance.
   */
  async breakdown(q: BreakdownQuery): Promise<BreakdownReport> {
    const tenantId = this.tenantCtx.requireTenantId();
    const whs = q.warehouse_codes == null ? null : q.warehouse_codes.map((c) => String(c).trim()).filter(Boolean);
    const isoOk = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
    const from = isoOk(q.from);
    const to = isoOk(q.to);
    if (!from || !to) throw new BadRequestException('from/to requeridos (YYYY-MM-DD)');
    if (from > to) throw new BadRequestException('from posterior a to');
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (days > MAX_RANGE_DAYS) throw new BadRequestException(`rango máximo ${MAX_RANGE_DAYS} días`);
    // Whitelist cerrada: la llave se concatena dentro de un `date_trunc`.
    const grain: BreakdownGrain = (Object.prototype.hasOwnProperty.call(GRAIN_SQL, String(q.grain))
      ? String(q.grain)
      : 'month') as BreakdownGrain;
    const childGrain = GRAIN_SQL[grain].child;
    const toExcl = addDays(to, 1);

    // Mismo recorte que el resto de /tienda: una camioneta de ruta no es una tienda.
    const whClause = (whs ? `AND w.code = ANY(?)` : ``) + ` AND w.code NOT LIKE 'RUTA-%'`;
    const whBind = whs ? [whs] : [];

    /**
     * `[TDA.A2]`/`[TDA.A3]` MODO ACOTADO — a una línea o a un producto. Recorta el fact y
     * **apaga el POS y los clientes**: no los filtra, los apaga.
     *
     * No es una limitación técnica: un ticket lleva productos de varias líneas y de varios
     * productos, así que *tickets*, *partidas por ticket*, *ticket promedio*, *$/partida*,
     * *unidades por ticket* y *clientes* NO son atribuibles a lo seleccionado. Repartirlos
     * sería inventar; dejar el número de la tienda entera sería peor, porque en una tabla
     * encabezada «La Rosa» se leería como de La Rosa. Vuelven `null` y la pantalla esconde
     * esas columnas diciendo por qué. Lo que sí queda —venta, margen, unidades y
     * $/unidad— sale entero del fact y es atribuible fila por fila.
     *
     * El producto gana sobre la línea si vinieran los dos: es el recorte más específico, y
     * aplicar los dos a la vez daría un resultado que depende de cuál se evaluó primero.
     */
    const prodId = String(q.product_id || '').trim();
    const linea = prodId ? '' : String(q.supplier_code || '').trim();
    const modoLinea = prodId.length > 0 || linea.length > 0;   // «acotado», el nombre quedó del A2
    const linJoin = linea
      ? `JOIN catalog.products pr ON pr.id = sd.product_id
         LEFT JOIN catalog.suppliers s ON s.id = pr.supplier_id`
      : ``;
    const linClause = prodId
      ? `AND sd.product_id = ?::uuid`
      : !linea ? `` : linea === SIN_LINEA ? `AND pr.supplier_id IS NULL` : `AND s.code = ?`;
    const linBind = prodId ? [prodId] : (linea && linea !== SIN_LINEA ? [linea] : []);

    return this.tk.run(async (trx) => {
      await trx.raw(`SET LOCAL statement_timeout = '30s'`);

      // 0) EL MAPA DEL CALENDARIO — la única definición de qué día cae en qué bucket.
      const cal: any = await trx.raw(
        `SELECT g.d::date::text AS day,
                ${GRAIN_SQL[grain].expr('g.d')} AS pb,
                ${CHILD_SQL[childGrain]('g.d')}  AS cb
           FROM generate_series(?::date, ?::date, interval '1 day') g(d)
          ORDER BY 1`,
        [from, to],
      );
      const parentOf = new Map<string, string>();
      const childOf = new Map<string, string>();
      /** Orden cronológico de los buckets: sale del calendario, no del orden de llegada de los datos. */
      const parentSeq: string[] = [];
      const parentSeen = new Set<string>();
      const childSeq = new Map<string, string[]>();
      for (const r of cal.rows) {
        const day = String(r.day), pb = String(r.pb), cb = String(r.cb);
        parentOf.set(day, pb);
        childOf.set(day, cb);
        if (!parentSeen.has(pb)) { parentSeen.add(pb); parentSeq.push(pb); }
        const kids = childSeq.get(pb) ?? [];
        if (!kids.includes(cb)) { kids.push(cb); childSeq.set(pb, kids); }
      }
      /**
       * `weekday` es el único grano cuyo orden NO es el del calendario: los 7 días van
       * lunes → domingo siempre. Tomando el orden de aparición, un rango que empieza en
       * viernes abría la tabla con «Viernes, Sábado, Domingo, Lunes…» — la semana
       * desordenada y distinta cada vez que se mueve el filtro. (Lo cazó el smoke.)
       */
      if (grain === 'weekday') parentSeq.sort((a, b) => Number(a) - Number(b));

      // 1) Fact por DÍA (venta, margen, unidades). En modo línea, acotado a esa línea.
      const factRes: any = await trx.raw(
        `SELECT sd.sale_date::date::text AS d,
                sum(sd.revenue)::float AS revenue,
                sum(sd.revenue - sd.cost)::float AS margin,
                sum(sd.units)::float AS units
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           ${linJoin}
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause} ${linClause}
          GROUP BY 1 ORDER BY 1`,
        [tenantId, from, toExcl, ...whBind, ...linBind],
      );

      // 2) POS por DÍA (tickets + partidas). Misma unión DISJUNTA que `range()`:
      //    `store_live_tickets` cubre las plazas ya migradas a Kepler y `wincaja` las
      //    que siguen en su POS (`kepler_code IS NULL`) — no se solapan.
      const bWh = whs ? `AND warehouse_code = ANY(?)` : ``;
      const mWh = whs ? `AND b.warehouse_code = ANY(?)` : ``;
      // En modo línea no se pide: el POS no sabe de líneas y su número no es atribuible.
      // Además se ahorra la consulta más cara del método.
      const posRes: any = modoLinea ? { rows: [] } : await trx.raw(
        `WITH tk AS (
           SELECT ticket_ts::date AS d, count(*)::int AS tickets,
                  COALESCE(sum(jsonb_array_length(items)), 0)::int AS lines
             FROM analytics.store_live_tickets
            WHERE tenant_id = ? AND ticket_ts::date >= ? AND ticket_ts::date <= ? ${bWh}
            GROUP BY 1
           UNION ALL
           SELECT m.fecha::date AS d,
                  count(DISTINCT (m.source_branch || '|' || m.consecutivo))::int AS tickets,
                  count(dt.*)::int AS lines
             FROM wincaja.maestro_mov_almacen m
             JOIN wincaja.branches b ON b.tenant_id = m.tenant_id AND b.source_branch = m.source_branch
                                    AND b.is_route = false AND b.kepler_code IS NULL
             LEFT JOIN wincaja.detalles_mov_almacen dt
               ON dt.tenant_id = m.tenant_id AND dt.source_branch = m.source_branch
              AND dt.source_dataset = m.source_dataset AND dt.consecutivo = m.consecutivo AND dt.tipo = 'V'
            WHERE m.tenant_id = ? AND m.tipo = 'V' AND COALESCE(m.cancelado, false) = false
              AND NOT EXISTS (
                SELECT 1 FROM wincaja.caja_channels k
                 WHERE k.tenant_id = m.tenant_id AND k.caja = m.caja
                   AND (k.source_branch = m.source_branch OR k.source_branch = '*'))
              AND m.fecha::date >= ? AND m.fecha::date <= ? ${mWh}
            GROUP BY 1
         )
         SELECT d::text AS d, sum(tickets)::int AS tickets, sum(lines)::int AS lines
           FROM tk GROUP BY 1`,
        [tenantId, from, to, ...(whs ? [whs] : []), tenantId, from, to, ...(whs ? [whs] : [])],
      );

      /**
       * 3) CLIENTES CON REGISTRO por bucket — padre e hijo, agrupados en SQL con la
       * MISMA expresión del mapa. Universo y exclusiones idénticas a `range()` (ver el
       * bloque 2b de ese método): fuera el mostrador anónimo `CONTADO`, fuera televenta.
       */
      const cliWh = whs ? `AND sucursal = ANY(?)` : ``;
      const cliSql = (bucketExpr: string) =>
        `SELECT ${bucketExpr} AS b,
                count(DISTINCT cliente_code)::int AS customers,
                COALESCE(sum(total), 0)::float AS revenue,
                max(fecha)::text AS as_of
           FROM analytics.erp_sales_invoices
          WHERE tenant_id = ? AND NOT cancelada
            AND cliente_code <> 'CONTADO' AND COALESCE(canal, '') <> 'TELEMARK'
            AND fecha >= ? AND fecha < ? ${cliWh}
          GROUP BY 1`;
      const cliBind = [tenantId, from, toExcl, ...(whs ? [whs] : [])];
      // Tampoco en modo línea: la factura es del cliente, no de la línea. Contar «los
      // clientes de La Rosa» exigiría mirar qué llevaba cada documento, y aun así un
      // cliente que compró tres líneas contaría tres veces si alguien sumara la columna.
      const cliParent: any = modoLinea ? { rows: [] } : await trx.raw(cliSql(GRAIN_SQL[grain].expr('fecha')), cliBind);
      const cliChild: any = modoLinea ? { rows: [] } : await trx.raw(cliSql(CHILD_SQL[childGrain]('fecha')), cliBind);

      // ── Agregación en memoria, SIEMPRE contra el mapa del calendario ──
      type Acc = {
        revenue: number; margin: number; units: number; tickets: number; lines: number;
        factDays: number; posDays: number; from: string; to: string;
      };
      const nuevo = (): Acc => ({ revenue: 0, margin: 0, units: 0, tickets: 0, lines: 0, factDays: 0, posDays: 0, from: '', to: '' });
      const padres = new Map<string, Acc>();
      const hijos = new Map<string, Acc>();
      const kkey = (pb: string, cb: string) => `${pb}>${cb}`;
      const tocar = (acc: Acc, day: string) => {
        if (!acc.from || day < acc.from) acc.from = day;
        if (!acc.to || day > acc.to) acc.to = day;
      };
      /** Aplica una fila diaria a su padre y a su hijo. Un día fuera del mapa se ignora. */
      const aplicar = (day: string, fn: (a: Acc) => void) => {
        const pb = parentOf.get(day);
        const cb = childOf.get(day);
        if (pb == null || cb == null) return;
        const p = padres.get(pb) ?? nuevo(); fn(p); tocar(p, day); padres.set(pb, p);
        const k = kkey(pb, cb);
        const h = hijos.get(k) ?? nuevo(); fn(h); tocar(h, day); hijos.set(k, h);
      };

      let lastFactDay: string | null = null;
      for (const r of factRes.rows) {
        const d = String(r.d);
        const rev = +r.revenue, mar = +r.margin, uni = +r.units;
        aplicar(d, (a) => {
          a.revenue += rev; a.margin += mar; a.units += uni;
          // La cobertura cuenta DÍAS con venta, no filas: es lo que hace comparable el
          // numerador del fact con el denominador del POS.
          if (rev > 0) a.factDays += 1;
        });
        if (rev > 0 && (!lastFactDay || d > lastFactDay)) lastFactDay = d;
      }
      for (const r of posRes.rows) {
        const d = String(r.d);
        const tks = Number(r.tickets) || 0, lns = Number(r.lines) || 0;
        aplicar(d, (a) => { a.tickets += tks; a.lines += lns; if (tks > 0) a.posDays += 1; });
      }

      const cliMap = (res: any) => {
        const m = new Map<string, { customers: number; revenue: number }>();
        for (const r of res.rows) m.set(String(r.b), { customers: Number(r.customers) || 0, revenue: +r.revenue });
        return m;
      };
      const cliP = cliMap(cliParent), cliC = cliMap(cliChild);
      const asOfCli: string | null = cliParent.rows.reduce((mx: string | null, r: any) => {
        const v = r.as_of ? String(r.as_of).slice(0, 10) : null;
        return v && (!mx || v > mx) ? v : mx;
      }, null);

      const totals = { revenue: 0, margin: 0, units: 0, tickets: 0 };
      for (const a of padres.values()) {
        totals.revenue += a.revenue; totals.margin += a.margin;
        totals.units += a.units; totals.tickets += a.tickets;
      }

      /**
       * Arma una fila. `denom` es el total contra el que se mide la participación (la
       * ventana para los padres, el padre para los hijos) y `prev` la fila anterior del
       * mismo nivel.
       */
      const fila = (
        key: string, gr: BreakdownGrain | BreakdownChildGrain, a: Acc,
        cli: { customers: number; revenue: number } | undefined,
        denom: number, prev: BreakdownRow | null, comparable: boolean,
      ): BreakdownRow => {
        // Compuerta de cobertura EN ESTE BUCKET: la venta del fact sólo se puede dividir
        // entre tickets/partidas del POS si el POS cubrió los mismos días. Si no, el
        // cociente no da cero — da un absurdo que parece medido.
        const cruzaOk = a.factDays > 0 && a.posDays >= a.factDays;
        const cross = (num: number, den: number) => (cruzaOk ? ratio(num, den) : null);
        const c = cli ?? { customers: 0, revenue: 0 };
        return {
          key,
          label: this.bucketLabel(gr, key),
          sub: this.bucketSub(gr, a.from, a.to, a.factDays),
          from: a.from, to: a.to,
          // En modo línea el POS y los clientes NO se preguntaron: vuelven `null`, que
          // dice "no aplica", y no 0, que diría "no hubo".
          fact_days: a.factDays, pos_days: modoLinea ? null : a.posDays,
          revenue: a.revenue, margin: a.margin, margin_pct: ratioPct(a.margin, a.revenue),
          units: a.units, tickets: modoLinea ? null : a.tickets,
          avg_ticket: modoLinea ? null : ratio(a.revenue, a.tickets),
          basket: modoLinea ? null : ratio(a.lines, a.tickets),
          avg_line: modoLinea ? null : cross(a.revenue, a.lines),
          units_per_ticket: modoLinea ? null : cross(a.units, a.tickets),
          avg_unit: ratio(a.revenue, a.units),
          customers: modoLinea ? null : c.customers,
          revenue_per_customer: modoLinea ? null : ratio(c.revenue, c.customers),
          share_pct: ratioPct(a.revenue, denom),
          delta_pct: comparable && prev ? pct(a.revenue, prev.revenue) : null,
          children: [],
        };
      };

      /**
       * En grano `weekday` los padres NO son una serie en el tiempo: el lunes no viene
       * "después" del domingo. Los HIJOS sí lo llevan — cada lunes contra el lunes
       * anterior es exactamente la pregunta que ese grano hace.
       */
      const padresComparables = grain !== 'weekday';

      const rows: BreakdownRow[] = [];
      for (const pb of parentSeq) {
        const a = padres.get(pb);
        if (!a) continue;
        const r = fila(pb, grain, a, cliP.get(pb), totals.revenue, rows.length ? rows[rows.length - 1] : null, padresComparables);
        for (const cb of childSeq.get(pb) ?? []) {
          const ha = hijos.get(kkey(pb, cb));
          if (!ha) continue;
          r.children.push(
            fila(cb, childGrain, ha, cliC.get(cb), a.revenue, r.children.length ? r.children[r.children.length - 1] : null, true),
          );
        }
        rows.push(r);
      }

      /**
       * El nombre del recorte sale de la CONSULTA, no del parámetro: si el código no
       * existe el endpoint devuelve cero filas, y la pantalla tiene que poder decir «eso
       * no vendió nada» en vez de repetirle al usuario el código que ya escribió.
       */
      let scope: { kind: 'linea' | 'producto'; code: string; name: string } | null = null;
      if (prodId) {
        const nom: any = await trx.raw(
          `SELECT nombre, sku FROM catalog.products WHERE tenant_id = ? AND id = ?::uuid LIMIT 1`, [tenantId, prodId]);
        scope = { kind: 'producto', code: prodId, name: nom.rows[0]?.nombre || nom.rows[0]?.sku || 'Producto' };
      } else if (linea) {
        const nom: any = linea === SIN_LINEA
          ? { rows: [{ name: 'Sin línea asignada' }] }
          : await trx.raw(`SELECT name FROM catalog.suppliers WHERE tenant_id = ? AND code = ? LIMIT 1`, [tenantId, linea]);
        scope = { kind: 'linea', code: linea, name: nom.rows[0]?.name || linea };
      }

      return {
        period: { from, to, days },
        grain, child_grain: childGrain,
        totals: { ...totals, tickets: modoLinea ? null : totals.tickets },
        rows,
        as_of: { fact: lastFactDay, customers: modoLinea ? null : asOfCli },
        scope,
      };
    });
  }

  /**
   * `[TDA.A2]` LAS LÍNEAS — la venta de la tienda repartida por proveedor del catálogo.
   *
   * Ver el bloque «Línea = el proveedor del catálogo» arriba para por qué ésta es la
   * atribución correcta y por qué la de «quién entregó» se descartó con medición.
   *
   * Los productos SIN línea asignada salen en su propia fila (`SIN_LINEA`) en vez de
   * desaparecer por un `INNER JOIN`. Hoy son centavos ($21,669 de $105.17M), pero el día
   * que alguien dé de alta productos sin línea, el total de esta tabla dejaría de cuadrar
   * con la fotografía **y nadie lo vería** — que es exactamente cómo se pierde un cuadre.
   */
  async suppliers(q: SupplierQuery): Promise<SupplierReport> {
    const tenantId = this.tenantCtx.requireTenantId();
    const whs = q.warehouse_codes == null ? null : q.warehouse_codes.map((c) => String(c).trim()).filter(Boolean);
    const { from, to, days, toExcl, prevFrom, prevToExcl } = this.ventana(q.from, q.to);
    const whClause = (whs ? `AND w.code = ANY(?)` : ``) + ` AND w.code NOT LIKE 'RUTA-%'`;
    const whBind = whs ? [whs] : [];

    return this.tk.run(async (trx) => {
      await trx.raw(`SET LOCAL statement_timeout = '30s'`);
      const res: any = await trx.raw(
        `SELECT COALESCE(s.code, ?) AS code,
                COALESCE(max(s.name), 'Sin línea asignada') AS name,
                COALESCE(sum(sd.revenue)           FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS rev_cur,
                COALESCE(sum(sd.revenue)           FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS rev_prev,
                COALESCE(sum(sd.revenue - sd.cost) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS mar_cur,
                COALESCE(sum(sd.units)             FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS uni_cur,
                count(DISTINCT sd.product_id) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ? AND sd.revenue > 0)::int AS skus,
                max(sd.sale_date) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ? AND sd.revenue > 0)::text AS as_of
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN catalog.suppliers s ON s.id = pr.supplier_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY 1
         HAVING COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0) <> 0
             OR COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0) <> 0
          ORDER BY rev_cur DESC`,
        [SIN_LINEA,
         from, toExcl, prevFrom, prevToExcl, from, toExcl, from, toExcl, from, toExcl, from, toExcl,
         tenantId, prevFrom, toExcl, ...whBind,
         from, toExcl, prevFrom, prevToExcl],
      );

      const totals = { revenue: 0, margin: 0, units: 0 };
      let asOf: string | null = null;
      for (const r of res.rows) {
        totals.revenue += +r.rev_cur; totals.margin += +r.mar_cur; totals.units += +r.uni_cur;
        const a = r.as_of ? String(r.as_of).slice(0, 10) : null;
        if (a && (!asOf || a > asOf)) asOf = a;
      }
      const rows: SupplierRow[] = res.rows.map((r: any) => ({
        code: String(r.code), name: r.name,
        revenue: +r.rev_cur, revenue_prev: +r.rev_prev, delta_pct: pct(+r.rev_cur, +r.rev_prev),
        margin: +r.mar_cur, margin_pct: ratioPct(+r.mar_cur, +r.rev_cur),
        units: +r.uni_cur, skus: Number(r.skus) || 0,
        share_pct: ratioPct(+r.rev_cur, totals.revenue),
      }));

      /**
       * Concentración MEDIDA, no un supuesto de diseño: cuántas líneas hacen la mitad de
       * la venta. Es lo que decide si esta tabla se lee de un golpe o hay que buscar.
       */
      let acum = 0, p50: number | null = null, p80: number | null = null;
      const conVenta = rows.filter((r) => r.revenue > 0);
      for (let i = 0; i < conVenta.length; i++) {
        acum += conVenta[i].revenue;
        if (p50 === null && acum >= totals.revenue * 0.5) p50 = i + 1;
        if (p80 === null && acum >= totals.revenue * 0.8) { p80 = i + 1; break; }
      }

      return {
        period: { from, to, days },
        prev_period: { from: prevFrom, to: addDays(prevToExcl, -1) },
        totals, rows,
        concentracion: { lineas: conVenta.length, para_50: p50, para_80: p80 },
        as_of: { fact: asOf },
      };
    });
  }

  /**
   * `[TDA.A2]` Los productos de UNA línea. Es el detalle del master-detail: la tabla de
   * líneas de arriba manda el código y acá bajan sus SKUs con venta.
   *
   * `share_pct` es participación **dentro de la línea**, no de la tienda: es la pregunta
   * que se hace al abrir una línea («¿de qué vive?»), y contra el total de la tienda los
   * números serían tan chicos que no se distinguirían entre sí.
   */
  async supplierProducts(q: SupplierQuery): Promise<SupplierProductsReport> {
    const tenantId = this.tenantCtx.requireTenantId();
    const whs = q.warehouse_codes == null ? null : q.warehouse_codes.map((c) => String(c).trim()).filter(Boolean);
    const { from, to, days, toExcl, prevFrom, prevToExcl } = this.ventana(q.from, q.to);
    const code = String(q.supplier_code || '').trim();
    if (!code) throw new BadRequestException('supplier_code requerido');
    const whClause = (whs ? `AND w.code = ANY(?)` : ``) + ` AND w.code NOT LIKE 'RUTA-%'`;
    const whBind = whs ? [whs] : [];
    // `SIN_LINEA` no es un código: es el cajón de los que no tienen ninguno.
    const linClause = code === SIN_LINEA ? `AND pr.supplier_id IS NULL` : `AND s.code = ?`;
    const linBind = code === SIN_LINEA ? [] : [code];

    return this.tk.run(async (trx) => {
      await trx.raw(`SET LOCAL statement_timeout = '30s'`);
      const res: any = await trx.raw(
        `SELECT sd.product_id, pr.sku, pr.nombre, b.nombre AS brand,
                COALESCE(max(s.name), 'Sin línea asignada') AS linea,
                COALESCE(sum(sd.revenue)           FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS rev_cur,
                COALESCE(sum(sd.revenue)           FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS rev_prev,
                COALESCE(sum(sd.revenue - sd.cost) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS mar_cur,
                COALESCE(sum(sd.units)             FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS uni_cur
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN catalog.suppliers s ON s.id = pr.supplier_id
           LEFT JOIN catalog.brands b ON b.id = pr.brand_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause} ${linClause}
          GROUP BY sd.product_id, pr.sku, pr.nombre, b.nombre
         HAVING COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0) <> 0
             OR COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0) <> 0
          ORDER BY rev_cur DESC
          LIMIT 300`,
        [from, toExcl, prevFrom, prevToExcl, from, toExcl, from, toExcl,
         tenantId, prevFrom, toExcl, ...whBind, ...linBind,
         from, toExcl, prevFrom, prevToExcl],
      );

      const totals = { revenue: 0, margin: 0, units: 0 };
      for (const r of res.rows) { totals.revenue += +r.rev_cur; totals.margin += +r.mar_cur; totals.units += +r.uni_cur; }
      const rows: SupplierProductRow[] = res.rows.map((r: any) => ({
        product_id: r.product_id, sku: r.sku, nombre: r.nombre, brand: r.brand || null,
        revenue: +r.rev_cur, revenue_prev: +r.rev_prev, delta_pct: pct(+r.rev_cur, +r.rev_prev),
        margin: +r.mar_cur, margin_pct: ratioPct(+r.mar_cur, +r.rev_cur),
        units: +r.uni_cur,
        share_pct: ratioPct(+r.rev_cur, totals.revenue),
      }));

      return {
        period: { from, to, days },
        prev_period: { from: prevFrom, to: addDays(prevToExcl, -1) },
        supplier: { code, name: res.rows[0]?.linea || (code === SIN_LINEA ? 'Sin línea asignada' : code) },
        totals, rows,
      };
    });
  }

  /**
   * `[TDA.A4]` CLIENTES — la cartera, y el techo que la enmarca.
   *
   * Ver el bloque «Clientes — la cartera, y su techo» arriba para las cifras. Tres
   * decisiones que definen la pantalla:
   *
   *  1. **El techo va en la respuesta, no en un pie de página.** `techo.venta_fact` es la
   *     venta real de la tienda y `techo.venta_clientes` lo poco de ella que tiene nombre.
   *     Sin esa comparación, una tabla de clientes con cifras grandes se lee como si fuera
   *     la venta del negocio.
   *  2. **Lo interno se marca y se muestra aparte, no se borra.** La cuenta del propio
   *     piso factura más que todos los clientes juntos; esconderla haría que la suma
   *     dejara de cuadrar contra la facturación sin explicación.
   *  3. **Se incluyen los que NO compraron en el período** pero sí en el anterior: son los
   *     `dormido`, y son la única señal de fuga que esta pantalla puede dar. Una consulta
   *     que sólo mire el período actual no puede verlos por construcción.
   */
  async customers(q: CustomersQuery): Promise<CustomersReport> {
    const tenantId = this.tenantCtx.requireTenantId();
    const whs = q.warehouse_codes == null ? null : q.warehouse_codes.map((c) => String(c).trim()).filter(Boolean);
    const { from, to, days, toExcl, prevFrom, prevToExcl } = this.ventana(q.from, q.to);
    const segmento = q.segmento === 'internos' || q.segmento === 'todos' ? q.segmento : 'externos';
    const texto = String(q.q || '').trim();

    // La facturación trae `sucursal` (código comercial), no warehouse_id.
    const cliWh = whs ? `AND i.sucursal = ANY(?)` : ``;   // se usa dentro del CTE `inv`
    const cliBind: string[][] = whs ? [whs] : [];
    const whClause = (whs ? `AND w.code = ANY(?)` : ``) + ` AND w.code NOT LIKE 'RUTA-%'`;
    const whBind = whs ? [whs] : [];

    return this.tk.run(async (trx) => {
      await trx.raw(`SET LOCAL statement_timeout = '30s'`);

      // 0) La venta REAL de la tienda: el denominador del techo.
      const fact: any = await trx.raw(
        `SELECT COALESCE(sum(sd.revenue), 0)::float AS rev
           FROM ${SALES_FACT} sd JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}`,
        [tenantId, from, toExcl, ...whBind],
      );

      /**
       * 1) La cartera. Universo y exclusiones idénticas al resto de la pantalla (fuera el
       * mostrador anónimo `CONTADO` y fuera la televenta, que tiene su propio módulo).
       *
       * El join al maestro es por **(sucursal, clave)**: la clave sola mezclaría clientes
       * distintos — ver `v_customer_master`.
       *
       * `primera_compra` se calcula SIN filtro de fecha (subconsulta aparte): «nuevo»
       * significa que nunca antes había comprado, no que no compró el mes pasado.
       */
      /**
       * ⚠️ Los tres `MATERIALIZED` no son adorno: `erp_sales_invoices` y
       * `v_customer_master` son VISTAS sobre el ODS, y sin forzar la materialización
       * Postgres las volvía a evaluar dentro del join. Medido: la vista de clientes sola
       * 33 ms, las facturas solas 684 ms, **las dos unidas 10 s** — y el endpoint entero
       * moría en el `statement_timeout` de 30 s.
       */
      const res: any = await trx.raw(
        `WITH inv AS MATERIALIZED (
           SELECT i.sucursal, btrim(i.cliente_code) AS cliente_code, i.cliente_nombre, i.fecha, i.total
             FROM analytics.erp_sales_invoices i
            WHERE i.tenant_id = ? AND NOT i.cancelada AND i.cliente_code <> 'CONTADO'
              AND COALESCE(i.canal, '') <> 'TELEMARK'
              AND i.fecha >= ? AND i.fecha < ? ${cliWh}
         ),
         mst AS MATERIALIZED (
           SELECT fuente_sucursal, cliente_code, nombre, grupo_nombre, zona_nombre,
                  vendedor_nombre, limite_credito, plazo_dias, es_interno
             FROM analytics.v_customer_master
         ),
         -- La primera compra HISTORICA, sin filtro de fecha: "nuevo" significa que nunca
         -- antes habia comprado, no que no compro el mes pasado.
         --
         -- OJO: se intento acotarla a los clientes de la ventana con un EXISTS contra el
         -- CTE de arriba y fue 13x MAS LENTA: 38 s contra 2.9 s. Postgres no puede indexar
         -- un CTE, asi que por cada fila del historico recorria el CTE entero. La pasada
         -- completa es mas barata que la "optimizacion" -- medido, no supuesto.
         -- (Y este comentario va con -- y sin acentos graves: esta DENTRO de un template
         --  literal de JS, donde un backtick lo corta en seco.)
         primera AS MATERIALIZED (
           SELECT h.sucursal, btrim(h.cliente_code) AS cliente_code, min(h.fecha)::text AS f
             FROM analytics.erp_sales_invoices h
            WHERE h.tenant_id = ? AND NOT h.cancelada AND h.cliente_code <> 'CONTADO'
              AND COALESCE(h.canal, '') <> 'TELEMARK'
            GROUP BY 1, 2
         )
         SELECT i.sucursal, i.cliente_code AS cliente_code,
                COALESCE(max(m.nombre), max(i.cliente_nombre), i.cliente_code) AS nombre,
                max(m.grupo_nombre)    AS grupo,
                max(m.zona_nombre)     AS zona,
                max(m.vendedor_nombre) AS vendedor,
                max(m.limite_credito)  AS limite_credito,
                max(m.plazo_dias)      AS plazo_dias,
                bool_or(COALESCE(m.es_interno, false)) AS es_interno,
                COALESCE(sum(i.total) FILTER (WHERE i.fecha >= ? AND i.fecha < ?), 0)::float AS rev_cur,
                COALESCE(sum(i.total) FILTER (WHERE i.fecha >= ? AND i.fecha < ?), 0)::float AS rev_prev,
                count(*) FILTER (WHERE i.fecha >= ? AND i.fecha < ?)::int AS docs,
                max(i.fecha) FILTER (WHERE i.fecha >= ? AND i.fecha < ?)::text AS ultima,
                max(p.f) AS primera
           FROM inv i
           LEFT JOIN mst m
             ON m.fuente_sucursal = i.sucursal AND m.cliente_code = i.cliente_code
           LEFT JOIN primera p
             ON p.sucursal = i.sucursal AND p.cliente_code = i.cliente_code
          GROUP BY 1, 2
          ORDER BY rev_cur DESC`,
        [tenantId, prevFrom, toExcl, ...cliBind,
         tenantId,
         from, toExcl, prevFrom, prevToExcl, from, toExcl, from, toExcl],
      );

      const todas = res.rows.map((r: any) => {
        const rev = +r.rev_cur;
        const ultima = r.ultima ? String(r.ultima).slice(0, 10) : null;
        const primera = r.primera ? String(r.primera).slice(0, 10) : null;
        const dias = ultima
          ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${ultima}T00:00:00Z`)) / 86400000)
          : null;
        // El estado sale de las FECHAS, no de una regla escrita a mano en otro lado.
        const estado: CustomerEstado = rev <= 0 ? 'dormido' : (primera && primera >= from ? 'nuevo' : 'activo');
        return {
          sucursal: r.sucursal, cliente_code: r.cliente_code, nombre: r.nombre,
          grupo: r.grupo || null, zona: r.zona || null, vendedor: r.vendedor || null,
          limite_credito: r.limite_credito == null ? null : +r.limite_credito,
          plazo_dias: r.plazo_dias == null ? null : +r.plazo_dias,
          es_interno: !!r.es_interno,
          revenue: rev, revenue_prev: +r.rev_prev, delta_pct: pct(rev, +r.rev_prev),
          docs: Number(r.docs) || 0,
          ticket_prom: ratio(rev, Number(r.docs) || 0),
          primera_compra: primera, ultima_compra: ultima, dias_sin_comprar: dias,
          estado,
          share_pct: null as number | null,
        };
      });

      // El techo: cuánto de la facturación es interna y cuánto es cartera de verdad.
      const ventaFacturada = todas.reduce((s: number, r: CustomerRow) => s + r.revenue, 0);
      const ventaInterna = todas.filter((r: CustomerRow) => r.es_interno).reduce((s: number, r: CustomerRow) => s + r.revenue, 0);
      const ventaClientes = ventaFacturada - ventaInterna;
      const ventaFact = +fact.rows[0].rev;

      // Los grupos, ANTES de filtrar por segmento: es el mapa completo de dónde cae la
      // facturación, y con los internos visibles.
      const porGrupo = new Map<string, CustomerGrupoRow>();
      for (const r of todas as CustomerRow[]) {
        const key = r.grupo || '(sin grupo)';
        const g = porGrupo.get(key) ?? { code: key, name: key, es_interno: r.es_interno, clientes: 0, revenue: 0, share_pct: null };
        g.clientes += 1; g.revenue += r.revenue; g.es_interno = g.es_interno || r.es_interno;
        porGrupo.set(key, g);
      }
      const grupos = [...porGrupo.values()]
        .map((g) => ({ ...g, share_pct: ratioPct(g.revenue, ventaFacturada) }))
        .sort((a, b) => b.revenue - a.revenue);

      // Recién ahora se filtra por segmento y por texto.
      let rows: CustomerRow[] = todas.filter((r: CustomerRow) =>
        segmento === 'todos' ? true : segmento === 'internos' ? r.es_interno : !r.es_interno);
      if (texto) {
        const t = texto.toLowerCase();
        rows = rows.filter((r) => r.nombre.toLowerCase().includes(t) || r.cliente_code.toLowerCase().includes(t));
      }
      const totalSeg = rows.reduce((s, r) => s + r.revenue, 0);
      rows = rows.map((r) => ({ ...r, share_pct: ratioPct(r.revenue, totalSeg) }));

      /**
       * ¿Se puede confiar en «nuevo»? Si la facturación empieza dentro (o después) del
       * período pedido, TODOS los clientes salen nuevos — no porque lo sean, sino porque
       * no hay con qué saber que ya venían. Medido en este entorno: 284 de 284. Se declara.
       */
      const hist: any = await trx.raw(
        `SELECT min(fecha)::text AS f FROM analytics.erp_sales_invoices
          WHERE tenant_id = ? AND NOT cancelada AND cliente_code <> 'CONTADO'
            AND COALESCE(canal, '') <> 'TELEMARK'`,
        [tenantId],
      );
      const historiaDesde: string | null = hist.rows[0]?.f ? String(hist.rows[0].f).slice(0, 10) : null;

      const resumen = {
        nuevos: rows.filter((r) => r.estado === 'nuevo').length,
        activos: rows.filter((r) => r.estado === 'activo').length,
        dormidos: rows.filter((r) => r.estado === 'dormido').length,
        historia_desde: historiaDesde,
        nuevos_confiable: !!historiaDesde && historiaDesde < from,
      };
      const asOf = todas.reduce((mx: string | null, r: CustomerRow) => {
        const v = r.ultima_compra;
        return v && (!mx || v > mx) ? v : mx;
      }, null as string | null);

      return {
        period: { from, to, days },
        prev_period: { from: prevFrom, to: addDays(prevToExcl, -1) },
        techo: {
          venta_fact: ventaFact,
          venta_facturada: ventaFacturada,
          venta_interna: ventaInterna,
          venta_clientes: ventaClientes,
          pct_identificado: ratioPct(ventaClientes, ventaFact),
        },
        grupos,
        totals: { revenue: totalSeg, clientes: rows.length },
        rows,
        resumen,
        as_of: { facturacion: asOf },
      };
    });
  }

  /**
   * `[TDA.A3]` PRODUCTOS TOP — el producto con sus tres etiquetas del ERP y la lectura de
   * Pareto.
   *
   * Tres decisiones que valen más que el SQL:
   *
   *  1. **El acumulado se calcula en el SERVIDOR, sobre el universo filtrado completo.**
   *     Si el cliente filtrara en memoria, el «acumulado» de la pantalla sería el de las
   *     filas que quedaron a la vista y no el del universo — un número con el mismo nombre
   *     y otro significado. Por eso hasta la búsqueda por texto es un parámetro.
   *  2. **Se devuelve el universo, no sólo lo mostrado.** `universo.productos` dice contra
   *     qué se está acumulando; sin eso, «80 %» no se puede interpretar.
   *  3. **Las facetas ignoran los filtros de taxonomía.** Si se filtraran con la selección
   *     puesta, elegir un tipo dejaría el desplegable con ese único tipo y no habría forma
   *     de cambiarlo sin recargar.
   */
  async topProducts(q: TopProductsQuery): Promise<TopProductsReport> {
    const tenantId = this.tenantCtx.requireTenantId();
    const whs = q.warehouse_codes == null ? null : q.warehouse_codes.map((c) => String(c).trim()).filter(Boolean);
    const { from, to, days, toExcl, prevFrom, prevToExcl } = this.ventana(q.from, q.to);
    const mode: 'pareto' | 'all' = q.mode === 'all' ? 'all' : 'pareto';
    const whClause = (whs ? `AND w.code = ANY(?)` : ``) + ` AND w.code NOT LIKE 'RUTA-%'`;
    const whBind = whs ? [whs] : [];

    // Filtros de taxonomía. `SIN_LINEA` no es un código: es el cajón de los que no tienen.
    const tipo = String(q.tipo || '').trim();
    const grupo = String(q.grupo || '').trim();
    const linea = String(q.supplier_code || '').trim();
    const texto = String(q.q || '').trim();
    const filtros: string[] = [];
    // `string[]`, no `unknown[]`: los bindings de knex son tipados y un `unknown[]` no
    // encaja en `RawBinding`. Todos estos filtros son texto, así que no cuesta nada.
    const fBind: string[] = [];
    if (tipo) { filtros.push(`AND tx.tipo_code = ?`); fBind.push(tipo); }
    if (grupo) { filtros.push(`AND tx.grupo_code = ?`); fBind.push(grupo); }
    if (linea === SIN_LINEA) filtros.push(`AND pr.supplier_id IS NULL`);
    else if (linea) { filtros.push(`AND s.code = ?`); fBind.push(linea); }
    if (texto) { filtros.push(`AND (pr.nombre ILIKE ? OR pr.sku ILIKE ?)`); fBind.push(`%${texto}%`, `%${texto}%`); }

    /** Tope duro de filas servidas. El universo completo sigue viniendo en `universo`. */
    const LIMITE = 1500;

    return this.tk.run(async (trx) => {
      await trx.raw(`SET LOCAL statement_timeout = '30s'`);

      const res: any = await trx.raw(
        `SELECT sd.product_id, pr.sku, pr.nombre, b.nombre AS brand,
                s.code AS linea_code, s.name AS linea,
                tx.tipo_nombre  AS tipo,
                tx.grupo_nombre AS grupo,
                COALESCE(sum(sd.revenue)           FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS rev_cur,
                COALESCE(sum(sd.revenue)           FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS rev_prev,
                COALESCE(sum(sd.revenue - sd.cost) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS mar_cur,
                COALESCE(sum(sd.units)             FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0)::float AS uni_cur,
                count(DISTINCT sd.sale_date) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ? AND sd.revenue > 0)::int AS sale_days,
                max(sd.sale_date) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ? AND sd.revenue > 0)::text AS as_of
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN catalog.suppliers s ON s.id = pr.supplier_id
           LEFT JOIN catalog.brands b ON b.id = pr.brand_id
           LEFT JOIN analytics.v_product_taxonomy tx ON tx.sku = pr.sku
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
                ${filtros.join(' ')}
          GROUP BY sd.product_id, pr.sku, pr.nombre, b.nombre, s.code, s.name, tx.tipo_nombre, tx.grupo_nombre
         HAVING COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?), 0) > 0
          ORDER BY rev_cur DESC`,
        [from, toExcl, prevFrom, prevToExcl, from, toExcl, from, toExcl, from, toExcl, from, toExcl,
         tenantId, prevFrom, toExcl, ...whBind, ...fBind, from, toExcl],
      );

      const total = res.rows.reduce((s: number, r: any) => s + (+r.rev_cur), 0);
      let acum = 0;
      let asOf: string | null = null;
      let p50: number | null = null, p80: number | null = null, p95: number | null = null;
      const todas: TopProductRow[] = res.rows.map((r: any, i: number) => {
        const rev = +r.rev_cur;
        acum += rev;
        const cum = total > 0 ? Math.round((acum / total) * 1000) / 10 : null;
        if (p50 === null && total > 0 && acum >= total * 0.5) p50 = i + 1;
        if (p80 === null && total > 0 && acum >= total * 0.8) p80 = i + 1;
        if (p95 === null && total > 0 && acum >= total * 0.95) p95 = i + 1;
        const a = r.as_of ? String(r.as_of).slice(0, 10) : null;
        if (a && (!asOf || a > asOf)) asOf = a;
        return {
          rank: i + 1,
          product_id: r.product_id, sku: r.sku, nombre: r.nombre, brand: r.brand || null,
          linea_code: r.linea_code || null, linea: r.linea || null,
          tipo: r.tipo || null, grupo: r.grupo || null,
          revenue: rev, revenue_prev: +r.rev_prev, delta_pct: pct(rev, +r.rev_prev),
          margin: +r.mar_cur, margin_pct: ratioPct(+r.mar_cur, rev),
          units: +r.uni_cur, avg_unit: ratio(rev, +r.uni_cur),
          sale_days: Number(r.sale_days) || 0,
          share_pct: ratioPct(rev, total), cum_pct: cum,
        };
      });

      // El corte de Pareto: hasta el 80 % acumulado. Nunca menos de 10 filas — con un
      // universo chico el 80 % puede ser 1 sola, y una tabla de una fila no se lee.
      const corte = mode === 'pareto' ? Math.max(10, p80 ?? todas.length) : todas.length;
      const rows = todas.slice(0, Math.min(corte, LIMITE));

      /**
       * Facetas SIN los filtros de taxonomía (ver el punto 3 del encabezado). Una sola
       * pasada que devuelve las tres dimensiones agrupadas aparte — más barato que tres
       * consultas y con el mismo universo garantizado.
       */
      const facRes: any = await trx.raw(
        `SELECT 'tipo' AS dim, COALESCE(tx.tipo_code, '') AS code, COALESCE(tx.tipo_nombre, 'Sin tipo') AS name,
                sum(sd.revenue)::float AS revenue, count(DISTINCT sd.product_id)::int AS skus
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN analytics.v_product_taxonomy tx ON tx.sku = pr.sku
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY 2, 3
         HAVING sum(sd.revenue) > 0
          UNION ALL
         SELECT 'grupo', COALESCE(tx.grupo_code, ''), COALESCE(tx.grupo_nombre, 'Sin grupo'),
                sum(sd.revenue)::float, count(DISTINCT sd.product_id)::int
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN analytics.v_product_taxonomy tx ON tx.sku = pr.sku
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY 2, 3
         HAVING sum(sd.revenue) > 0
          UNION ALL
         SELECT 'linea', COALESCE(s.code, ?), COALESCE(s.name, 'Sin línea asignada'),
                sum(sd.revenue)::float, count(DISTINCT sd.product_id)::int
           FROM ${SALES_FACT} sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN catalog.suppliers s ON s.id = pr.supplier_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY 2, 3
         HAVING sum(sd.revenue) > 0`,
        [tenantId, from, toExcl, ...whBind,
         tenantId, from, toExcl, ...whBind,
         SIN_LINEA, tenantId, from, toExcl, ...whBind],
      );
      const facet = (dim: string): TopFacet[] => facRes.rows
        .filter((r: any) => r.dim === dim)
        .map((r: any) => ({ code: String(r.code), name: r.name, revenue: +r.revenue, skus: Number(r.skus) || 0 }))
        .sort((a: TopFacet, b: TopFacet) => b.revenue - a.revenue);

      return {
        period: { from, to, days },
        prev_period: { from: prevFrom, to: addDays(prevToExcl, -1) },
        universo: { productos: todas.length, venta: total },
        pareto: { para_50: p50, para_80: p80, para_95: p95 },
        mode,
        mostrados: rows.length,
        topado: corte > LIMITE,
        rows,
        facets: { tipos: facet('tipo'), grupos: facet('grupo'), lineas: facet('linea') },
        as_of: { fact: asOf },
      };
    });
  }

  /**
   * Ventana [from,to] validada + el período previo del MISMO tamaño. Estaba repetida tres
   * veces con los mismos cuatro `throw`; una cuarta copia era una cuarta forma de que el
   * tope de días se desincronizara entre endpoints que comparten el control de la pantalla.
   */
  private ventana(qFrom?: string, qTo?: string) {
    const isoOk = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
    const from = isoOk(qFrom);
    const to = isoOk(qTo);
    if (!from || !to) throw new BadRequestException('from/to requeridos (YYYY-MM-DD)');
    if (from > to) throw new BadRequestException('from posterior a to');
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (days > MAX_RANGE_DAYS) throw new BadRequestException(`rango máximo ${MAX_RANGE_DAYS} días`);
    return { from, to, days, toExcl: addDays(to, 1), prevFrom: addDays(from, -days), prevToExcl: from };
  }

  /** Rótulo del bucket. Ver `MESES`/`DIAS_SEMANA`: nombres en duro, no por ICU. */
  private bucketLabel(grain: BreakdownGrain | BreakdownChildGrain, key: string): string {
    if (grain === 'weekday') return DIAS_SEMANA[Number(key) - 1] ?? key;
    if (grain === 'day') {
      const [y, m, d] = key.split('-');
      return `${DIAS_CORTO[this.isoDow(key) - 1] ?? ''} ${d}/${m}/${y.slice(2)}`;
    }
    if (grain === 'week') {
      // El número de semana solo no alcanza: en una ventana de 2 años la S37 aparece
      // dos veces y las dos filas se llamarían igual.
      return `S${String(this.isoWeekNumber(key)).padStart(2, '0')} · ${key.slice(0, 4)}`;
    }
    if (grain === 'month') return `${cap(MESES[Number(key.slice(5, 7)) - 1])} ${key.slice(0, 4)}`;
    if (grain === 'quarter') return `T${Math.floor((Number(key.slice(5, 7)) - 1) / 3) + 1} ${key.slice(0, 4)}`;
    return key.slice(0, 4); // year
  }

  /** Segunda línea: el tramo que el bucket cubre DE VERDAD dentro del rango pedido. */
  private bucketSub(grain: BreakdownGrain | BreakdownChildGrain, from: string, to: string, factDays: number): string {
    if (grain === 'day') return '';
    if (grain === 'weekday') return factDays === 1 ? '1 día con venta' : `${factDays} días con venta`;
    if (!from) return 'sin venta registrada';
    const corto = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
    return from === to ? corto(from) : `${corto(from)} – ${corto(to)}`;
  }

  /** Día ISO de la semana (1 = lunes … 7 = domingo) de una fecha 'YYYY-MM-DD'. */
  private isoDow(isoDate: string): number {
    const d = new Date(isoDate + 'T00:00:00Z');
    return ((d.getUTCDay() + 6) % 7) + 1;
  }

  /** Número de semana ISO a partir del lunes de esa semana. */
  private isoWeekNumber(monday: string): number {
    return Number(this.isoWeekLabel(monday).slice(-2));
  }

  /** Etiqueta ISO 'YYYY-Www' a partir del lunes de la semana. */
  private isoWeekLabel(monday: string): string {
    const d = new Date(monday + 'T00:00:00Z');
    // La semana ISO se numera por el jueves de esa semana.
    const thursday = new Date(d);
    thursday.setUTCDate(d.getUTCDate() + 3);
    const isoYear = thursday.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
  }
}
