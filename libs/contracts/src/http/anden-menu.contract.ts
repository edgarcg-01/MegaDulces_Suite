/**
 * [WMS-REC.15] El menu del Anden: a que sucursal entra la mercancia y cuantos vales de
 * entrada de HOY quedan sin abrir en cada una.
 *
 * ── POR QUE VIVE ACA Y NO EN EL DOMINIO (ADR-052) ─────────────────────────────────────
 * Esta forma nacio en `ReceivingSessionService.pendingErpBranches()` y el mismo dia ya
 * estaba declarada a mano en `apps/view/.../almacen/receiving-session.service.ts`. Es el
 * patron que la Fase VP existe para cortar: una forma correcta, escrita en una rebanada,
 * re-declarada en su consumidor hasta que las dos copias se separan en silencio.
 *
 * Dos campos hacen que separarse tenga consecuencia visible, no cosmetica:
 *
 *  · `alcance` es el MODO del alcance de almacen, no una cuenta de filas. La pantalla
 *    avisa "estas viendo todas porque tu usuario no tiene una asignada" leyendo ESTE
 *    campo. Si el backend gana un quinto modo, una copia a mano sigue compilando, cae en
 *    el `else` y el aviso se vuelve falso sin un solo error. Por eso se deriva de
 *    `ScopeMode` (`libs/platform-core/.../scope.types.ts`) y no se re-escribe la union.
 *
 *  · `sin_almacen` decide si la fila se puede tocar: sin mapa sucursal->almacen, `open()`
 *    responde 400. Que back y front discrepen ahi es un boton habilitado que falla.
 *
 * Aca vive solo la FORMA del wire; la LOGICA (resolver el almacen, contar pendientes,
 * aplicar el alcance) se queda en el dominio. Un cambio de forma = error de compilacion
 * en los dos lados, que es la garantia por la que existe este paquete.
 *
 * Interfaces planas y no Zod a proposito: no hay `.parse()` en este borde (10 de los 13
 * contratos de `http/` son planos; Zod se usa donde algo se valida de verdad).
 */

/** Los cuatro modos de alcance. Espejo de `ScopeMode`; si alla se agrega uno, aca rompe. */
export type AndenScopeMode = 'none' | 'own' | 'listed' | 'all';

/**
 * Una sucursal del menu del Anden: a donde entra la mercancia y cuantos vales de
 * HOY quedan sin abrir ahi.
 */
export interface ErpPendingBranch {
  sucursal: string;
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  pendientes: number;
  ultimo: string | null;
  /** Sin mapa sucursal->almacen no se puede abrir el vale: la pantalla lo avisa antes. */
  sin_almacen: boolean;
}

/**
 * El menu completo. El MODO del alcance viaja con el: la pantalla avisa "estas
 * viendo todas porque tu usuario no tiene una asignada" y eso tiene que salir
 * del alcance, no de contar filas.
 */
export interface ErpPendingMenu {
  alcance: AndenScopeMode;
  sucursales: ErpPendingBranch[];
}

/**
 * Un vale de entrada del ERP listo para abrir en el Anden.
 *
 * Lo devuelven DOS endpoints que tienen que ser intercambiables: `erp-search` (busqueda por
 * folio) y `erp-pending` (los de HOY de una sucursal, desde el menu). La pantalla usa el mismo
 * componente y el mismo camino de apertura para los dos, asi que la forma tiene que ser una.
 *
 * ⚠️ `tipo` y `monto` NO salen del `select`: los pone el mapeo del servicio
 * (`classifyReceivingOrigin` decide traspaso vs compra, y `monto` se coacciona a numero porque
 * Postgres entrega `numeric` como string). Un endpoint que devuelva la fila cruda cumple el
 * tipo en el papel y miente: `tipo` llega `undefined` y la pantalla lo lee como 'compra'.
 */
export interface ErpOrderMatch {
  sucursal: string;
  folio: string;
  receipt_date?: string | null;
  proveedor_code?: string | null;
  proveedor_nombre?: string | null;
  proveedor_rfc?: string | null;
  oc_folio?: string | null;
  vale_folio?: string | null;
  concepto?: string | null;
  monto: number;
  warehouse_id?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  line_count: number;
  service_count: number;
  /** De donde viene la mercancia. Una sola definicion: `receiving-origin.ts`. */
  origin?: { kind: 'supplier' | 'transfer'; isCedis: boolean; label: string; name: string | null };
  tipo: 'compra' | 'traspaso';
}
