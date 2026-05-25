/**
 * Fórmula canónica de scoring de exhibiciones — compartida entre frontend y backend.
 * Mantiene una sola fuente de verdad: si cambia aquí, cambia en ambos lados.
 */

export interface ExhibicionScoreInput {
  /** Puntuación de la posición / ubicación (catálogo `ubicaciones`) */
  posicionPuntuacion: number;
  /** Puntuación del concepto / exhibición (catálogo `conceptos`) */
  conceptoPuntuacion: number;
  /** Puntuación del nivel de ejecución (catálogo `niveles`). Se capa a 1.0 como defensa. */
  nivelPuntuacion: number;
}

/**
 * Calcula los puntos de UNA exhibición.
 * Fórmula: `concepto × posición × min(nivel, 1)`.
 *
 * El cap en `nivel` evita que un valor de catálogo > 1 multiplique el score
 * más allá del 100% del par concepto×posición.
 *
 * Devuelve el valor crudo (sin redondeo) — el caller decide cómo presentarlo.
 */
export function calcularPuntosExhibicion(input: ExhibicionScoreInput): number {
  const concepto = Number(input.conceptoPuntuacion) || 0;
  const posicion = Number(input.posicionPuntuacion) || 0;
  const nivelRaw = Number(input.nivelPuntuacion) || 0;
  const nivel = Math.min(nivelRaw, 1);
  return concepto * posicion * nivel;
}

/**
 * Suma los puntos de varias exhibiciones para obtener el score total de la visita.
 */
export function sumarPuntosVisita(exhibiciones: ExhibicionScoreInput[]): number {
  return exhibiciones.reduce(
    (sum, ex) => sum + calcularPuntosExhibicion(ex),
    0,
  );
}
