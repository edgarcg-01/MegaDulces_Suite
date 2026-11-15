import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type PoolClient } from 'pg';
import type { Env } from '@megadulces/platform-core';

import {
  escrituraDeSolicitudEncendida, esReintentable, KeplerSolicitudGastoSinkAdapter, plantillaSolicitudDe,
  type EntregaSolicitudKepler, type EscrituraSolicitudKepler,
} from './kepler-solicitud-gasto-sink.adapter';
import { revisarEscrituraSolicitud } from './kepler-solicitud-gasto-sink.revision';

/**
 * `[PGP.122.11]` Las reglas del escritor que no piden base de datos, y el ENSAYO contra el Kepler REAL:
 * corre `entregar()` completo —marca, tope, acreedor y catálogos del servidor, plantilla, contador
 * `sqliov` con su candado, tipos de las 200 columnas— y en vez de escribir revisa y hace ROLLBACK.
 *
 * ⛔ El ensayo sólo corre con `KEPLER_ENSAYO=1`, el maestro de `ops/prod/kepler-push-secretos.js` y desde
 * una máquina que `pg_hba.conf` de Kepler acepte (hoy: `md`). Sin eso se salta: NO MEDIDO, no verde. En el
 * CI no hay ERP; ahí la prueba es `database/tests/test-newdb-kepler-solicitud-gasto.js` (Postgres real).
 *
 *   KEPLER_ENSAYO=1 KEPLER_SOLGASTO_TEMPLATE_FOLIO_05=0000079 KEPLER_ENSAYO_SUCURSAL=05 npx vitest run \
 *     --config vitest.config.ts src/lib/expense-proofs/solicitud-kepler/kepler-solicitud-gasto-sink.ensayo.spec.ts
 */
const DIR = process.env.KEPLER_PUSH_SECRETOS || path.join(os.homedir(), 'kepler-push-secretos');
const MAESTRO = path.join(DIR, 'kepler-push.env');
const ACTIVO = process.env.KEPLER_ENSAYO === '1' && fs.existsSync(MAESTRO);
const SUC = process.env.KEPLER_ENSAYO_SUCURSAL || '05';

const pedido = (sucursal: string, extra: Partial<EntregaSolicitudKepler> = {}): EntregaSolicitudKepler => ({
  sucursal, acreedor: 'GA022', fechaSolicitud: '2026-11-13', fechaPago: null,
  renglones: [{ concepto: '240', proyecto: '2-15-26-02', departamento: '1-02-32-15', importe: 100 }],
  iva: 16, comprobante: { tipo: 'ticket', folio: 'ENSAYO', fecha: '2026-11-12' }, comentario: 'ENSAYO PGP122',
  solicita: 'ensayo', formaPago: 'efectivo', marca: 'SUITE SG-0E0E0E0E', estado: 'A',
  capturadaEn: { fecha: '2026-11-13', hora: '12:00' }, tope_dia: null, ...extra,
});

describe('[PGP.122.11] los candados del escritor — apagado por default', () => {
  it('sólo «encendida» prende la escritura', () => {
    expect(escrituraDeSolicitudEncendida({})).toBe(false);
    expect(escrituraDeSolicitudEncendida({ KEPLER_GASTO_SOLICITUD: 'true' })).toBe(false);
    expect(escrituraDeSolicitudEncendida({ KEPLER_GASTO_SOLICITUD: ' encendida ' })).toBe(true);
  });
  it('la plantilla no tiene default en ningún servidor: sin su variable de 7 dígitos, apagado', () => {
    expect(plantillaSolicitudDe('05', {}).ok).toBe(false);
    expect(plantillaSolicitudDe('05', { KEPLER_SOLGASTO_TEMPLATE_FOLIO_05: '79' }).ok).toBe(false);
    expect(plantillaSolicitudDe('05', { KEPLER_SOLGASTO_TEMPLATE_FOLIO_05: '0000079' })).toEqual({ ok: true, valor: '0000079' });
    expect(plantillaSolicitudDe('08', { KEPLER_SOLGASTO_TEMPLATE_FOLIO_05: '0000079' }).ok).toBe(false);
  });
  it('⛔ NEGATIVA — con cualquier candado cerrado NO abre conexión y dice cuál', async () => {
    const url = 'postgres://nadie@127.0.0.1:1/x';
    const casos: Array<[Env, RegExp]> = [
      [{ KEPLER_PUSH_URL_05: url, KEPLER_SOLGASTO_TEMPLATE_FOLIO_05: '0000079' }, /KEPLER_GASTO_SOLICITUD/],
      [{ KEPLER_GASTO_SOLICITUD: 'encendida', KEPLER_SOLGASTO_TEMPLATE_FOLIO_05: '0000079' }, /KEPLER_PUSH_URL_05/],
      [{ KEPLER_GASTO_SOLICITUD: 'encendida', KEPLER_PUSH_URL_05: url }, /TEMPLATE_FOLIO_05/],
    ];
    for (const [env, rx] of casos) {
      class Cerrado extends KeplerSolicitudGastoSinkAdapter { protected override get env(): Env { return env; } }
      const r = await new Cerrado().entregar(pedido('05'));
      expect(r.estado).toBe('apagado');
      expect(r.estado === 'apagado' && r.motivo).toMatch(rx);
    }
  });
  it('⛔ NEGATIVA — un pedido que el armador rechaza no llega a conectarse', async () => {
    class Abierto extends KeplerSolicitudGastoSinkAdapter {
      protected override get env(): Env { return { KEPLER_GASTO_SOLICITUD: 'encendida', KEPLER_PUSH_URL_05: 'postgres://nadie@127.0.0.1:1/x', KEPLER_SOLGASTO_TEMPLATE_FOLIO_05: '0000079' }; }
    }
    const r = await new Abierto().entregar(pedido('05', { renglones: [] }));
    expect(r).toEqual({ estado: 'rechazado', motivo: expect.stringMatching(/renglones/), reintentable: false });
  });
  it('sin Kepler (puerto cerrado): rechazado y reintentable — no se pierde, se reintenta', async () => {
    class SinKepler extends KeplerSolicitudGastoSinkAdapter {
      protected override get env(): Env { return { KEPLER_GASTO_SOLICITUD: 'encendida', KEPLER_PUSH_URL_05: 'postgres://nadie@127.0.0.1:1/x', KEPLER_SOLGASTO_TEMPLATE_FOLIO_05: '0000079' }; }
    }
    const ad = new SinKepler();
    const r = await ad.entregar(pedido('05'));
    await ad.onModuleDestroy();
    expect(r).toMatchObject({ estado: 'rechazado', reintentable: true });
  });
});

