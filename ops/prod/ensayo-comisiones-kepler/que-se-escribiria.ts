/**
 * `[CB.62.4]` — **Qué escribiría la Suite en Kepler con las comisiones de hoy, sin escribir nada.**
 * SÓLO LECTURA (fuerza `default_transaction_read_only` en la conexión).
 *
 *   npx esbuild ops/prod/ensayo-comisiones-kepler/que-se-escribiria.ts --bundle --platform=node \
 *     --tsconfig=tsconfig.base.json --external:pg --external:knex --outfile=<scratchpad>/que.cjs
 *   NODE_PATH=node_modules DATABASE_URL=<url de sólo lectura> node <scratchpad>/que.cjs [dias]
 *
 * Corre la MISMA consulta del servicio (`leerPropuesta`) y el MISMO traductor del escritor
 * (`entregasDelDia`): lo que imprime es lo que se le entregaría a cada uno de los tres escritores de PGP,
 * no una copia que puede desviarse.
 *
 * ⛔ Lo que NO hace, a propósito: no mira los diales (la bandera, el interruptor por sucursal, la fecha de D3
 * de la cuenta). Esto contesta «¿qué hay para escribir?», no «¿se va a escribir?». El escritor sí los mira.
 */
import knexFactory from 'knex';

import { entregasDelDia } from '../../../libs/finance/src/lib/bank/comisiones-kepler/comisiones-kepler.escritor';
import { leerPropuesta } from '../../../libs/finance/src/lib/bank/comisiones-kepler/comisiones-kepler.query';

const TENANT = '00000000-0000-0000-0000-00000000d01c';

async function main(): Promise<void> {
  const db = knexFactory({
    client: 'pg',
    connection: process.env['DATABASE_URL'],
    pool: { min: 1, max: 1, afterCreate: (c: { query: (s: string, cb: (e: unknown) => void) => void }, done: (e: unknown, c: unknown) => void) => c.query('SET default_transaction_read_only = on', (e: unknown) => done(e, c)) },
  });
  const ventana = Math.min(Math.max(1, Number(process.argv[2]) || 14), 45);
  const hasta = new Date().toISOString().slice(0, 10);
  const desde = new Date(Date.now() - ventana * 86_400_000).toISOString().slice(0, 10);

  const p = await leerPropuesta(db, TENANT, desde, hasta);
  console.log(`[CB.62.4] ventana ${desde} → ${hasta}`);
  if (!p.medido) { console.log(`NO MEDIDO: ${p.motivo}`); await db.destroy(); return; }
  console.log(`resumen: ${JSON.stringify(p.resumen)}`);

  const listos = p.dias.filter((d) => d.estado === 'lista');
  console.log(`\nDías listos: ${listos.length}\n`);
  const capturadaEn = { fecha: hasta, hora: '00:00' };
  let total = 0;
  let documentos = 0;

  for (const d of listos) {
    if (!d.plantilla) { console.log(`-- sucursal ${d.sucursal} venta ${d.dia_venta}: sin plantilla, no se escribiria
`); continue; }
    const r = entregasDelDia(d, d.plantilla, capturadaEn);
    console.log(`── sucursal ${d.sucursal} · ${d.banco} · venta ${d.dia_venta} · acreedor ${d.acreedor}`);
    if (!r.ok) { console.log(`   ⛔ NO se escribiría: ${r.motivos.join(' · ')}\n`); continue; }
    const e = r.entregas;
    total += e.total;
    documentos += 2 + e.pagos.length;
    console.log(`   1 · X-A-15 marca ${e.solicitud.marca} · ${e.solicitud.renglones.length} renglón(es) 611-003 · IVA $${e.iva.toFixed(2)} · total $${e.total.toFixed(2)}`);
    console.log(`       «${e.solicitud.comentario}» · nace en ${e.solicitud.estado}`);
    for (const x of e.solicitud.renglones) console.log(`       concepto ${x.concepto} · proyecto ${x.proyecto} · depto ${x.departamento} · $${Number(x.importe).toFixed(2)}`);
    console.log(`   2 · X-A-10 fecha ${e.gasto.fecha} · esperado $${e.gasto.esperado.total.toFixed(2)} a ${e.gasto.esperado.acreedor}`);
    console.log(`   3 · ${e.pagos.length} pago(s) X-D-26:`);
    for (const x of e.pagos) console.log(`       ${x.referencia.padEnd(10)} $${x.importe.toFixed(2)} · cuenta ${x.cuenta} (${x.banco}) · ${x.fecha} · cargo ${x.cargoId}`);
    console.log('');
  }
  console.log(`TOTAL: ${documentos} documentos en Kepler por $${total.toFixed(2)}`);
  console.log('⚠️ Esto NO mira los diales: dice qué hay para escribir, no si se va a escribir.');
  await db.destroy();
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
