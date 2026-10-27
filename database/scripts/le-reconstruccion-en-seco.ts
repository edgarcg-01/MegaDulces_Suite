/* eslint-disable no-console */
/**
 * `[LE.3.4]` — Reconstrucción EN SECO de la bóveda de la máquina con las reglas del libro nuevo,
 * contra sus testigos. SÓLO LECTURA (una conexión, transacción READ ONLY, verifica
 * `system_identifier`). No escribe nada en ninguna base.
 *
 * Usa el código REAL de `libs/finance/src/lib/cashbook` (no una copia), por eso es TypeScript:
 *
 *   npx esbuild database/scripts/le-reconstruccion-en-seco.ts --bundle --platform=node \
 *     --external:pg --outfile=<scratchpad>/le-reconstruccion.js
 *   node -e "require('dotenv').config(); require('<scratchpad>/le-reconstruccion.js')"
 *
 * Lo que mide:
 *  1. Desde la máquina en cero tras el vaciado #1607 (15-oct; el «Fin de Día» #1606 leyó lo mismo
 *     que se vació) hasta el inventario de casetes del 20-oct 10:04 → ¿el libro da el mismo vector?
 *     Medido el 2026-10-27: SÍ, $360,020 en las 5 denominaciones.
 *  2. Desde el primer vaciado (17-jun), cada «Fin de Día» contra el libro, y el residuo por tramo.
 */
// Un script FUERA de los proyectos de Nx que esbuild empaqueta: importa el archivo exacto (no el
// barril de `@megadulces/finance`, que arrastraría Nest entero) para medir con el código REAL.
/* eslint-disable @nx/enforce-module-boundaries */
import { diferenciaContraTestigo, piezasDe, reproducirCaos } from '../../libs/finance/src/lib/cashbook/reconstruccion';
import type { MovimientoCaos } from '../../libs/finance/src/lib/cashbook/identidad';
import type { ClasificacionCaos, Contexto } from '../../libs/finance/src/lib/cashbook/reglas';
/* eslint-enable @nx/enforce-module-boundaries */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg');

const PROD_ID = '7688376744939610156';
const INVENTARIO_20OCT: Record<string, string> = { 500: '507', 200: '383', 100: '252', 50: '46', 20: '121' };
const CTX: Contexto = { actor: { kind: 'servicio', service: 'reconstruccion-en-seco' }, valueAt: '' };
/** Para la bóveda da igual quién estuvo del otro lado del cambio: se usa el cajón. */
const CAMBIO_CON_CAJON = (m: MovimientoCaos): ClasificacionCaos | undefined => (m.type_id === 7 ? { tipo: 'cajon' } : undefined);
const pesos = (p: Record<string, string>): string =>
  `$${Object.entries(p).reduce((s, [k, n]) => s + Number(k) * Number(n), 0).toLocaleString('es-MX')}`;

async function main(): Promise<void> {
  const c = new Client({ connectionString: process.env['PROD_DB_URL'] });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== PROD_ID) throw new Error(`no es pg-prod (${id})`);
    await c.query(`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-00000000d01c', true)`);
    const movs: MovimientoCaos[] = (await c.query(`
      SELECT m.device, m.external_id::text, m.type_id, m.type_label, m.occurred_at, m.total::text, m.ref, m.user_external,
             coalesce(json_agg(json_build_object('denom', d.denom::text, 'pieza_tipo', d.pieza_tipo, 'quantity', d.quantity::text))
                      FILTER (WHERE d.movement_id IS NOT NULL), '[]') AS piezas
        FROM analytics.caos_cash_movements m LEFT JOIN analytics.caos_cash_denominations d ON d.movement_id = m.id
       GROUP BY m.id ORDER BY m.external_id`)).rows;

    // 1 · La apertura propuesta y su testigo.
    const tramo = movs.filter((m) => Number(m.external_id) > 1607 && new Date(m.occurred_at) < new Date('2026-10-20T10:04:00-06:00'));
    const r1 = reproducirCaos(tramo, CTX, CAMBIO_CON_CAJON);
    const libro = piezasDe(r1.libro, 'BOVEDA_CAOS');
    const dif = diferenciaContraTestigo(libro, INVENTARIO_20OCT);
    console.log(`[1] #1608 → 20-oct 10:04 · ${tramo.length} movimientos · sin regla ${r1.sinRegla.length} · negativos ${r1.negativos.length}`);
    console.log(`    libro ${pesos(libro)} ${JSON.stringify(libro)}`);
    console.log(`    testigo ${pesos(INVENTARIO_20OCT)} ${JSON.stringify(INVENTARIO_20OCT)}`);
    console.log(`    ${Object.keys(dif).length ? 'NO CUADRA ' + JSON.stringify(dif) : 'CUADRA en todas las denominaciones'}`);

    // 2 · La historia desde el primer vaciado.
    const primero = movs.find((m) => m.type_id === 5);
    if (!primero) return;
    const r2 = reproducirCaos(movs.filter((m) => Number(m.external_id) > Number(primero.external_id)), CTX, CAMBIO_CON_CAJON);
    console.log(`[2] desde el vaciado #${primero.external_id} · asientos ${r2.asientos.length} · sin regla ${r2.sinRegla.length} · negativos en la bóveda ${r2.negativos.filter((x) => x.detalle.some((d) => d.startsWith('BOVEDA'))).length}`);
    for (const s of r2.sinRegla) console.log(`    sin regla #${s.external_id}: ${s.motivo}`);
    for (const p of r2.puntos) {
      const extra = p.testigo ? ` testigo ${pesos(p.testigo)} → ${p.cuadra ? 'CUADRA' : 'difiere ' + JSON.stringify(diferenciaContraTestigo(p.libro, p.testigo))}` : '';
      console.log(`    #${p.external_id} ${p.fecha.slice(0, 16)} ${p.tipo} libro ${pesos(p.libro)}${extra}`);
    }
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

main().catch((e: Error) => { console.error('✗', e.message); process.exit(1); });
