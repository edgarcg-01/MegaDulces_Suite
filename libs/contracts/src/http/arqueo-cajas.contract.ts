/**
 * [SM.48] `GET /store/arqueo/cajas` — Sucursales y sus cajas de UN día.
 *
 * Reemplaza «Arqueos recientes» para quien VALIDA (RECONCILIATION_VER): por
 * sucursal, cada caja con sus turnos de Kepler, y en cada turno sus retiros y el
 * conteo del cajón, con dos revisiones:
 *
 *  1. Retiros: lo contado contra lo que Kepler dice que salió en sangrías (c48).
 *  2. Cuadre del turno: retiros + cajón contra el esperado (c15), con la identidad
 *     única de `cuadreTurno` (cash-cut-identity) — la misma que usa el historial.
 *
 * La cajera NO ve esto: muestra el esperado, y el arqueo es ciego.
 */

/**
 * [SM.49] Por qué salió el dinero en un retiro. Una sola lista para el servidor (que la
 * valida y el CHECK de la tabla que la repite) y la pantalla (el menú del tipo de arqueo).
 * Con `otro`, el motivo escrito es obligatorio.
 */
export const CONCEPTOS_RETIRO = [
  { value: 'pago_proveedor', label: 'Pago a proveedor' },
  { value: 'pago_nomina', label: 'Pago de nómina' },
  { value: 'gasto_sucursal', label: 'Gasto de la sucursal (caja chica)' },
  { value: 'deposito_banco', label: 'Depósito al banco' },
  { value: 'otro', label: 'Otro' },
  // Va en «Otros arqueos» del menú: es la sangría normal, la que pide Kepler por el límite.
  { value: 'retiro_caja', label: 'Retiro de caja' },
] as const;

export type ConceptoRetiro = typeof CONCEPTOS_RETIRO[number]['value'];

/** Nombre del concepto; con `otro`, el motivo escrito. null = retiro anterior a SM.49 (sin concepto). */
export function conceptoRetiroLabel(concepto: string | null | undefined, motivo?: string | null): string | null {
  if (!concepto) return null;
  if (concepto === 'otro') return motivo ? 'Otro: ' + motivo : 'Otro';
  return CONCEPTOS_RETIRO.find((c) => c.value === concepto)?.label ?? concepto;
}

/** Un conteo (retiro, cierre, relevo, ruta o conteo sin caja) tal como se capturó. */
export interface ArqueoCajasConteo {
  id: string;
  tipo: string;
  secuencia: number;
  caja: string;
  /** Hora de captura en la zona de la tienda, 'HH:MM:SS'. */
  hora: string;
  captured_at: string;
  total: number;
  /** Usuario de la Suite que lo capturó, y su nombre si está dado de alta. */
  usuario: string | null;
  usuario_nombre: string | null;
  /** Piezas por denominación, como se guardaron ({"500":21,"20m":3,...}). */
  denominations: Record<string, number>;
  medios: Record<string, number> | null;
  nota: string | null;
  incidencia_tipo: string | null;
  motivo: string | null;
  /** [SM.49] Solo retiro: el concepto (ver CONCEPTOS_RETIRO). null en retiros anteriores. */
  concepto: string | null;
  route_code: string | null;
  cash_cut_folio: string | null;
  validado_por: string | null;
  validado_at: string | null;
  /** Cómo se pegó a su turno: por el folio guardado o por caja + hora. */
  ligado?: 'folio' | 'hora';
}

export type ArqueoRetirosEstado = 'sin_retiros' | 'cuadra' | 'faltan' | 'de_mas';

