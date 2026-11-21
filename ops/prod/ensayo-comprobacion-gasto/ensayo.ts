/* eslint-disable no-console */
/**
 * `[PGP.123]` G.10 — **Ensayo de «escribir el gasto (X-A-10)» contra el Kepler vivo, desde `md`, sin escribir.**
 *
 * Corre el `KeplerGastoSinkAdapter` REAL —la solicitud viva con su candado, sus renglones, `kdmm`, `kdc3`, las
 * cuentas de `kdc126`, `kdxg`, el contador `KFXA1001.NN`, el número de póliza D y los tipos reales— y cambia el
 * único paso que escribe (`confirmar`) por la revisión (`revisarEscrituraGasto`) + `ROLLBACK`. Lo único que toca el
 * Kepler real son los candados de la transacción (milisegundos) y lo que el ROLLBACK deshace.
 *
 * Entrada por stdin (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { "sucursal": "05", "solicitud": "0000092" }   (una X-A-15 real en `A`, con todo su saldo y sin gasto)
 *
 * Lo que aprobaría G.5 (total, acreedor y fecha) se lee de la misma solicitud viva: el ensayo no pasa por el ODS.
 * La fecha del gasto es la de la solicitud (DG1), como la decide el servicio.
 *
 * Salida: el resultado, las fallas (el verde exige cero), los avisos, lo revisado y el CONTROL (contador, solicitud,
 * gastos de la solicitud, máximo de la póliza D del mes y cargos del acreedor: como estaban). Código 1 = fallas o
 * no llegó a revisar; 2 = el control falló.
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import {
  KeplerGastoSinkAdapter, type EscrituraGastoKepler,
} from '../../../libs/finance/src/lib/expense-proofs/comprobacion-kepler/kepler-gasto-sink.adapter';
import { revisarEscrituraGasto } from '../../../libs/finance/src/lib/expense-proofs/comprobacion-kepler/kepler-gasto-sink.revision';

type Env = Readonly<Record<string, string | undefined>>;

class AdaptadorEnsayo extends KeplerGastoSinkAdapter {
  public revision: Awaited<ReturnType<typeof revisarEscrituraGasto>> | null = null;
  public escritura: Omit<EscrituraGastoKepler, 'plan'> & { renglones?: number; poliza_renglones?: number } | null = null;
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient, w: EscrituraGastoKepler): Promise<void> {
    this.revision = await revisarEscrituraGasto(c, w);
    const { plan: _plan, ...resto } = w;
    this.escritura = resto;
    await c.query('ROLLBACK');
  }
}

const hoyMx = (): { fecha: string; hora: string } => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
};

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const p = JSON.parse(json) as { sucursal: string; solicitud: string };
  if (!/^\d{2}$/.test(p.sucursal) || !/^\d{7}$/.test(p.solicitud)) throw new Error('sucursal (2 dígitos) y solicitud (7 dígitos)');
  const env: Env = { KEPLER_GASTO_COMPROBACION: 'encendida', [`KEPLER_PUSH_URL_${p.sucursal}`]: url };

  const { Client } = await import('pg');
  const k = new Client({ connectionString: url, statement_timeout: 20000 });
  await k.connect();
  const viva = (await k.query(
    `SELECT round(c16::numeric, 2)::float8 AS total, btrim(c10) AS acreedor, to_char(c9, 'YYYY-MM-DD') AS fecha
       FROM md.kdm1 WHERE c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND btrim(c6) = $2`, [p.sucursal, p.solicitud])).rows[0];
  if (!viva) throw new Error(`No existe la solicitud ${p.solicitud} en ${p.sucursal}`);
  const tabla = `kdc2${viva.fecha.slice(2, 4)}${viva.fecha.slice(5, 7)}`;
  const foto = async (): Promise<string> => JSON.stringify((await k.query(
    `SELECT (SELECT btrim(c4) FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0) AS contador,
            (SELECT btrim(c43) || ' ' || c42::text FROM md.kdm1 WHERE c1 = $2 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND btrim(c6) = $3) AS solicitud,
            (SELECT count(*) FROM md.kdm1 WHERE c1 = $2 AND c2 = 'X' AND c3 = 'A' AND c4 = 10 AND c5 = 1 AND btrim(c39) = $3 AND btrim(c43) <> 'C') AS gastos,
            (SELECT max(c1) FROM md.${tabla} WHERE c8 = 'D') AS poliza_max,
            (SELECT count(*) FROM md.${tabla}) AS poliza_filas,
            (SELECT count(*) FROM md.kdxe) AS kdxe_filas,
            (SELECT count(*) FROM md.kdcn26) AS kdcn26_filas`,
    [`KFXA1001.${p.sucursal}`, p.sucursal, p.solicitud])).rows[0]);
  const antes = await foto();

  const hoy = hoyMx();
  const ad = new AdaptadorEnsayo(env);
  let resultado: unknown;
  try {
    resultado = await ad.entregar({
      sucursal: p.sucursal, solicitud: p.solicitud, fecha: viva.fecha, capturadoEn: hoy,
      formaPagoVale: null, vale: 'ensayo-g10', tope_dia: null, esperado: viva,
    });
  } finally {
    await ad.onModuleDestroy();
  }
  const despues = await foto();
  await k.end();

  console.log(JSON.stringify({
    sucursal: p.sucursal, solicitud: p.solicitud, aprobado: viva, resultado,
    escritura: ad.escritura, fallas: ad.revision?.fallas ?? null, avisos: ad.revision?.avisos ?? null,
    revisado: ad.revision?.revisado ?? null, control: { antes: JSON.parse(antes), despues: JSON.parse(despues), igual: antes === despues },
  }, null, 2));
  if (antes !== despues) process.exit(2);
  if (!ad.revision || ad.revision.fallas.length) process.exit(1);
}

main().catch((e) => { console.error(`ERROR ${(e as Error).message}`); process.exit(1); });
