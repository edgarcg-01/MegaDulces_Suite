import { esPromotora } from './tipos';

/**
 * Fase RH · `[RH.1.6b]` — NADIE A PRENÓMINA SIN IDENTIFICAR. Traslado de `mega-talento-90/api/src/
 * cierres.ts` @ 64ae212 (08/10/2026): «Donnacho» era Ignacio. Quien checó en la semana y nadie
 * reconoce no puede entrar a la prenómina sin que alguien lo diga por escrito.
 *
 * Mega Talento llama «sin identificar» a quien checó y su ficha no tiene NOMBRE COMPLETO o
 * DEPARTAMENTO, o el código no tiene ficha. En la Suite la ficha es la persona ligada al código
 * (`[RH.1.4]`), así que:
 *   · sin ficha          = el código no está ligado a ninguna persona;
 *   · sin nombre completo = el nombre de la persona tiene MENOS DE DOS PALABRAS. ⚠️ Aproximación:
 *     Mega Talento tenía una columna aparte (`nombre_completo`) y la Suite no; la carga de personas
 *     pone el nombre completo cuando existía y el apodo del reloj cuando no, así que un apodo de
 *     una palabra sale aquí y uno de dos palabras no. Declarado en FASE_RH §5.5;
 *   · sin departamento   = la persona no tiene `department_code`.
 * Igual que allá, no cuentan las promotoras de marca (no van a la prenómina), la cuenta «Admin» del
 * reloj ni los códigos que RH marcó `ignorado` (su `padron_depurado`).
 */

/** Lo que el lector trae por código que checó en la semana. */
export interface FilaChecoEnSemana {
  codigo: string;
  checadas: number;
  ligado: boolean;
  ignorado: boolean;
  nombre: string | null;
  /** «nombre · código» del departamento, como lo arma el padrón (para `esPromotora`). */
  departamento: string | null;
  tieneDepartamento: boolean;
  nombreReloj: string | null;
}

export interface PersonaSinIdentificar {
  codigo: string;
  nombre: string;
  checadas: number;
  sinFicha: boolean;
  sinNombre: boolean;
  sinDepartamento: boolean;
}

const RE_ADMIN = /^\s*admin/i;
const palabras = (s: string | null): number => String(s || '').trim().split(/\s+/).filter(Boolean).length;

/** Quiénes, de los que checaron, no están identificados. El que más checó primero. */
export function sinIdentificar(filas: FilaChecoEnSemana[]): PersonaSinIdentificar[] {
  const out: PersonaSinIdentificar[] = [];
  for (const f of filas) {
    if (f.ignorado) continue;
    if (RE_ADMIN.test(f.nombre || '') || RE_ADMIN.test(f.nombreReloj || '')) continue;
    if (f.ligado && esPromotora({ departamento: f.departamento })) continue;
    const sinFicha = !f.ligado;
    const sinNombre = sinFicha || palabras(f.nombre) < 2;
    const sinDepartamento = sinFicha || !f.tieneDepartamento;
    if (!sinFicha && !sinNombre && !sinDepartamento) continue;
    out.push({
      codigo: f.codigo,
      nombre: (f.ligado && f.nombre) || f.nombreReloj || '(sin ficha)',
      checadas: f.checadas, sinFicha, sinNombre, sinDepartamento,
    });
  }
  return out.sort((a, b) => b.checadas - a.checadas || a.codigo.localeCompare(b.codigo));
}

/** El mínimo de letras del motivo para cerrar con gente sin identificar (el mismo de Mega Talento). */
export const MOTIVO_MINIMO = 5;

/** Texto del 409, igual de claro que el de Mega Talento. */
export function textoSinIdentificar(n: number): string {
  return `${n} persona${n === 1 ? '' : 's'} checó esta semana y no está identificada (sin ficha, sin nombre completo o sin departamento). ` +
    'Complétalas, o cierra de todos modos explicando por qué.';
}
