/* eslint-disable no-console */
/**
 * `[GP.A.2]` **Ensayo de autorizar (o regresar) un pedido TELEMARK contra el Kepler vivo, desde `md`, con ROLLBACK.**
 *
 * Corre el `KeplerAutorizacionPedidoAdapter` REAL —no una copia de su SQL—: lee el pedido con candado, decide, ejecuta
 * el `UPDATE` de `c11` y comprueba que tocó una fila. Sólo el último paso cambia: su `COMMIT` se vuelve `ROLLBACK`. Así
 * se prueban el permiso, la llave y el `rowCount` sin escribir nada. Mismo empaquetado que el ensayo de la nota
 * (`ops/prod/ensayo-nota-kepler`): ver `README.md`.
 *
 * Entrada por stdin, una línea cada una (la conexión nunca va en la línea de comandos):
 *   1. la URL de `kepler_push` del servidor
 *   2. JSON: { sucursal, serie, folio, accion }   (accion: "autorizar" | "regresar")
 */
import * as readline from 'node:readline';
import type { PoolClient } from 'pg';

import { KeplerAutorizacionPedidoAdapter } from '../../../libs/finance/src/lib/customer-ledger/kepler-autorizacion-pedido.adapter';
import { PERMISOS_AUTORIZACION, type AccionAutorizacion } from '../../../libs/finance/src/lib/customer-ledger/autorizacion-kepler';

type Env = Readonly<Record<string, string | undefined>>;

class AdaptadorEnsayo extends KeplerAutorizacionPedidoAdapter {
  public sentencias: string[] = [];
  public deshecho = false;
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  /** La conexión real, con cada sentencia anotada (texto corto y filas tocadas). */
  protected override async conectar(url: string): Promise<PoolClient> {
    const c = await super.conectar(url);
    return new Proxy(c, {
      get: (obj, prop) => {
        if (prop !== 'query') return Reflect.get(obj, prop);
        return async (text: string, params?: unknown[]) => {
          const r = await obj.query(text, params);
          this.sentencias.push(`${text.replace(/\s+/g, ' ').trim().slice(0, 90)} → ${r.rowCount ?? 0}`);
          return r;
        };
      },
    });
  }
  /** El paso que haría permanente la escritura: aquí se deshace. */
  protected override async confirmar(c: PoolClient): Promise<void> {
    this.deshecho = true;
    await c.query('ROLLBACK');
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const lineas: string[] = [];
  for await (const l of rl) lineas.push(l);
  const [url, json] = lineas;
  if (!url || !json) throw new Error('Faltan las dos líneas de entrada (URL y JSON)');
  const p = JSON.parse(json) as { sucursal: string; serie: number; folio: string; accion: AccionAutorizacion };

  const { Client } = await import('pg');
  const leer = async () => {
    const k = new Client({ connectionString: url });
    await k.connect();
    const r = await k.query(
      `SELECT btrim(c11) AS estado, btrim(coalesce(c27,'')) AS canal, btrim(coalesce(c43,'')) AS doc_estado,
              ${PERMISOS_AUTORIZACION.join(', ')} AS permiso_c11
         FROM md.kdm1 WHERE c1 = $1 AND c2 = 'U' AND c3 = 'D' AND c4 = 40 AND c5 = $2 AND btrim(c6) = $3`,
      [p.sucursal, p.serie, p.folio]);
    await k.end();
    return r.rows[0] ?? null;
  };

  const antes = await leer();
  console.log(`ANTES: ${JSON.stringify(antes)}`);

  const ad = new AdaptadorEnsayo({ KEPLER_AUTORIZACION_PEDIDOS: 'encendida', [`KEPLER_PUSH_URL_${p.sucursal}`]: url });
  const r = await ad.escribir(p);
  console.log(JSON.stringify({ resultado: r, deshecho: ad.deshecho, sentencias: ad.sentencias }, null, 1));
  await ad.onModuleDestroy();

  // El control, con su propia conexión: después del ROLLBACK el estatus es el MISMO que antes.
  const despues = await leer();
  const igual = antes?.estado === despues?.estado;
  console.log(`CONTROL: estatus antes = ${antes?.estado} · después = ${despues?.estado} · ${igual ? 'IGUAL (no se escribió nada)' : '⛔ CAMBIÓ'}`);
  if (!igual) process.exit(2);
}

main().catch((err) => { console.error(`ERROR: ${(err as Error).message}`); process.exit(1); });
