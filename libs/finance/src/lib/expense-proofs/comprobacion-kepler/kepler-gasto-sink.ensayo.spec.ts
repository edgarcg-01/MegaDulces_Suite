import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type PoolClient } from 'pg';
import type { Env } from '@megadulces/platform-core';

import {
  cambioContraLoAprobado, esReintentableGasto, escrituraDeGastoEncendida, KeplerGastoSinkAdapter, SERVIDORES_POLIZA_MENSUAL, vacioDeTipo,
  type EntregaGastoKepler, type EscrituraGastoKepler,
} from './kepler-gasto-sink.adapter';
import { revisarEscrituraGasto } from './kepler-gasto-sink.revision';

/**
 * `[PGP.123]` G.7 — Las reglas del escritor del gasto (X-A-10) que no piden base de datos, y el ENSAYO contra el
 * Kepler REAL: corre `entregar()` completo —la solicitud viva con su candado, sus renglones, `kdmm`, `kdc3`, las
 * cuentas de `kdc126`, `kdxg`, el contador, el número de póliza y los tipos reales— y en vez de escribir revisa y
 * hace ROLLBACK.
 *
 * ⛔ El ensayo sólo corre con `KEPLER_ENSAYO=1`, el maestro de `ops/prod/kepler-push-secretos.js`, una solicitud
 * real en `A` (`KEPLER_ENSAYO_SOLICITUD`) y desde una máquina que `pg_hba.conf` de Kepler acepte (hoy: `md`). Sin
 * eso se salta: NO MEDIDO, no verde. En el CI la prueba es `database/tests/test-newdb-kepler-gasto-comprobacion.js`.
 *
 *   KEPLER_ENSAYO=1 KEPLER_ENSAYO_SUCURSAL=05 KEPLER_ENSAYO_SOLICITUD=0000123 npx vitest run \
 *     --config vitest.config.ts src/lib/expense-proofs/comprobacion-kepler/kepler-gasto-sink.ensayo.spec.ts
 */
const DIR = process.env.KEPLER_PUSH_SECRETOS || path.join(os.homedir(), 'kepler-push-secretos');
const MAESTRO = path.join(DIR, 'kepler-push.env');
const SOLICITUD = process.env.KEPLER_ENSAYO_SOLICITUD ?? '';
const ACTIVO = process.env.KEPLER_ENSAYO === '1' && fs.existsSync(MAESTRO) && /^\d{7}$/.test(SOLICITUD);
const SUC = process.env.KEPLER_ENSAYO_SUCURSAL || '05';
const hoyMx = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

const pedido = (sucursal: string, extra: Partial<EntregaGastoKepler> = {}): EntregaGastoKepler => ({
  sucursal, solicitud: '0000120', fecha: '2026-11-13', capturadoEn: { fecha: '2026-11-13', hora: '12:00' },
  formaPagoVale: null, vale: 'ensayo', tope_dia: null, esperado: { total: 116, acreedor: 'GA022', fecha: '2026-11-13' }, ...extra,
});
const CERRADO = 'postgres://nadie@127.0.0.1:1/x';

