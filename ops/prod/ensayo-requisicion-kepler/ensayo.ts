/* eslint-disable no-console */
/**
 * `[PGP.122.4]` **Ensayo de la REQUISICIÓN (X-A-30 / OC X-A-35 / traspaso U-D-40) contra el Kepler
 * vivo, desde `md`, con ROLLBACK.** Corre el `KeplerRequisitionSinkAdapter` REAL —no una copia de
 * su SQL— con el único paso que escribe (`confirmar`) cambiado por revisar el FOLIO y el CONTADOR y
 * deshacer. Existe aparte del spec (`kepler-requisition-sink.ensayo.spec.ts`, que revisa las
 * columnas arrastradas de la plantilla) porque `pg_hba.conf` de Kepler sólo acepta `kepler_push`
 * desde `md`, y en `md` no hay node ni el repo: esto se empaqueta en UN archivo y corre en un
 * contenedor que se borra al terminar.
 *
 * Lo que este ensayo prueba, que el spec NO puede en `md`: que el folio sale del CONTADOR de Kepler
 * (`md.sqliov`, con el GRANT nuevo) y que `sqliov.c4` quedó avanzado — el arreglo que reemplaza al
 * viejo `MAX(c6)+1` pelón. La corrección de columnas la sigue cubriendo el spec en el CI/local.
 *
 * Entrada por stdin, una línea cada una (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { sucursal, plantilla_req, plantilla_ped? }
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { KeplerRequisitionSinkAdapter } from '../../../libs/commercial/src/lib/commercial-replenishment/kepler-requisition-sink.adapter';

const pad2 = (v: unknown) => String(v).trim().padStart(2, '0');

class AdaptadorEnsayo extends KeplerRequisitionSinkAdapter {
  public fallas: string[] = [];
  public contadores: string[] = [];
  constructor(private readonly sucEnsayo: string) { super(); }

  /** Revisa el folio y el avance del contador para el documento (y la OC, si la hay); nunca escribe. */
  protected override async confirmar(c: PoolClient, conOrden = false): Promise<void> {
    const no: string[] = [];
    await this.revisarDoc(c, '_h', conOrden ? 'F' : 'N', no);
    if (conOrden) await this.revisarDoc(c, '_oh', 'N', no);
    this.fallas = no;
    await c.query('ROLLBACK');
  }

  private async revisarDoc(c: PoolClient, tabla: '_h' | '_oh', c43esperado: string, no: string[]): Promise<void> {
    const r = (await c.query(
      `SELECT c6, btrim(c2) c2, btrim(c3) c3, btrim(c4::text) c4, btrim(c5::text) c5, btrim(c67) c67, btrim(c43) c43 FROM ${tabla}`)).rows;
    if (r.length !== 1) { no.push(`${tabla} tiene ${r.length} filas`); return; }
    const H = r[0];
    const llave = `KF${H.c2}${H.c3}${pad2(H.c4)}${pad2(H.c5)}.${this.sucEnsayo}`;
    const cont = (await c.query(`SELECT c4::text c4 FROM md.sqliov WHERE c1=$1 AND c2=0 AND c3=0`, [llave])).rows[0];
    const folio = Number(H.c6);
    if (!cont) no.push(`${tabla}: no hay contador ${llave} en sqliov`);
    else if (Number(cont.c4) !== folio + 1) no.push(`${tabla}: sqliov.c4 (${llave}) = ${cont.c4} ≠ folio+1 (${folio + 1}): el contador no avanzó`);
    if (H.c67 !== 'SUITE') no.push(`${tabla}: c67 = ${H.c67} (≠ SUITE)`);
    if (H.c43 !== c43esperado) no.push(`${tabla}: c43 = ${H.c43} (≠ ${c43esperado})`);
    this.contadores.push(`${tabla} ${llave}: folio ${H.c6}, contador → ${cont?.c4}`);
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const p = JSON.parse(json) as { sucursal: string; plantilla_req: string; plantilla_ped?: string };
  const s = p.sucursal;
  // El adaptador lee `process.env` DIRECTO (no un getter): se setea global, como el spec.
  process.env[`KEPLER_PUSH_URL_${s}`] = url;
  process.env[`KEPLER_REQ_TEMPLATE_FOLIO_${s}`] = p.plantilla_req;
  if (p.plantilla_ped) process.env[`KEPLER_PED_TEMPLATE_FOLIO_${s}`] = p.plantilla_ped;
  process.env[`KEPLER_PUSH_MAX_DIA_${s}`] = '999'; // el ensayo no escribe: el tope diario no aplica

  // Proveedor y producto REALES de ese servidor: su última compra (igual que el spec).
  const { Client } = await import('pg');
  const k = new Client({ connectionString: url, statement_timeout: 20000 });
  await k.connect();
  const muestra = (await k.query(
    `SELECT btrim(m.c10) prov, btrim(d.c8) sku, btrim(d.c10) nombre
       FROM md.kdm1 m JOIN md.kdm2 d ON d.c1=m.c1 AND d.c2=m.c2 AND d.c3=m.c3 AND d.c4=m.c4 AND d.c5=m.c5 AND d.c6=m.c6
      WHERE m.c1=$1 AND m.c2='X' AND m.c3='A' AND btrim(m.c4::text) IN ('30','35') AND btrim(m.c11) NOT LIKE 'RQ-%'
      ORDER BY m.c9 DESC LIMIT 1`, [s])).rows[0];
  // Para el traspaso hace falta un SKU con CAJA real (ficha factor > 1); el de la compra puede ser pieza suelta.
  const tras = p.plantilla_ped ? (await k.query(
    `SELECT btrim(c1) sku, btrim(c2) nombre FROM md.kdii
      WHERE NULLIF(regexp_replace(c81::text,'[^0-9.]','','g'),'')::numeric > 1 ORDER BY c1 LIMIT 1`)).rows[0] : null;
  await k.end();
  if (!muestra) throw new Error(`el servidor ${s} no tiene ninguna compra de la que tomar proveedor`);

  const ad = new AdaptadorEnsayo(s);
  const salida: Record<string, unknown> = {};
  const base = { requisition_id: '00000000-0000-0000-0000-000000000000', sucursal: s, fecha: new Date().toISOString().slice(0, 10) };
  const linea = { sku: muestra.sku, nombre: muestra.nombre, cajas: 3, costo_caja: 373.76, importe: 1121.28 };

  // 1. Compra (X-A-30)
  ad.fallas = []; ad.contadores = [];
  const compra = await ad.entregar({ ...base, folio_suite: 'RQ-ENSAYO-PGP1224-C', tipo: 'compra', proveedor_code: muestra.prov, lineas: [linea], total: 1121.28 });
  salida['compra'] = { resultado: compra, contadores: ad.contadores, fallas: ad.fallas };

  // 2. Compra + OC (X-A-30 convertida + X-A-35 ligada)
  ad.fallas = []; ad.contadores = [];
  const oc = await ad.entregar({ ...base, folio_suite: 'RQ-ENSAYO-PGP1224-OC', tipo: 'compra', generar_orden: true, proveedor_code: muestra.prov, lineas: [linea], total: 1121.28 });
  salida['compra_con_oc'] = { resultado: oc, contadores: ad.contadores, fallas: ad.fallas };

  // 3. Traspaso (U-D-40, contador KFUD4001): SKU con caja real; el objetivo es ejercer el contador.
  if (p.plantilla_ped && tras) {
    ad.fallas = []; ad.contadores = [];
    const t = await ad.entregar({ ...base, folio_suite: 'RQ-ENSAYO-PGP1224-T', tipo: 'traspaso', destino_sucursal: s === '01' ? '00' : '01', lineas: [{ sku: tras.sku, nombre: tras.nombre, cajas: 2, costo_caja: 100, importe: 200 }], total: 200 });
    salida['traspaso'] = { resultado: t, contadores: ad.contadores, fallas: ad.fallas };
  } else {
    salida['traspaso'] = p.plantilla_ped ? 'NO MEDIDO (sin SKU con caja en la ficha)' : 'NO MEDIDO (sin plantilla de traspaso)';
  }

  await ad.onModuleDestroy();
  console.log(JSON.stringify(salida, null, 1));

  // Control: después de los ROLLBACK no quedó NINGÚN documento del ensayo en Kepler.
  const k2 = new Client({ connectionString: url });
  await k2.connect();
  const n = (await k2.query(
    `SELECT count(*)::int n FROM md.kdm1 WHERE c1=$1 AND (btrim(c11) LIKE 'RQ-ENSAYO-PGP1224%' OR btrim(c24) LIKE 'RQ-ENSAYO-PGP1224%')`, [s])).rows[0].n;
  await k2.end();
  console.log(`CONTROL: documentos del ensayo en Kepler después del ROLLBACK = ${n}`);
  const fallo = Object.values(salida).some((v) => v && typeof v === 'object' && Array.isArray((v as { fallas?: string[] }).fallas) && (v as { fallas: string[] }).fallas.length);
  const rechazo = Object.values(salida).some((v) => v && typeof v === 'object' && (v as { resultado?: { estado?: string } }).resultado?.estado === 'rechazada');
  if (n !== 0) process.exitCode = 2;
  else if (fallo || rechazo) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR', (e as Error).message); process.exit(1); });
