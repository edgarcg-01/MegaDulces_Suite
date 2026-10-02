/**
 * `[IG.1]` La FORMA del wire de Ingresos contables (`/finanzas/ingresos`).
 *
 * Vive acá y no en cada lado por la razón de siempre (ADR-052 / ADR-056): el tipo de `Freshness`
 * nació en un dominio y **a los tres días ya estaba copiado a mano** en el frontend. Acá la forma se
 * declara una vez y un cambio es error de compilación en los dos lados, que es la garantía por la
 * que existe este paquete.
 *
 * La LÓGICA (las tres reglas duras, el clasificador de canal) no está acá: vive en
 * `analytics.income_entries_src()` — ver la migración `20260925150000`.
 */

import type { Coverage, Freshness } from './provenance.contract';

/** Dimensión de agrupación del reporte. */
export type IncomeGroupBy = 'canal' | 'plaza' | 'mes' | 'documento';

export interface IncomeCanalRow {
  canal: string;
  label: string;
  total: number;
  movs: number;
}

export interface IncomeRow {
  key: string;
  label: string;
  canal: string | null;
  total: number;
  movs: number;
  share_pct: number;
  prev_total: number | null;
  delta_pct: number | null;
}

export interface IncomeSeriesPoint {
  mes: string;
  total: number;
  mostrador: number;
  telemarketing: number;
  ruta: number;
  vecinal: number;
  contado: number;
  otro: number;
  /** El rango corta ese mes → su barra es más baja por calendario, no por venta. */
  parcial: boolean;
  /** Plazas que reportaron ese mes. Un escalón acá explica un escalón en el total. */
  plazas: number;
}

/**
 * Cobertura del período. Extiende la `Coverage` del contrato de procedencia con el detalle que la
 * pantalla necesita para poder NOMBRAR lo que quedó afuera — `measured`/`pct`/`note` solos dicen
 * que falta algo, no qué.
 *
 * `grupos` es la plaza del lado ingreso y la sucursal del lado gasto: el motor
 * (`period-coverage.ts`) es el mismo y recibe la etiqueta del que llama.
 */
export interface PeriodCoverageWire extends Coverage {
  grupos: string[];
  grupos_todos: string[];
  grupos_parciales: Array<{ grupo: string; desde: string; total: number }>;
  meses_parciales: string[];
}

/** El Δ con y sin los grupos que cambiaron de universo entre los dos períodos. */
export interface PeriodComparativoWire {
  grupos_ambos: string[];
  solo_actual: string[];
  solo_previo: string[];
  total: number;
  total_prev: number;
  delta_pct: number | null;
  total_comparable: number;
  total_prev_comparable: number;
  delta_pct_comparable: number | null;
  universo_cambio: boolean;
}

export interface IncomeReport {
  from: string;
  to: string;
  prev_from: string;
  prev_to: string;
  freshness: Freshness;
  coverage: PeriodCoverageWire;
  comparativo: PeriodComparativoWire | null;
  group_by: string;
  total: number;
  movimientos: number;
  by_canal: IncomeCanalRow[];
  rows: IncomeRow[];
  series: IncomeSeriesPoint[];
}

/**
 * `[IG.9]` Un nodo del árbol. Los dos primeros niveles (canal, período) vienen en la carga
 * inicial; **folio y depósito se piden al abrir**, porque un canal de 90 días son miles de
 * documentos y decenas de miles de depósitos: traerlos de una haría lo contrario de lo que este
 * árbol existe para hacer.
 */
export interface IncomeTreeNode {
  key: string;
  label: string;
  /** `canal` · `periodo` · `folio` · `pago` */
  level: string;
  total: number;
  movs: number;
  share_pct: number;
  children?: IncomeTreeNode[];
  /** `false` cuando el nodo todavía puede abrirse (y sus hijos se piden al servidor). */
  leaf?: boolean;
  /** Segunda línea del renglón: la plaza del folio, o el banco y la fecha del depósito. */
  sub?: string | null;
  /** Qué es el cliente detrás del documento. Sólo en `folio`. */
  kind?: string | null;
  /** ⛔ El ERP canceló el documento y su ingreso sigue publicado. Sólo en `folio`. */
  cancelado?: boolean;
  cobrado?: number | null;
  pendiente?: number | null;
  /** Cómo entró el dinero, en texto corto: «3 depósitos · BANORTE 7744» o «efectivo». */
  como?: string | null;
  /** Las llaves que el cliente devuelve para pedir los hijos de este nodo. */
  canal?: string | null;
  /** La sucursal, la ruta o el repartidor. `kind` dice cuál de los tres es. */
  plaza?: string | null;
  fecha?: string | null;
  folio?: string | null;
}

