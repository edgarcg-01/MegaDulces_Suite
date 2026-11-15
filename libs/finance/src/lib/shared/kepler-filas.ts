import type { PoolClient } from 'pg';

/**
 * `[PGP.122.7]` **Copiar una fila del ERP y pisarle columnas, sin interpolar nada de afuera.** Para los
 * escritores de finanzas que clonan un documento real de Kepler (ADR-092): las 200 columnas de `kdm1` son
 * `NOT NULL`, así que se parte de una fila que Kepler ya aceptó y se cambian sólo las decididas.
 *
 * ⚠️ Deuda con nombre (ADR-056): `kepler-pago-sink.adapter.ts` (`[PGP.106]`) tiene su propia copia
 * privada de estas mismas funciones. Se dejó intacta porque el escritor de pagos está en uso y se cambia
 * sólo con su propio ensayo; al tocarlo, que importe de aquí.
 *
 * Los valores van SIEMPRE como parámetros: los tipos de Kepler no son uniformes (`c17` es texto, `c40`
 * doble precisión) y Postgres resuelve cada uno contra su columna destino. Lo único que se interpola son
 * nombres de columna (`c1`…`c999`) y de tabla temporal, validados aquí.
 */

type Valor = string | number;

/** Sólo nombres de columna de Kepler (`c1`…`c999`). */
const COLUMNA = /^c\d{1,3}$/;
/** Sólo tablas temporales del escritor (`_h`, `_l`, `_h0`…) o tablas de `md`. */
const TABLA = /^(_[a-z0-9]{1,8}|md\.[a-z0-9_]{2,30})$/;

function tabla(t: string): string {
  if (!TABLA.test(t)) throw new Error(`Tabla inválida: ${t}`);
  return t;
}

export function setDe(cols: Record<string, unknown>, desde: number): { sql: string; valores: unknown[] } {
  const ks = Object.keys(cols);
  for (const k of ks) if (!COLUMNA.test(k)) throw new Error(`Columna inválida en el plan: ${k}`);
  return { sql: ks.map((k, i) => `${k} = $${desde + i}`).join(', '), valores: ks.map((k) => cols[k]) };
}

/** Copia la fila base (`desde`, exactamente una) a `hacia` y le pisa las columnas. */
export async function clonarFila(c: PoolClient, desde: string, hacia: string, cols: Record<string, Valor>): Promise<void> {
  const r = await c.query(`INSERT INTO ${tabla(hacia)} SELECT * FROM ${tabla(desde)} RETURNING ctid::text AS t`);
  if (r.rowCount !== 1) throw new Error(`La fila base ${desde} trae ${r.rowCount} filas: se esperaba una`);
  if (!Object.keys(cols).length) return;
  const s = setDe(cols, 2);
  await c.query(`UPDATE ${tabla(hacia)} SET ${s.sql} WHERE ctid = $1::tid`, [r.rows[0].t, ...s.valores]);
}

/** Inserta una fila construida entera (todas sus columnas conocidas). */
export async function insertarFila(c: PoolClient, hacia: string, fila: Record<string, Valor>): Promise<void> {
  const ks = Object.keys(fila);
  for (const k of ks) if (!COLUMNA.test(k)) throw new Error(`Columna inválida en el plan: ${k}`);
  await c.query(`INSERT INTO ${tabla(hacia)} (${ks.join(', ')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(', ')})`, ks.map((k) => fila[k]));
}
