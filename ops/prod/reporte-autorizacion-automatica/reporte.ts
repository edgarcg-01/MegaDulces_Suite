/* eslint-disable no-console */
/**
 * `[GP.A.3]` **Reporte para Crédito y cobranza antes de cada empuje que toque la autorización de pedidos.**
 *
 * Pedido de Edgar (2026-11-20): cada vez que se diga «está todo listo, sólo es empujar», va con la lista de los
 * pedidos TELEMARK que la Suite autorizaría SOLA, para avisarle a Crédito y cobranza antes. Cada pedido de esa lista
 * es una notificación que les va a llegar.
 *
 * No copia la bandeja: corre las MISMAS consultas (`leerBandeja`) y la MISMA regla (`armarBandeja` →
 * `decidirAutorizacion`) contra prod, en sólo lectura, por `pgprod.sh` en `md`. Si la bandeja cambia, esto cambia.
 *
 * Saca dos escenarios:
 *   1. **Al empujar**: con el interruptor de prod tal como está (`commercial.kepler_push_switch`, tipo `autorizacion`).
 *   2. **Al encender el interruptor** en todas las sucursales (sin tope), con la frescura real de los datos.
 *
 *   npx tsx --tsconfig tsconfig.base.json ops/prod/reporte-autorizacion-automatica/reporte.ts [--salida <archivo.md>]
 *
 * La salida lleva nombres de clientes: se guarda fuera del repo (el repo es público).
 */
import './sin-servidor';
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import knexFactory, { type Knex } from 'knex';

import { armarBandeja, leerBandeja } from '../../../libs/finance/src/lib/customer-ledger/autorizacion-pedidos.service';
import { CustomerLedgerService } from '../../../libs/finance/src/lib/customer-ledger/customer-ledger.service';
import { PARAMETROS_PROPUESTOS } from '../../../libs/contracts/src/finance/autorizacion-pedido.contract';
import type { BandejaAutorizacion, PedidoPorAutorizar } from '../../../libs/contracts/src/finance/autorizacion-pedido.contract';

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SERVIDOR = 'superoot@192.168.0.222';
const pg = knexFactory({ client: 'pg' });