describe('[PGP.123] G.7 los candados del escritor del gasto — apagado por default', () => {
  it('sólo «encendida» prende la escritura', () => {
    expect(escrituraDeGastoEncendida({})).toBe(false);
    expect(escrituraDeGastoEncendida({ KEPLER_GASTO_COMPROBACION: 'true' })).toBe(false);
    expect(escrituraDeGastoEncendida({ KEPLER_GASTO_COMPROBACION: ' encendida ' })).toBe(true);
  });
  it('DG7: sólo las sucursales con UNA secuencia de póliza D por mes (02, 04, 05, 07)', () => {
    expect([...SERVIDORES_POLIZA_MENSUAL].sort()).toEqual(['02', '04', '05', '07']);
  });
  it('⛔ NEGATIVA — con cualquier candado cerrado NO abre conexión y dice cuál', async () => {
    const casos: Array<[Env, string, RegExp]> = [
      [{ KEPLER_PUSH_URL_05: CERRADO }, '05', /KEPLER_GASTO_COMPROBACION/],
      [{ KEPLER_GASTO_COMPROBACION: 'encendida' }, '05', /KEPLER_PUSH_URL_05/],
      [{ KEPLER_GASTO_COMPROBACION: 'encendida', KEPLER_PUSH_URL_00: CERRADO }, '00', /DG7/],
      [{ KEPLER_GASTO_COMPROBACION: 'encendida', KEPLER_PUSH_URL_08: CERRADO }, '08', /DG7/],
    ];
    for (const [env, suc, rx] of casos) {
      class Cerrado extends KeplerGastoSinkAdapter { protected override get env(): Env { return env; } }
      const r = await new Cerrado().entregar(pedido(suc));
      expect(r.estado, suc).toBe('apagado');
      expect(r.estado === 'apagado' && r.motivo).toMatch(rx);
    }
  });
  it('⛔ NEGATIVA — folio o fecha inválidos no llegan a conectarse', async () => {
    class Abierto extends KeplerGastoSinkAdapter { protected override get env(): Env { return { KEPLER_GASTO_COMPROBACION: 'encendida', KEPLER_PUSH_URL_05: CERRADO }; } }
    expect(await new Abierto().entregar(pedido('05', { solicitud: '120' }))).toEqual({ estado: 'rechazado', motivo: expect.stringMatching(/Folio/), reintentable: false });
    expect(await new Abierto().entregar(pedido('05', { fecha: '13/11/2026' }))).toEqual({ estado: 'rechazado', motivo: expect.stringMatching(/Fecha/), reintentable: false });
  });
  it('⛔ NEGATIVA — sin lo que aprobó G.5 (total, acreedor y fecha) no se conecta: no se escribe a ciegas', async () => {
    class Abierto extends KeplerGastoSinkAdapter { protected override get env(): Env { return { KEPLER_GASTO_COMPROBACION: 'encendida', KEPLER_PUSH_URL_05: CERRADO }; } }
    const a = new Abierto();
    for (const esperado of [undefined, { total: Number.NaN, acreedor: 'GA022', fecha: '2026-11-13' }, { total: 116, acreedor: ' ', fecha: '2026-11-13' }, { total: 116, acreedor: 'GA022', fecha: '13/11/2026' }]) {
      const r = await a.entregar({ ...pedido('05'), esperado: esperado as EntregaGastoKepler['esperado'] });
      expect(r).toEqual({ estado: 'rechazado', motivo: expect.stringMatching(/a ciegas/), reintentable: false });
    }
  });
  it('⛔ la solicitud viva tiene que ser la que aprobó G.5: total al centavo, acreedor y fecha', () => {
    const esp = { total: 116, acreedor: 'GA022', fecha: '2026-11-12' };
    expect(cambioContraLoAprobado({ total: '116.00', acreedor: 'GA022', fecha: '2026-11-12' }, esp)).toBeNull();
    expect(cambioContraLoAprobado({ total: '116.004', acreedor: ' GA022 ', fecha: '2026-11-12' }, esp)).toBeNull();
    expect(cambioContraLoAprobado({ total: '150.00', acreedor: 'GA022', fecha: '2026-11-12' }, esp)).toBe('total: el ODS dice $116.00 y Kepler $150.00');
    expect(cambioContraLoAprobado({ total: '116.00', acreedor: 'GA077', fecha: '2026-11-12' }, esp)).toBe('acreedor: GA022 → GA077');
    expect(cambioContraLoAprobado({ total: '116.00', acreedor: 'GA022', fecha: '2026-10-30' }, esp)).toBe('fecha: 2026-11-12 → 2026-10-30');
    expect(cambioContraLoAprobado({ total: null, acreedor: null, fecha: null }, esp)).toMatch(/total: .* · acreedor: .* · fecha: /);
  });
  it('sin Kepler (puerto cerrado): rechazado y reintentable — no se pierde, se reintenta', async () => {
    class SinKepler extends KeplerGastoSinkAdapter { protected override get env(): Env { return { KEPLER_GASTO_COMPROBACION: 'encendida', KEPLER_PUSH_URL_05: CERRADO }; } }
    const ad = new SinKepler();
    const r = await ad.entregar(pedido('05'));
    await ad.onModuleDestroy();
    expect(r).toMatchObject({ estado: 'rechazado', reintentable: true });
  });
});

