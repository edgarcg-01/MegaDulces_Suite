import type {
  CadenciaContratoCargo, ConceptoRenglonCargo, EstadoContratoCargo, EvidenciaDeSerie, MotivoCargoAutomatico, OrigenContratoCargo,
  ReglaImporteCargo, TipoContratoCargo,
} from '../finance/contratos-de-cargo.contract';

/**
 * `[PGP.213]` C2 — **La API de los contratos que sustentan los cargos del banco** (anexo CR §3.1–§3.4, DCR1/DCR2/DCR11).
 * `finance/charge-contracts`. Ver = `FINANCE_PAYMENTS_VER`; todo lo que escribe = `FINANCE_CHARGE_CONTRACTS_GESTIONAR`
 * (Tesorería y Finanzas). Los cuerpos son los que manda la pantalla (`[PGP.214]`): con ellos se prueba contra Postgres
 * real (regla 13). Las reglas puras viven en `finance/contratos-de-cargo.contract.ts`.
 */

/** Una fila de la tabla de amortización de un renglón «por tabla» (DCR8). `saldo` = el saldo insoluto, si el contrato lo da. */
export interface FilaTablaContratoCargo {
  fecha: string;
  importe: number;
  saldo?: number | null;
}

/** Un concepto de cobro, como lo manda la pantalla al dar de alta o al corregir una propuesta. */
export interface RenglonContratoCargoBody {
  concepto: ConceptoRenglonCargo;
  descripcion: string;
  cabeza_banco?: string | null;
  regla_importe: ReglaImporteCargo;
  importe_fijo?: number | null;
  cargos_por_periodo?: number;
  tasa_referencia?: string | null;
  tasa_puntos?: number | null;
  base_dias?: 360 | 365 | null;
  /** Al corregir: la tabla completa del renglón (reemplaza la que tenía). Sin la llave, la tabla no se toca. */
  tabla?: FilaTablaContratoCargo[];
}

/** `POST finance/charge-contracts` — un contrato que el detector no ve (la línea de crédito, uno nuevo). Nace propuesto. */
export interface CrearContratoCargoBody {
  tipo: TipoContratoCargo;
  acreedor: string;
  referencia?: string | null;
  cuenta_id: string;
  cadencia: CadenciaContratoCargo;
  dia_desde: number;
  dia_hasta: number;
  inicio?: string | null;
  fin?: string | null;
  kepler_acreedor?: string | null;
  sucursal?: string | null;
  notas?: string | null;
  renglones: RenglonContratoCargoBody[];
}

/** Lo que se puede corregir del encabezado de un contrato (al editar una propuesta o al confirmarla). */
export interface EncabezadoContratoCargoBody {
  tipo?: TipoContratoCargo;
  acreedor?: string;
  referencia?: string | null;
  cadencia?: CadenciaContratoCargo;
  dia_desde?: number;
  dia_hasta?: number;
  inicio?: string | null;
  fin?: string | null;
  kepler_acreedor?: string | null;
  sucursal?: string | null;
  notas?: string | null;
}

/**
 * `PATCH finance/charge-contracts/:id` — corregir una PROPUESTA (sólo `propuesto`). Un renglón con `id` se corrige; sin
 * `id`, se agrega. Los renglones que no vienen se quedan como están (nada se borra: el que cita una serie del banco es su
 * evidencia).
 */
export interface EditarContratoCargoBody extends EncabezadoContratoCargoBody {
  renglones?: (RenglonContratoCargoBody & { id?: string })[];
}

/** `POST finance/charge-contracts/:id/confirmar` — Tesorería confirma, con las correcciones que traiga. El PDF se sube antes. */
export type ConfirmarContratoCargoBody = EncabezadoContratoCargoBody;

/** `POST …/:id/terminar` (con `fin` opcional) y `POST …/:id/rechazar`: siempre con motivo. */
export interface MotivoContratoCargoBody {
  motivo: string;
  fin?: string | null;
}

/** `POST …/:id/documento` — el PDF del contrato (DCR11), como data URI. */
export interface DocumentoContratoCargoBody {
  pdf: string;
  nombre: string;
}

export interface RenglonContratoCargo {
  id: string;
  concepto: ConceptoRenglonCargo;
  descripcion: string;
  cabeza_banco: string | null;
  regla_importe: ReglaImporteCargo;
  importe_fijo: number | null;
  cargos_por_periodo: number;
  tasa_referencia: string | null;
  tasa_puntos: number | null;
  base_dias: number | null;
  /** La serie del banco que lo originó (`[PGP.209]`), o `null` si lo dio de alta una persona. */
  series_key: string | null;
  orden: number;
  tabla: FilaTablaContratoCargo[];
}

export interface FirmaContratoCargo {
  por: string;
  el: string;
}