/** Un renglón del documento, tal como lo escribió el ERP. */
export interface IncomeDocLinea {
  sku: string;
  descripcion: string;
  cantidad: number;
  unidad: string;
  precio: number;
  importe: number;
}

/**
 * `[IG.10]` El documento detrás de un folio del árbol.
 *
 * ⛔ `solo_servicio` es la advertencia que da sentido a todo lo demás: medido sobre 30 días, los
 * 1,548 `U-D-13` del CEDIS traen **un renglón o ninguno, nunca dos**, y ese renglón es el SKU `1`
 * con unidad `SER` y el total completo adentro. **El ERP no detalla la mercancía de este
 * doctype** — por eso la Fase AX lo excluyó de su visor. No se dibuja una tabla vacía, que se
 * leería como «no compró nada»: se declara.
 */
export interface IncomeDocumento {
  folio: string;
  fecha: string;
  doctype: string;
  doctype_label: string | null;
  cliente_code: string;
  cliente_nombre: string | null;
  kind: string | null;
  sucursal_destino: string | null;
  condicion: string | null;
  cancelado: boolean;
  total: number;
  cobrado: number;
  nota_credito: number;
  pendiente: number;
  renglones: IncomeDocLinea[];
  /** `true` = el ERP no detalla mercancía en este documento. Se DECLARA en pantalla. */
  solo_servicio: boolean;
  /** Cada cobro y cada nota de crédito aplicados contra el documento. */
  pagos: IncomeTreeNode[];
}

export interface IncomeTree {
  from: string;
  to: string;
  total: number;
  /** Grano del SEGUNDO nivel. El árbol siempre baja a folio y depósito debajo de él. */
  grain: IncomeGrain;
  tree: IncomeTreeNode[];
}

/** Respuesta de la carga por demanda de un nivel del árbol. */
export interface IncomeTreeChildren {
  level: string;
  nodes: IncomeTreeNode[];
}

/**
 * `[IG.3]` Una de las cuatro fuentes del mismo peso de venta.
 *
 * `monto: null` significa **NO MEDIDO**, y es distinto de `0`. `comparable: false` marca la fuente
 * que NO se resta de frente: la cobranza es lo que se cobró, no lo que se devengó, y su diferencia
 * es plazo de crédito, no faltante.
 */
export interface IncomeSourceRow {
  key: string;
  label: string;
  monto: number | null;
  delta_pct: number | null;
  comparable: boolean;
  /** ISO del último cierre del feed que produjo este número, cuando se pudo medir. */
  medido_al?: string | null;
  nota: string;
}

export interface IncomeSources {
  from: string;
  to: string;
  fuentes: IncomeSourceRow[];
}

// ─────────── `[IG.7]` Conciliación: el ingreso LIGADO a su documento, su cliente y su cobro ───
//
// Pedido de Edgar: *"casar todos los ingresos a cada tienda y saber de dónde viene cada ingreso"*,
// y después, viendo la pantalla: *"aún no ligas los ingresos"*.
//
// ⛔ `[IG.6]` cruzaba por **almacén emisor** mientras la pestaña Árbol agrupa por **plaza**: dos
// ejes distintos, dos tablas que no se pueden restar. `[IG.7]` liga por **folio** — la póliza
// contable y su documento comparten folio y fecha (medido: 0 días de desfase en 4,809 de 4,809),
// así que cada renglón de acá cuadra al centavo con el renglón del Árbol que tiene al lado.
//
// ⛔ Y son DOS columnas, no una: el 84 % de lo que esta pantalla publica como ingreso es el CEDIS
// facturándole a sus propias tiendas y rutas. Obligar a que vendido == cobrado forzaría a elegir
// una cifra y esconder la otra; acá las dos se publican y la diferencia se EXPLICA.

/** Qué es el cliente de una venta. `sin_catalogo` es NO MEDIDO, no "externo por default". */
export type IncomeKind =
  | 'externo'
  | 'interno_sucursal'
  | 'interno_punto_venta'
  | 'interno_ruta'
  | 'interno_traspaso'
  | 'interno_telemarketing'
  | 'sin_catalogo';

/** Grano temporal del corte. */
export type IncomeGrain = 'dia' | 'mes' | 'trimestre';

