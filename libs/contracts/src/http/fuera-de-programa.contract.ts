/**
 * `[PGP.97]` `GET /finance/payment-calendar/fuera-de-programa` — la guía «pagado en el banco,
 * falta en Kepler» y la cobertura del programa de pagos. Sólo lectura.
 *
 * La regla vive en `finance/salida-proveedor.contract.ts`; aquí sólo la forma de la respuesta.
 */
import type { CoberturaDelPrograma, GuiaCalculada, MontoContado } from '../finance/salida-proveedor.contract';

/** Hasta qué día llega el workbook de bancos en cada cuenta. */
export interface CuentaCoberturaBanco {
  cuenta_id: string;
  /** Como la conoce Tesorería (`bank_accounts.alias`). */
  cuenta: string;
  account_label: string | null;
  /** Último movimiento vivo con fecha posible (no futura). `null` = la cuenta no tiene nada cargado. */
  hasta: string | null;
  /** Movimientos con fecha en el futuro: año mal tecleado (p. ej. 2027 por 2026). No se usan. */
  fechas_futuras: number;
  /** ¿Hay estado de cuenta de algún mes de la ventana? Sin él, la cuenta es un HUECO, no una cuenta quieta. */
  estado_cargado: boolean;
  /** ¿El workbook de esta cuenta llega al último día de la ventana? */
  cubre_ventana: boolean;
}

export interface GuiaFueraDePrograma extends Omit<GuiaCalculada, 'fuera_del_universo'> {
  desde: string;
  hasta: string;
  hoy: string;
  /** Última lectura buena de Kepler (el carril que trae `kdm1`). `null` = no se pudo medir. */
  datos_al: string | null;
  cuentas: CuentaCoberturaBanco[];
  fuera_del_universo: {
    /** Marcadas como proveedor, pero su pago (o su concepto) es de un acreedor de gasto. */
    gasto: MontoContado;
    /** El banco las devolvió (abono `DS`): no son pago. */
    devueltas: MontoContado;
    /** Fecha imposible para su estado de cuenta (más de un mes de desvío): no se usan. */
    fechas_invalidas: number;
  };
  /** Lo que no se pudo medir en esta ventana, dicho en palabras (ADR-056). Vacío = todo medido. */
  no_medido: string[];
}

/**
 * `[PGP.232]` `GET /finance/payment-calendar/cobertura` — cuánto del pago a proveedores de la
 * ventana pasó por el Calendario, y qué pago grande no. Sólo lectura.
 *
 * La cuenta es la misma que `metrica` de la guía de arriba; lo que cambia es que esto **no
 * depende del banco** (no parea salidas ni necesita la descarga subida), así que la franja del
 * Calendario puede publicarla todos los días.
 */
export interface CoberturaDelProgramaHttp extends CoberturaDelPrograma {
  hoy: string;
  /**
   * Última corrida buena del carril que trae `kdm1`/`kdxe` (`ods_live_caja`). `null` = no se pudo
   * medir: entonces la franja dice «sin medir», nunca un número (ADR-056).
   */
  datos_al: string | null;
}