describe('[PGP.123] G.7 lo vacío de cada tipo (lo que llevan las columnas que el armador no pone)', () => {
  it('texto en blanco, número en cero, fecha centinela', () => {
    expect(vacioDeTipo('character varying(7)')).toBe('');
    expect(vacioDeTipo('numeric(15,2)')).toBe(0);
    expect(vacioDeTipo('double precision')).toBe(0);
    expect(vacioDeTipo('timestamp without time zone')).toBe('1800-01-01');
  });
});

describe('[PGP.123] G.7 esReintentableGasto', () => {
  it('candado ocupado, número ganado, tiempo agotado y red caída: se reintenta', () => {
    for (const code of ['55P03', '23505', '57014', '40P01', '40001', 'ECONNREFUSED', 'ETIMEDOUT']) expect(esReintentableGasto({ code }), code).toBe(true);
    expect(esReintentableGasto(new Error('Connection terminated unexpectedly'))).toBe(true);
  });
  it('⛔ NEGATIVA — un dato que Kepler no acepta, NO: reintentar no lo arregla (el permiso se trata aparte: apagado)', () => {
    for (const code of ['42501', '23502', '22001', '42P01']) expect(esReintentableGasto({ code }), code).toBe(false);
  });
});

function envDeEnsayo(): Env {
  const env: Record<string, string | undefined> = { ...process.env, KEPLER_GASTO_COMPROBACION: 'encendida' };
  for (const line of fs.readFileSync(MAESTRO, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^#?\s*(KEPLER_PUSH_URL_\d{2})=(\S+)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** El escritor real con el único paso que escribe cambiado por revisar las temporales y ROLLBACK. */
class AdaptadorEnsayo extends KeplerGastoSinkAdapter {
  public fallas: string[] = [];
  public avisos: string[] = [];
  public revisado = false;
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient, w: EscrituraGastoKepler): Promise<void> {
    const r = await revisarEscrituraGasto(c, w);
    this.fallas = r.fallas;
    this.avisos = r.avisos;
    this.revisado = true;
    await c.query('ROLLBACK');
  }
}

describe.skipIf(!ACTIVO)('[PGP.123] G.7 ensayo contra el Kepler real (ROLLBACK, no escribe)', () => {
  it(`arma el gasto de la solicitud ${SOLICITUD || '(sin elegir)'} de ${SUC} y lo revisa sin escribir`, async () => {
    const env = envDeEnsayo();
    const k = new Client({ connectionString: env[`KEPLER_PUSH_URL_${SUC}`], statement_timeout: 20000 });
    await k.connect();
    const foto = async () => JSON.stringify((await k.query(
      `SELECT (SELECT c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0) contador,
              (SELECT btrim(c43) || ' ' || c42::text FROM md.kdm1 WHERE c1 = $2 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND c6 = $3) solicitud,
              (SELECT count(*) FROM md.kdm1 WHERE c1 = $2 AND c2 = 'X' AND c3 = 'A' AND c4 = 10 AND c5 = 1 AND btrim(c39) = $3 AND btrim(c43) <> 'C') gastos`,
      [`KFXA1001.${SUC}`, SUC, SOLICITUD])).rows[0]);
    const antes = await foto();
    const hoy = hoyMx();
    // Lo que aprobaría G.5: se lee de la misma solicitud viva (el ensayo no pasa por el ODS).
    const viva = (await k.query(
      `SELECT round(c16::numeric, 2)::float8 AS total, btrim(c10) AS acreedor, to_char(c9, 'YYYY-MM-DD') AS fecha
         FROM md.kdm1 WHERE c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND c6 = $2`, [SUC, SOLICITUD])).rows[0];
    const ad = new AdaptadorEnsayo(env);
    const r = await ad.entregar(pedido(SUC, { solicitud: SOLICITUD, fecha: hoy, capturadoEn: { fecha: hoy, hora: '12:00' }, esperado: viva }));
    await ad.onModuleDestroy();
    expect(ad.revisado, JSON.stringify(r)).toBe(true);
    expect(ad.fallas).toEqual([]);
    // ⛔ El control: tras el ROLLBACK, el contador, la solicitud y sus gastos están como estaban.
    expect(await foto()).toBe(antes);
    await k.end();
  }, 60000);
});
