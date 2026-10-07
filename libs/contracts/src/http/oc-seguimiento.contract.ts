/**
 * `[RA-PRO.62]` Estatus de SEGUIMIENTO de una orden de compra de Kepler, para `/compras/oc-abiertas`.
 *
 * Es un registro de Compras, NO un estado del ERP: Kepler es read-only, así que marcar una orden
 * como "No surtida / cancelada" acá no la cancela allá. Por eso la pantalla muestra los dos
 * (el estatus de Kepler y el de seguimiento) lado a lado.
 *
 * Vive en `libs/contracts` porque lo leen los dos lados: el servidor valida con `validarSeguimiento`
 * antes de guardar y la pantalla usa las mismas etiquetas y la misma regla para habilitar el botón.
 * Una regla escrita dos veces diverge.
 *
 * Una orden SIN registro se muestra como "Sin revisar" (`null`), que no es lo mismo que "Vigente":
 * vigente = alguien la revisó y sigue en pie. Así el conteo de "Sin revisar" dice cuánto falta atender.
 */

export const OC_SEGUIMIENTO_ESTATUS = [
  'vigente',
  'detenida_pago',
  'detenida_logistica',
  'backorder',
  'no_surtida_cancelada',
] as const;

export type OcSeguimientoEstatus = (typeof OC_SEGUIMIENTO_ESTATUS)[number];

export const OC_SEGUIMIENTO_LABEL: Record<OcSeguimientoEstatus, string> = {
  vigente: 'Vigente',
  detenida_pago: 'Detenida por pago',
  detenida_logistica: 'Detenida por logística',
  backorder: 'Backorder vigente',
  no_surtida_cancelada: 'No surtida / cancelada',
};

/** Etiqueta de una orden sin registro de seguimiento. */
export const OC_SIN_REVISAR = 'Sin revisar';

/** Largo de la nota: mínimo para que diga algo, máximo para que quepa en la tabla y el PDF. */
export const OC_NOTA_MIN = 3;
export const OC_NOTA_MAX = 500;

/** Lo que se guarda de una orden (el renglón vigente del seguimiento). */
export interface OcSeguimiento {
  estatus: OcSeguimientoEstatus;
  nota: string | null;
  actualizado_por: string | null;   // username, snapshot al guardar
  actualizado_en: string;           // ISO
}

export function esEstatusSeguimiento(v: unknown): v is OcSeguimientoEstatus {
  return typeof v === 'string' && (OC_SEGUIMIENTO_ESTATUS as readonly string[]).includes(v);
}

/** La nota es obligatoria en todo lo que no sea "Vigente": detenida, backorder o cancelada piden motivo. */
export function notaObligatoria(estatus: OcSeguimientoEstatus): boolean {
  return estatus !== 'vigente';
}

/**
 * Valida un cambio de seguimiento. Devuelve el valor normalizado (nota recortada, `null` si vacía)
 * o el motivo del rechazo en palabras para el usuario.
 */
export function validarSeguimiento(
  estatus: unknown,
  nota: unknown,
): { ok: true; estatus: OcSeguimientoEstatus; nota: string | null } | { ok: false; error: string } {
  if (!esEstatusSeguimiento(estatus)) return { ok: false, error: 'Estatus de seguimiento no válido.' };
  const n = typeof nota === 'string' ? nota.trim() : '';
  if (n.length > OC_NOTA_MAX) return { ok: false, error: `La nota no puede pasar de ${OC_NOTA_MAX} caracteres.` };
  if (notaObligatoria(estatus) && n.length < OC_NOTA_MIN) {
    return { ok: false, error: `"${OC_SEGUIMIENTO_LABEL[estatus]}" necesita una nota con el motivo.` };
  }
  return { ok: true, estatus, nota: n.length ? n : null };
}

// ── [RA-PRO.61] Respuestas de /commercial/replenishment/open-purchase-orders/:sucursal/:folio ──
// Un solo tipo para el servidor (lo devuelve) y la pantalla (lo dibuja en el PDF): ADR-052.

/** Un renglón de la OC de Kepler, en la unidad del documento. */
export interface OcRenglonDto {
  linea: string | number | null;
  sku: string | null;
  nombre: string | null;
  cantidad: number;
  unidad: string | null;
  costo_unitario: number;
  importe: number;
  /** Factor de caja de Kepler; sólo se usa si el costo lo confirma (ver `cajasDeRenglon`). */
  unidades_por_caja: number | null;
  costo_caja: number | null;
}

export interface OcRecepcionDto { folio: string; fecha: string | null; monto: number; }

export interface OcHistoriaDto {
  estatus_anterior: OcSeguimientoEstatus | null;   // null = venía de "Sin revisar"
  estatus: OcSeguimientoEstatus;
  nota: string | null;
  por: string | null;
  en: string;                                       // ISO
}

export interface OcDetalleDto {
  orden: {
    sucursal: string; folio: string;
    fecha: string | null; vence: string | null; dias: number;
    proveedor: string | null; proveedor_rfc: string | null;
    condicion_pago: string | null; concepto: string | null; referencia: string | null;
    estatus_kepler: string; monto: number;
  };
  lineas: OcRenglonDto[];
  /** Recepciones del mismo proveedor y no anteriores a la orden: las que cuentan como surtido. */
  recepciones: OcRecepcionDto[];
  /** Recepciones que citan el folio pero NO cuentan (otro proveedor o anteriores). Se declaran. */
  recepciones_descartadas: { n: number; monto: number };
  recibido: number;
  /** Recibido ÷ importe, en %. `null` si la orden no tiene importe. */
  pct_surtido: number | null;
  seguimiento: OcSeguimiento | null;
  historia: OcHistoriaDto[];
}

/** Respuesta de PUT …/:sucursal/:folio/seguimiento. */
export interface OcSeguimientoGuardadoDto {
  sucursal: string;
  folio: string;
  estatus: OcSeguimientoEstatus;
  nota: string | null;
  actualizado_por: string | null;
  actualizado_en: string | null;
  /** `true` si no había nada que cambiar (mismo estatus y nota): no se escribió historia. */
  sin_cambio: boolean;
}

/** Cuerpo de PUT …/:sucursal/:folio/seguimiento. Se valida con `validarSeguimiento` antes de guardar. */
export interface OcSeguimientoInputDto {
  estatus: OcSeguimientoEstatus;
  nota: string | null;
}
