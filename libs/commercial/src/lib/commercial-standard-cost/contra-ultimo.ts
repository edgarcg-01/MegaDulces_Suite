import {
  AntiguedadUltimo,
  MotivoSinCosto,
  TOLERANCIA_CONTRA_ULTIMO,
  VeredictoContraUltimo,
} from '@megadulces/contracts';

/**
 * `[CAT-COSTO.7]` — **La regla de la vista «Contra último costo»**, en una función pura.
 *
 * Compara el costo estándar de la ficha contra el último costo de compra (XA2001). Los dos vienen
 * de `analytics.mv_kepler_costos` ya en la unidad BASE de la ficha y sin impuesto, así que aquí no
 * se convierte nada: sólo se decide.
 *
 * Lo que no se puede comparar se DECLARA con su propio resultado (`sin_compra`, `unidad_no_clara`,
 * `sin_estandar`) en vez de dibujarse como «igual».
 */
export interface EntradaContraUltimo {
  costo_estandar: number | null;
  costo_ultimo: number | null;
  /** El motivo que trae la fuente cuando el último costo es NULL. */
  ultimo_motivo: MotivoSinCosto | null;
}

export interface SalidaContraUltimo {
  veredicto: VeredictoContraUltimo;
  /** `(último − estándar) / estándar`, en %, 1 decimal. */
  diferencia_pct: number | null;
}

export function clasificarContraUltimo(
  e: EntradaContraUltimo,
  tolerancia = TOLERANCIA_CONTRA_ULTIMO,
): SalidaContraUltimo {
  const est = e.costo_estandar;
  const ult = e.costo_ultimo;
  if (!(est !== null && est > 0)) return { veredicto: 'sin_estandar', diferencia_pct: null };
  if (!(ult !== null && ult > 0)) {
    // Sin compra en ningún lado vs. una compra que no se pudo llevar a la unidad de la ficha.
    const veredicto: VeredictoContraUltimo = e.ultimo_motivo === 'sin_compra' || e.ultimo_motivo === null
      ? 'sin_compra'
      : 'unidad_no_clara';
    return { veredicto, diferencia_pct: null };
  }
  const d = ult / est - 1;
  const diferencia_pct = Math.round(d * 1000) / 10;
  if (d > tolerancia) return { veredicto: 'estandar_abajo', diferencia_pct };
  if (d < -tolerancia) return { veredicto: 'estandar_arriba', diferencia_pct };
  return { veredicto: 'igual', diferencia_pct };
}

/** Antigüedad de la última compra contra `hoy` (ambas `YYYY-MM-DD`). */
export function antiguedadUltimo(fecha: string | null, hoy: string): AntiguedadUltimo | null {
  if (!fecha) return null;
  const dias = Math.round((Date.parse(hoy) - Date.parse(fecha.slice(0, 10))) / 86_400_000);
  if (!Number.isFinite(dias)) return null;
  if (dias <= 90) return 'hasta_90';
  if (dias <= 180) return 'de_90_a_180';
  return 'mas_de_180';
}