/** Cómo entró el dinero. `ajuste` NO es un depósito: son las cuentas de devolución y ajuste. */
export type IncomeMedio = 'efectivo' | 'banco' | 'ajuste' | 'sin_catalogo';

/**
 * Un tramo del puente entre lo vendido y lo cobrado. `monto: null` = NO MEDIDO.
 * `resta` dice si el tramo se descuenta del vendido para llegar al cobrado, o si sólo acompaña.
 */
export interface IncomeBridgeItem {
  key: string;
  label: string;
  monto: number | null;
  resta: boolean;
  nota: string;
}

/** Una cuenta de tesorería por la que entró dinero: el "¿fue depósito o fue efectivo?". */
export interface IncomeCuenta {
  code: string;
  nombre: string | null;
  medio: IncomeMedio;
  pagos: number;
  importe: number;
}

/**
 * Un renglón de la conciliación: **la misma celda que publica el Árbol**, con todo lo que la liga
 * por folio le pudo agregar.
 */
export interface IncomeReconRow {
  periodo: string;
  plaza: string;
  canal: string;
  /**
   * Qué es el cliente detrás de esa plaza. `mixto` cuando la plaza agrupa varios tipos;
   * `sin_documento` cuando la póliza no encontró su factura (NO MEDIDO, no "externo").
   */
  kind: IncomeKind | 'mixto' | 'sin_documento';
  /** `null` cuando no se pudo saber: ninguna de las pólizas de la celda encontró su documento. */
  es_interno: boolean | null;
  /** Lo que publica el Árbol para esta misma celda. Cuadra al centavo con esa pestaña. */
  vendido: number;
  docs: number;
  /** De esos documentos, cuántos encontraron su factura. `docs - docs_ligados` es el hueco. */
  docs_ligados: number;
  /**
   * ⛔ Documentos que el ERP **canceló** y cuyo ingreso sigue publicado en la cuenta 401.
   * No es un hueco de medición: es dinero de más en la cifra. Medido: 154 de 158 cancelados SÍ
   * perdieron su póliza; estos no.
   */
  docs_cancelados: number;
  vendido_cancelado: number;
  /** Cobrado A LA FECHA contra esas facturas, venga el pago del período o de después. */
  cobrado: number;
  pagos: number;
  /** Nota de crédito aplicada: dinero que ya NO va a entrar. No se mezcla con lo cobrado. */
  nota_credito: number;
  /**
   * Saldo de **las facturas de la celda**: por cada una, `facturado − cobrado − nota de crédito`.
   * ⚠️ NO es `vendido − cobrado` de esta fila: una devolución resta en `vendido` pero se aplica
   * contra la factura que le toque, que puede ser de otro día — así que en ventanas cortas
   * `pendiente` puede salir mayor que `vendido`, y es correcto. `null` cuando la celda no tiene
   * ninguna factura que deba (por ejemplo, una celda que es sólo nota de crédito).
   */
  pendiente: number | null;
  efectivo: number;
  banco: number;
  /** Cuentas de devolución/ajuste. NO son un depósito: se publican aparte a propósito. */
  ajuste: number;
  /** Lo cobrado cuyo cobro CAE en el período. Es el flujo de caja, no el devengo. */
  cobrado_en_periodo: number;
  pagos_en_periodo: number;
  primer_cobro: string | null;
  ultimo_cobro: string | null;
  /** Las cuentas distintas por las que entró el dinero — el "cuántos depósitos diferentes". */
  cuentas: IncomeCuenta[];
}

export interface IncomeReconTotals {
  vendido: number;
  vendido_externo: number;
  vendido_interno: number;
  vendido_sin_clasificar: number;
  docs: number;
  docs_ligados: number;
  docs_cancelados: number;
  vendido_cancelado: number;
  cobrado: number;
  pagos: number;
  nota_credito: number;
  pendiente: number;
  efectivo: number;
  banco: number;
  ajuste: number;
  cobrado_en_periodo: number;
  pagos_en_periodo: number;
  /** El máximo de pagos distintos casados contra UNA sola factura del período. */
  max_pagos_por_factura: number;
}

export interface IncomeRecon {
  from: string;
  to: string;
  grain: IncomeGrain;
  freshness: Freshness;
  rows: IncomeReconRow[];
  totales: IncomeReconTotals;
  bridge: IncomeBridgeItem[];
  /** Lo que esta pantalla NO puede medir, con su monto. Nunca se dibuja como cero. */
  huecos: IncomeBridgeItem[];
}
