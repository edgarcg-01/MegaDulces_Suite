/* eslint-disable no-console */
/**
 * `[PGP.71]` **Ensayo del pago `X-D-26` contra el Kepler vivo, desde `md`, con ROLLBACK.**
 *
 * Corre el `KeplerPagoSinkAdapter` REAL —no una copia de su SQL— con el único paso que escribe
 * (`confirmar`) cambiado por revisar las tablas temporales y deshacer. Existe aparte del spec
 * (`kepler-pago-sink.ensayo.spec.ts`) porque `pg_hba.conf` de Kepler sólo acepta a `kepler_push`
 * desde `md`, y en `md` no hay node ni el repo: esto se empaqueta en UN archivo y corre en un
 * contenedor que se borra al terminar. Ver `README.md` de esta carpeta.
 *
 * Entrada por stdin, una línea cada una (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { sucursal, plantilla, acreedor, factura: { tipo, subtipo, folio }, aplicado, origen: { bank, account_label } }
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { KeplerPagoSinkAdapter } from '../../../libs/finance/src/lib/payment-calendar/kepler-pago/kepler-pago-sink.adapter';
import type { PlanPagoKepler } from '../../../libs/finance/src/lib/payment-calendar/kepler-pago/pago-kepler.armador';

type Env = Readonly<Record<string, string | undefined>>;
const REFERENCIA = 'ENSAYO-PGP71';

class AdaptadorEnsayo extends KeplerPagoSinkAdapter {
  public fallas: string[] = [];
  public revisado: Record<string, unknown> | null = null;
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient, plan: PlanPagoKepler, sucursal: string): Promise<void> {
    const no: string[] = [];
    const h = (await c.query(`SELECT c6, btrim(c10) c10, c16::text c16, c42::text c42, btrim(c45) c45, btrim(c12) c12, btrim(c48) c48, c81, c82, c84, btrim(c67) c67 FROM _h`)).rows;
    const e = (await c.query(`SELECT c6, btrim(c2) c2, c11::text c11, c17::text c17, c20::text c20, btrim(c22) c22, btrim(c16) c16 FROM _e`)).rows;
    const f = (await c.query(`SELECT c6, btrim(c4::text) c4, c7::text c7, c9, c10::text c10 FROM _f`)).rows;
    const max = (await c.query(`SELECT max(c6::int) m FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='D' AND btrim(c4::text)='26' AND btrim(c5::text)='1'`, [sucursal])).rows[0].m;
    const H = h[0] ?? {}, E = e[0] ?? {};
    if (h.length !== 1) no.push(`_h tiene ${h.length} filas`);
    if (e.length !== 1) no.push(`_e tiene ${e.length} filas`);
    if (Number(H.c6) !== Number(max) + 1) no.push(`folio ${H.c6} ≠ MAX+1 (${Number(max) + 1})`);
    if (E.c6 !== H.c6) no.push(`kdxe.c6 ${E.c6} ≠ kdm1.c6 ${H.c6}`);
    if (Number(H.c16) !== Number(plan.kdm1['c16']) || Number(H.c42) !== Number(H.c16)) no.push(`importe ${H.c16}/${H.c42}`);
    if (E.c22 !== H.c45) no.push(`c45 ${H.c45} / kdxe.c22 ${E.c22}`);
    if (Number(E.c20) !== 0 || Number(E.c11) !== Number(H.c16) || Number(E.c17) !== Number(H.c16)) no.push(`kdxe c11 ${E.c11} c17 ${E.c17} c20 ${E.c20}`);
    if (f.length !== plan.kdxf.length || f.some((x) => x.c6 !== H.c6)) no.push(`kdxf ${f.length} filas`);
    // La baja de saldo NO se ensaya: es lo único que tocaría una fila real. Se comprueba que exista y alcance.
    for (const s of plan.saldos) {
      const r = await c.query(`SELECT c20::float8 c20 FROM md.kdxe WHERE btrim(c1)=$1 AND btrim(c2)=$2 AND c3='A' AND btrim(c4::text)=$3 AND btrim(c5::text)=$4 AND c6=$5`,
        [s.almacen, s.acreedor, String(s.tipo), String(s.subtipo), s.folio]);
      if (r.rowCount !== 1 || r.rows[0].c20 < s.menos - 0.005) no.push(`saldo de ${s.folio}: ${r.rows[0]?.c20}`);
    }
    this.fallas = no;
    this.revisado = { kdm1: H, kdxe: E, kdxf: f, saldos: plan.saldos };
    await c.query('ROLLBACK');
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const p = JSON.parse(json) as {
    sucursal: string; plantilla: string; acreedor: string; aplicado: number;
    factura: { tipo: number; subtipo: number; folio: string }; origen: { bank: string; account_label: string };
  };
  const env: Env = {
    KEPLER_PAGO_ESCRITURA: 'encendida',
    [`KEPLER_PUSH_URL_${p.sucursal}`]: url,
    [`KEPLER_PAGO_TEMPLATE_FOLIO_${p.sucursal}`]: p.plantilla,
  };
  const ad = new AdaptadorEnsayo(env);
  const r = await ad.entregar({
    sucursal: p.sucursal, fecha: new Date().toISOString().slice(0, 10), hora: '00:00', referencia: REFERENCIA,
    acreedor: p.acreedor, importe: p.aplicado, origen: p.origen, destino: null,
    facturas: [{ ...p.factura, aplicado: p.aplicado }],
  });
  console.log(JSON.stringify({ resultado: r, revisado: ad.revisado, fallas: ad.fallas }, null, 1));
  await ad.onModuleDestroy();
  // El control, con su propia conexión: después del ROLLBACK no quedó NINGÚN documento del ensayo.
  const { Client } = await import('pg');
  const k = new Client({ connectionString: url });
  await k.connect();
  const n = (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1=$1 AND btrim(c11)=$2`, [p.sucursal, REFERENCIA])).rows[0].n;
  await k.end();
  console.log(`CONTROL: documentos con la referencia ${REFERENCIA} en Kepler después del ensayo = ${n}`);
  if (n !== 0) process.exitCode = 2;
  else if (!ad.revisado || ad.fallas.length) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR', (e as Error).message); process.exit(1); });
