/**
 * `[MX.1.4]` — **Catálogo de excepciones de movimientos de inventario**: qué es cada documento y si
 * va a la bandeja de excepciones (Fase MX; ADR-056: la regla vive una vez, en `libs/`).
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 * Hoy se audita a mano el Diario completo: medido el 2026-10-28, el 90.7 % de 4,282 marcas
 * «auditado» cayó en documentos que el motor ya cuadraba, y sólo 21 tocaron una excepción de 1,222
 * disponibles. La bandeja trae SÓLO lo que el motor no puede dar por bueno; este catálogo es la regla
 * que lo decide, para que la API de la bandeja, el Diario y el PDF no la repitan cada uno a su modo.
 *
 * ── Reglas (decisiones D3 y D5 de la fase) ─────────────────────────────────────────────────
 *  · Traspaso que cuadra (misma suma Y misma firma de productos, MX.1.1) → `cuadrado`, NO va.
 *  · Traspaso en tránsito (a almacén, ≤ 15 días) → `en_transito`, todavía NO va.
 *  · Salida a ruta o cliente → `sin_recepcion_esperada`: nadie emite acuse, NO va.
 *  · Diferencia, sin acuse (> 15 días), recepción sin origen → SÍ va.
 *  · Ajuste de inventario (`InvOut1` / `InvIn1`) → SÍ va siempre: un ajuste ya es una excepción.
 *  · Cualquier otro tipo (compras, ventas, inventario físico, Wincaja) → `sin_comparacion`: el motor
 *    no tiene contra qué compararlo; NO va, y NO se pinta como bueno (ADR-056).
 *  · Un importe incompleto (renglones con costo 0 en Kepler, MX.1.2) se AGREGA como excepción a lo
 *    que ya sea el documento: un traspaso que cuadra en piezas con dinero sin verificar SÍ va.
 */

/**
 * `[MX.1.7]` — **El importe de una SALIDA de traspaso no tiene una sola unidad: depende del destino.**
 * El importe sale del documento (`kdm2.c13`). Medido el 2026-10-28 (MX.0.2):
 *  · a SUCURSAL → valor de traspaso: idéntico al de la recepción en 1,762 de 1,764 pares;
 *  · a CLIENTE  → precio de venta (`c12 ≈ c66`, lista): el kardex (costo) vale 0.83×, 0 de 119 iguales;
 *  · a RUTA     → mezcla: 74 de 181 iguales al kardex, 1.07× en promedio.
 * Ningún total suma las tres sin decirlo.
 */
export type DestinoSalida = 'sucursal' | 'ruta' | 'cliente';
export type UnidadImporte = 'valor_traspaso' | 'precio_venta' | 'mixta';
export const UNIDAD_IMPORTE_SALIDA: Readonly<Record<DestinoSalida, UnidadImporte>> = {
  sucursal: 'valor_traspaso', cliente: 'precio_venta', ruta: 'mixta',
};
export const ETIQUETA_UNIDAD_IMPORTE: Readonly<Record<UnidadImporte, string>> = {
  valor_traspaso: 'valor de traspaso', precio_venta: 'a precio de venta', mixta: 'costo y precio mezclados',
};

/**
 * `[MX.2.3]` — **Respuesta de la bandeja de excepciones** (`GET /commercial/movements/exceptions`).
 * Los totales se calculan sobre el conjunto COMPLETO; `rows` es una página. El importe se suma POR
 * UNIDAD (MX.1.7), nunca en un solo número: una salida a cliente está a precio de venta.
 */
export interface ExcepcionMovimientoItem {
  tipo: 'traspaso' | 'ajuste';
  excepciones: ExcepcionMovimiento[];
  fecha: string;
  /** Traspaso: el almacén que envió. Ajuste: el almacén del ajuste. */
  origen: { warehouse_id: string | null; nombre: string | null; folio: string | null; doc_code: string };
  /** Sólo traspaso: a quién iba (o quién recibió). */
  destino: { warehouse_id: string | null; nombre: string | null; folio: string | null } | null;
  piezas_enviadas: number | null;
  piezas_recibidas: number | null;
  /** Traspaso: recibidas − enviadas. Ajuste: piezas con signo (+ entrada, − salida). */
  delta_piezas: number | null;
  importe: number | null;
  /** `null` = unidad NO MEDIDA (ajustes; recepción sin origen). */
  unidad_importe: UnidadImporte | null;
  lineas_sin_importe: number;
  /** Días desde la salida (traspaso) o desde el ajuste. */
  dias: number;
}

