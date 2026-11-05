import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client, type PoolClient } from 'pg';
import type { Env } from '@megadulces/platform-core';

import { KeplerPagoSinkAdapter, plantillaPagoDe } from './kepler-pago-sink.adapter';
import type { PlanPagoKepler } from './pago-kepler.armador';

/**
 * `[PGP.71]` ENSAYO contra el Kepler REAL: corre `entregar()` completo —acreedor, cuenta de
 * tesorería, saldo vivo de la factura, plantilla, folio `MAX+1`, los UPDATE con sus tipos— y en vez
 * de escribir hace ROLLBACK. Todo lo que toca son tablas temporales de la sesión. Es la misma
 * herramienta que cazó en KR un «tipos de dato inconsistentes» que ningún doble habría visto.
 *
 * ⛔ Sólo corre con `KEPLER_ENSAYO=1`, el maestro de `ops/prod/kepler-push-secretos.js` y desde
 * una máquina que `pg_hba.conf` de Kepler acepte (hoy: el servidor `md`). Sin eso se salta: NO
 * MEDIDO, no verde. En CI no hay ERP.
 *
 *   KEPLER_ENSAYO=1 KEPLER_PAGO_TEMPLATE_FOLIO_00=0023768 npx vitest run --config vitest.config.ts \
 *     src/lib/payment-calendar/kepler-pago/kepler-pago-sink.ensayo.spec.ts
 */
const DIR = process.env.KEPLER_PUSH_SECRETOS || path.join(os.homedir(), 'kepler-push-secretos');
const MAESTRO = path.join(DIR, 'kepler-push.env');
const ACTIVO = process.env.KEPLER_ENSAYO === '1' && fs.existsSync(MAESTRO);
const SUC = process.env.KEPLER_ENSAYO_SUCURSAL || '00';

