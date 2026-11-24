/* eslint-disable no-console */
/**
 * [BFU.4.5.1] CANDADO — cada categoría de Bancos tiene un ÁREA DUEÑA o dice por qué no la tiene.
 *
 * El área decide a quién le llega un movimiento sin explicar (anexo BFU, BFU.4.5). Una categoría con el área nula y sin
 * nota sería un «sin dueño» mudo: el movimiento no le llegaría a nadie y nadie sabría por qué. Verifica, contra la base:
 *   (1) las columnas existen (la migración 20261123175931 corrió);
 *   (2) ninguna categoría activa queda MUDA (sin área y sin `owner_note`);
 *   (3) ningún área apunta a un departamento que no existe en el tenant (colgada);
 *   (4) la partición: cada movimiento cae en un área o en «sin área» declarada, y la suma es el total;
 *   (5) en una base LOCAL (la del CI), dentro de una transacción que se deshace: re-correr el `up` no cambia nada, no pisa
 *       un área puesta después a mano, y el `down` se niega a deshacer si alguien la cambió.
 * NEGATIVAS de (2) y (3) con filas sintéticas: un gate sin prueba negativa es una intención.
 *
 *   DATABASE_URL_NEW=... node database/tests/test-newdb-bank-area-duena.js
 */
'use strict';
const { Client } = require('pg');
const { classify } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');
const MIG = require('../migrations-newdb/20261123175931_bfu451_area_duena_por_categoria.js');

const categoriasMudas = (cats) => cats.filter((c) => c.active && !c.owner_department_code && !String(c.owner_note || '').trim());
const areasColgadas = (cats, deps) => cats.filter((c) => c.owner_department_code && !deps.has(`${c.tenant_id}|${c.owner_department_code}`));

