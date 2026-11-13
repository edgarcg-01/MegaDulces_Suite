/**
 * `[GP.1]` La FORMA del wire del tablero de pedidos del almacén (`/almacen/pedidos`).
 *
 * El pedido es el documento Kepler `U-D-40` ("Pedido"), el mismo para telemarketing y para
 * sucursal: los separa sólo el **origen** (`kdm1.c27`). La Suite lo LEE del ODS y no lo
 * escribe (ADR-086). Decode en `docs/ERP_KEPLER.md` §3.y.3.
 *
 * La lógica (periodo por defecto, antigüedad, conteos) vive en
 * `libs/commercial/src/lib/warehouse-orders/warehouse-orders.engine.ts`; acá sólo la forma.
 */

/** Estatus de Kepler en el orden en que avanza el pedido. */
export const WAREHOUSE_ORDER_ESTATUS = ['CREADO', 'AUTORIZADO', 'SURTIDO', 'CHECADO', 'EMBARCADO'] as const;
export type WarehouseOrderEstatus = (typeof WAREHOUSE_ORDER_ESTATUS)[number];

/**
 * `[GP.10.0]` Estatus VIGENTE de un pedido cancelado. Kepler cancela con `kdm1.c43 = 'C'`, deja el
 * importe en $0 y borra los renglones, pero **conserva el `c11`** que tenía: sin esto, un cancelado
 * se contaba como vivo en su estatus viejo (medido 2026-11-13: 34 de los 54 «en SURTIDO» de
 * noviembre). No es una etapa del flujo: no va en `WAREHOUSE_ORDER_ESTATUS`.
 */
export const WAREHOUSE_ORDER_CANCELADO = 'CANCELADO' as const;

/**
 * `[GP.10.2]` Etapa de ALMACÉN de un pedido, de Kepler (`U-D-40`) o de preventa (`PD-`), en el orden
 * en que avanza (FASE_GP §3, paso 3). `en_cola`, `surtiendo` y `checando` sólo existen en el piso
 * (la Suite); los demás también los registra Kepler. La deriva `etapaDePedido` (warehouse-orders).
 */
export const ETAPAS_PEDIDO = ['creado', 'autorizado', 'en_cola', 'surtiendo', 'surtido', 'checando', 'checado', 'embarcado'] as const;
/** `cancelado` y `sin_dato` (sin cabecera en el ODS: nunca se pinta como «creado») van fuera del flujo. */
export type EtapaPedido = (typeof ETAPAS_PEDIDO)[number] | 'cancelado' | 'sin_dato';
/** Quién sabe la etapa: Kepler (su estatus) o el piso (lo que se registró en la Suite). */
export type FuenteEtapaPedido = 'kepler' | 'piso';

export interface EtapaPedidoResultado {
  etapa: EtapaPedido;
  /** `null` sólo en `sin_dato`. */
  fuente: FuenteEtapaPedido | null;
  /**
   * El piso registró un hito que Kepler todavía no (`piso_adelante`: surtido en la Suite, AUTORIZADO
   * en Kepler), o Kepler avanzó sin pasar por la Suite (`kepler_adelante`). Sólo se compara en los
   * hitos que registran los dos (surtido, checado, embarcado). Se marca, no se esconde.
   */
  desfase: 'piso_adelante' | 'kepler_adelante' | null;
}

export type WarehouseOrderOrigen = 'TELEMARK' | 'SUCURSAL';

