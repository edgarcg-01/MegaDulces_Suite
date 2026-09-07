/* eslint-disable no-console */
/**
 * `[WR.7][WR.8]` CANDADO — la réplica cruda de Wincaja es un ESPEJO: mismas tablas, mismas
 * columnas, mismas filas. Ninguna diferencia.
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────────────────────
 * Un espejo que pierde filas en silencio es peor que no tenerlo: se consulta con la misma
 * confianza. Se midió el 2026-09-07 y perdía por DOS mecanismos distintos, ninguno visible:
 *
 *   1. **Watermark ciego** (carril vivo). `Cortes` y `Retiros` se leían `WHERE Folio > marca`, pero
 *      su PK es `(Folio, Caja)` y **el folio reinicia por caja**. Cuando la caja más alta fijó la
 *      marca, las demás quedaron por debajo para siempre: 5 de 6 cajas en la 30, 2,939 de 4,193
 *      retiros. No era atraso — esas filas no se iban a leer nunca más. Son cortes de caja y
 *      retiros de efectivo.
 *   2. **Colapso de duplicados** (carril histórico). Identidad `(_dataset, _row_hash)` +
 *      `ON CONFLICT DO NOTHING` sobre una partición recién borrada: los únicos choques posibles
 *      eran contra el propio archivo, así que dos filas byte-idénticas entraban como una.
 *      19,321 filas de 146,289,530 — DetallesMovAlmacen 18,433 · DetalleCotizaciones 882 ·
 *      MovimientoClientes 4 · OrdenesCompra 2. Dos renglones iguales de un ticket son dos veces la
 *      cantidad; el espejo crudo no está para discutirle a la fuente.
 *
 * Los dos estaban DECLARADOS como efecto lateral aceptable en los comentarios del código. Este test
 * existe porque "aceptable" dejó de serlo, y porque lo que no se mide vuelve.
 *
 * ── Los bloques ────────────────────────────────────────────────────────────────────────────
 *   1. Ninguna carga escribió menos filas de las que leyó (el ledger es el testigo).
 *   2. Ninguna carga quedó en estado distinto de `ok`.
 *   3. INVARIANTE del watermark: toda tabla incremental tiene su columna de marca == su PK
 *      completa, o está declarada en `WM_SIN_PK` con el motivo. Con PRUEBA NEGATIVA.
 *   4. Paridad de TABLAS y COLUMNAS entre los schemas del mismo origen.
 *   5. Las particiones ya migradas llevan la identidad con `_ocurrencia`.
 *
 * Read-only. Apunta a la réplica LOCAL (`:5433/wincaja`), nunca a prod — no hay nada de esto en
 * Railway. Si no la alcanza, declara NO MEDIDO (exit 2), no verde.
 *
 *   WINCAJA_REPLICA_URL=… node database/tests/test-wincaja-replica-fidelidad.js
 */
'use strict';
const path = require('path');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const CFG = path.resolve(__dirname, '..', 'importers', 'wincaja', 'wincaja-replica-config.js');
const { INCREMENTAL, WM_SIN_PK, REPLICA_URL } = require(CFG);
const URL = process.env.WINCAJA_REPLICA_URL || REPLICA_URL;

let ok = 0; let fail = 0; let skip = 0;
const chk = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };
const nomedido = (msg) => { skip++; console.log(`  ◻ NO MEDIDO — ${msg}`); };
const num = (v) => Number(v || 0);
const miles = (n) => Number(n).toLocaleString('es-MX');

/**
 * El PREDICADO del invariante del watermark, aislado para poder romperlo a propósito.
 * Devuelve null si la tabla puede ir por el carril incremental, o el motivo del rechazo.
 */
function porQueNoEsIncrementable(table, wmCol, pk) {
  const claves = (pk || []).filter(Boolean);
  if (claves.length > 1) {
    return `la PK es (${claves.join(', ')}): el watermark escalar sobre '${wmCol}' deja ciegos `
      + `a los demás valores de ${claves.filter((k) => k.toLowerCase() !== wmCol.toLowerCase()).join('/')}`;
  }
  if (claves.length === 1 && claves[0].toLowerCase() !== wmCol.toLowerCase()) {
    return `la PK es (${claves[0]}) y el watermark es '${wmCol}'`;
  }
  if (claves.length === 0 && !WM_SIN_PK[table]) {
    return 'sin PK y sin motivo declarado en WM_SIN_PK: no se puede probar que la columna sea monótona global';
  }
  return null;
}