export interface ArqueoCajasTurno {
  caja: string;
  folio: string;
  /** Código de cajera de Kepler (c8) y su nombre del catálogo de cajeros. */
  cajero_code: string | null;
  cajero_nombre: string | null;
  hora_apertura: string | null;
  /** null = el turno sigue abierto. */
  hora_cierre: string | null;
  abierto: boolean;
  /** c15. null mientras la caja opera: Kepler lo escribe al cerrar. */
  esperado: number | null;
  /** c48 — lo que Kepler registró como sangrías. */
  retirado_kepler: number;
  retiros: ArqueoCajasConteo[];
  /** El conteo del cajón (normalmente uno). */
  cierres: ArqueoCajasConteo[];
  relevos: ArqueoCajasConteo[];
  retiros_contados: number;
  retiros_estado: ArqueoRetirosEstado;
  /** contados − Kepler. Negativo = falta contar; positivo = contado de más. */
  retiros_diferencia: number;
  cuadre: {
    medible: boolean;
    /** sin_esperado · sin_conteo · sin_desglose · null */
    motivo: string | null;
    /** + faltante / − sobrante. null si no es medible. */
    diferencia: number | null;
    /** Retiros que Kepler registró y nadie contó: se aceptan para cerrar la cuenta, marcados. */
    retiros_sin_verificar: number;
    contado_total: number | null;
  };
}

export interface ArqueoCajasSucursal {
  warehouse_code: string;
  nombre: string | null;
  turnos: ArqueoCajasTurno[];
  /** Conteos de caja que no cayeron en ningún turno (se dicen, no se pegan al «más parecido»). */
  sin_turno: ArqueoCajasConteo[];
  /** RD, RV y «Conteo de efectivo»: no son de una caja y no suman a ningún cuadre. */
  sin_caja: ArqueoCajasConteo[];
}

export interface ArqueoCajasResp {
  fecha: string;
  /** Desde cuántos pesos una diferencia se considera real (CUADRE_UMBRAL). */
  umbral: number;
  sucursales: ArqueoCajasSucursal[];
}

// ── [SM.55] Turnos por revisar: la encargada justifica lo que quedó sin contar ──

/**
 * Por qué un turno cerrado le toca a la encargada.
 *  - `retiros_sin_contar`: Kepler registró sangrías (c48) y la Suite tiene menos.
 *  - `retiros_de_mas`: la Suite tiene más retiros que Kepler (otra caja, otro concepto, duplicado).
 *  - `cajon_sin_contar`: el turno cerró con esperado y nadie contó el cajón.
 */
export type MotivoRevision = 'retiros_sin_contar' | 'retiros_de_mas' | 'cajon_sin_contar';

/**
 * Lo que la encargada encontró. Sale de la medición de prod del 1–22 nov 2026: casi todo
 * fue «no se capturó», «en otra caja» o «con otro tipo», no dinero perdido. `otro` exige
 * que la nota diga qué pasó (la nota es obligatoria siempre; ver NOTA_MIN).
 */
export const CAUSAS_REVISION = [
  { value: 'no_capturado', label: 'Se hizo pero no se capturó en la Suite (el dinero está)' },
  { value: 'otra_caja', label: 'Se capturó en otra caja o en otro turno' },
  { value: 'otro_tipo', label: 'Se capturó con otro tipo o concepto (depósito, fondo, préstamo)' },
  { value: 'duplicado', label: 'Retiro duplicado (en la Suite o en Kepler)' },
  { value: 'error_kepler', label: 'Error en Kepler (retiro o corte mal registrado)' },
  { value: 'faltante_real', label: 'Faltante real de dinero' },
  { value: 'otro', label: 'Otro' },
] as const;

export type CausaRevision = typeof CAUSAS_REVISION[number]['value'];

/** La nota es la justificación: sin ella el registro no sirve para nada. */
export const NOTA_REVISION_MIN = 10;
export const NOTA_REVISION_MAX = 500;
/** Cuántos días hacia atrás se le muestran a la encargada (y el tope de una consulta). */
export const REVISION_DIAS_DEFAULT = 7;
export const REVISION_DIAS_MAX = 31;

export function causaRevisionLabel(causa: string | null | undefined): string | null {
  if (!causa) return null;
  return CAUSAS_REVISION.find((c) => c.value === causa)?.label ?? causa;
}

