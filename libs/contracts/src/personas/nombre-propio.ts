/**
 * `[RH.14.9]` UNA sola forma de escribir el nombre de una persona (Edgar, 18-nov: «que no se quede sólo en minúsculas o
 * sólo en mayúsculas»). Medido ese día en prod: de 1,241 personas, 419 en MAYÚSCULAS, 14 en minúsculas y ~38 mezcladas
 * a medias («Juan pablo», «EDITH Picard»).
 *
 * La regla, a propósito corta:
 *   · cada palabra con mayúscula inicial y el resto en minúscula, también después de un guion, un apóstrofo o una
 *     diagonal («PEÑA-ORTIZ» → «Peña-Ortiz», «o'brien» → «O'Brien», «Lucia/ferrero» → «Lucia/Ferrero»);
 *   · las partículas van en minúscula salvo al inicio («MARÍA DE LA PAZ» → «María de la Paz»);
 *   · los acentos NO se inventan: «MARIA» queda «Maria» (si falta un acento, lo corrige una persona, no una regla);
 *   · una sigla se respeta: sin vocales y de hasta 3 letras siempre («MARGARITA PH» → «Margarita PH»); en un nombre que
 *     ya mezcla mayúsculas y minúsculas, cualquiera de hasta 3 letras («Checador-ZC»);
 *   · una palabra con mayúsculas por dentro («JorgeRubioLeon») no se toca: está pegada o escrita así a propósito, y
 *     pasarla a «Jorgerubioleon» la empeora (lo mostró el ensayo contra prod). Se corrige a mano;
 *   · lo que no es un nombre de persona no se toca: con dígitos, «@», «_», o una sola «palabra» con punto
 *     («francisco.compras», «promLP_mara», «Empleado 96»): eso es una credencial o un ID, y cambiarle la forma lo
 *     escondería en vez de arreglarlo.
 *
 * Idempotente: aplicarla dos veces da lo mismo que una. ⚠️ La migración que corrigió los nombres que ya existían lleva
 * una COPIA en JavaScript (corre sin `libs/`); `nombre-propio.spec.ts` exige que las dos decidan igual.
 */

const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos', 'van', 'von', 'di']);
/** «la», «las», «los» van en minúscula sólo después de «de» («María de la Paz»); solos son apellido («La Rosa»). */
const ARTICULOS = new Set(['la', 'las', 'los']);

/** ¿Es un nombre de persona, o una credencial / un ID que no se debe reformatear? */
export function esNombreDePersona(v: unknown): boolean {
  const s = String(v ?? '').trim();
  if (!s) return false;
  if (/[0-9@_]/.test(s)) return false;
  if (!/\s/.test(s) && s.includes('.')) return false;       // «francisco.compras»
  return /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(s);
}

const MAYUS = /[A-ZÁÉÍÓÚÜÑ]/;
const VOCAL = /[AEIOUÁÉÍÓÚÜaeiouáéíóúü]/;
/** Minúscula seguida de mayúscula dentro de la palabra («JorgeRubio»): se escribió así a propósito o pegada; no se toca. */
const CAMEL = /[a-záéíóúüñ][A-ZÁÉÍÓÚÜÑ]/;

function capitalizar(seg: string, respetarSiglas: boolean): string {
  if (!seg) return seg;
  if (/^(jr|sr)\.?$/i.test(seg)) return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
  if (seg.length <= 3 && seg === seg.toUpperCase() && MAYUS.test(seg) && (respetarSiglas || !VOCAL.test(seg))) return seg;
  const bajo = seg.toLocaleLowerCase('es-MX');
  return bajo.charAt(0).toLocaleUpperCase('es-MX') + bajo.slice(1);
}

export function nombrePropio(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!esNombreDePersona(s)) return s;
  const letras = s.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '');
  const uniforme = letras === letras.toUpperCase() || letras === letras.toLowerCase();
  const palabras = s.split(' ');
  return palabras.map((palabra, i) => {
    const bajo = palabra.toLocaleLowerCase('es-MX');
    const previa = i > 0 ? palabras[i - 1].toLocaleLowerCase('es-MX') : '';
    if (i > 0 && PARTICULAS.has(bajo) && (!ARTICULOS.has(bajo) || previa === 'de')) return bajo;
    if (CAMEL.test(palabra)) return palabra;
    // Guion y apóstrofo separan partes que también llevan mayúscula; el separador se conserva.
    return palabra.split(/([-'’/])/).map((seg) => (/^[-'’/]$/.test(seg) ? seg : capitalizar(seg, !uniforme))).join('');
  }).join(' ');
}
