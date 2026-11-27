/* eslint-disable no-console */
/**
 * `[CC.35]` **Ensayo de escribir un cobro CON SU FICHA DE CFDI en el Kepler vivo, y deshacerlo.**
 *
 * Corre **el adaptador de producción** (`KeplerCobroSinkAdapter`), no una copia suya: lo único que cambia es
 * que `cerrar()` hace `ROLLBACK` en vez de `COMMIT`. Así lo que se prueba contra Kepler es el código que
 * después va a correr desde la pantalla.
 *
 * ── Qué contesta ───────────────────────────────────────────────────────────────────────────────────────────
 * Si la quinta tabla (`md.kdfe33m1`) **clona bien**: es lo único que no se puede saber leyendo. Sus 69
 * columnas tienen tipos que no conocemos y la plantilla puede venir timbrada, así que vaciar los campos del
 * PAC puede fallar por tipo. Si falla, falla **aquí**, sin dejar nada.
 *
 * ⛔⛔ **No confirma nunca.** El `ROLLBACK` está en `cerrar()` y en el `finally`.
 * ⛔ Y el control de siempre: después del ROLLBACK, una conexión NUEVA comprueba que no quedó ni una fila.
 *
 * Entrada por stdin, una línea cada una:
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { "sucursal":"06", "cliente":"C3065", "fecha":"2026-11-23",
 *              "facturas":[{ "tipo":8, "serie":1, "folio":"0001446", "monto":15539.63 }] }
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { KeplerCobroSinkAdapter, type EntregaCobro } from '../../../libs/finance/src/lib/customer-ledger/kepler-cobro-sink.adapter';

/** El adaptador de producción, con una sola cosa cambiada: no confirma. */
class EnsayoCobro extends KeplerCobroSinkAdapter {
  private readonly url: string;
  constructor(url: string) { super(); this.url = url; }

  /** La bandera, encendida sólo para el ensayo: lo que se mide es el SQL, no el interruptor. */
  protected override get env(): NodeJS.ProcessEnv {
    return { ...process.env, KEPLER_COBRO_ESCRITURA: 'encendida', KEPLER_PUSH_URL_06: this.url } as NodeJS.ProcessEnv;
  }

  /** ⛔ Incondicional: no hay ningún camino que confirme. */
  protected override async cerrar(c: PoolClient): Promise<void> {
    await c.query('ROLLBACK');
    console.log('— ROLLBACK: nada quedó escrito —');
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const e = JSON.parse(json) as EntregaCobro;
  if (!e.sucursal || !e.cliente || !e.fecha || !e.facturas?.length) {
    throw new Error('El JSON pide sucursal, cliente, fecha y al menos una factura');
  }
  e.referencia = e.referencia || `ENSAYO-${Date.now().toString(36)}`.slice(0, 20);

  const sink = new EnsayoCobro(url);
  const r = await sink.entregar(e);
  console.log(JSON.stringify({ resultado: r }, null, 1));

  // EL CONTROL, con una conexión nueva: después del ROLLBACK no puede quedar NADA.
  const { Client } = await import('pg');
  const k = new Client({ connectionString: url });
  await k.connect();
  try {
    const q = await k.query(
      `SELECT (SELECT count(*) FROM md.kdm1 WHERE c1=$1 AND c2='U' AND c3='A' AND c4=7 AND btrim(c11)=$2) AS kdm1,
              (SELECT count(*) FROM md.kdfe33m1 WHERE c1=$1 AND btrim(c13) = $3) AS ficha`,
      [e.sucursal, e.referencia, r.estado === 'escrito' ? r.kepler.folio : '-']);
    console.log(`CONTROL tras el ROLLBACK: kdm1=${q.rows[0].kdm1} ficha=${q.rows[0].ficha} (los dos deben ser 0)`);
    if (Number(q.rows[0].kdm1) !== 0 || Number(q.rows[0].ficha) !== 0) {
      throw new Error('⛔ QUEDÓ ALGO ESCRITO: el ensayo no deshizo');
    }
  } finally {
    await k.end();
  }
  await sink.onModuleDestroy();
}

main().catch((err) => { console.error(`ERROR: ${(err as Error).message}`); process.exit(1); });