describe('[PGP.122.11] esReintentable', () => {
  it('candado ocupado, folio ganado, tiempo agotado y red caída: se reintenta', () => {
    for (const code of ['55P03', '23505', '57014', '40P01', '40001', 'ECONNREFUSED', 'ETIMEDOUT']) expect(esReintentable({ code }), code).toBe(true);
    expect(esReintentable(new Error('Connection terminated unexpectedly'))).toBe(true);
  });
  it('⛔ NEGATIVA — sin permiso o con un dato que Kepler no acepta, NO: reintentar no lo arregla', () => {
    for (const code of ['42501', '23502', '22001', '42P01']) expect(esReintentable({ code }), code).toBe(false);
  });
});

function envDeEnsayo(): Env {
  const env: Record<string, string | undefined> = { ...process.env, KEPLER_GASTO_SOLICITUD: 'encendida' };
  for (const line of fs.readFileSync(MAESTRO, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^#?\s*(KEPLER_PUSH_URL_\d{2})=(\S+)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** El adaptador real con el único paso que escribe cambiado por revisar las temporales y ROLLBACK. */
class AdaptadorEnsayo extends KeplerSolicitudGastoSinkAdapter {
  public fallas: string[] = [];
  public avisos: string[] = [];
  public revisado = false;
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient, w: EscrituraSolicitudKepler): Promise<void> {
    const r = await revisarEscrituraSolicitud(c, w);
    this.fallas = r.fallas;
    this.avisos = r.avisos;
    this.revisado = true;
    await c.query('ROLLBACK');
  }
}

describe.skipIf(!ACTIVO)('[PGP.122.11] ensayo contra el Kepler real (ROLLBACK, no escribe)', () => {
  it(`arma una solicitud real en ${SUC} con el acreedor, concepto, proyecto y depto de su última solicitud`, async (ctx) => {
    const env = envDeEnsayo();
    if (!plantillaSolicitudDe(SUC, env).ok) ctx.skip(); // sin plantilla elegida: NO MEDIDO
    const k = new Client({ connectionString: env[`KEPLER_PUSH_URL_${SUC}`], statement_timeout: 20000 });
    await k.connect();
    const m = (await k.query(
      `SELECT btrim(h.c10) acreedor, btrim(l.c12) concepto, btrim(l.c13) proyecto, btrim(l.c16) depto
         FROM md.kdm1 h JOIN md.kdm6 l ON l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
        WHERE h.c1 = $1 AND h.c2 = 'X' AND h.c3 = 'A' AND h.c4 = 15 AND h.c5 = 1 AND h.c43 <> 'C' AND btrim(h.c10) LIKE 'G%' AND btrim(h.c10) <> 'GN001'
        ORDER BY h.c6 DESC LIMIT 1`, [SUC])).rows[0];
    expect(m).toBeTruthy();
    const contadorAntes = (await k.query(`SELECT c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [`KFXA1501.${SUC}`])).rows[0]?.c4;
    const ad = new AdaptadorEnsayo(env);
    const r = await ad.entregar(pedido(SUC, { acreedor: m.acreedor, renglones: [{ concepto: m.concepto, proyecto: m.proyecto, departamento: m.depto, importe: 100 }] }));
    await ad.onModuleDestroy();
    expect(ad.revisado, JSON.stringify(r)).toBe(true);
    expect(ad.fallas).toEqual([]);
    // ⛔ El control: tras el ROLLBACK no quedó nada con la marca del ensayo y el contador está como estaba.
    const quedaron = (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1 = $1 AND btrim(c26) = 'SUITE SG-0E0E0E0E'`, [SUC])).rows[0].n;
    const contadorDespues = (await k.query(`SELECT c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [`KFXA1501.${SUC}`])).rows[0]?.c4;
    await k.end();
    expect(quedaron).toBe(0);
    expect(contadorDespues).toBe(contadorAntes);
  }, 60000);
});
