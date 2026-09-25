/**
 * `[RA-PRO.51]` Redondeo del SUGERIDO del motor para `/compras/pedido`, aislado del componente
 * para poder probarlo sin montar Angular (ADR-056: un primitivo que decide un número se prueba).
 *
 * Regla pedida por el comprador (2026-09-25): que el sugerido llegue listo para pedir.
 *  - Media caja o más → **cajas CERRADAS**, al entero más cercano (147.1 → 147, 1.5 → 2, 0.6 → 1).
 *  - Menos de media caja → se propone en **PIEZAS enteras** (0.4 cj × 20 → 8 pz), mínimo 1 pieza:
 *    si el motor pidió algo, no se borra redondeando a cero.
 *
 * El canónico SIGUE siendo cajas: en el ramo de piezas se devuelve `pz / uxc` (fracción de caja),
 * así que días, valor, totales, requisición y Excel leen el mismo número que ve el input. `unit`
 * sólo dice en qué unidad se PROPONE capturar.
 */
export interface SeedRedondeado {
  /** Valor inicial del input, SIEMPRE en cajas (el canónico). */
  cajas: number;
  /** Unidad en que se propone capturar: caja cerrada, o pieza si no llega a media caja. */
  unit: 'caja' | 'pieza';
}

/**
 * @param ped sugerido del motor, en cajas.
 * @param uxc unidades (piezas) por caja de este producto en esta plaza.
 */
export function roundSeed(ped: number, uxc: number): SeedRedondeado {
  // No hay nada que pedir (o el motor mandó un valor inválido).
  if (!(ped > 0)) return { cajas: 0, unit: 'caja' };

  // ⚠️ `uxc` inválido (0, negativo, NaN): sin factor de caja no se puede proponer en piezas sin
  // dividir por cero (`pz / uxc` → Infinity). Se cae a cajas cerradas, que no depende de `uxc`.
  const factor = uxc > 0 ? uxc : 1;

  // Media caja o más → cajas cerradas (Math.round nunca da 0 acá: round(0.5) = 1).
  if (ped >= 0.5) return { cajas: Math.round(ped), unit: 'caja' };

  // Menos de media caja → piezas enteras, mínimo 1.
  const pz = Math.max(1, Math.round(ped * factor));
  return { cajas: pz / factor, unit: 'pieza' };
}
