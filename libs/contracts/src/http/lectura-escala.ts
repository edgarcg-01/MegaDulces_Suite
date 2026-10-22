/**
 * `[RE.44]` — **¿El OCR leyó la misma cifra con el separador corrido?**
 *
 * En México la coma separa miles y el punto los decimales. El OCR, sobre todo en notas escritas a
 * mano, lee `22,500` como `22.50` y `48,850` como `48.85`. El resultado no es «el proveedor cobra
 * $22,477 de menos»: es un error de LECTURA, y pintarlo como descuadre manda al revisor a pelear
 * una diferencia que no existe — o a devolver una factura que estaba bien.
 *
 * MEDIDO en prod (2026-10-21), 1,077 evidencias con total leído y monto de Kepler: **7** casan con
 * Kepler a ×1,000 o ×100 (±1%) — `10.8`↔`10,800`, `48.85`↔`48,850`, `6.25`↔`6,255`, `81.3`↔`8,130`
 * — y casi todas seguían «recibidas», atoradas en la cola con un descuadre que no era tal.
 *
 * ⛔ NO corrige nada. Usar Kepler para «arreglar» el total sería circular: todo cuadraría. Sólo
 * CLASIFICA la diferencia, para que se diga qué es y lo verifique un humano contra el papel.
 * ⛔ **×10 queda FUERA a propósito.** Los 3 casos medidos a ×10 eran un DÍGITO PERDIDO
 * (`1538`↔`15,388`, `2800`↔`27,800`), no el separador: decir «es la misma cifra» ahí sería falso.
 * El separador mueve la coma 2 o 3 lugares, nunca 1.
 *
 * Vive en `contracts` porque la usan el servidor (clasifica el descuadre al guardar) y la pantalla
 * (lo explica al revisor). Dos copias de la regla ya divergieron en este dominio antes.
 */

/** Tolerancia relativa: dentro del 1%, para absorber los centavos que el OCR también pierde. */
export const ESCALA_TOLERANCIA = 0.01;

/**
 * Si `referencia ≈ leido × 10^k` con k ∈ {±2, ±3}, devuelve `10^k` (p. ej. `1000` cuando se
 * leyó `22.50` por `22,500`, `0.001` al revés). `null` si no hay tal escala, o falta un número.
 */
export function escalaDeLectura(leido?: number | null, referencia?: number | null, tolerancia = ESCALA_TOLERANCIA): number | null {
  const a = Number(leido);
  const b = Number(referencia);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  for (const k of [3, 2, -2, -3]) {
    const f = 10 ** k;
    if (Math.abs(a * f - b) / b <= tolerancia) return f;
  }
  return null;
}
