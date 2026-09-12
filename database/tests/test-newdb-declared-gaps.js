/* eslint-disable no-console */
/**
 * CANDADO — UN HUECO DECLARADO TIENE QUE SEGUIR SIENDO UN HUECO (R.0).
 *
 * Pedido de Edgar (2026-09-11): *"todo lo declarado. lo tenemos que resolver. busquemos patrones en
 * las fallas para poder resolverlo"*.
 *
 * ── El patrón que este archivo existe para romper ────────────────────────────────────────────
 *
 * Se midieron los ~10 huecos de `docs/VERDAD_ABSOLUTA.md` §7 contra prod y **no eran diez
 * problemas**. Los dos más grandes compartían la misma falla, y no es de datos:
 *
 *   · **`U-D-8` "no es arbitrable"** ($16.2M / 90 d) — declarado porque `c62`/`c63` están vacíos
 *     (cierto: 1.15%). Pero **`c58`, el peldaño, está al 99.97%** y hay costo del mismo almacén al
 *     99.54%. Medido hoy: **arbitrable en el 99.87% de 16,994 renglones.**
 *   · **Wincaja "no declara peldaño"** ($84.07M) — `v_unit_truth` ya resuelve **330,504 de
 *     343,015 celdas (96.4%)**, y el fact sigue con `rung_factor` escrito en **0**.
 *
 * Los resolvedores que los cierran se construyeron **para otra cosa**, después de que el hueco se
 * declarara. **Las declaraciones no caducan**: la prosa de un `.md` no puede re-medirse sola.
 *
 * ── Qué asegura ─────────────────────────────────────────────────────────────────────────────
 *
 * Corre el `recheck_sql` de cada fila de `analytics.declared_gaps` y **se pone ROJO cuando la
 * realidad no coincide con la declaración**, en las dos direcciones:
 *
 *   · `abierto` o `irresoluble_con_la_fuente` + el recheck dice que YA NO es hueco  → ROJO
 *     (apareció el resolvedor; hay que ir a cerrarlo, no dejarlo declarado)
 *   · `cerrado` + el recheck dice que SÍ es hueco                                   → ROJO
 *     (volvió; un cierre no es para siempre)
 *
 * ⛔ **El `recheck_sql` vive en una tabla, así que se ejecuta dentro de una transacción
 * `READ ONLY`.** Ése es el freno real — el CHECK por verbos de la migración es defensa en
 * profundidad, no la garantía. El bloque 2 lo prueba en negativo.
 *
 * ⚠️ Este candado NO mide los huecos: mide que **lo declarado siga siendo verdad**. Cada hueco
 * tiene su propio candado para el tamaño.
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
// ⛔ `Number(n || 0)` convierte un campo INEXISTENTE en 0. Paso el 2026-09-11: una consulta
// aliaseaba `sin_testigo_NO_escribir` y Postgres devuelve `sin_testigo_no_escribir` (baja a
// minusculas los identificadores sin comillas); el helper dibujo 1,479 como CERO y por poco
// se decide sobre ese cero. Un campo ausente NO es un cero -- se grita.
const N = (n) => {
  if (n === undefined) throw new Error('N() recibio undefined: nombre de columna mal escrito '
    + '(Postgres devuelve los alias en MINUSCULAS). Un campo ausente no es un cero.');
  return Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
};

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '600s'`);
  const q = async (sql) => (await c.query(sql)).rows;

  console.log('\n=== CANDADO: un hueco declarado tiene que seguir siendo un hueco (R.0) ===\n');

  // ── 1. La tabla y su contrato ─────────────────────────────────────────────────────────────
  console.log('── 1. La tabla y su contrato ──');
  const existe = (await q(`SELECT to_regclass('analytics.declared_gaps') t`))[0].t;
  check('analytics.declared_gaps existe', !!existe);
  if (!existe) {
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(1);
  }
  const gaps = await q(`
    SELECT clave, titulo, monto, unidad, declarado_en::text AS declarado_en, estado,
           resolver_faltante, recheck_sql
      FROM analytics.declared_gaps WHERE tenant_id = '${T}' ORDER BY clave`);
  check('hay huecos sembrados', gaps.length > 0, `${gaps.length}`);
  check('todos traen `recheck_sql` (sin él, un hueco no puede caducar)',
    gaps.every((g) => (g.recheck_sql || '').trim().length > 0));
  check('todos traen `declarado_en` y `resolver_faltante`',
    gaps.every((g) => g.declarado_en && g.resolver_faltante));

  // ── 2. ⛔ El recheck NO puede escribir — y se prueba en negativo ──────────────────────────
  console.log('\n── 2. ⛔ El recheck corre en READ ONLY ──');
  let mordio = false; let msg = '';
  try {
    await c.query('BEGIN');
    await c.query('SET TRANSACTION READ ONLY');
    await c.query(`CREATE TEMP TABLE __probe_ro (x int)`);
  } catch (e) { mordio = true; msg = e.message.slice(0, 60); }
  await c.query('ROLLBACK');
  check('⭐⭐ PRUEBA NEGATIVA: una escritura dentro de la transacción READ ONLY es RECHAZADA',
    mordio, 'la transacción aceptó escribir: el freno es decorativo');
  if (mordio) console.log(`     (Postgres respondió: ${msg})`);

  // ── 3. ⭐⭐ El corazón: la realidad contra la declaración ─────────────────────────────────
  console.log('\n── 3. ⭐⭐ ¿Sigue siendo cierto lo que declaramos? ──');
  const rotos = [];
  for (const g of gaps) {
    let row = null; let err = null;
    try {
      await c.query('BEGIN');
      await c.query('SET TRANSACTION READ ONLY');
      await c.query(`SET LOCAL statement_timeout = '300s'`);
      row = (await c.query(g.recheck_sql)).rows[0];
      await c.query('ROLLBACK');
    } catch (e) { err = e.message; await c.query('ROLLBACK').catch(() => {}); }

    const monto = g.monto ? `${g.unidad === 'MXN/90d' || g.unidad === 'MXN' ? '$' : ''}${N(g.monto)}${g.unidad ? ` ${g.unidad}` : ''}` : '—';
    if (err) {
      check(`el recheck de \`${g.clave}\` corre`, false, err.slice(0, 90));
      continue;
    }
    if (!row || typeof row.sigue_siendo_hueco !== 'boolean') {
      check(`el recheck de \`${g.clave}\` cumple el contrato`, false,
        `devolvió ${JSON.stringify(row)}`);
      continue;
    }
    console.log(`     ${g.clave.padEnd(24)} declarado ${g.declarado_en} · ${monto}`);
    console.log(`       hoy: ${row.detalle}`);

    // El veredicto: ROJO cuando la realidad y la declaración no coinciden, en cualquier dirección.
    const declaradoAbierto = g.estado === 'abierto' || g.estado === 'irresoluble_con_la_fuente';
    if (declaradoAbierto && !row.sigue_siendo_hueco) {
      rotos.push(g.clave);
      check(`⭐ \`${g.clave}\` sigue siendo un hueco`, false,
        `YA NO LO ES — el resolvedor que faltaba ("${g.resolver_faltante}") existe. `
        + `Hay que cerrarlo, no dejarlo declarado`);
    } else if (g.estado === 'cerrado' && row.sigue_siendo_hueco) {
      rotos.push(g.clave);
      check(`\`${g.clave}\` sigue cerrado`, false, 'VOLVIÓ — un cierre no es para siempre');
    } else {
      check(`\`${g.clave}\` coincide con lo declarado (${g.estado})`, true);
    }
  }

  // ── 4. Lo que este candado NO mide ───────────────────────────────────────────────────────
  console.log('\n── 4. Lo que este candado no mide ──');
  console.log('     ⚠️  NO mide el TAMAÑO de cada hueco: mide que lo declarado siga siendo verdad.');
  console.log('        El monto lo vigila el candado propio de cada uno.');
  console.log('     ⚠️  Un hueco SIN fila acá es invisible para este mecanismo. La lista se siembra');
  console.log('        a mano desde VERDAD_ABSOLUTA §7 — si alguien declara un hueco en prosa y no');
  console.log('        lo siembra, vuelve a pasar exactamente lo que esta fase encontró.');
  const irres = gaps.filter((g) => g.estado === 'irresoluble_con_la_fuente');
  if (irres.length) {
    nomedido('los huecos irresolubles con la fuente',
      `${irres.map((g) => g.clave).join(', ')} — necesitan un dato que hoy no existe `
      + `(un corte físico, una decisión humana o tiempo), no una consulta mejor`);
  }

  if (rotos.length) {
    console.log(`\n  ⭐ ${rotos.length} declaración(es) desactualizada(s): ${rotos.join(', ')}`);
    console.log('     Eso es exactamente para lo que existe este candado — no es un falso positivo.');
  }

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
