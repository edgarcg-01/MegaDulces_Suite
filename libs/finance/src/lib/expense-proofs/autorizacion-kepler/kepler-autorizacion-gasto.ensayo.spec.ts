import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type PoolClient } from 'pg';
import type { Env } from '@megadulces/platform-core';

import { KeplerAutorizacionGastoAdapter } from './kepler-autorizacion-gasto.adapter';

/**
 * `[PGP.79]` ENSAYO contra el Kepler REAL: corre `autorizar()` completo —conexión de esa sucursal,
 * el UPDATE con sus tipos, la llave primaria y el permiso `UPDATE (c43)` de `kepler_push`— sobre
 * una solicitud que hoy está en `N`, y en vez de confirmar hace ROLLBACK.
 *
 * ⛔ Sólo corre con `KEPLER_ENSAYO=1`, el maestro `~/kepler-push-secretos/kepler-push.env` y desde
 * una máquina que `pg_hba.conf` de Kepler acepte (hoy: el servidor `md`). Sin eso se salta: NO
 * MEDIDO, no verde. En CI no hay ERP (lo que sí corre en CI es
 * `database/tests/test-newdb-kepler-autorizacion-gasto.js`, contra un `kdm1` de prueba).
 *
 *   KEPLER_ENSAYO=1 KEPLER_ENSAYO_SUCURSAL=00 npx vitest run --config vitest.config.ts \
 *     src/lib/expense-proofs/autorizacion-kepler/kepler-autorizacion-gasto.ensayo.spec.ts
 */
const DIR = process.env.KEPLER_PUSH_SECRETOS || path.join(os.homedir(), 'kepler-push-secretos');
const MAESTRO = path.join(DIR, 'kepler-push.env');
const ACTIVO = process.env.KEPLER_ENSAYO === '1' && fs.existsSync(MAESTRO);
const SUC = process.env.KEPLER_ENSAYO_SUCURSAL || '00';

function envDeEnsayo(): Env {
  const env: Record<string, string | undefined> = { ...process.env, KEPLER_GASTO_AUTORIZACION: 'encendida' };
  for (const line of fs.readFileSync(MAESTRO, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^#?\s*(KEPLER_PUSH_URL_\d{2})=(\S+)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** El adaptador real con el paso que confirma cambiado por mirar la fila y ROLLBACK. */
class AdaptadorEnsayo extends KeplerAutorizacionGastoAdapter {
  public dentro: string | null = null;
  constructor(private readonly envEnsayo: Env, private readonly folio: string) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient): Promise<void> {
    this.dentro = (await c.query(`SELECT c43 FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='A' AND c4=15 AND c5=1 AND c6=$2`, [SUC, this.folio])).rows[0]?.c43 ?? null;
    await c.query('ROLLBACK');
  }
}

describe('[PGP.79] KeplerAutorizacionGastoAdapter — apagado por default', () => {
  it('sin KEPLER_GASTO_AUTORIZACION no abre ninguna conexión', async () => {
    class Apagado extends KeplerAutorizacionGastoAdapter { protected override get env(): Env { return { KEPLER_PUSH_URL_00: 'postgres://nadie@127.0.0.1:1/x' }; } }
    const a = new Apagado();
    expect(a.encendida()).toBe(false);
    expect(await a.autorizar({ sucursal: '00', folio_solicitud: '0010750' })).toEqual({ estado: 'no_escrito', motivo: expect.stringMatching(/apagada/) });
  });
  it('encendida pero sin la conexión de esa sucursal: no se redirige a otra', async () => {
    class SinUrl extends KeplerAutorizacionGastoAdapter { protected override get env(): Env { return { KEPLER_GASTO_AUTORIZACION: 'encendida', KEPLER_PUSH_URL_00: 'postgres://nadie@127.0.0.1:1/x' }; } }
    expect(await new SinUrl().autorizar({ sucursal: '03', folio_solicitud: '0000001' })).toEqual({ estado: 'no_escrito', motivo: expect.stringMatching(/KEPLER_PUSH_URL_03/) });
  });
});

describe.skipIf(!ACTIVO)('[PGP.79] ensayo contra el Kepler real (ROLLBACK, no escribe)', () => {
  it(`autoriza una solicitud real en N de ${SUC} y la deja en N`, async (ctx) => {
    const env = envDeEnsayo();
    const k = new Client({ connectionString: env[`KEPLER_PUSH_URL_${SUC}`], statement_timeout: 20000 });
    await k.connect();
    const m = (await k.query(
      `SELECT c6 FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='A' AND c4=15 AND c5=1 AND c43='N' ORDER BY c6 DESC LIMIT 1`, [SUC])).rows[0];
    if (!m) { await k.end(); ctx.skip(); } // ninguna pendiente hoy: NO MEDIDO
    const ad = new AdaptadorEnsayo(env, m.c6);
    const r = await ad.autorizar({ sucursal: SUC, folio_solicitud: m.c6 });
    expect(r).toEqual({ estado: 'escrito' });
    expect(ad.dentro, 'dentro de la transacción la solicitud quedó en A').toBe('A');
    // ⛔ El control: después del ROLLBACK la solicitud sigue en N.
    const despues = (await k.query(`SELECT c43 FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='A' AND c4=15 AND c5=1 AND c6=$2`, [SUC, m.c6])).rows[0].c43;
    expect(despues).toBe('N');
    await k.end();
  }, 60000);
});