(async () => {
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 15000, statement_timeout: 300000 });
  try {
    await c.connect();
  } catch (e) {
    if (esFaltaDeAcceso(e)) {
      return noMedido(`la réplica local (:5433/wincaja) no responde (${e.code || e.message}) — `
        + 'este espejo vive on-prem, no en Railway');
    }
    throw e;
  }

  const hayLedger = await c.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='ods' AND table_name='wincaja_hist_load'");

  console.log('\n[1] Ninguna carga escribió menos filas de las que leyó');
  if (!hayLedger.rowCount) {
    nomedido('no existe ods.wincaja_hist_load — el carril histórico no corrió en este destino');
  } else {
    const { rows } = await c.query(`
      SELECT count(*)::int cargas,
             count(*) FILTER (WHERE rows_written < rows_read)::int con_perdida,
             coalesce(sum(rows_read - rows_written) FILTER (WHERE rows_written < rows_read), 0)::bigint filas,
             coalesce(sum(rows_read), 0)::bigint leidas
        FROM ods.wincaja_hist_load`);
    const r = rows[0];
    // Guarda anti-no-op: un ledger vacío hace que "cero pérdidas" sea cierto y no pruebe nada.
    chk(num(r.cargas) > 1000, `el ledger tiene ${miles(r.cargas)} cargas para revisar (se esperan >1000)`);
    if (num(r.con_perdida) === 0) {
      chk(true, `las ${miles(r.cargas)} cargas escribieron TODO lo que leyeron (${miles(r.leidas)} filas)`);
    } else {
      const { rows: det } = await c.query(`
        SELECT table_name, count(*)::int cargas, sum(rows_read - rows_written)::bigint filas
          FROM ods.wincaja_hist_load WHERE rows_written < rows_read
         GROUP BY 1 ORDER BY 3 DESC LIMIT 6`);
      chk(false, `${r.con_perdida} cargas perdieron ${miles(r.filas)} filas — `
        + det.map((d) => `${d.table_name}:${miles(d.filas)}`).join(' · ')
        + '. Recargá esas particiones con --force (la identidad ya lleva _ocurrencia)');
    }

    console.log('\n[2] Ninguna carga quedó en estado distinto de ok');
    const { rows: est } = await c.query(
      "SELECT status, count(*)::int n FROM ods.wincaja_hist_load WHERE status <> 'ok' GROUP BY 1");
    chk(est.length === 0, est.length === 0 ? 'todas las cargas en ok'
      : `hay cargas sin cerrar: ${est.map((x) => `${x.status}=${x.n}`).join(', ')}`);
  }

  console.log('\n[3] INVARIANTE del watermark — la columna de marca es toda la identidad');
  const { rows: pks } = await c.query(`
    SELECT n.nspname s, k.relname t, pg_get_constraintdef(con.oid) def
      FROM pg_constraint con
      JOIN pg_class k ON k.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = k.relnamespace
     WHERE con.contype = 'p' AND n.nspname ~ '^w[0-9]+$' AND k.relname = ANY($1)`,
  [Object.keys(INCREMENTAL)]);
  const pkDe = new Map();
  for (const r of pks) {
    const m = r.def.match(/\(([^)]+)\)/);
    if (m) pkDe.set(r.t, m[1].split(',').map((x) => x.trim().replace(/"/g, '')));
  }
  const { rows: existenW } = await c.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname ~ '^w[0-9]+$'");
  const nW = existenW.length ? num(existenW[0].n) : 0;
  if (!nW) {
    nomedido('no hay schemas del carril vivo (w##) en este destino');
  } else {
    chk(true, `${nW} schemas del carril vivo presentes`);
    for (const [table, wmCol] of Object.entries(INCREMENTAL)) {
      const pk = pkDe.get(table) || [];
      const motivo = porQueNoEsIncrementable(table, wmCol, pk);
      chk(motivo === null,
        motivo === null
          ? `${table}: watermark '${wmCol}' ${pk.length ? `== PK (${pk.join(', ')})` : `sin PK, declarado en WM_SIN_PK`}`
          : `${table}: NO puede ser incremental — ${motivo}`);
    }
    // Y ninguna tabla expulsada del carril puede tener marca viva: si vuelve, arranca ciega.
    const { rows: hu } = await c.query(
      'SELECT schema_name, table_name FROM ods.wincaja_watermark WHERE NOT (table_name = ANY($1))',
      [Object.keys(INCREMENTAL)]).catch(() => ({ rows: null }));
    if (hu === null) nomedido('no existe ods.wincaja_watermark');
    else {
      chk(hu.length === 0, hu.length === 0
        ? 'ninguna marca de agua huérfana (toda marca corresponde a una tabla incremental declarada)'
        : `marcas huérfanas: ${hu.map((x) => `${x.schema_name}.${x.table_name}`).join(', ')} — `
          + 'borralas: si esa tabla vuelve al carril, arranca desde el máximo y nace ciega');
    }
  }

  console.log('\n[3b] PRUEBA NEGATIVA — el predicado rechaza lo que tiene que rechazar');
  chk(porQueNoEsIncrementable('Cortes', 'Folio', ['Folio', 'caja']) !== null,
    'una PK de dos ejes con watermark en uno de ellos es RECHAZADA (el caso real de Cortes)');
  chk(porQueNoEsIncrementable('X', 'Consecutivo', ['Consecutivo']) === null,
    'una PK de un eje igual al watermark es ACEPTADA');
  chk(porQueNoEsIncrementable('SinDeclarar', 'Consecutivo', []) !== null,
    'una tabla sin PK y sin motivo declarado es RECHAZADA');
  chk(porQueNoEsIncrementable('PagosDia', 'Consecutivo', []) === null,
    'una tabla sin PK CON motivo declarado en WM_SIN_PK es ACEPTADA');

  console.log('\n[4] Paridad de tablas y columnas entre schemas del mismo origen');
  const { rows: tabs } = await c.query(`
    SELECT n.nspname s, k.relname t
      FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
     WHERE k.relkind = 'r' AND n.nspname ~ '^[wh][0-9_a-z]+$'`);
  if (tabs.length < 100) {
    nomedido(`sólo ${tabs.length} tablas espejo en este destino — no hay con qué comparar`);
  } else {
    const porSchema = new Map();
    tabs.forEach((r) => { if (!porSchema.has(r.s)) porSchema.set(r.s, new Set()); porSchema.get(r.s).add(r.t); });
    // Universo = las tablas presentes en la MAYORÍA de los schemas. `Errores de pegado` es una
    // tabla que Access genera al fallar un pegado y sólo existe en 4 de los 33 archivos: no es
    // una tabla que falte, es una que el origen sólo tiene ahí. Se excluye por medición, no a mano.
    const cuenta = new Map();
    for (const [, set] of porSchema) for (const t of set) cuenta.set(t, (cuenta.get(t) || 0) + 1);
    const universo = [...cuenta.entries()].filter(([, n]) => n > porSchema.size / 2).map(([t]) => t);
    chk(universo.length > 50, `el universo común son ${universo.length} tablas en ${porSchema.size} schemas`);
    const incompletos = [...porSchema.entries()]
      .map(([s, set]) => ({ s, falta: universo.filter((t) => !set.has(t)) }))
      .filter((x) => x.falta.length);
    chk(incompletos.length === 0, incompletos.length === 0
      ? 'todos los schemas tienen las tablas del universo común'
      : `schemas incompletos: ${incompletos.map((x) => `${x.s} (falta ${x.falta.join(', ')})`).join(' · ')}`);

    const { rows: cols } = await c.query(`
      SELECT n.nspname s, k.relname t, a.attname col
        FROM pg_attribute a
        JOIN pg_class k ON k.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = k.relnamespace
       WHERE k.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         AND n.nspname ~ '^[wh][0-9_a-z]+$'
         AND a.attname NOT IN ('_row_hash', '_synced_at', '_dataset', '_ocurrencia')
         AND k.relname = ANY($1)`, [universo]);
    const key = new Map();
    cols.forEach((r) => {
      if (!key.has(r.t)) key.set(r.t, new Map());
      if (!key.get(r.t).has(r.s)) key.get(r.t).set(r.s, new Set());
      key.get(r.t).get(r.s).add(r.col);
    });
    const dif = [];
    for (const [t, porS] of key) {
      const union = new Set();
      for (const [, set] of porS) for (const x of set) union.add(x);
      for (const [s, set] of porS) {
        const falta = [...union].filter((x) => !set.has(x));
        if (falta.length) dif.push(`${s}.${t} le falta [${falta.slice(0, 6).join(', ')}]`);
      }
    }
    chk(dif.length === 0, dif.length === 0
      ? `las ${universo.length} tablas del universo tienen el MISMO set de columnas en todos los schemas`
      : `columnas dispares: ${dif.slice(0, 8).join(' · ')}`);
  }

  console.log('\n[5] Identidad con `_ocurrencia` donde el carril histórico ya recargó');
  const { rows: idn } = await c.query(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE pg_get_constraintdef(con.oid) LIKE '%_ocurrencia%')::int migradas
      FROM pg_constraint con
      JOIN pg_class k ON k.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = k.relnamespace
     WHERE con.contype = 'u' AND n.nspname ~ '^h[0-9_a-z]+$'
       AND pg_get_constraintdef(con.oid) LIKE '%_row_hash%'`);
  const t5 = idn[0];
  if (!num(t5.total)) nomedido('no hay tablas con identidad surrogate en este destino');
  else {
    console.log(`  · ${miles(t5.migradas)} de ${miles(t5.total)} identidades surrogate ya llevan _ocurrencia`);
    // No se exige el 100%: la migración es por tabla y se paga al recargar (reconstruir el índice
    // único no es gratis). Lo que SÍ se exige es que donde quedó pendiente no haya pérdida — y eso
    // lo cubre el bloque 1, que es la pregunta de verdad. Acá sólo se prueba que el mecanismo vive.
    chk(num(t5.migradas) > 0, 'el mecanismo está aplicado en al menos una tabla (si fuera 0, el arreglo no llegó a la DB)');
  }

  await c.end();
  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
  if (fail) process.exit(1);
  if (ok === 0) return noMedido('no se pudo comprobar nada');
  return undefined;
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
