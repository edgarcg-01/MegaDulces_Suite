#!/usr/bin/env node
'use strict';
/**
 * **¿Dónde deja Kepler la huella de QUIÉN autorizó un gasto, y a qué hora?**
 *
 *   # 1) ANTES de apretar «autorizar» en Kepler:
 *   node database/scripts/huella-autorizacion-gasto.js --suc=01 --folio=0000010 --antes
 *
 *   # 2) Autorizás en Kepler. Esperás a que el CDC lo traiga (segundos).
 *
 *   # 3) DESPUÉS:
 *   node database/scripts/huella-autorizacion-gasto.js --suc=01 --folio=0000010 --despues
 *
 * SÓLO LEE. No escribe en Kepler ni en la plataforma (ADR-040).
 *
 * ## Por qué un antes/después sobre el MISMO documento
 * Ya se midió una vez «qué distingue a un `A` de un `N`» comparando documentos distintos, y
 * la conclusión fue que **sólo cambia `c43`**. Pero esa comparación no puede ver un campo que
 * valga lo mismo en los dos documentos por casualidad, ni distinguir «no cambió» de «nunca se
 * llenó». El antes/después sobre la MISMA fila sí.
 *
 * ## ⭐ Y no mira sólo `kdm1`
 * Si Kepler guardara el rastro, podría hacerlo en otra tabla. El bloque 3 busca el folio en
 * **todas** las tablas del ODS que tengan una columna donde pudiera aparecer, y reporta las
 * que lo tienen DESPUÉS y no ANTES. Mirar sólo `kdm1` daría «no hay huella» sin haber buscado.
 *
 * ## ⚠️ El ODS es una RÉPLICA
 * Lo que se lee acá llega por CDC, no en el instante del clic. Si el `--despues` sale idéntico
 * al `--antes`, puede ser que el cambio **todavía no llegó**: el script lo dice y no concluye
 * «no hay huella» por una ventana de replicación (ADR-056).
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
const SUC = arg('suc', '');
const FOLIO = arg('folio', '');
const ANTES = process.argv.includes('--antes');
const DESPUES = process.argv.includes('--despues');
const SNAP = path.join(require('os').tmpdir(), `huella-${SUC}-${FOLIO}.json`);

if (!SUC || !FOLIO || (!ANTES && !DESPUES)) {
  console.error('\nUso: --suc=01 --folio=0000010 --antes   (y luego --despues)\n');
  process.exit(1);
}

/** La fila completa del documento, sin las columnas vacías (son ~200 y casi todas lo están). */
async function filaDelDoc() {
  const r = await knex('kepler_ods.kdm1')
    .where('sucursal', SUC)
    .whereRaw(`c2 = 'X' AND c3 = 'A' AND btrim(c4::text) = '15' AND btrim(c5::text) = '1'`)
    .whereRaw('btrim(c6) = ?', [FOLIO])
    .first();
  if (!r) return null;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    const s = v == null ? '' : String(v).trim();
    if (s !== '') out[k] = s;
  }
  return out;
}

/** Dónde más aparece este folio en el ODS. Se busca por NOMBRE de columna plausible. */
async function dondeAparece() {
  const cols = (await knex.raw(`
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'kepler_ods'
       and data_type = 'text'
       and column_name in ('c6','c39','c37','c40','c41')
     order by 1,2`)).rows;

  const hits = [];
  for (const c of cols) {
    try {
      const [{ n }] = await knex.raw(
        `select count(*)::int n from kepler_ods.${c.table_name}
          where btrim(${c.column_name}) = ? and btrim(sucursal) = ?`, [FOLIO, SUC]
      ).then((r) => r.rows);
      if (n > 0) hits.push(`${c.table_name}.${c.column_name} (${n})`);
    } catch { /* la tabla no tiene `sucursal`: se salta */ }
  }
  return hits;
}

