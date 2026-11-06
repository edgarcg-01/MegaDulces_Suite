/* eslint-disable no-console */
/**
 * `[PGP.79]` **Ensayo de la autorización de la solicitud de gasto contra el Kepler vivo, desde `md`,
 * con ROLLBACK.**
 *
 * Corre el `KeplerAutorizacionGastoAdapter` REAL —no una copia de su SQL— sobre la solicitud
 * `X-A-15-1` en `N` más reciente de la sucursal, con el único paso que confirma (`confirmar`)
 * cambiado por mirar la fila dentro de la transacción y deshacer. Existe aparte del spec porque
 * `pg_hba.conf` de Kepler sólo acepta a `kepler_push` desde `md`, y en `md` no hay node ni el repo.
 *
 * Entrada por stdin, una línea cada una (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. la sucursal (dos dígitos)
 *
 * Sale con 0 si: el UPDATE tocó la fila (`escrito`), dentro de la transacción quedó en `A`, y
 * DESPUÉS del ROLLBACK, con otra conexión, sigue en `N`. Con 2 si quedó escrita (avisar a quien
 * administra Kepler). Con 3 si no hay ninguna solicitud en `N` (NO MEDIDO, no verde).
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { KeplerAutorizacionGastoAdapter } from '../../../libs/finance/src/lib/expense-proofs/autorizacion-kepler/kepler-autorizacion-gasto.adapter';

type Env = Readonly<Record<string, string | undefined>>;
const LLAVE = `c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND c6 = $2`;

class AdaptadorEnsayo extends KeplerAutorizacionGastoAdapter {
  public dentro: string | null = null;
  constructor(private readonly envEnsayo: Env, private readonly suc: string, private readonly folio: string) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient): Promise<void> {
    this.dentro = (await c.query(`SELECT c43 FROM md.kdm1 WHERE ${LLAVE}`, [this.suc, this.folio])).rows[0]?.c43 ?? null;
    await c.query('ROLLBACK');
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l.trim());
  const [url, suc] = lineas;
  if (!url || !/^\d{2}$/.test(suc ?? '')) throw new Error('Faltan las dos líneas de entrada (URL y sucursal)');

  const { Client } = await import('pg');
  const k = new Client({ connectionString: url, statement_timeout: 20000 });
  await k.connect();
  const m = (await k.query(`SELECT c6 FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='A' AND c4=15 AND c5=1 AND c43='N' ORDER BY c6 DESC LIMIT 1`, [suc])).rows[0];
  if (!m) { console.log(JSON.stringify({ sucursal: suc, medido: false, motivo: 'ninguna solicitud en N hoy' })); await k.end(); process.exit(3); }

  const ad = new AdaptadorEnsayo({ KEPLER_GASTO_AUTORIZACION: 'encendida', [`KEPLER_PUSH_URL_${suc}`]: url }, suc, m.c6);
  const r = await ad.autorizar({ sucursal: suc, folio_solicitud: m.c6 });
  await ad.onModuleDestroy();
  // El control, con su propia conexión: después del ROLLBACK la solicitud sigue en N.
  const despues = (await k.query(`SELECT c43 FROM md.kdm1 WHERE ${LLAVE}`, [suc, m.c6])).rows[0]?.c43 ?? null;
  await k.end();

  const fallas: string[] = [];
  if (r.estado !== 'escrito') fallas.push(`resultado ${JSON.stringify(r)}`);
  if (ad.dentro !== 'A') fallas.push(`dentro de la transacción quedó en ${ad.dentro}`);
  if (despues !== 'N') fallas.push(`⛔ DESPUÉS del ROLLBACK está en ${despues}`);
  console.log(JSON.stringify({ sucursal: suc, folio: m.c6, resultado: r, dentro: ad.dentro, despues, fallas }));
  process.exit(despues !== 'N' ? 2 : fallas.length ? 1 : 0);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