export interface WarehouseOrderRow {
  /** Llave única en la red: `<sucursal>-<serie>-<folio>`. El folio solo NO es único entre sucursales. */
  clave: string;
  sucursal: string;
  sucursal_nombre: string;
  serie: number;
  folio: string;
  /** Como se ve en Kepler: `UD4001-0002781`. */
  documento: string;
  /** `YYYY-MM-DD`. */
  fecha: string;
  /** `HH:MM` de creación del ticket (`kdm1.c62`); `null` si Kepler no la trae. */
  hora: string | null;
  /** `TELEMARK`, `SUCURSAL`, u otro valor crudo si Kepler trae algo nuevo. */
  origen: string | null;
  /**
   * Estatus VIGENTE: el de Kepler (`kdm1.c11`), o `CANCELADO` si el documento está cancelado
   * (`c43 = 'C'`, `[GP.10.0]`).
   */
  estatus: string | null;
  /** Estatus crudo de Kepler (`kdm1.c11`). En un cancelado es el que tenía al cancelarse. */
  estatus_kepler: string | null;
  cliente_code: string | null;
  /** Nombre del destino tal como lo trae el pedido (`c32`). */
  destino_nombre: string | null;
  destino_ciudad: string | null;
  vendedor_code: string | null;
  vendedor_nombre: string | null;
  renglones: number;
  /**
   * Volumen del pedido sumado por unidad de presentación (`kdm2.c55`, cantidad `c56`): p. ej.
   * 16 CJA, 164 PAQ, 43.4 KG. Unidad `SIN UNIDAD` = renglón sin unidad capturada (no se usa `?`: knex lo toma como parámetro).
   */
  volumen: Array<{ unidad: string; cantidad: number }>;
  importe: number | null;
  guia: string | null;
  transporte: string | null;
  chofer: string | null;
  /** Claves de Kepler: sus catálogos NO están en el ODS, quedan en código. */
  resp_surtido: string | null;
  resp_checado: string | null;
  resp_embarque: string | null;
  /**
   * Horas desde que se CREÓ el pedido (fecha + hora del ticket, hora de México). `null` si ya
   * está `EMBARCADO` o `CANCELADO`, o si falta la hora. ⚠️ No es el tiempo en la etapa actual: Kepler no guarda
   * cuándo cambió de estatus (ERP_KEPLER §3.y.3), así que ese dato no existe.
   */
  horas_abierto: number | null;
}

export interface WarehouseOrdersAlcance {
  /** `true` = todas las sucursales; si no, sólo `sucursales`. */
  todas: boolean;
  sucursales: Array<{ codigo: string; nombre: string }>;
}

export interface WarehouseOrdersResponse {
  periodo: { from: string; to: string };
  alcance: WarehouseOrdersAlcance;
  /** Filtros aplicados a `items` (el periodo y el alcance aplican a todo). */
  filtros: { estatus: string[]; origen: string | null; sucursal: string | null; q: string | null };
  /**
   * Pedidos por estatus en el periodo, con origen/sucursal aplicados pero SIN el filtro de
   * estatus: son los números de los botones de filtro. Incluye `CANCELADO` si hay alguno.
   */
  conteos: Array<{ estatus: string; pedidos: number; renglones: number; mas_antiguo_horas: number | null }>;
  /**
   * `importe` null = quien consulta no ve dinero (`[MCP.3.2]`: el surtidor, sin `ALMACEN_PEDIDOS_VER`).
   * Sin filtro de estatus, los cancelados NO entran (ni aquí ni en `items`): se ven eligiéndolos.
   */
  totales: { pedidos: number; renglones: number; importe: number | null };
  items: WarehouseOrderRow[];
  /** `true` si `items` se recortó al tope; los conteos y totales NO se recortan. */
  truncado: boolean;
  generado_en: string;
}

export interface WarehouseOrderLine {
  renglon: number;
  sku: string;
  descripcion: string | null;
  /** Cantidad y unidad de venta (`kdm2.c9`, `c11`). */
  cantidad: number | null;
  unidad: string | null;
  /** Unidad de presentación del pedido (`c55`); las cuatro cantidades por etapa van en ella. */
  unidad_presentacion: string | null;
  cant_pedida: number | null;
  cant_surtida: number | null;
  cant_checada: number | null;
  cant_embarcada: number | null;
  /** Ubicación capturada en Kepler por etapa (`c59`/`c60`/`c61`). Hoy casi nadie la llena. */
  ubic_surtido: string | null;
  ubic_checado: string | null;
  ubic_embarque: string | null;
  /** Etapa en que se AGREGÓ el renglón (`c28`); no es su estatus. */
  etapa_alta: string | null;
  importe: number | null;
}

export interface WarehouseOrderShipment {
  documento: string;
  fecha: string;
  estatus: string | null;
  guia: string | null;
}

export interface WarehouseOrderDetail {
  pedido: WarehouseOrderRow;
  lineas: WarehouseOrderLine[];
  /** Embarques `U-D-41` que apuntan a este pedido (`c37='40'` + `c39` = folio). */
  embarques: WarehouseOrderShipment[];
}
