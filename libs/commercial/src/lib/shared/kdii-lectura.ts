import type { Knex } from 'knex';
import type { KdiiFila } from './kdii-codigo';

/**
 * Lectura de fichas de `kepler_ods.kdii` como `KdiiFila`, compartida por el checado (`[GP.4]`) y el
 * levantamiento (`[NP.7.L.9a]`). Antes vivía privada en `ChecadoService`; se movió aquí sin cambiar
 * su SQL cuando apareció el segundo consumidor (regla 16 / ADR-056).
 *
 * `tresCompleta`: el checado lee sólo `c85` en la Unidad Tres (las casillas 2 y 3, `c97`/`c98`, traen
 * claves internas `CB23`+SKU / `CB33`+SKU, verificadas en 3 pantallas de Kepler el 2026-11-02). El
 * levantamiento las lee también, para que un código guardado ahí no salga «no existe».
 */
const COLS = `
    btrim(c1) AS sku, NULLIF(btrim(c2), '') AS nombre,
    upper(NULLIF(btrim(c11), '')) AS u1,
    upper(NULLIF(btrim(c80), '')) AS u2, NULLIF(btrim(c81::text), '')::numeric AS f2,
    upper(NULLIF(btrim(c83), '')) AS u3, NULLIF(btrim(c84::text), '')::numeric AS f3,
    btrim(c7) AS b1, btrim(c93) AS b2, btrim(c102) AS b3,
    btrim(c82) AS d1, btrim(c95) AS d2, btrim(c96) AS d3,
    btrim(c85) AS t1, btrim(c97) AS t2, btrim(c98) AS t3`;

/** Desempate fijo si la sucursal trae dos fichas de la misma clave: la de caja más grande. */
const ORDEN = `ORDER BY btrim(c1), NULLIF(btrim(c84::text), '')::numeric DESC NULLS LAST, NULLIF(btrim(c81::text), '')::numeric DESC NULLS LAST`;

export interface OpcionesKdii {
  /** Lee también `c97`/`c98` en la Unidad Tres. Por defecto no (el checado). */
  tresCompleta?: boolean;
}

export function filaKdii(r: Record<string, unknown>, op: OpcionesKdii = {}): KdiiFila {
  const s = (k: string): string | null => (r[k] == null ? null : String(r[k]));
  const n = (k: string): number | null => (r[k] == null ? null : Number(r[k]));
  return {
    sku: String(r['sku']), nombre: s('nombre'),
    u1: s('u1'), u2: s('u2'), f2: n('f2'), u3: s('u3'), f3: n('f3'),
    base: [s('b1'), s('b2'), s('b3')], dos: [s('d1'), s('d2'), s('d3')],
    tres: op.tresCompleta ? [s('t1'), s('t2'), s('t3')] : [s('t1')],
  };
}

/** Productos de la sucursal que traen ese código en alguna casilla, o cuya caja es C+clave. */
export async function kdiiPorCodigo(
  trx: Knex | Knex.Transaction, sucursal: string, code: string, op: OpcionesKdii = {},
): Promise<KdiiFila[]> {
  const extra = op.tresCompleta ? ', upper(btrim(c97)), upper(btrim(c98))' : '';
  const { rows } = await trx.raw(
    `SELECT DISTINCT ON (btrim(c1)) ${COLS}
       FROM kepler_ods.kdii
      WHERE btrim(sucursal) = ?
        AND (upper(?) IN (upper(btrim(c7)), upper(btrim(c93)), upper(btrim(c102)), upper(btrim(c82)),
                          upper(btrim(c95)), upper(btrim(c96)), upper(btrim(c85))${extra})
             OR upper(?) = 'C' || upper(btrim(c1)))
      ${ORDEN}`,
    [sucursal, code, code],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => filaKdii(r, op));
}

export async function kdiiPorSku(
  trx: Knex | Knex.Transaction, sucursal: string, skus: string[], op: OpcionesKdii = {},
): Promise<KdiiFila[]> {
  if (!skus.length) return [];
  const { rows } = await trx.raw(
    `SELECT DISTINCT ON (btrim(c1)) ${COLS}
       FROM kepler_ods.kdii
      WHERE btrim(sucursal) = ? AND btrim(c1) = ANY(?::text[])
      ${ORDEN}`,
    [sucursal, skus],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => filaKdii(r, op));
}