(async () => {
  let ok = 0, fail = 0;
  const pass = (m) => { ok++; console.log('  ✔ ' + m); };
  const bad = (m) => { fail++; console.log('  ✖ ' + m); };
  const noMedido = (m) => console.log('  ⚠ NO MEDIDO: ' + m);
  console.log('\n=== [BFU.4.5.1] Cada categoría de Bancos tiene área dueña ===\n');

  // Negativas, sin base: el gate tiene que ver lo que dice ver.
  const T = 't1';
  const deps0 = new Set([`${T}|tesoreria`]);
  if (categoriasMudas([{ active: true, owner_department_code: null, owner_note: null }]).length === 1) pass('negativa: una categoría sin área y sin nota se detecta como muda');
  else bad('negativa: la categoría muda NO se detectó');
  if (categoriasMudas([{ active: true, owner_department_code: null, owner_note: 'Por definir: …' }]).length === 0) pass('control: con la pregunta escrita en la nota no es muda');
  else bad('control: una categoría con nota se tomó por muda');
  if (areasColgadas([{ tenant_id: T, owner_department_code: 'no_existe' }], deps0).length === 1) pass('negativa: un área que no es departamento del tenant se detecta como colgada');
  else bad('negativa: el área colgada NO se detectó');

  const url = process.env.DATABASE_URL_NEW;
  if (!url) { noMedido('sin DATABASE_URL_NEW (la parte contra base real corre en el CI)'); console.log(`\n${ok} ✔ · ${fail} ✖\n`); process.exit(fail ? 1 : 0); }
  const destino = classify(url).kind;
  const c = new Client({ connectionString: url, statement_timeout: 60000 });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  try {
    const cols = await q(`SELECT column_name FROM information_schema.columns
                           WHERE table_schema = 'finance' AND table_name = 'movement_categories'
                             AND column_name IN ('owner_department_code', 'owner_note')`);
    if (cols.length !== 2) { bad(`(1) faltan columnas: hay ${cols.length} de 2 (¿corrió la migración 20261123175931?)`); return; }
    pass('(1) owner_department_code y owner_note existen');

    const cats = await q(`SELECT tenant_id, code, active, owner_department_code, owner_note FROM finance.movement_categories`);
    const deps = new Set((await q(`SELECT tenant_id, code FROM identity.departments WHERE deleted_at IS NULL`)).map((d) => `${d.tenant_id}|${d.code}`));
    if (!cats.length) noMedido('(2)(3) no hay categorías en esta base');
    else {
      const mudas = categoriasMudas(cats);
      if (mudas.length === 0) pass(`(2) ${cats.length} categorías, ninguna muda (${cats.filter((x) => x.owner_department_code).length} con área, el resto con su pregunta)`);
      else bad(`(2) categorías mudas: ${mudas.map((x) => x.code).join(', ')}`);
      const colgadas = areasColgadas(cats, deps);
      if (colgadas.length === 0) pass('(3) toda área es un departamento vivo del tenant');
      else bad(`(3) áreas colgadas: ${colgadas.map((x) => `${x.code}→${x.owner_department_code}`).join(', ')}`);
      if (!deps.size) noMedido('(3) la base no tiene departamentos: el mapa no pudo llenar ninguna área');
    }

    const [tot] = await q(`SELECT count(*)::int n FROM finance.bank_movements WHERE deleted_at IS NULL`);
    if (!tot.n) noMedido('(4) no hay movimientos en esta base');
    else {
      const parts = await q(`
        SELECT COALESCE(mc.owner_department_code, '(sin área)') area,
               count(*)::int n,
               count(*) FILTER (WHERE mc.id IS NOT NULL AND mc.owner_department_code IS NULL
                                  AND COALESCE(btrim(mc.owner_note), '') = '')::int mudos
          FROM finance.bank_movements bm LEFT JOIN finance.movement_categories mc ON mc.id = bm.category_id
         WHERE bm.deleted_at IS NULL GROUP BY 1`);
      const suma = parts.reduce((s, p) => s + p.n, 0);
      const mudos = parts.reduce((s, p) => s + p.mudos, 0);
      if (suma === tot.n) pass(`(4) la suma por área es el total: ${suma} movimientos en ${parts.length} grupos`);
      else bad(`(4) la suma por área (${suma}) no es el total (${tot.n})`);
      if (mudos === 0) pass('(4) ningún movimiento cae en una categoría muda');
      else bad(`(4) ${mudos} movimientos caen en una categoría sin área y sin nota`);
    }

    // Lista blanca, no negra: el up/down en transacción sólo corre contra una base que se reconoce LOCAL (la del CI es
    // localhost). Una base «desconocida» podría ser prod con otro nombre.
    if (destino !== 'local') { noMedido(`(5) la base es «${destino}»: el up/down en transacción sólo corre en una base local`); return; }
    const knex = require('knex')({ client: 'pg', connection: url });
    const snap = (trx) => trx.raw(`SELECT code, owner_department_code, owner_note FROM finance.movement_categories ORDER BY tenant_id, code`).then((r) => JSON.stringify(r.rows));
    const DESHACER = new Error('deshacer');
    try {
      await knex.transaction(async (trx) => {
        const antes = await snap(trx);
        await MIG.up(trx);
        if ((await snap(trx)) === antes) pass('(5) re-correr el up no cambia nada (idempotente)');
        else bad('(5) re-correr el up cambió filas');
        const conArea = cats.find((x) => x.owner_department_code && x.owner_department_code !== 'tesoreria' && deps.has(`${x.tenant_id}|tesoreria`));
        if (!conArea) { noMedido('(5) sin una categoría con área y sin «tesoreria» para cambiarla a mano'); throw DESHACER; }
        await trx.raw(`UPDATE finance.movement_categories SET owner_department_code = 'tesoreria' WHERE tenant_id = ? AND code = ?`, [conArea.tenant_id, conArea.code]);
        await MIG.up(trx);
        const [r] = (await trx.raw(`SELECT owner_department_code FROM finance.movement_categories WHERE tenant_id = ? AND code = ?`, [conArea.tenant_id, conArea.code])).rows;
        if (r.owner_department_code === 'tesoreria') pass(`(5) el up no pisa un área cambiada después (${conArea.code})`);
        else bad(`(5) el up pisó el área cambiada de ${conArea.code}: quedó ${r.owner_department_code}`);
        let nego = false;
        try { await trx.raw('SAVEPOINT bfu451'); await MIG.down(trx); } catch (e) { nego = /no se deshace/.test(e.message); await trx.raw('ROLLBACK TO SAVEPOINT bfu451'); }
        if (nego) pass('(5) el down se niega si alguien cambió un área');
        else bad('(5) el down deshizo un área puesta a mano');
        throw DESHACER;
      });
    } catch (e) { if (e !== DESHACER) throw e; } finally { await knex.destroy(); }
  } finally {
    await c.end();
    console.log(`\n${ok} ✔ · ${fail} ✖\n`);
    process.exitCode = fail ? 1 : 0;
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
