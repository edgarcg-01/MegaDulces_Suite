/**
 * `[RA-PRO.60]` Decisiones de `/compras/oc-abiertas`, aisladas del servicio para probarlas sin base
 * (ADR-056: lo que decide un número se prueba). El servicio sólo arma la consulta y llama esto.
 *
 * Dos cosas que la pantalla hacía mal y esto cierra:
 *
 *  1. **El alcance.** `openPurchaseOrders` no recortaba por sucursal: quien tenía
 *     `COMPRAS_PEDIDO_VER` con alcance acotado (encargadas de tienda) veía las órdenes de las nueve.
 *     Es el fail-open que `[ZN.3.3]` ya había cerrado en los reportes del pedido y que acá quedó
 *     vivo. `filtroSucursalOc` traduce el resultado de `ScopeService.readParam` a la condición SQL
 *     sin colapsar el `[]` (cero sucursales) contra el `null` (no filtrar).
 *
 *  2. **El tope silencioso.** La consulta cortaba en 500 renglones y los indicadores (órdenes,
 *     valor en papel, esperado, para barrer) se calculaban SOBRE esos 500, sin avisar. Ahora
 *     `resumenOcAbiertas` calcula los indicadores sobre TODAS las órdenes y recorta sólo lo que se
 *     pinta, declarando cuántas quedaron fuera.
 */

import { OC_SEGUIMIENTO_ESTATUS, OcSeguimiento, OcSeguimientoEstatus } from '@megadulces/contracts';

/** Una orden abierta, ya en la forma que devuelve la API. */
export interface OcAbierta {
  almacen: string;
  folio: string;
  fecha_oc: unknown;
  proveedor: string | null;
  estatus: string;
  dias: number;
  lineas: number;
  valor: number;
  /** Probabilidad de llegar, 0–100. `null` = la curva todavía no existe (no se inventa). */
  prob: number | null;
  /** `[RA-PRO.62]` Estatus de seguimiento de Compras. `null` = Sin revisar. */
  seguimiento?: OcSeguimiento | null;
}

/** `[RA-PRO.62]` Llave del conteo para las órdenes sin registro de seguimiento. */
export const SIN_REVISAR = 'sin_revisar';

/** Condición de sucursal para el `WHERE`. */
export interface FiltroSucursal {
  /** `true` = no filtrar (alcance total y nadie pidió una sucursal). */
  todas: boolean;
  /** Códigos permitidos. Con `todas: false` y lista vacía, la consulta NO debe devolver nada. */
  codigos: string[];
}

/**
 * De lo que devuelve `ScopeService.readParam(…, 'warehouse')` a la condición del `WHERE`:
 *  - `null` → todas (alcance total, sin sucursal pedida);
 *  - `[...]` → esas sucursales;
 *  - `[]`   → **ninguna**. Es el estado que se pierde siempre: un alcance que resolvió a cero
 *    sucursales, o una sucursal pedida que la persona no alcanza. Leerlo como "todas" es
 *    exactamente el defecto.
 */
export function filtroSucursalOc(codigos: string[] | null): FiltroSucursal {
  if (codigos === null) return { todas: true, codigos: [] };
  return { todas: false, codigos: [...new Set(codigos.map((c) => String(c).trim()).filter(Boolean))] };
}

/** Días desde los cuales una orden se considera "para barrer" (misma cifra que pinta la pantalla). */
export const DIAS_PARA_BARRER = 30;
/** Renglones que se pintan. Los indicadores NO se limitan por esto. */
export const LIMITE_RENGLONES = 500;

export interface ResumenOcAbiertas {
  rows: OcAbierta[];
  /** Órdenes que cumplen el filtro (todas, no sólo las que se pintan). */
  total: number;
  /** Renglones que viajan a la pantalla (≤ límite). */
  mostradas: number;
  /** `true` si quedaron órdenes fuera de la tabla: la pantalla lo DECLARA. */
  truncado: boolean;
  total_valor: number;
  /** Valor pesado por la probabilidad de llegar. Sin curva (`prob` null) cuenta completo. */
  valor_esperado: number;
  /** Órdenes con más de `DIAS_PARA_BARRER` días abiertas, y su valor. */
  viejas: number;
  valor_viejas: number;
  /** `[RA-PRO.62]` Cuántas órdenes hay en cada estatus de seguimiento (`sin_revisar` incluido), sobre TODAS. */
  por_seguimiento: Record<string, number>;
}

const centavos = (n: number) => Math.round(n * 100) / 100;

/**
 * Indicadores sobre TODAS las órdenes; la tabla lleva sólo las primeras `limite` (las más viejas,
 * porque llegan ordenadas por antigüedad). Un indicador nunca depende de cuántas se pintan.
 */