export interface ContratoCargo {
  id: string;
  tipo: TipoContratoCargo;
  estado: EstadoContratoCargo;
  origen: OrigenContratoCargo;
  acreedor: string;
  referencia: string | null;
  cuenta: { id: string; banco: string; etiqueta: string };
  cadencia: CadenciaContratoCargo;
  dia_desde: number;
  dia_hasta: number;
  inicio: string | null;
  fin: string | null;
  kepler_acreedor: string | null;
  sucursal: string | null;
  notas: string | null;
  /** El PDF del contrato, si ya lo tiene (se abre con `GET …/:id/documento`). */
  documento: { nombre: string | null } | null;
  /** Las series del banco que originaron la propuesta (vacío en un contrato dado de alta a mano). */
  evidencia: EvidenciaDeSerie[];
  renglones: RenglonContratoCargo[];
  /** Lo que le falta para confirmarse, en llano (`problemasParaConfirmar`). Sólo en una propuesta; vacío = se puede. */
  faltan_para_confirmar: string[];
  alta: FirmaContratoCargo;
  confirmado: FirmaContratoCargo | null;
  terminado: (FirmaContratoCargo & { motivo: string | null }) | null;
  rechazado: (FirmaContratoCargo & { motivo: string | null }) | null;
}

/** `GET finance/charge-contracts` — todos los contratos del tenant (son decenas: sin paginar), con su conteo por estado. */
export interface ContratosCargoResponse {
  contratos: ContratoCargo[];
  conteo: Record<EstadoContratoCargo, number>;
}

/** `POST finance/charge-contracts/proponer` — lo que propuso el sistema con la historia del banco (DCR1). */
export interface ResultadoPropuestaContratos {
  /** Series vigentes que leyó del banco. */
  series: number;
  /** De ésas, las que ya cita algún renglón (propuesto, confirmado, terminado o rechazado). */
  ya_citadas: number;
  contratos: number;
  renglones: number;
}

/** Lo que dejó programado en el Calendario una corrida de «el cargo de cada mes» (`[PGP.211]`). */
export interface ResumenCargosDelMes {
  generados: number;
  ya_estaban: number;
  omitidos: { contrato_id: string; renglon_id: string; periodo: string; motivo: string }[];
}

/**
 * La respuesta de lo que escribe un contrato. Al confirmar trae `cargos`: el cargo del mes se programa en ese momento,
 * no hasta la siguiente carga del banco. Si no se pudo programar, el contrato queda confirmado y `aviso` dice por qué.
 */
export interface ContratoCargoEscrito {
  contrato: ContratoCargo;
  cargos?: ResumenCargosDelMes | null;
  aviso?: string | null;
  /**
   * Al TERMINAR: los cargos programados después del fin, que salen del Calendario (`retirados`), y los que se quedan
   * porque su día ya está autorizado (`se_quedan`, con qué hacer). Lo de antes del fin se queda: el banco pudo cobrarlo tarde.
   */
  cargos_retirados?: {
    retirados: { allocation_id: string; fecha: string; periodo: string; importe: number }[];
    se_quedan: { allocation_id: string; fecha: string; motivo: string }[];
  } | null;
}

/** Un cargo automático del banco que NO sustenta un contrato confirmado (`finance.v_automatic_bank_charges`, `[PGP.212]`). */
export interface CargoSinContrato {
  movimiento_id: string;
  cuenta: { id: string; banco: string; etiqueta: string };
  fecha: string;
  importe: number;
  concepto: string | null;
  cabeza: string | null;
  serie: string | null;
  detectado_por: string | null;
  contrato_id: string | null;
  motivo: MotivoCargoAutomatico;
}

/**
 * `GET finance/charge-contracts/sin-contrato?desde&hasta&limit` — los cargos sin contrato del rango, del más nuevo al más
 * viejo. `total` e `importe_total` son de TODO el rango aunque la lista se tope en `limit` (`has_more`): la cifra del
 * encabezado se tiene que poder recorrer (Cruce 1).
 */
export interface CargosSinContratoResponse {
  desde: string;
  hasta: string;
  cargos: CargoSinContrato[];
  total: number;
  importe_total: number;
  limit: number;
  has_more: boolean;
}

/** `GET …/:id/documento` — URL prefirmada de vida corta (600 s): no se guarda, se vuelve a pedir. */
export interface DocumentoContratoCargoUrl {
  url: string;
  nombre: string | null;
}

/**
 * `POST finance/charge-contracts/pasada` (y lo que corre el worker con cada carga del banco): proponer lo nuevo,
 * recalcular el interés de un crédito un día antes, programar el cargo de cada mes y cerrar lo que el banco ya cobró.
 * Cada paso falla solo: `fallas` dice cuál, y los demás corren igual.
 */
export interface PasadaCargosDelBanco {
  hoy: string;
  propuesta: ResultadoPropuestaContratos | null;
  recalculados: number | null;
  cargos: ResumenCargosDelMes | null;
  cerrados: number | null;
  esperando: number | null;
  fallas: string[];
}