(async () => {
  console.log(`\nHuella de autorización — sucursal ${SUC}, solicitud XA1501-${FOLIO}\n`);

  const fila = await filaDelDoc();
  if (!fila) {
    console.log('⛔ NO ENCONTRADO. El documento no está en `kepler_ods.kdm1`.');
    console.log('   Puede ser que el CDC todavía no lo haya traído, o que la sucursal/folio');
    console.log('   no sean los correctos. NO concluye que no exista.\n');
    await knex.destroy();
    process.exit(1);
  }

  const donde = await dondeAparece();

  if (ANTES) {
    fs.writeFileSync(SNAP, JSON.stringify({ fila, donde, at: new Date().toISOString() }, null, 1));
    console.log(`estado actual  c43 = ${fila.c43 || '(vacío)'}   (N = sin autorizar)`);
    console.log(`columnas con valor: ${Object.keys(fila).length}`);
    console.log(`aparece además en: ${donde.length ? donde.join(', ') : '(ninguna otra tabla)'}`);
    console.log(`\n📸 foto guardada en ${SNAP}`);
    console.log('   Ahora autorizá en Kepler y corré el mismo comando con --despues\n');
    await knex.destroy();
    return;
  }

  // ── DESPUÉS ────────────────────────────────────────────────────────────────────────
  if (!fs.existsSync(SNAP)) {
    console.log(`⛔ No hay foto previa en ${SNAP}. Hay que correr --antes PRIMERO:`);
    console.log('   sin el antes, un campo lleno no se distingue de uno que ya estaba lleno.\n');
    await knex.destroy();
    process.exit(1);
  }
  const prev = JSON.parse(fs.readFileSync(SNAP, 'utf8'));

  const claves = [...new Set([...Object.keys(prev.fila), ...Object.keys(fila)])].sort();
  const cambios = [];
  for (const k of claves) {
    const a = prev.fila[k] ?? '(vacío)';
    const b = fila[k] ?? '(vacío)';
    if (a !== b) cambios.push({ columna: k, antes: a.slice(0, 40), ahora: b.slice(0, 40) });
  }

  console.log(`foto previa: ${prev.at}`);
  console.log(`\n1) QUÉ CAMBIÓ en kdm1 — ${cambios.length} columna(s)`);
  if (cambios.length) console.table(cambios);
  else {
    console.log('   ⚪ NINGUNA. Dos lecturas posibles, y no son la misma:');
    console.log('      · el cambio todavía no llegó por el CDC (esperá y repetí), o');
    console.log('      · Kepler no escribió nada en kdm1 al autorizar.');
    console.log('   Este script NO elige por vos: volvé a correrlo en un minuto.');
  }

  const nuevas = donde.filter((d) => !prev.donde.includes(d));
  console.log(`\n2) ¿Apareció en alguna tabla NUEVA? — ${nuevas.length}`);
  if (nuevas.length) console.table(nuevas.map((x) => ({ tabla: x })));
  else console.log('   ninguna: el folio no empezó a existir en ningún otro lado.');

  console.log('\n3) ⭐ LO QUE IMPORTA: ¿hay rastro de QUIÉN y CUÁNDO?');
  const usuario = cambios.filter((c) => /61/.test(c.ahora));
  const fechaHoy = new Date().toISOString().slice(0, 10);
  const marcaTiempo = cambios.filter((c) => c.ahora.includes(fechaHoy) || /\d{2}:\d{2}/.test(c.ahora));
  console.log(`   columnas que ahora traen el usuario (61): ${usuario.length ? usuario.map((c) => c.columna).join(', ') : 'NINGUNA'}`);
  console.log(`   columnas que ahora traen fecha/hora de hoy: ${marcaTiempo.length ? marcaTiempo.map((c) => c.columna).join(', ') : 'NINGUNA'}`);
  if (!usuario.length && !marcaTiempo.length && cambios.length) {
    console.log('\n   ⛔ Cambió algo, pero NADA identifica a la persona ni el momento.');
    console.log('      Entonces la huella de "quién autorizó y a qué hora" NO vive en este');
    console.log('      documento: hay que buscarla en la bitácora del propio Kepler (fuera');
    console.log('      del ODS) o aceptar que no se registra.');
  }

  console.log('');
  await knex.destroy();
})().catch(async (e) => { console.error('ERR', e.message); await knex.destroy(); process.exit(1); });