function envDeEnsayo(): Env {
  const env: Record<string, string | undefined> = { ...process.env, KEPLER_PAGO_ESCRITURA: 'encendida' };
  for (const line of fs.readFileSync(MAESTRO, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^#?\s*(KEPLER_PUSH_URL_\d{2})=(\S+)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** El adaptador real con el único paso que escribe cambiado por revisar las temporales y ROLLBACK. */
class AdaptadorEnsayo extends KeplerPagoSinkAdapter {
  public fallas: string[] = [];
  public revisado = false;
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient, plan: PlanPagoKepler, sucursal: string): Promise<void> {
    const no: string[] = [];
    const h = (await c.query(`SELECT count(*) OVER ()::int n, c6, btrim(c10) c10, c16::text c16, c42::text c42, btrim(c45) c45, btrim(c12) c12, btrim(c67) c67 FROM _h`)).rows;
    const e = (await c.query(`SELECT count(*) OVER ()::int n, c6, btrim(c2) c2, c3, c11::text c11, c20::text c20, btrim(c22) c22 FROM _e`)).rows;
    const f = (await c.query(`SELECT c6, c10::text c10 FROM _f`)).rows;
    const max = (await c.query(`SELECT max(c6::int) m FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='D' AND btrim(c4::text)='26' AND btrim(c5::text)='1'`, [sucursal])).rows[0].m;
    if (h.length !== 1) no.push(`_h tiene ${h.length} filas`);
    if (e.length !== 1) no.push(`_e tiene ${e.length} filas`);
    const H = h[0] ?? {}, E = e[0] ?? {};
    if (Number(H.c6) !== Number(max) + 1) no.push(`folio ${H.c6} ≠ MAX+1 (${Number(max) + 1})`);
    if (E.c6 !== H.c6) no.push(`kdxe.c6 ${E.c6} ≠ kdm1.c6 ${H.c6}`);
    if (Number(H.c16) !== Number(plan.kdm1['c16']) || Number(H.c42) !== Number(H.c16)) no.push(`importe ${H.c16}/${H.c42}`);
    if (H.c45 !== plan.kdm1['c45'] || E.c22 !== H.c45) no.push(`c45 ${H.c45} / kdxe.c22 ${E.c22}`);
    if (Number(E.c20) !== 0 || Number(E.c11) !== Number(H.c16)) no.push(`kdxe c11 ${E.c11} c20 ${E.c20}`);
    if (H.c67 !== 'SUITE') no.push(`c67 ${H.c67}`);
    if (f.length !== plan.kdxf.length || f.some((x) => x.c6 !== H.c6)) no.push(`kdxf ${f.length} filas`);
    // La baja de saldo no se ensaya (pide el UPDATE que aún no está): se comprueba que su fila exista.
    for (const s of plan.saldos) {
      const r = await c.query(`SELECT c20::float8 c20 FROM md.kdxe WHERE btrim(c1)=$1 AND btrim(c2)=$2 AND c3='A' AND btrim(c4::text)=$3 AND btrim(c5::text)=$4 AND c6=$5`,
        [s.almacen, s.acreedor, String(s.tipo), String(s.subtipo), s.folio]);
      if (r.rowCount !== 1 || r.rows[0].c20 < s.menos - 0.005) no.push(`saldo de ${s.folio}: ${r.rows[0]?.c20}`);
    }
    this.fallas = no;
    this.revisado = true;
    await c.query('ROLLBACK');
  }
}

describe('[PGP.71] plantillaPagoDe — sin default en ningún servidor', () => {
  it('sin la variable, apagado; con un folio de 7 dígitos, encendido', () => {
    expect(plantillaPagoDe('00', {}).ok).toBe(false);
    expect(plantillaPagoDe('00', { KEPLER_PAGO_TEMPLATE_FOLIO_00: '23768' }).ok).toBe(false);
    expect(plantillaPagoDe('00', { KEPLER_PAGO_TEMPLATE_FOLIO_00: '0023768' })).toEqual({ ok: true, valor: { serie: '1', folio: '0023768' } });
    expect(plantillaPagoDe('02', { KEPLER_PAGO_TEMPLATE_FOLIO_00: '0023768' }).ok).toBe(false);
  });
});

describe('[PGP.71] KeplerPagoSinkAdapter — apagado por default', () => {
  it('sin KEPLER_PAGO_ESCRITURA no abre ninguna conexión', async () => {
    class Apagado extends KeplerPagoSinkAdapter { protected override get env(): Env { return { KEPLER_PUSH_URL_00: 'postgres://nadie@127.0.0.1:1/x' }; } }
    const r = await new Apagado().entregar({ sucursal: '00', fecha: '2026-11-05', hora: '10:00', referencia: 'X', acreedor: 'CA041', importe: 1,
      origen: { bank: 'BBVA', account_label: '4176' }, destino: null, facturas: [{ tipo: 20, subtipo: 1, folio: '1', aplicado: 1 }] });
    expect(r).toEqual({ estado: 'rechazado', motivo: expect.stringMatching(/apagada/) });
  });
});

describe.skipIf(!ACTIVO)('[PGP.71] ensayo contra el Kepler real (ROLLBACK, no escribe)', () => {
  it(`paga una factura abierta real en ${SUC}: SQL completo, columnas del pago y ROLLBACK`, async (ctx) => {
    const env = envDeEnsayo();
    if (!plantillaPagoDe(SUC, env).ok) ctx.skip(); // sin plantilla elegida: NO MEDIDO
    const k = new Client({ connectionString: env[`KEPLER_PUSH_URL_${SUC}`], statement_timeout: 20000 });
    await k.connect();
        const muestra = (await k.query(
      `SELECT btrim(c2) acreedor, btrim(c4::text)::int tipo, btrim(c5::text)::int subtipo, c6 folio, c20::float8 saldo
         FROM md.kdxe WHERE btrim(c1)=$1 AND c3='A' AND btrim(c2) LIKE 'C%' AND c20 > 100 AND btrim(coalesce(c18,'')) LIKE 'C-%'
        ORDER BY c7 DESC LIMIT 1`, [SUC])).rows[0];
    expect(muestra).toBeTruthy();
    const ad = new AdaptadorEnsayo(env);
    const r = await ad.entregar({
      sucursal: SUC, fecha: '2026-11-05', hora: '10:00', referencia: 'ENSAYO-PGP71', acreedor: muestra.acreedor,
      importe: muestra.saldo, origen: { bank: 'BBVA', account_label: '4176' }, destino: null,
      facturas: [{ tipo: muestra.tipo, subtipo: muestra.subtipo, folio: muestra.folio, aplicado: muestra.saldo }],
    });
    expect(ad.revisado, JSON.stringify(r)).toBe(true);
    expect(ad.fallas).toEqual([]);
    // ⛔ El control: después del ROLLBACK no quedó NINGÚN documento con la referencia del ensayo.
    const quedaron = (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='D' AND btrim(c11)='ENSAYO-PGP71'`, [SUC])).rows[0].n;
    expect(quedaron).toBe(0);
    await k.end();
  }, 60000);
});
