/**
 * `[GX.103]` — **Cómo se lee lo que alguien escribe en el buscador de gastos.**
 *
 * Nace de comparar el buscador con el de Kepler (2026-11-09): la gente lo encuentra «mucho más rápido» allá.
 * Kepler sólo busca texto, pero enseña los últimos documentos sin escribir nada (F9). Aquí:
 *
 *  · la caja **vacía** pide los **recientes**, como F9 en Kepler;
 *  · un **monto** se reconoce como lo escribe la gente: `1250`, `1,250.00`, `$1,250`. Es la ley de Postel:
 *    se tolera la FORMA, nunca se adivina el significado. `10.570` no es un monto (tres decimales); se busca
 *    como texto;
 *  · un número sin formato puede ser **folio o monto**: se buscan los dos, y el folio exacto va primero;
 *  · un número con ceros adelante (`0010570`) es un folio, no un monto.
 *
 * Es una función pura para poder probarla sin base de datos; el servicio sólo traduce esto a SQL.
 */

/** Menos que esto no se busca: una letra suelta trae media base. Un dígito sí (es un folio). */
export const MINIMO_TEXTO_BUSQUEDA = 2;
/** Cuántos recientes se enseñan con la caja vacía: los mismos 50 que la lista de F9 de Kepler. */
export const TOPE_RECIENTES = 50;
/** Más de esto no es un folio ni un monto: `Number()` pierde precisión con 16 cifras o más. */
const MAX_CIFRAS = 15;

export interface MontoBuscado {
  valor: number;
  /** Se escribió con decimales: se compara al centavo. Sin decimales: al peso (`1250` ≈ 1,249.50–1,250.49). */
  alCentavo: boolean;
}

export type LecturaBusqueda =
  | { modo: 'recientes' }
  | { modo: 'corta' }
  | {
      modo: 'buscar';
      /** Lo que va al motor de texto (`applySmartSearch`). `null` cuando sólo se escribió un monto. */
      texto: string | null;
      monto: MontoBuscado | null;
      /** El folio como número (`'0010570'` → 10570): con él se ordena primero el folio exacto. */
      folio: number | null;
    };

/** `$1,250.50` · `1,250` · `1250.5` · `$ 800`. Las comas, sólo en grupos de tres. */
const CON_FORMATO = /^\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

export function leerBusqueda(crudo: unknown): LecturaBusqueda {
  const q = String(crudo ?? '').trim().slice(0, 80);
  if (!q) return { modo: 'recientes' };

  // Sólo cifras: puede ser un folio o un monto.
  if (/^\d+$/.test(q)) {
    if (q.length > MAX_CIFRAS) return { modo: 'buscar', texto: q, monto: null, folio: null };
    const n = Number(q);
    return {
      modo: 'buscar',
      texto: q,
      // Con ceros adelante es un folio (`0010570`), nunca un monto.
      monto: q.startsWith('0') || n === 0 ? null : { valor: n, alCentavo: false },
      folio: n,
    };
  }

  // Con signo de pesos, comas o punto decimal: es un monto, y sólo un monto.
  if (CON_FORMATO.test(q)) {
    const limpio = q.replace(/[$\s,]/g, '');
    if (limpio.replace('.', '').length <= MAX_CIFRAS) {
      const valor = Number(limpio);
      if (Number.isFinite(valor) && valor > 0) {
        return { modo: 'buscar', texto: null, monto: { valor, alCentavo: limpio.includes('.') }, folio: null };
      }
    }
  }

  if (q.length < MINIMO_TEXTO_BUSQUEDA) return { modo: 'corta' };
  return { modo: 'buscar', texto: q, monto: null, folio: null };
}

/**
 * La condición SQL para un monto, con `?` para el valor. `columna` llega del código, nunca de la persona.
 * Al peso redondea (`round(x)`); al centavo compara a dos decimales.
 */
export function sqlDelMonto(columna: string, m: MontoBuscado): string {
  return m.alCentavo ? `round(${columna}::numeric, 2) = ?` : `round(${columna}::numeric) = ?`;
}

/**
 * El `ORDER BY` que pone primero el folio EXACTO (`10570` → `0010570`), con `?` para el número. Es la
 * misma lectura del folio que usa el alta (`searchSolicitudes`): sólo sus dígitos, como número.
 */
export function sqlFolioExactoPrimero(columna: string): string {
  return `(NULLIF(regexp_replace(${columna}, '[^0-9]', '', 'g'), '')::bigint = ?) DESC NULLS LAST`;
}
