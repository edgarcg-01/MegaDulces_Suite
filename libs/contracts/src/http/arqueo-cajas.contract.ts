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