export function resumenOcAbiertas(todas: OcAbierta[], limite = LIMITE_RENGLONES): ResumenOcAbiertas {
  const tope = Math.max(0, Math.floor(limite));
  let valor = 0, esperado = 0, viejas = 0, valorViejas = 0;
  // Todas las llaves presentes aunque valgan 0: la pantalla pinta el conteo de cada estatus.
  const porSeguimiento: Record<string, number> = { [SIN_REVISAR]: 0 };
  for (const e of OC_SEGUIMIENTO_ESTATUS) porSeguimiento[e] = 0;
  for (const o of todas) {
    const v = Number(o.valor) || 0;
    valor += v;
    esperado += v * ((o.prob ?? 100) / 100);
    if ((Number(o.dias) || 0) > DIAS_PARA_BARRER) { viejas++; valorViejas += v; }
    const k = o.seguimiento?.estatus ?? SIN_REVISAR;
    porSeguimiento[k] = (porSeguimiento[k] ?? 0) + 1;
  }
  const rows = todas.slice(0, tope);
  return {
    rows,
    total: todas.length,
    mostradas: rows.length,
    truncado: todas.length > rows.length,
    total_valor: centavos(valor),
    valor_esperado: centavos(esperado),
    viejas,
    valor_viejas: centavos(valorViejas),
    por_seguimiento: porSeguimiento,
  };
}

/**
 * Tope de la CONSULTA (no de la tabla). Con la ventana de 120 días hoy son ~270 órdenes; el tope
 * sólo existe para que un dato roto no traiga medio ERP. Si se alcanza, el servicio lo declara
 * (`total_minimo`): el total pasa a ser un mínimo, no una cifra exacta.
 */
export const TOPE_CONSULTA_OC = 5000;

/** Una recepción (XA2001) que cita a una OC por la cadena de Kepler. */
export interface RecepcionCitada { folio: string; fecha: string | null; monto: number; proveedor_code: string | null; }

/**
 * `[RA-PRO.61]` Qué recepciones cuentan como surtido de una OC.
 *
 * La cadena de Kepler (`erp_goods_receipts.oc_folio`) a veces apunta a una OC equivocada con el
 * mismo folio. Medido 2026-09-26 en la OC 00-0003095 (BARCEL, $747,720): 3 recepciones la citan,
 * 2 son de BIMBO por $1.39M, y el "surtido" salía 229%. Una recepción cuenta sólo si:
 *   - es del MISMO proveedor que la orden (si alguno de los dos no trae código, no se puede
 *     afirmar y NO cuenta), y
 *   - no es anterior a la orden (no se recibe algo antes de pedirlo).
 * Las que no cuentan NO desaparecen: se devuelven aparte para que el PDF las declare.
 */
export function clasificarRecepciones(
  ocProveedor: string | null, ocFecha: string | null, recs: RecepcionCitada[],
): { validas: RecepcionCitada[]; descartadas: RecepcionCitada[] } {
  const prov = String(ocProveedor ?? '').trim().toUpperCase();
  const f0 = ocFecha ? ocFecha.slice(0, 10) : null;
  const validas: RecepcionCitada[] = [];
  const descartadas: RecepcionCitada[] = [];
  for (const r of recs) {
    const rp = String(r.proveedor_code ?? '').trim().toUpperCase();
    const mismoProv = !!prov && !!rp && rp === prov;
    const noAntes = !f0 || !r.fecha || r.fecha.slice(0, 10) >= f0;
    (mismoProv && noAntes ? validas : descartadas).push(r);
  }
  return { validas, descartadas };
}

// ── Filas tal como salen de la base (lo que devuelve knex), para no tipar con `any` ──────────
// Los numéricos de Postgres llegan como string (numeric) o number: por eso `number | string`.

/** `analytics.erp_purchase_docs` (XA3501) con las fechas ya formateadas. */
export interface OcDocRow {
  sucursal: string; folio: string;
  proveedor_code: string | null; proveedor_nombre: string | null; proveedor_rfc: string | null;
  concepto: string | null; condicion_pago: string | null; referencia: string | null;
  monto: number | string | null; estatus: string | null;
  doc_date: string | null; due_date: string | null; dias: number | string | null;
}

/** `analytics.erp_purchase_doc_lines` (XA3501). */
export interface OcLineRow {
  linea: string | number | null; sku: string | null; nombre: string | null;
  cantidad: number | string | null; unidad: string | null;
  costo_unitario: number | string | null; importe: number | string | null;
  unidades_por_caja: number | string | null; costo_caja: number | string | null;
}

/** `analytics.erp_goods_receipts` (sólo lo que usa el detalle). */
export interface OcReceiptRow { folio: string; monto: number | string | null; proveedor_code: string | null; fecha: string | null; }

/** `commercial.purchase_order_followups`. */
export interface OcFollowupRow {
  estatus: OcSeguimientoEstatus; nota: string | null;
  updated_by_username: string | null; updated_at: string | Date;
}

/** `commercial.purchase_order_followup_history`. */
export interface OcHistoryRow {
  estatus_anterior: OcSeguimientoEstatus | null; estatus: OcSeguimientoEstatus; nota: string | null;
  changed_by_username: string | null; changed_at: string | Date;
}
