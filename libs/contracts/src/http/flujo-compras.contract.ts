/**
 * `[RA-PRO.63]` Flujo de compras: requisición (nuestra) → orden de compra (Kepler XA3501) →
 * orden de entrada (Kepler XA2001). Pestaña "Flujo" de `/compras/pedido`.
 *
 * **La liga requisición→OC es SUGERIDA, no un hecho.** Nadie captura hoy qué OC cubrió cada
 * requisición (medido 2026-09-26: las 310 requisiciones de prod siguen en `pending_approval`), así
 * que se busca la OC de Kepler de la MISMA sucursal y el MISMO proveedor en los días siguientes, y
 * se elige la que trae más productos de la requisición. La confianza se declara (`alta`/`media`) y
 * el empate también (`ambigua`).
 *
 * **Lo que NO se compara: la cantidad.** La OC no es la requisición copiada — el comprador arma su
 * propia orden y a veces junta varias requisiciones (medido: la OC trae de 0.1× a 94× lo pedido del
 * mismo producto). Por eso requisición→OC se mide como "¿el producto entró a la OC?" y OC→entrada
 * en DINERO (la orden y la entrada pueden venir en unidades distintas).
 */

/** Etapa a la que llegó una requisición. */
export const FLUJO_ETAPAS = ['con_entrada', 'en_oc', 'esperando', 'sin_oc', 'sin_fuente'] as const;
export type FlujoEtapa = (typeof FLUJO_ETAPAS)[number];

export const FLUJO_ETAPA_LABEL: Record<FlujoEtapa, string> = {
  con_entrada: 'Con entrada',
  en_oc: 'En OC, sin entrada',
  esperando: 'Esperando OC',
  sin_oc: 'Sin OC',
  sin_fuente: 'Sin fuente',
};

/** Confianza de la liga sugerida requisición→OC. */
export type FlujoConfianza = 'alta' | 'media';

export interface FlujoOcDto {
  sucursal: string;
  folio: string;
  fecha: string;
  /** Días de la requisición a la OC. */
  dias: number;
  monto: number;
  /** % de los productos de la requisición que vienen en esta OC (0–100). */
  coincidencia_pct: number;
  confianza: FlujoConfianza;
  /** Otra OC empata en productos: la liga es la más cercana en fecha, pero hay duda. */
  ambigua: boolean;
  /** Cuántas requisiciones del periodo quedaron ligadas a esta misma OC. */
  requisiciones_en_oc: number;
}

export interface FlujoEntradaDto {
  /** Entradas XA2001 válidas (mismo proveedor, desde la fecha de la OC). */
  n: number;
  primera_fecha: string | null;
  monto: number;
  /** Entradas ÷ OC, en dinero. `null` si la OC no trae monto. */
  surtido_pct: number | null;
}

export interface FlujoRenglonDto {
  sku: string;
  nombre: string;
  /** Costo pedido en la requisición (cantidad × costo del momento). */
  costo: number;
  /** `true` = vino en la OC ligada · `false` = no vino (negado) · `null` = no hay OC ligada. */
  en_oc: boolean | null;
}

export interface FlujoRequisicionDto {
  id: string;
  folio: string;
  fecha: string;
  almacen: string;
  almacen_nombre: string;
  proveedor: string | null;
  renglones: number;
  costo: number;
  etapa: FlujoEtapa;
  /** Por qué quedó en esa etapa, en palabras (sobre todo `sin_fuente` y `esperando`). */
  motivo: string | null;
  oc: FlujoOcDto | null;
  entrada: FlujoEntradaDto | null;
  /** Renglones que no vinieron en la OC ligada (0 si no hay OC). */
  negados: number;
  lineas: FlujoRenglonDto[];
}

export interface FlujoNegadoDto {
  sku: string;
  nombre: string;
  proveedor: string | null;
  /** En cuántas requisiciones CON OC ligada se pidió. */
  veces_pedido: number;
  /** En cuántas de ésas no vino en la OC. */
  veces_negado: number;
  costo_negado: number;
}

export interface FlujoResumenDto {
  requisiciones: number;
  por_etapa: Record<FlujoEtapa, number>;
  /** Requisiciones con OC ligada (alta + media). */
  con_oc: number;
  ambiguas: number;
  /** Renglones de las requisiciones con OC ligada. */
  renglones_ligados: number;
  negados: number;
  /** % de renglones (de requisiciones con OC) que sí vinieron en la OC. `null` sin datos. */
  renglones_en_oc_pct: number | null;
  /**
   * OC→entrada: MEDIANA del surtido de las OC que ya tienen entrada. Es la cifra principal: una
   * sola OC grande sin terminar de recibir no debe pintar a todas (medido: una de Mondelez de $10 M al
   * 19% bajaba el ponderado a 32% mientras 46 de 53 OC surtían 90–110%).
   */
  surtido_mediana_pct: number | null;
  /** OC→entrada ponderado por dinero (cada OC UNA vez). Se muestra al lado, no en lugar de la mediana. */
  surtido_dinero_pct: number | null;
  /** OC con al menos una entrada válida. */
  ocs_con_entrada: number;
  ocs_distintas: number;
}

export interface FlujoComprasDto {
  desde: string;
  hasta: string;
  dias: number;
  /** Días que se espera a Kepler antes de dar una requisición por "sin OC". */
  ventana_dias: number;
  resumen: FlujoResumenDto;
  requisiciones: FlujoRequisicionDto[];
  negados_recurrentes: FlujoNegadoDto[];
  /** Requisiciones de traspaso (CEDIS→sucursal): no pasan por una OC, no se buscan en Kepler. */
  traspasos_fuera: number;
}