export interface MovimientosExcepcionesResponse {
  range: { from: string; to: string };
  totals: {
    items: number;
    /** Por excepción: un ítem con dos excepciones cuenta en las dos. */
    por_excepcion: Partial<Record<ExcepcionMovimiento, { n: number; importe: number }>>;
    /** El importe, separado por unidad; `sin_unidad` = no medida. */
    importe_por_unidad: Record<UnidadImporte | 'sin_unidad', number>;
    /** De cuántos documentos salió la bandeja (para decir qué fracción es excepción). */
    universo: { traspasos: number; ajustes: number };
  };
  /** El pareo trae a lo más 50,000 filas; si llegó, la bandeja está INCOMPLETA. */
  capped: boolean;
  page: number; pageSize: number; total: number;
  rows: ExcepcionMovimientoItem[];
}

/** Por qué un documento está en la bandeja. Un documento puede tener más de una. */
export type ExcepcionMovimiento =
  | 'diferencia'          // piezas o productos distintos entre salida y recepción
  | 'sin_acuse'           // salió a un almacén y nadie registró la recepción en el umbral
  | 'sin_origen'          // recepción sin una salida que la respalde
  | 'ajuste_inventario'   // InvOut1 / InvIn1: siempre se revisa
  | 'importe_incompleto'; // renglones con costo 0 en Kepler: el dinero no se pudo verificar

/** Qué es el documento para el motor, haya o no excepción. */
export type EstadoMovimiento =
  | 'cuadrado'
  | 'en_transito'
  | 'sin_recepcion_esperada'
  | 'sin_comparacion'
  | 'excepcion';

/** Tipos de documento que el motor sí compara (salida ↔ recepción). */
export const DOC_CODES_TRASPASO: readonly string[] = ['TrsfShip', 'TrsfRcv'];
/** Ajustes de inventario: van siempre a la bandeja (decisión D3). */
export const DOC_CODES_AJUSTE: readonly string[] = ['InvOut1', 'InvIn1'];

/** Estado del documento de traspaso como lo publica el motor (`transfer_status` del Diario). */
export type EstadoTraspaso = 'en_transito' | 'sin_acuse' | 'sin_recepcion_esperada' | 'completado' | 'diferencia' | 'sin_origen';

export interface DocumentoAClasificar {
  doc_code: string;
  /** Sólo traspasos: el estado que calculó el motor. Ausente en un traspaso = no se sabe. */
  transfer_status?: EstadoTraspaso | null;
  /** Renglones con costo 0 en Kepler (MX.1.2). */
  lineas_sin_importe?: number | null;
}

export interface ClasificacionMovimiento {
  estado: EstadoMovimiento;
  excepciones: ExcepcionMovimiento[];
  /** `true` = va a la bandeja de excepciones. */
  a_bandeja: boolean;
}

export function clasificarMovimiento(doc: DocumentoAClasificar): ClasificacionMovimiento {
  const excepciones: ExcepcionMovimiento[] = [];
  let estado: EstadoMovimiento;

  if (DOC_CODES_AJUSTE.includes(doc.doc_code)) {
    excepciones.push('ajuste_inventario');
    estado = 'excepcion';
  } else if (DOC_CODES_TRASPASO.includes(doc.doc_code)) {
    switch (doc.transfer_status) {
      case 'completado': estado = 'cuadrado'; break;
      case 'en_transito': estado = 'en_transito'; break;
      case 'sin_recepcion_esperada': estado = 'sin_recepcion_esperada'; break;
      case 'diferencia': excepciones.push('diferencia'); estado = 'excepcion'; break;
      case 'sin_acuse': excepciones.push('sin_acuse'); estado = 'excepcion'; break;
      case 'sin_origen': excepciones.push('sin_origen'); estado = 'excepcion'; break;
      // Un traspaso sin veredicto no se da por bueno: se declara sin comparación.
      default: estado = 'sin_comparacion';
    }
  } else {
    estado = 'sin_comparacion';
  }

  if ((Number(doc.lineas_sin_importe) || 0) > 0 && estado !== 'sin_comparacion') {
    excepciones.push('importe_incompleto');
    estado = 'excepcion';
  }
  return { estado, excepciones, a_bandeja: excepciones.length > 0 };
}