/** Una consulta contra prod, en sólo lectura; devuelve sus filas. */
function consultarProd(sql: string): Array<Record<string, unknown>> {
  const envuelta = `SET default_transaction_read_only = on;\nSET statement_timeout = '60s';\n`
    // jsonb y no json: json_agg mete un salto de línea entre elementos y la salida dejaría de ser UNA línea.
    + `SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (\n${sql}\n) t;\n`;
  const out = execFileSync('ssh', [SERVIDOR, 'sh ~/ops/prod/pgprod.sh -At'], { input: envuelta, encoding: 'utf8', maxBuffer: 256 << 20 });
  const json = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[')).pop();
  if (!json) throw new Error(`prod no devolvió filas:\n${out.slice(0, 500)}`);
  return JSON.parse(json);
}

/**
 * Lo único que usan las lecturas de la bandeja de una transacción de Knex es `raw(sql, valores)` → `{ rows }`.
 * Aquí cada `raw` se vuelve SQL literal (Knex sin conexión) y va a prod. Los SAVEPOINT de `fuenteCartera` no
 * aplican: cada consulta es su propia sesión.
 */
const trx = {
  raw: async (sql: string, valores: readonly unknown[] = []) => {
    if (/^\s*(SAVEPOINT|RELEASE|ROLLBACK)\b/i.test(sql)) return { rows: [] };
    return { rows: consultarProd(pg.raw(sql, valores as Knex.RawBinding[]).toQuery()) };
  },
} as unknown as Knex.Transaction;

const pesos = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dia = (f: string) => `${Number(f.slice(8, 10))} ${MESES[Number(f.slice(5, 7)) - 1]}`;
const solos = (b: BandejaAutorizacion) => [...b.pendientes, ...b.contado].filter((x) => x.resultado.decision === 'autorizar');
const suma = (xs: PedidoPorAutorizar[]) => xs.reduce((s, x) => s + x.importe, 0);

function lista(xs: PedidoPorAutorizar[]): string[] {
  const out: string[] = [];
  const porSucursal = new Map<string, PedidoPorAutorizar[]>();
  for (const x of xs) porSucursal.set(x.sucursal_nombre, [...(porSucursal.get(x.sucursal_nombre) ?? []), x]);
  for (const [suc, ps] of [...porSucursal].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`**${suc}**`);
    for (const x of ps) {
      const quien = x.es_contado ? 'Venta de contado' : (x.cliente_nombre ?? x.cliente);
      const credito = x.es_contado ? '' : ` · límite ${pesos(x.limite ?? 0)}, debe ${pesos(x.por_cobrar_kepler ?? 0)}`;
      out.push(`- Pedido ${x.folio} · ${quien} · ${pesos(x.importe)} · del ${dia(x.fecha)}${credito}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const salida = process.argv.includes('--salida') ? process.argv[process.argv.indexOf('--salida') + 1] : null;
  const P = PARAMETROS_PROPUESTOS;

  const fuente = await CustomerLedgerService.prototype.fuenteCartera.call(null, trx);
  const freshness = await CustomerLedgerService.prototype.freshness.call(null, trx, fuente);
  const lectura = await leerBandeja(trx, TENANT, fuente.rel, undefined, freshness, P);

  const hoy = armarBandeja(lectura, P);
  const sucursales = [...new Set(lectura.pedidos.map((x) => x.sucursal))];
  const encendido = armarBandeja({ ...lectura, carril: sucursales.map((s) => ({ sucursal: s, encendida: true, tope_dia: 100_000 })) }, P);

  const alEmpujar = solos(hoy);
  const alEncender = solos(encendido);
  // Los que sólo se detienen por la edad de los datos (condición 5): con los datos al día pasarían.
  const porFrescura = encendido.pendientes.concat(encendido.contado).filter((x) =>
    x.resultado.decision !== 'autorizar' && x.resultado.motivos.length > 0 && x.resultado.motivos.every((m) => m.condicion === 5));
  const aCredito = encendido.pendientes.filter((x) => x.resultado.decision !== 'autorizar' && !porFrescura.includes(x));
  const ahora = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' });

  const r: string[] = [];
  r.push(`# Pedidos de telemarketing que la Suite autorizaría sola`);
  r.push('');
  r.push(`Corte: ${ahora} · datos de Kepler con ${freshness.age_human ?? 'edad desconocida'} (${freshness.status}).`);
  r.push('');
  r.push(`## Al empujar: ${alEmpujar.length} pedidos se autorizan solos`);
  r.push('');
  if (hoy.sucursales_encendidas.length === 0) {
    r.push('La autorización automática está apagada en todas las sucursales, así que nada pasa solo.');
  } else {
    r.push(`Encendida en ${hoy.sucursales_encendidas.length} sucursales.`);
    r.push('');
    r.push(...lista(alEmpujar));
  }
  r.push('');
  r.push(`## Al encender la autorización automática: ${alEncender.length} pedidos (${pesos(suma(alEncender))})`);
  r.push('');
  r.push('Cada uno les llegaría como aviso: «se autorizó solo».');
  r.push('');
  r.push(...(alEncender.length ? lista(alEncender) : ['Ninguno.']));
  if (porFrescura.length) {
    r.push('');
    r.push(`Otros ${porFrescura.length} pasarían también, pero hoy se detienen porque los datos de Kepler no están al día.`);
  }
  r.push('');
  r.push(`## Lo que sigue esperando a Crédito y cobranza`);
  r.push('');
  r.push(`- ${aCredito.length} pedidos para decidir (${pesos(suma(aCredito))}), en Finanzas › Cartera › Por autorizar.`);
  r.push(`- ${encendido.aparte.length} van aparte: viejos (más de ${P.pedidoViejoDias} días) o de ruta vecinal. Esos nunca pasan solos.`);
  const texto = r.join('\n');

  console.log(texto);
  if (salida) { writeFileSync(salida, texto + '\n', 'utf8'); console.error(`\n→ ${salida}`); }
  await pg.destroy();
}

main().catch((err) => { console.error(`ERROR: ${(err as Error).message}`); process.exit(1); });
