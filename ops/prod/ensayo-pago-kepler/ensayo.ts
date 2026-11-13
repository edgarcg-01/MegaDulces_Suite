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

import { KeplerPagoSinkAdapter, type EscrituraPagoKepler } from '../../../libs/finance/src/lib/payment-calendar/kepler-pago/kepler-pago-sink.adapter';
import { revisarEscrituraPago } from '../../../libs/finance/src/lib/payment-calendar/kepler-pago/kepler-pago-sink.revision';

type Env = Readonly<Record<string, string | undefined>>;
const REFERENCIA = 'ENSAYO-PGP71';

class AdaptadorEnsayo extends KeplerPagoSinkAdapter {
  public fallas: string[] = [];
  public revisado: Record<string, unknown> | null = null;
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient, w: EscrituraPagoKepler): Promise<void> {
    const r = await revisarEscrituraPago(c, w);
    this.fallas = r.fallas;
    this.revisado = r.revisado;
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