/**
 * Lo que hizo la encargada DESPUÉS de saber la causa. Un caso no se cierra sin al menos una.
 * `corrigio_suite` = se capturó en la Suite el retiro o el cajón que faltaba.
 */
export const ACCIONES_REVISION = [
  { value: 'hablo_cajera', label: 'Hablé con la cajera' },
  { value: 'corrigio_suite', label: 'Se capturó en la Suite lo que faltaba' },
  { value: 'corrigio_kepler', label: 'Se corrigió en Kepler' },
  { value: 'repuso_faltante', label: 'Se repuso el faltante' },
  { value: 'acta_administrativa', label: 'Se levantó acta administrativa' },
  { value: 'escalo', label: 'Se escaló al supervisor de zona' },
  { value: 'otro', label: 'Otro' },
] as const;

export type AccionRevision = typeof ACCIONES_REVISION[number]['value'];

export function accionRevisionLabel(accion: string | null | undefined): string | null {
  if (!accion) return null;
  return ACCIONES_REVISION.find((a) => a.value === accion)?.label ?? accion;
}

/** Los motivos que rompen el empate de RETIROS Suite ↔ Kepler: los únicos que se justifican. */
export const MOTIVOS_RETIROS: readonly MotivoRevision[] = ['retiros_sin_contar', 'retiros_de_mas'];

/**
 * En qué va cada turno cerrado, en cuanto a sus RETIROS (lo que se empareja con Kepler). El cajón
 * sin contar va aparte, como dato (`motivos` + `cajon_contado`): no se justifica aquí.
 *  - `cuadra`: los retiros de la Suite empatan con los de Kepler.
 *  - `por_justificar`: no empatan y nadie dijo qué pasó.
 *  - `en_seguimiento`: ya tiene causa; falta la acción o cerrarlo.
 *  - `cerrado`: con causa, acción y cerrado. Ya no se edita.
 */
export type EstadoRevision = 'cuadra' | 'por_justificar' | 'en_seguimiento' | 'cerrado';

/** Un renglón del historial del caso, en el orden en que pasó. */
export interface ArqueoRevisionEvento {
  tipo: 'causa' | 'accion' | 'cerrado';
  /** La causa o la acción (clave del catálogo). null en `cerrado`. */
  valor: string | null;
  nota: string | null;
  por: string | null;
  por_nombre: string | null;
  at: string;
}

/** La justificación que dejó la encargada (la última, si se justificó más de una vez). */
export interface ArqueoRevisionJustificacion {
  causa: string;
  nota: string;
  por: string | null;
  por_nombre: string | null;
  at: string;
}

/** Un turno cerrado de Kepler, con lo que le falta y en qué va su revisión. */
export interface ArqueoRevisionTurno {
  /** La llave del turno, la misma que usa el motor de hallazgos (dedup). */
  clave: string;
  fecha: string;
  warehouse_code: string;
  warehouse_nombre: string | null;
  caja: string;
  folio: string;
  cajero_code: string | null;
  cajero_nombre: string | null;
  hora_apertura: string | null;
  hora_cierre: string | null;
  /** Vacío = el turno cuadra (estado `cuadra`). */
  motivos: MotivoRevision[];
  /** c48: lo que Kepler dice que salió en sangrías. */
  retirado_kepler: number;
  retiros_contados: number;
  /** contados − Kepler. Negativo = falta contar; positivo = contado de más. */
  retiros_diferencia: number;
  cajon_contado: boolean;
  estado: EstadoRevision;
  /** La última causa. null = todavía nadie lo justificó. */
  justificacion: ArqueoRevisionJustificacion | null;
  historial: ArqueoRevisionEvento[];
}

/** Quién marcó el día como revisado. */
export interface ArqueoRevisionFirmaDia {
  por: string | null;
  por_nombre: string | null;
  at: string;
  nota: string | null;
}

