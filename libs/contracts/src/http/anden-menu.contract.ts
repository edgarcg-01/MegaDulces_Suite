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
/**
 * `[WMS-REC.18]` Cuantos dias atras se siguen mostrando las ordenes de entrada que nadie recibio.
 *
 * Cambia la regla de "solo hoy" (Edgar, 2026-09-24) a pedido de quien recibe (2026-10-07): si
 * ayer llegaron 8 y se recibieron 6, las 2 tienen que seguir a la vista al dia siguiente. Hoy
 * sigue arriba, igual que antes; lo atrasado va en su propio grupo. Lo fechado a FUTURO en Kepler
 * sigue fuera (el motivo de la regla original: Kepler adelanta documentos).
 */
export const DIAS_PENDIENTES_ANDEN = 7;

export interface ErpPendingBranch {
  sucursal: string;
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  /** Total por abrir: `compras + traspasos`. Es el numero que pinta la insignia. */
  pendientes: number;
  /** Ordenes de entrada sin recibir: las de hoy y las de los ultimos `DIAS_PENDIENTES_ANDEN` dias. */
  compras: number;
  /**
   * `[WMS-REC.18]` De `compras`, cuantas son de DIAS ANTERIORES (no de hoy). La pantalla las
   * separa: hoy sigue arriba, como decidio Edgar; lo atrasado va aparte para que no se pierda.
   */
  anteriores: number;
  /**
   * `[WMS-REC.17]` Embarques de otra sucursal o del CEDIS que vienen a esta y nadie abrio.
   * Su regla de dia es distinta (salio hoy, o sigue en camino): ver `transferVisible()`.
   */
  traspasos: number;
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
  /**
   * `[WMS-REC.17]` QUE documento de Kepler respalda el vale:
   *  · `orden_entrada` — `XA2001` de la sucursal que recibe (compras, y traspasos viejos `TI###`).
   *  · `embarque`      — `U-D-41` de la sucursal que EMBARCA. Ahi `sucursal` es el ORIGEN y
   *                      el almacen (`warehouse_*`) es el DESTINO.
   * Ausente = `orden_entrada` (lo que devolvian los endpoints antes de existir el campo).
   */
  fuente?: 'orden_entrada' | 'embarque';
  /** Serie del embarque (el folio de Kepler se repite entre series). Solo en `embarque`. */
  serie?: number | null;
  /** Fecha en que Kepler registro la recepcion `U-A-50`; `null` = todavia no la registra. */
  recibido_kepler?: string | null;
  /** Dias desde que salio el embarque (hora de Mexico). Solo en `embarque`. */
  dias_en_camino?: number | null;
  /** A donde lo mando Kepler, tal cual: codigo `TI###` y nombre del documento. */
  destino_code?: string | null;
  destino_nombre?: string | null;
}

/**
 * `[WMS-REC.17]` Un vale que alguien ya abrio y no ha cerrado.
 *
 * Existe para poder **cambiar de camion** a media captura: el vale abierto sale del menu de
 * pendientes (ya tiene sesion), y sin esta lista no habia forma de volver a el mas que el
 * borrador local del equipo, que solo recuerda el ultimo.
 */
export interface AndenValeEnCurso {
  id: string;
  /** Folio del vale de la Suite (`VE-2026-00123`). */
  folio: string;
  source_kind: 'manual' | 'erp_receipt' | 'erp_transfer';
  /** El documento de Kepler, para reconocerlo: `01/0000412` o `Embarque 00-2-0001048`. */
  documento: string | null;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  origin: { kind: 'supplier' | 'transfer'; isCedis: boolean; label: string; name: string | null };
  renglones: number;
  /** Renglones que todavia esperan lote y caducidad. */
  por_fechar: number;
  abierto_por: string | null;
  created_at: string;
}
