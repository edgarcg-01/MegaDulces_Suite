/**
 * `[MX.1.8]` — **Existencia en negativo: qué la explica, cómo se dice y cuándo vuelve a la bandeja.**
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-11-03: «hay que hacer un apartado para avisar a prevención todos estos incidentes de
 * existencias en negativo». Kepler deja vender sin existencia y nadie se entera: la pantalla de
 * Existencia recorta el negativo a 0. Medido ese día: ~3,030 producto×sucursal en negativo; la mitad
 * con movimiento en 30 días.
 *
 * ── Qué prueba el dato y qué NO (ADR-056) ──────────────────────────────────────────────────
 *  · `entrada_sin_aplicar` — la ÚNICA causa que el dato prueba: hay un vale de entrada (X-A-37) sin
 *    su orden de entrada (X-A-40, la que suma inventario). Medido: 14–20 de ~3,030 (17210 en Zamora
 *    Centro es uno). Se dice cuánto quedaría al aplicarla.
 *  · `salio_sin_existencia` — salió más de lo que entró y ningún vale pendiente lo explica. NO se
 *    afirma por qué (venta con otra clave, entrada que nunca se capturó, faltante real): eso lo
 *    averigua Prevención y lo deja en el motivo.
 *  · `rezago` — sin entrada ni salida en {@link DIAS_REZAGO} días: un negativo viejo. Decisión D9
 *    (Edgar, 2026-11-03): va aparte, en un solo renglón para revisarse en bloque, no mezclado con
 *    lo que está pasando hoy.
 *
 * ── Cuándo una resolución deja de valer ────────────────────────────────────────────────────
 * Se guarda la existencia que la persona vio. La incidencia vuelve si Kepler queda MÁS negativo
 * (se siguió vendiendo sin existencia) o si entró mercancía DESPUÉS de resolver y sigue en negativo
 * (la entrada no alcanzó, o se volvió a caer). Una mejora parcial sin entrada nueva no la reabre.
 */

import { diaCorto } from '../finance/dia-corto.contract';

export type CausaNegativo = 'entrada_sin_aplicar' | 'salio_sin_existencia' | 'rezago';

/** Días sin entrada ni salida para que un negativo sea «rezago» (D9). */
export const DIAS_REZAGO = 30;

export const ETIQUETA_CAUSA_NEGATIVO: Readonly<Record<CausaNegativo, string>> = {
  entrada_sin_aplicar: 'Entrada recibida sin aplicar',
  salio_sin_existencia: 'Salió sin existencia registrada',
  rezago: `Rezago: sin movimiento en ${DIAS_REZAGO} días`,
};

/** Las causas que forman la bandeja del día (D9): el rezago se cuenta aparte. */
export const CAUSAS_ACTIVAS: readonly CausaNegativo[] = ['entrada_sin_aplicar', 'salio_sin_existencia'];

/** Lo que Kepler dice de un producto en una sucursal. Fechas `YYYY-MM-DD`. */
export interface NegativoKepler {
  existencia: number;
  ult_entrada: string | null;
  ult_salida: string | null;
  /** Piezas en vale de entrada sin orden de entrada (null = no hay). */
  vale_piezas: number | null;
  vale_desde: string | null;
  vale_folios: readonly string[];
}

export interface ClasificacionNegativo {
  causa: CausaNegativo;
  /** Sólo `entrada_sin_aplicar`: la existencia si se aplica el vale. */
  quedaria: number | null;
}

/** Resta de días entre dos fechas `YYYY-MM-DD` (a − b), sin zona horaria. */
function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/** La fecha más reciente de las dos (o la que haya). */
export function ultimaActividad(n: Pick<NegativoKepler, 'ult_entrada' | 'ult_salida'>): string | null {
  const fechas = [n.ult_entrada, n.ult_salida].filter((f): f is string => !!f).sort();
  return fechas.length ? fechas[fechas.length - 1] : null;
}

