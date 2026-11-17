/* eslint-disable no-console */
/**
 * `[PGP.122.4]` **Ensayo del PEDIDO TELEMARK (`U-D-40`, contador `KFUD4001`) contra el Kepler vivo,
 * desde `md`, con ROLLBACK.** Corre el `KeplerPedidoTlmkSinkAdapter` REAL con el único paso que
 * escribe (`confirmar`) cambiado por revisar el FOLIO y el CONTADOR y deshacer. Existe aparte del
 * spec (`kepler-pedido-tlmk-sink.ensayo.spec.ts`, que reproduce los importes de un pedido real)
 * porque `pg_hba.conf` de Kepler sólo acepta `kepler_push` desde `md`, y en `md` no hay node ni el
 * repo: esto se empaqueta en UN archivo y corre en un contenedor que se borra.
 *
 * Toma el último pedido TELEMARK en CREADO del servidor como PLANTILLA y le da al adaptador sus
 * propios renglones como cotización (igual que el spec). Lo que prueba, que el spec no puede en
 * `md`: que el folio sale del CONTADOR (`md.sqliov` con el GRANT) y que `sqliov.c4` avanzó.
 *
 * Entrada por stdin: 1) URL de `kepler_push`  2) JSON { sucursal }.
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { KeplerPedidoTlmkSinkAdapter } from '../../../libs/commercial/src/lib/commercial-quotes/kepler-pedido-tlmk-sink.adapter';
import type { RenglonCotizacion } from '../../../libs/commercial/src/lib/commercial-quotes/kepler-pedido-tlmk';

const pad2 = (v: unknown) => String(v).trim().padStart(2, '0');

class AdaptadorEnsayo extends KeplerPedidoTlmkSinkAdapter {
  public fallas: string[] = [];
  public contadores: string[] = [];
  constructor(private readonly sucEnsayo: string) { super(); }

  protected override async confirmar(c: PoolClient): Promise<void> {
    const no: string[] = [];
    const r = (await c.query(
      `SELECT c6, btrim(c2) c2, btrim(c3) c3, btrim(c4::text) c4, btrim(c5::text) c5, btrim(c11) c11, btrim(c43) c43, btrim(c67) c67 FROM _h`)).rows;
    if (r.length !== 1) no.push(`_h tiene ${r.length} filas`);
    const H = r[0] ?? {};
    const llave = `KF${H.c2}${H.c3}${pad2(H.c4)}${pad2(H.c5)}.${this.sucEnsayo}`;
    const cont = (await c.query(`SELECT c4::text c4 FROM md.sqliov WHERE c1=$1 AND c2=0 AND c3=0`, [llave])).rows[0];
    const folio = Number(H.c6);
    if (!cont) no.push(`no hay contador ${llave} en sqliov`);
    else if (Number(cont.c4) !== folio + 1) no.push(`sqliov.c4 (${llave}) = ${cont.c4} ≠ folio+1 (${folio + 1}): el contador no avanzó`);
    if (H.c11 !== 'CREADO') no.push(`c11 = ${H.c11} (≠ CREADO)`);
    if (H.c43 !== 'N') no.push(`c43 = ${H.c43} (≠ N)`);
    if (H.c67 !== 'SUITE') no.push(`c67 = ${H.c67} (≠ SUITE)`);
    this.contadores.push(`KFUD4001 ${llave}: folio ${H.c6}, contador → ${cont?.c4}`);
    this.fallas = no;
    await c.query('ROLLBACK');
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const p = JSON.parse(json) as { sucursal: string };
  const s = p.sucursal;
  process.env[`KEPLER_PUSH_URL_${s}`] = url;
  process.env[`KEPLER_PUSH_MAX_DIA_${s}`] = '999';

  const { Client } = await import('pg');
  const cli = new Client({ connectionString: url, statement_timeout: 20000 });
  await cli.connect();
  // Último pedido TELEMARK en CREADO = plantilla, y sus renglones como cotización (igual que el spec).
  await cli.query('BEGIN READ ONLY');
  // Para probar el CONTADOR sirve cualquier pedido TELEMARK de plantilla (el nuevo nace CREADO
  // igual); el spec exige CREADO porque además reproduce importes, acá sólo revisamos el folio.
  const plantilla = (await cli.query(
    `SELECT btrim(c5::text) c5, c6, btrim(c10) c10, btrim(c12) c12,
            coalesce(nullif(btrim(c19::text),''),'0') c19, btrim(coalesce(c115::text,'')) c115
       FROM md.kdm1 WHERE c1=$1 AND c2='U' AND c3='D' AND btrim(c4::text)='40'
        AND btrim(c27)='TELEMARK' ORDER BY c9 DESC, c6 DESC LIMIT 1`, [s])).rows[0];
  let ren: Array<Record<string, string>> = [];
  if (plantilla) {
    ren = (await cli.query(
      `SELECT btrim(c8) sku, c9::text c9, c12::text c12, c13::text c13, btrim(c51::text) c51, btrim(c55) c55,
              btrim(c58::text) c58, btrim(c66::text) c66, btrim(c11) c11
         FROM md.kdm2 WHERE c1=$1 AND c2='U' AND c3='D' AND btrim(c4::text)='40' AND btrim(c5::text)=$2 AND c6=$3 ORDER BY c7`,
      [s, plantilla.c5, plantilla.c6])).rows;
  }
  await cli.query('ROLLBACK');
  await cli.end();
  if (!plantilla || !ren.length) throw new Error(`servidor ${s}: sin pedido TELEMARK en CREADO — NO MEDIDO`);

  process.env[`KEPLER_TLMK_TEMPLATE_FOLIO_${s}`] = plantilla.c6;
  process.env[`KEPLER_TLMK_TEMPLATE_SERIE_${s}`] = plantilla.c5;
  const num = (v: string) => Number(String(v ?? '').replace(/[^0-9.-]/g, '') || 0);
  const renglones: RenglonCotizacion[] = ren.map((r) => {
    const f = num(r.c58) || 1;
    return {
      sku: r.sku, cantidad: num(r.c51) || num(r.c9) / f,
      presentacion: r.c55 || r.c11, factor: f === 1 ? null : f,
      precio: Math.round(num(r.c12) * f * 100) / 100, lista: num(r.c66) * f, importe: num(r.c13),
    };
  });

  const ad = new AdaptadorEnsayo(s);
  const res = await ad.entregar({
    cotizacion_id: '00000000-0000-0000-0000-000000000000', folio_suite: 'COT-ENSAYO-PGP1224',
    sucursal: s, cliente: plantilla.c10, vendedor: plantilla.c12,
    fecha: new Date().toISOString().slice(0, 10), pct_cliente: num(plantilla.c19),
    direccion_envio: plantilla.c115 || null, renglones, tope_dia: null,
  });
  await ad.onModuleDestroy();
  console.log(JSON.stringify({ plantilla: { folio: plantilla.c6, serie: plantilla.c5, renglones: ren.length }, resultado: res, contadores: ad.contadores, fallas: ad.fallas }, null, 1));

  // Control: después del ROLLBACK no quedó NINGÚN documento del ensayo en Kepler.
  const k2 = new Client({ connectionString: url });
  await k2.connect();
  const n = (await k2.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1=$1 AND btrim(c24) LIKE 'COT-ENSAYO-PGP1224%'`, [s])).rows[0].n;
  await k2.end();
  console.log(`CONTROL: documentos del ensayo en Kepler después del ROLLBACK = ${n}`);
  const rechazo = (res as { estado?: string }).estado === 'rechazado';
  if (n !== 0) process.exitCode = 2;
  else if (ad.fallas.length || rechazo) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR', (e as Error).message); process.exit(1); });
