/**
 * `[PQ.160]` Editar las CANTIDADES de una OC de Kepler (`X-A-35`) desde `/compras/oc-abiertas`, con motivo.
 * Llave `COMPRAS_OC_EDITAR`; interruptor `kepler_push_switch` tipo `edita_oc`, por sucursal.
 *
 * `GET  /commercial/replenishment/open-purchase-orders/:sucursal/:folio/edicion` — si se puede, y sus renglones.
 * `POST /commercial/replenishment/open-purchase-orders/:sucursal/:folio/editar`  — escribe en Kepler, todo o nada.
 *
 * Sólo cantidades de renglones que ya existen: no agrega ni quita renglones y no cambia costos.
 */

/** Mínimo de letras del motivo: el mismo para el servidor, la pantalla y el CHECK de la tabla. */
export const OC_EDITAR_MOTIVO_MIN = 10;

/** Un renglón de la OC como se edita: la cantidad va en la PRESENTACIÓN de Kepler (`c55`, p. ej. CJA). */
export interface OcEdicionRenglonDto {
  /** `kdm2.c7`. */
  renglon: number;
  sku: string;
  nombre: string;
  /** La presentación en que se captura (`c55`; si falta, `c11`). */
  unidad: string;
  /** Piezas por presentación (`c58`). 1 = la unidad ES la presentación. */
  factor: number;
  /** Cantidad en la presentación (`c56`). */
  cantidad: number;
  /** Costo de UNA presentación, sin impuestos (`c12 × c58`). */
  costo: number;
  /** Importe sin impuestos (`c13`). */
  importe: number;
}

export interface OcEdicionDisponibleDto {
  sucursal: string;
  folio: string;
  disponible: boolean;
  /** Por qué no, en palabras para la persona. `null` si `disponible`. */
  porque: string | null;
  /** Total actual (`c16`), con impuestos. */
  total: number | null;
  /** Renglones editables (vacío si no se puede). Leídos de la RÉPLICA: al guardar se revisan contra Kepler vivo. */
  renglones: OcEdicionRenglonDto[];
  /** La requisición de la Suite de la que salió (su referencia en Kepler), si la hay: no cambia al editar la OC. */
  requisicion: string | null;
  /** La última edición registrada desde la Suite, si la hay. */
  ultima: OcEdicionDto | null;
}

export interface OcEditarInputDto {
  /** Sólo los renglones que cambian. Cantidad nueva en la presentación, mayor que cero. */
  renglones: Array<{ renglon: number; cantidad: number }>;
  /** Por qué se cambia. Obligatorio, al menos `OC_EDITAR_MOTIVO_MIN` letras: queda en la Suite junto a la OC. */
  motivo: string;
}

export interface OcEdicionCambioDto {
  renglon: number;
  sku: string;
  unidad: string;
  antes: number;
  despues: number;
  importe_antes: number;
  importe_despues: number;
}

export interface OcEdicionDto {
  sucursal: string;
  folio: string;
  /** `aplicada` = Kepler ya tiene las cantidades nuevas. `rechazada` = NO se escribió nada; `rechazo` dice por qué. */
  estado: 'aplicada' | 'rechazada';
  rechazo: string | null;
  motivo: string;
  cambios: OcEdicionCambioDto[];
  total_antes: number | null;
  total_despues: number | null;
  editada_por: string | null;
  editada_en: string;
}