/** `hoy` en `YYYY-MM-DD` (hora de México, la pone el servicio). */
export function clasificarNegativo(n: NegativoKepler, hoy: string): ClasificacionNegativo {
  if ((n.vale_piezas ?? 0) > 0) {
    return { causa: 'entrada_sin_aplicar', quedaria: redondear(n.existencia + (n.vale_piezas as number)) };
  }
  const ultima = ultimaActividad(n);
  if (!ultima || diasEntre(hoy, ultima) > DIAS_REZAGO) return { causa: 'rezago', quedaria: null };
  return { causa: 'salio_sin_existencia', quedaria: null };
}

function redondear(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Fecha corta o «sin fecha»: el formateador es el de CGP-L.4, no una segunda copia. */
function dia(f: string | null): string {
  return f ? diaCorto(f) : 'sin fecha';
}

function piezas(x: number): string {
  return `${Number(x.toFixed(2)).toLocaleString('es-MX')} pz`;
}

/**
 * DÓNDE está el error, en una línea (mismo criterio que `resumirDonde` de MX.2.4): lo que Kepler
 * marca, lo que lo explica si el dato lo prueba, y si no, lo que se sabe sin inventar el porqué.
 */
export function describirNegativo(n: NegativoKepler, c: ClasificacionNegativo): string {
  const marca = `Kepler marca ${piezas(n.existencia)}`;
  if (c.causa === 'entrada_sin_aplicar') {
    const folios = n.vale_folios.length > 1 ? `los vales ${n.vale_folios.join(', ')}` : `el vale ${n.vale_folios[0] ?? ''}`.trim();
    return `${marca}. Hay ${piezas(n.vale_piezas as number)} en ${folios} (desde ${dia(n.vale_desde)}) sin orden de entrada: al aplicarla queda en ${piezas(c.quedaria as number)}.`;
  }
  if (c.causa === 'rezago') {
    const u = ultimaActividad(n);
    return `${marca}, sin movimiento desde ${dia(u)}.`;
  }
  return `${marca}: salió más de lo que entró. Última salida ${dia(n.ult_salida)}, última entrada ${dia(n.ult_entrada)}; ningún vale pendiente lo explica.`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Motivos para dar por atendida una existencia negativa. Se guardan en
 * `commercial.negative_stock_reviews.resolution_reason`; codificados para contar después cuántas
 * fueron captura y cuántas faltante. `pide_nota` = sin nota no se acepta.
 */
export type MotivoNegativo =
  | 'entrada_aplicada'
  | 'conteo_ajustado'
  | 'error_de_captura'
  | 'faltante_confirmado'
  | 'otro';

export interface MotivoNegativoDef {
  codigo: MotivoNegativo;
  etiqueta: string;
  pide_nota: boolean;
}

export const MOTIVOS_EXISTENCIA_NEGATIVA: readonly MotivoNegativoDef[] = [
  { codigo: 'entrada_aplicada', etiqueta: 'Se aplicó la entrada pendiente en Kepler', pide_nota: false },
  { codigo: 'conteo_ajustado', etiqueta: 'Se contó y se ajustó en Kepler', pide_nota: false },
  { codigo: 'error_de_captura', etiqueta: 'Error de captura: se vendió con otra clave', pide_nota: true },
  { codigo: 'faltante_confirmado', etiqueta: 'Faltante real: se levantó acta', pide_nota: true },
  { codigo: 'otro', etiqueta: 'Otro motivo', pide_nota: true },
];

/** Valida una resolución. Devuelve el error en palabras, o `null` si es aceptable. */
export function validarResolucionNegativo(motivo: string | null | undefined, nota: string | null | undefined): string | null {
  const def = MOTIVOS_EXISTENCIA_NEGATIVA.find((m) => m.codigo === motivo);
  if (!def) return 'Elige un motivo de la lista.';
  if (def.pide_nota && (nota ?? '').trim().length < 3) return `«${def.etiqueta}» necesita una nota que diga qué pasó.`;
  if ((nota ?? '').length > 1000) return 'La nota pasa de 1,000 caracteres.';
  return null;
}

export interface ResolucionNegativo {
  motivo: MotivoNegativo;
  nota: string | null;
  por: string | null;
  /** `YYYY-MM-DD` (hora de México) en que se resolvió. */
  fecha: string;
  /** La existencia que la persona vio al resolver. */
  existencia_vista: number;
}

/** Por qué una incidencia resuelta volvió a la bandeja. */
export type MotivoReapertura = 'se_hundio' | 'entro_y_sigue';

export const ETIQUETA_REAPERTURA: Readonly<Record<MotivoReapertura, string>> = {
  se_hundio: 'Volvió: se siguió vendiendo sin existencia',
  entro_y_sigue: 'Volvió: entró mercancía y sigue en negativo',
};

/** `null` = la resolución sigue valiendo; si no, por qué volvió a la bandeja. */
export function reaperturaNegativo(
  r: Pick<ResolucionNegativo, 'fecha' | 'existencia_vista'>,
  actual: Pick<NegativoKepler, 'existencia' | 'ult_entrada'>,
): MotivoReapertura | null {
  if (actual.existencia < r.existencia_vista - 0.001) return 'se_hundio';
  if (actual.ult_entrada && actual.ult_entrada > r.fecha) return 'entro_y_sigue';
  return null;
}

// ════════════════════════════════════════════════════════════════════════════════════════════

export interface ExistenciaNegativaItem {
  warehouse_id: string;
  kepler_code: string;
  sucursal: string;
  sku: string;
  /** `null` = SKU de Kepler sin ficha en el catálogo: se publica igual. */
  product_id: string | null;
  producto: string | null;
  existencia: number;
  /** Costo de Kepler de ESA sucursal (`mv_kepler_unit_cost`); `null` = no hay costo, NO es 0. */
  costo_unitario: number | null;
  /** Lo que falta, a costo: |existencia| × costo. `null` si no hay costo. */
  valor: number | null;
  ult_entrada: string | null;
  ult_salida: string | null;
  causa: CausaNegativo;
  donde: string;
  vale: { piezas: number; desde: string | null; folios: string[] } | null;
  quedaria: number | null;
  /** Vigente o no: si `reabierta` trae motivo, la resolución ya no vale y está en pendientes. */
  resolucion: ResolucionNegativo | null;
  reabierta: MotivoReapertura | null;
}

export type EstadoNegativo = 'pendientes' | 'resueltas';

export interface ExistenciaNegativaResponse {
  /** `todas` = ve la red; `propias` = sólo sus sucursales (D10, alcance `own`). */
  alcance: 'todas' | 'propias';
  totals: {
    /** Todo lo que está en negativo dentro del alcance, resuelto o no. */
    universo: number;
    pendientes: number;
    resueltas: number;
    /** Pendientes por causa, con su valor a costo. */
    por_causa: Record<CausaNegativo, { n: number; valor: number; sin_costo: number }>;
    /**
     * Pendientes ACTIVOS (sin rezago) por sucursal, para el filtro: se ve dónde pesa antes de
     * elegir. Se calcula sobre el alcance completo, ignorando el filtro de sucursal de la consulta.
     */
    por_sucursal: { warehouse_id: string; sucursal: string; n: number; valor: number }[];
  };
  page: number;
  pageSize: number;
  /** Filas que cumplen el filtro (antes de paginar). */
  total: number;
  rows: ExistenciaNegativaItem[];
}

/** Orden de la bandeja: el dinero manda; sin costo al final; luego lo más negativo. */
export function ordenarNegativos<T extends Pick<ExistenciaNegativaItem, 'valor' | 'existencia' | 'sku' | 'kepler_code'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    (b.valor ?? -1) - (a.valor ?? -1)
    || a.existencia - b.existencia
    || a.kepler_code.localeCompare(b.kepler_code)
    || a.sku.localeCompare(b.sku));
}
