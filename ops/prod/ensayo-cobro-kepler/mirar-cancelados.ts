/* eslint-disable no-console */
/**
 * `[CC.27]` **Sólo LEE.** Mira cómo queda en el Kepler vivo un cobro que una persona canceló, para saber qué hay
 * que deshacer además de marcar `c43='C'` — y si eso se puede hacer sin el programa.
 *
 * ⛔ **Se lee en Kepler, no en el ODS**, por la lección de `kdm6`: **Kepler BORRA filas al cancelar y el ODS las
 * conserva**, así que medirlo en el ODS daría una imagen falsa (parecería que no borra nada).
 *
 * Entrada por stdin: la URL de `kepler_push` del servidor. Argumento 1: la sucursal.
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

const TIPO = 7;

async function main(): Promise<void> {
  const suc = process.argv[2] || '06';
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const url = lineas[0];
  if (!url) throw new Error('Falta la URL por stdin');

  const { Client } = await import('pg');
  const k = new Client({ connectionString: url });
  await k.connect();
  const c = k as unknown as PoolClient;

  // Los cobros cancelados y los vivos, con lo que les cuelga. La comparación es el control:
  // si los cancelados conservan sus kdm5, cancelar NO las borra; si no las tienen, sí.
  const q = async (estado: string) => (await c.query(
    `SELECT count(*)::int AS cobros,
            sum((SELECT count(*) FROM md.kdm5 m WHERE m.c1 = k.c1 AND m.c2='U' AND m.c3='A' AND m.c4=$2::numeric AND btrim(m.c6)=btrim(k.c6)))::int AS kdm5,
            sum((SELECT count(*) FROM md.kdue e WHERE e.c1 = k.c1 AND e.c3='A' AND e.c4=$2::numeric AND btrim(e.c6)=btrim(k.c6)))::int AS kdue
       FROM md.kdm1 k
      WHERE k.c1=$1 AND k.c2='U' AND k.c3='A' AND k.c4=$2::numeric AND k.c9 >= date '2026-09-01'
        AND btrim(coalesce(k.c43,'')) ${estado}`, [suc, TIPO])).rows[0];

  const cancelados = await q(`= 'C'`);
  const vivos = await q(`<> 'C'`);
  console.log(`CANCELADOS: ${JSON.stringify(cancelados)}`);
  console.log(`VIVOS:      ${JSON.stringify(vivos)}`);
  const porCobro = (x: { cobros: number; kdm5: number; kdue: number }) =>
    x.cobros ? { kdm5: +(x.kdm5 / x.cobros).toFixed(2), kdue: +(x.kdue / x.cobros).toFixed(2) } : null;
  console.log(`POR COBRO — cancelados: ${JSON.stringify(porCobro(cancelados))} · vivos: ${JSON.stringify(porCobro(vivos))}`);

  // Un cancelado concreto, para verlo entero.
  const uno = (await c.query(
    `SELECT btrim(c6) AS folio, c9::date AS fecha, round(c16::numeric,2) AS importe, btrim(coalesce(c10,'')) AS cliente,
            btrim(coalesce(c67,'')) AS capturista, c81::text AS c81, c82::text AS c82
       FROM md.kdm1 WHERE c1=$1 AND c2='U' AND c3='A' AND c4=$2::numeric AND btrim(coalesce(c43,''))='C'
       ORDER BY c9 DESC LIMIT 1`, [suc, TIPO])).rows[0];
  if (uno) {
    const ap = (await c.query(
      `SELECT count(*)::int AS n FROM md.kdm5 WHERE c1=$1 AND c2='U' AND c3='A' AND c4=$2::numeric AND btrim(c6)=$3`,
      [suc, TIPO, uno.folio])).rows[0].n;
    const ca = (await c.query(
      `SELECT count(*)::int AS n FROM md.kdue WHERE c1=$1 AND c3='A' AND c4=$2::numeric AND btrim(c6)=$3`,
      [suc, TIPO, uno.folio])).rows[0].n;
    console.log(`UN CANCELADO: ${JSON.stringify({ ...uno, kdm5: ap, kdue: ca })}`);
  }

  // Y el nuestro, para compararlo.
  const mio = (await c.query(
    `SELECT btrim(c6) AS folio, btrim(coalesce(c43,'')) AS estatus, c81::text AS c81, c82::text AS c82,
            (SELECT count(*)::int FROM md.kdm5 m WHERE m.c1=k.c1 AND m.c2='U' AND m.c3='A' AND m.c4=$2::numeric AND btrim(m.c6)=btrim(k.c6)) AS kdm5,
            (SELECT count(*)::int FROM md.kdue e WHERE e.c1=k.c1 AND e.c3='A' AND e.c4=$2::numeric AND btrim(e.c6)=btrim(k.c6)) AS kdue
       FROM md.kdm1 k WHERE k.c1=$1 AND k.c2='U' AND k.c3='A' AND k.c4=$2::numeric AND btrim(k.c67)='SUITE'`, [suc, TIPO])).rows;
  console.log(`EL NUESTRO: ${JSON.stringify(mio)}`);

  await (c as unknown as { end(): Promise<void> }).end();
}

main().catch((err) => { console.error(`ERROR: ${(err as Error).message}`); process.exit(1); });
