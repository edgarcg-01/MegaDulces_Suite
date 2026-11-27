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

/** Lo «vacío» de una columna de Kepler, como lo dejan los gastos medidos: texto en blanco, número en cero. */
export function vacioDeTipo(tipo: string): Valor {
  if (/char|text/.test(tipo)) return '';
  if (/timestamp|date/.test(tipo)) return '1800-01-01';
  if (/bool/.test(tipo)) return 0;
  return 0;
}

/** Inserta en `tabla` una fila COMPLETA: lo que dice el plan y, en las demás columnas, lo vacío de su tipo. */
export async function insertarCompleta(c: PoolClient, destino: string, valores: Record<string, Valor>): Promise<void> {
  const cols = (await c.query(
    `SELECT a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [tabla(destino)])).rows as { n: string; t: string }[];
  const conocidas = new Set(cols.map((x) => x.n));
  for (const k of Object.keys(valores)) if (!conocidas.has(k)) throw new Error(`El plan trae ${k}, que no existe en ${destino}`);
  const fila: Record<string, Valor> = {};
  for (const x of cols) fila[x.n] = valores[x.n] ?? vacioDeTipo(x.t);
  await insertarFila(c, destino, fila);
}

/**
 * `[PGP.172]` **Lo que un movimiento suma al acumulado del acreedor (`md.kdxg`), creando la fila si no existe.**
 *
 * ⛔⛔ `kdxg` **NO es un catálogo**: es un acumulado que **nace con el primer movimiento**. El catálogo de
 * acreedores es `kdxd`, y está completo (~745 por sucursal). Medido en las 9 réplicas el 2026-11-27, en los dos
 * sentidos: **1,308 acreedores con movimiento en `kdxe` → 1,308 con fila en `kdxg`, 0 sin ella y 0 al revés.**
 * Correspondencia exacta. Por eso Kepler la crea sola cuando hace falta y quien escribe desde fuera también debe.
 *
 * *Cifra que lo motivó:* los tres escritores (gasto `X-A-10`, pago `X-D-26` y nota) exigían que la fila YA
 * existiera, y **5,474 de 6,779 pares (sucursal, acreedor) del catálogo no la tienen: el 80.7 %**. En Zamora
 * Centro, 724 de 747 (96.9 %). O sea que el PRIMER movimiento de casi cualquier acreedor en casi cualquier
 * sucursal fallaba; «se captura a mano» no era la excepción sino el caso normal fuera del CEDIS. El gasto
 * rechazaba limpio, el pago y la nota reventaban a media escritura.
 *
 * ⛔ **El filtro por sucursal (`c2`) no es opcional.** La Piedad Abastos y 8 Esquinas guardan filas de OTRAS
 * sucursales (`[PGP.131]`, medido 2026-11-20). Medido el 2026-11-27 en `md_03`: de 83 acreedores, **13 tienen su
 * única fila en la sucursal 02** — un `UPDATE` sin `c2` acierta `rowCount === 1` y suma el dinero al renglón de
 * la sucursal equivocada, **sin un solo error**. El escritor de la nota lo hacía así hasta hoy.
 *
 * Devuelve si la fila se actualizó o nació. Dos filas propias es un error ruidoso: no se adivina cuál.
 */
export interface AcumuladoAcreedor {
  sucursal: string;
  acreedor: string;
  /** `c35`–`c46` abonos (pagos) o `c47`–`c58` cargos (gastos): la dan `columnaAbonoKdxg`/`columnaCargoKdxg`. */
  columna: string;
  importe: number;
  fecha: string;
  /** Las columnas de fecha que sube este movimiento: el gasto `['c4','c6']`, el pago `['c4','c7']`. */
  fechas: readonly string[];
}

export async function sumarAcumuladoAcreedor(c: PoolClient, a: AcumuladoAcreedor): Promise<'actualizada' | 'creada'> {
  if (!COLUMNA.test(a.columna)) throw new Error(`Columna inválida para el acumulado del acreedor: ${a.columna}`);
  for (const f of a.fechas) {
    if (!COLUMNA.test(f)) throw new Error(`Columna de fecha inválida: ${f}`);
    if (f === a.columna) throw new Error(`La columna de fecha ${f} es la misma del importe: el plan está mal armado`);
  }
  const sube = a.fechas.map((f) => `, ${f} = greatest(${f}, $2::timestamp)`).join('');
  const r = await c.query(
    `UPDATE md.kdxg SET ${a.columna} = ${a.columna} + $1${sube}
      WHERE btrim(c1) = 'PESOS' AND btrim(c2) = $3 AND btrim(c3) = $4`,
    [a.importe, a.fecha, a.sucursal, a.acreedor]);
  if (r.rowCount === 1) return 'actualizada';
  if ((r.rowCount ?? 0) > 1) {
    throw new Error(`El acumulado del acreedor ${a.acreedor} (kdxg) trae ${r.rowCount} filas propias en ${a.sucursal}: se esperaba una`);
  }
  // No existe: nace con este movimiento y en CERO todo lo demás, que es lo que haría Kepler. La PK (c1,c2,c3)
  // es la red: si otra transacción la creó mientras tanto, el INSERT falla ruidoso en vez de duplicar el saldo.
  await insertarCompleta(c, 'md.kdxg', {
    c1: 'PESOS', c2: a.sucursal, c3: a.acreedor,
    [a.columna]: a.importe,
    ...Object.fromEntries(a.fechas.map((f) => [f, a.fecha])),
  });
  return 'creada';
}
