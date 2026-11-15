/* eslint-disable no-console */
/**
 * `[PGP.122.11]` **Ensayo de «crear la solicitud de gasto» contra el Kepler vivo, desde `md`, sin escribir.**
 *
 * Corre el `KeplerSolicitudGastoSinkAdapter` REAL —marca, tope, acreedor y catálogos del servidor, la
 * plantilla con sus 200 columnas, el candado del contador `sqliov`— y cambia el único paso que escribe
 * (`confirmar`) por la revisión (`revisarEscrituraSolicitud`) + `ROLLBACK`. Lo único que toca el Kepler
 * real es el candado de la fila del contador, milisegundos, y su `UPDATE` deshecho por el ROLLBACK.
 *
 * Entrada por stdin (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { "sucursal": "05", "plantilla": "0000079" }   (opcional: acreedor, concepto, proyecto, departamento;
 *      sin ellos se toman de la última solicitud viva del servidor)
 *
 * Salida: el resultado, las fallas (el verde exige cero), los avisos de la plantilla, los permisos y el
 * CONTROL (nada con la marca del ensayo y el contador como estaba). Código 1 = fallas; 2 = el control falló.
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import {
  KeplerSolicitudGastoSinkAdapter, type EscrituraSolicitudKepler,
} from '../../../libs/finance/src/lib/expense-proofs/solicitud-kepler/kepler-solicitud-gasto-sink.adapter';
import { revisarEscrituraSolicitud } from '../../../libs/finance/src/lib/expense-proofs/solicitud-kepler/kepler-solicitud-gasto-sink.revision';

type Env = Readonly<Record<string, string | undefined>>;
const MARCA = 'SUITE SG-0E0E0E0E';

class AdaptadorEnsayo extends KeplerSolicitudGastoSinkAdapter {
  public revision: Awaited<ReturnType<typeof revisarEscrituraSolicitud>> | null = null;
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient, w: EscrituraSolicitudKepler): Promise<void> {
    this.revision = await revisarEscrituraSolicitud(c, w);
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
  const p = JSON.parse(json) as { sucursal: string; plantilla: string; acreedor?: string; concepto?: string; proyecto?: string; departamento?: string };
  const env: Env = { KEPLER_GASTO_SOLICITUD: 'encendida', [`KEPLER_PUSH_URL_${p.sucursal}`]: url, [`KEPLER_SOLGASTO_TEMPLATE_FOLIO_${p.sucursal}`]: p.plantilla };

  const { Client } = await import('pg');
  const k = new Client({ connectionString: url });
  await k.connect();
  const m = p.acreedor && p.concepto && p.proyecto && p.departamento
    ? { acreedor: p.acreedor, concepto: p.concepto, proyecto: p.proyecto, depto: p.departamento }
    : (await k.query(
      `SELECT btrim(h.c10) acreedor, btrim(l.c12) concepto, btrim(l.c13) proyecto, btrim(l.c16) depto
         FROM md.kdm1 h JOIN md.kdm6 l ON l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
        WHERE h.c1 = $1 AND h.c2 = 'X' AND h.c3 = 'A' AND h.c4 = 15 AND h.c5 = 1 AND h.c43 <> 'C'
          AND btrim(h.c10) LIKE 'G%' AND btrim(h.c10) NOT LIKE 'GB%' AND btrim(h.c10) <> 'GN001'
        ORDER BY h.c6 DESC LIMIT 1`, [p.sucursal])).rows[0];
  if (!m) throw new Error(`No hay una solicitud de gasto viva en ${p.sucursal} de dónde tomar acreedor y catálogos`);
  const llave = `KFXA1501.${p.sucursal}`;
  const contador = async () => (await k.query(`SELECT c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [llave])).rows[0]?.c4 ?? null;
  const conMarca = async () => (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1 = $1 AND btrim(c26) = $2`, [p.sucursal, MARCA])).rows[0].n;
  const antes = { contador: await contador(), marca: await conMarca() };

  const cuando = hoyMx();
  const ad = new AdaptadorEnsayo(env);
  const r = await ad.entregar({
    sucursal: p.sucursal, acreedor: m.acreedor, fechaSolicitud: cuando.fecha, fechaPago: null,
    renglones: [{ concepto: m.concepto, proyecto: m.proyecto, departamento: m.depto, importe: 100 }],
    iva: 16, comprobante: { tipo: 'ticket', folio: 'ENSAYO', fecha: cuando.fecha },
    comentario: 'ENSAYO PGP122 NO SE ESCRIBE', solicita: 'ensayo', formaPago: 'efectivo',
    marca: MARCA, estado: 'A', capturadaEn: cuando, tope_dia: null,
  });
  await ad.onModuleDestroy();
  const despues = { contador: await contador(), marca: await conMarca() };
  await k.end();

  const intacto = antes.contador === despues.contador && despues.marca === 0;
  console.log(JSON.stringify({
    sucursal: p.sucursal, plantilla: p.plantilla, tomado_de: m, resultado: r,
    fallas: ad.revision?.fallas ?? ['la revisión no corrió: el adaptador se detuvo antes (ver resultado)'],
    avisos: ad.revision?.avisos ?? [], revisado: ad.revision?.revisado ?? null,
    control: { antes, despues, intacto },
  }, null, 1));
  if (!intacto) { console.error('⛔ EL CONTROL FALLÓ: avisar a quien administra Kepler'); process.exitCode = 2; return; }
  if (!ad.revision || ad.revision.fallas.length) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR', (e as Error).message); process.exit(1); });