/** Un día de una sucursal: cuántos turnos cerró y en qué va cada uno. */
export interface ArqueoRevisionDia {
  fecha: string;
  warehouse_code: string;
  turnos: number;
  cuadran: number;
  por_justificar: number;
  en_seguimiento: number;
  cerrados: number;
  /** null = nadie lo ha marcado revisado. */
  revisado: ArqueoRevisionFirmaDia | null;
}

/** Cuántas veces se repite cada error por cajera, en el rango consultado. */
export interface ArqueoRevisionCajera {
  cajero_code: string;
  cajero_nombre: string | null;
  sucursales: string[];
  turnos: number;
  con_problema: number;
  motivos: Record<MotivoRevision, number>;
  /** Causas que dio la encargada, con cuántas veces cada una. */
  causas: Record<string, number>;
  por_justificar: number;
  /** Retiros de TODOS sus turnos cerrados del rango: Kepler, Suite y la diferencia (Suite − Kepler). */
  retirado_kepler: number;
  retiros_contados: number;
  retiros_diferencia: number;
  /** Suma de las diferencias SIN signo: una de +$2,000 no esconde una de −$5,000. */
  retiros_descuadre: number;
  /** Turnos cuyos retiros no empatan con Kepler. */
  turnos_descuadre: number;
}

/** Los totales de retiros del rango (todas las sucursales consultadas): la meta es diferencia 0. */
export interface ArqueoRevisionTotales {
  retirado_kepler: number;
  retiros_contados: number;
  /** Suite − Kepler, neta. */
  retiros_diferencia: number;
  /** Suma de las diferencias sin signo. */
  retiros_descuadre: number;
  turnos_descuadre: number;
  cajeras_descuadre: number;
  /** Turnos que no empatan y nadie ha explicado. */
  por_justificar: number;
}

export interface ArqueoRevisionSucursal {
  warehouse_code: string;
  nombre: string | null;
  /** Turnos con algo que revisar (los que cuadran no cuentan aquí). */
  total: number;
  /** Con causa (en seguimiento o cerrados). */
  justificados: number;
  /** Sin causa todavía. */
  pendientes: number;
  en_seguimiento: number;
  cerrados: number;
  dias_sin_revisar: number;
}

export interface ArqueoRevisionResp {
  desde: string;
  hasta: string;
  /** Cuándo entró el último dato de Kepler (ODS). null = no se sabe: se declara, no se supone. */
  datos_al: string | null;
  frescura: 'ok' | 'error' | 'desconocido';
  /** TODOS los turnos cerrados del rango, también los que cuadran. */
  turnos: ArqueoRevisionTurno[];
  dias: ArqueoRevisionDia[];
  /** Solo las cajeras con al menos un turno cuyos retiros no empatan, la de mayor descuadre primero. */
  cajeras: ArqueoRevisionCajera[];
  sucursales: ArqueoRevisionSucursal[];
  totales: ArqueoRevisionTotales;
}

/** `GET /store/arqueo-revision/resumen` — lo justo para el aviso de las pestañas. */
export interface ArqueoRevisionResumen {
  desde: string;
  hasta: string;
  por_justificar: number;
  en_seguimiento: number;
  dias_sin_revisar: number;
}

/** `POST /store/arqueo-revision` — lo que manda la pantalla. */
export interface ArqueoRevisionJustificarDto {
  warehouse_code: string;
  fecha: string;
  caja: string;
  folio: string;
  causa: CausaRevision;
  nota: string;
}

/** `POST /store/arqueo-revision/accion` — qué se hizo, y si con eso se cierra el caso. */
export interface ArqueoRevisionAccionDto {
  warehouse_code: string;
  fecha: string;
  caja: string;
  folio: string;
  accion: AccionRevision;
  nota: string;
  cerrar: boolean;
}

/** `POST /store/arqueo-revision/dia` — la encargada firma que revisó el día. */
export interface ArqueoRevisionDiaDto {
  warehouse_code: string;
  fecha: string;
  nota?: string | null;
}
