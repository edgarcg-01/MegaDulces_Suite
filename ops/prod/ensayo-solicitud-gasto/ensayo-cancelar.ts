/* eslint-disable no-console */
/**
 * `[PGP.122.8]` **Ensayo de «Cancela sol gasto» contra el Kepler vivo, desde `md`, sin escribir.**
 *
 * Corre `KeplerSolicitudGastoSinkAdapter.cancelar` REAL —la lectura con candado, la regla (DS40, marca o total), la
 * cabecera en C y el `DELETE` de sus renglones (`kdm6`)— con un cliente que cambia SU `COMMIT` por `ROLLBACK` y
 * anota cada sentencia con las filas que tocó. Así se prueban los permisos (UPDATE de kdm1, SELECT + DELETE de kdm6)
 * y cada `rowCount` sobre una solicitud real, sin cancelarla.
 *
 * Entrada por stdin (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { "sucursal": "05", "folio": "0000088" }   (opcional "marca": la de la Suite; sin ella, capturada en Kepler)
 *
 * Verde: `resultado.estado = 'cancelada'`, `deshecho: true`, la cabecera tocó 1 fila y los renglones tocaron los
 * leídos, y el CONTROL (otra conexión, después): estado, total y renglones exactamente como antes.
 * Código 1 = no llegó a cancelar; 2 = el control falló (avisar a quien administra Kepler).
 */
import * as readline from 'node:readline';
import type { Pool, PoolClient } from 'pg';

import { KeplerSolicitudGastoSinkAdapter } from '../../../libs/finance/src/lib/expense-proofs/solicitud-kepler/kepler-solicitud-gasto-sink.adapter';

type Env = Readonly<Record<string, string | undefined>>;

class AdaptadorEnsayo extends KeplerSolicitudGastoSinkAdapter {
  public sentencias: string[] = [];
  public deshecho = false;
  constructor(private readonly envEnsayo: Env) {
    super();
    // `poolDe` es privado: se envuelve en tiempo de ejecución para que cada cliente cambie su COMMIT por ROLLBACK.
    const self = this as unknown as { poolDe: (url: string) => Pool };
    const original = self.poolDe.bind(this);
    self.poolDe = (url: string) => {
      const pool = original(url);
      return new Proxy(pool, {
        get: (obj, prop) => {
          if (prop !== 'connect') return Reflect.get(obj, prop);
          return async () => this.envolver(await obj.connect());
        },
      });
    };
  }
  protected override get env(): Env { return this.envEnsayo; }
  private envolver(c: PoolClient): PoolClient {
    return new Proxy(c, {
      get: (obj, prop) => {
        if (prop !== 'query') return Reflect.get(obj, prop);
        return async (text: string, params?: unknown[]) => {
          if (/^\s*COMMIT\s*$/i.test(text)) { this.deshecho = true; return obj.query('ROLLBACK'); }
          const r = await obj.query(text, params);
          this.sentencias.push(`${text.replace(/\s+/g, ' ').trim().slice(0, 80)} → ${r.rowCount}`);
          return r;
        };
      },
    });
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const p = JSON.parse(json) as { sucursal: string; folio: string; marca?: string };
  const env: Env = { KEPLER_GASTO_SOLICITUD: 'encendida', [`KEPLER_PUSH_URL_${p.sucursal}`]: url };

  const { Client } = await import('pg');
  const k = new Client({ connectionString: url });
  await k.connect();
  const foto = async () => {
    const h = (await k.query(
      `SELECT btrim(c43) estado, c16::text total, c42::text saldo, btrim(c67) quien, c68::text fecha FROM md.kdm1
        WHERE c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND btrim(c6) = $2`, [p.sucursal, p.folio])).rows[0] ?? null;
    const n = (await k.query(
      `SELECT count(*)::int n FROM md.kdm6 WHERE c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND btrim(c6) = $2`, [p.sucursal, p.folio])).rows[0].n;
    return { ...h, renglones: n };
  };
  const antes = await foto();

  const ad = new AdaptadorEnsayo(env);
  const r = await ad.cancelar({ sucursal: p.sucursal, folio: p.folio, marca: p.marca ?? null, fecha: '2026-01-01', hora: '00:00' });
  await ad.onModuleDestroy();
  const despues = await foto();
  await k.end();

  const intacto = JSON.stringify(antes) === JSON.stringify(despues);
  const original = r.estado === 'cancelada' ? r.original : undefined;
  console.log(JSON.stringify({
    sucursal: p.sucursal, folio: p.folio, resultado: { ...r, original: original ? { ...original, renglones: original.renglones?.length } : undefined },
    deshecho: ad.deshecho, sentencias: ad.sentencias, control: { antes, despues, intacto },
  }, null, 1));
  if (!intacto) { console.error('⛔ EL CONTROL FALLÓ: avisar a quien administra Kepler'); process.exitCode = 2; return; }
  if (r.estado !== 'cancelada' || !ad.deshecho) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR', (e as Error).message); process.exit(1); });
