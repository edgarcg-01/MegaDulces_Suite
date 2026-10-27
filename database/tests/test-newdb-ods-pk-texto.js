#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[OPS-AUD.12]` — La llave que el reconciliador manda a BORRAR lleva el timestamp como TEXTO.
 *
 * Reproduce, contra un Postgres real y con la zona de la ingesta, el viaje que hace una fila de
 * `kdc2YYMM` (fecha `c2` dentro de la PK) desde que se lee del ODS hasta que el `raw-delete` la
 * busca: JSON → COPY a una columna `timestamp` → `DELETE … USING`. Dos copias de la misma póliza
 * a las 00:00 y a las 06:00, como las que existen en el ODS.
 *
 *   · `pkParaEnviar` borra EXACTAMENTE la copia pedida;
 *   · ⛔ NEGATIVA: el camino viejo (`r[k]`, un Date) borra la OTRA copia.
 *
 * Sólo crea una tabla TEMPORAL. No toca nada más.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *     node database/tests/test-newdb-ods-pk-texto.js
 */
process.env.TZ = 'America/Mexico_City'; // la zona de los pods de ingesta
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-ods-pk-texto', { url: URL });
const { Client } = require('pg');
const { pkParaEnviar } = require('../importers/lib/ods-pk');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

(async () => {
  if (!URL) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  console.log('\n=== [OPS-AUD.12] la llave de borrado lleva el timestamp como texto ===\n');
  try {
    // Los tipos REALES: el ODS guarda la fecha como timestamptz ([NORM.3c]) y la sesión que escribe
    // fija hora de México; la temporal del raw-delete toma el tipo del RÉPLICA (timestamp ingenuo).
    await c.query(`SET TIME ZONE 'America/Mexico_City'`);
    await c.query(`CREATE TEMP TABLE kdc2_prueba (sucursal text, c1 text, c2 timestamptz, c3 text, importe numeric)`);
    const sembrar = () => c.query(`TRUNCATE kdc2_prueba; INSERT INTO kdc2_prueba VALUES
      ('00','D','2026-09-20 00:00','25097', 0),
      ('00','D','2026-09-20 06:00','25097', 25755.15)`);
    // Lo que hace el reconciliador: la PK como viene + la fecha como texto en `_t_c2`.
    const leerLa0000 = async () => (await c.query(
      `SELECT sucursal, c1, c2, c3, c2::text AS _t_c2 FROM kdc2_prueba WHERE c2 = '2026-09-20 00:00'`)).rows[0];
    // Lo que hace el raw-delete: JSON → temp con el tipo de la columna → DELETE por la llave.
    const borrar = async (llave) => {
      const viaje = JSON.parse(JSON.stringify(llave));
      const r = await c.query(
        `DELETE FROM kdc2_prueba t USING (SELECT $1::text sucursal, $2::text c1, $3::timestamp c2, $4::text c3) d
          WHERE t.sucursal=d.sucursal AND t.c1=d.c1 AND t.c2=d.c2 AND t.c3=d.c3`,
        [viaje.sucursal, viaje.c1, viaje.c2, viaje.c3]);
      const quedan = (await c.query(`SELECT to_char(c2, 'YYYY-MM-DD HH24:MI:SS') AS c2 FROM kdc2_prueba ORDER BY c2`)).rows.map((x) => x.c2);
      return { borradas: r.rowCount, quedan };
    };
    const PK = ['c1', 'c2', 'c3'];

    await sembrar();
    const nuevo = await borrar(pkParaEnviar(await leerLa0000(), PK, '00'));
    t('pkParaEnviar: borra la copia de las 00:00 y deja la de las 06:00',
      nuevo.borradas === 1 && nuevo.quedan.length === 1 && nuevo.quedan[0] === '2026-09-20 06:00:00', JSON.stringify(nuevo));

    await sembrar();
    const fila = await leerLa0000();
    const viejo = await borrar({ sucursal: '00', c1: fila.c1, c2: fila.c2, c3: fila.c3 }); // el `r[k]` de antes
    t('PRUEBA NEGATIVA: el camino viejo (Date de JS) borra la OTRA copia (06:00)',
      viejo.borradas === 1 && viejo.quedan[0] === '2026-09-20 00:00:00', JSON.stringify(viejo));

    t('sin columna `_t_`, pkParaEnviar manda el valor tal cual (tablas sin fecha en la PK)',
      JSON.stringify(pkParaEnviar({ c1: 'X', c6: 'F1' }, ['c1', 'c6'], '01')) === JSON.stringify({ sucursal: '01', c1: 'X', c6: 'F1' }));
  } catch (e) {
    bad++;
    console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await c.end();
  }
  console.log(`\n${ok} ✔ · ${bad} ✘\n`);
  process.exit(bad ? 1 : 0);
})();
