/**
 * `[DN.8]` Columnas que PROD tiene y que la cadena de migraciones NO crea.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * La base del job `pruebas-db` se arma desde las migraciones (`dev-bootstrap-empty-db.js`), que
 * moldea desde la foto de prod las TABLAS que faltan, pero no las COLUMNAS. Medido el 2026-11-08:
 * prod (`system_identifier` 7688376744939610156) tiene `catalog.products.articulo` — llegó con la
 * importación desde Railway (`database/scripts/local-import-from-railway.sql`) y ninguna migración
 * de `migrations-newdb` la crea. El resolvedor de existencia (`stock-state.ts`, `[MCP.3.16]`) la lee
 * para el gemelo del legado, así que en esa base toda prueba que pase por él aborta con 42703
 * («column … does not exist»): `test-newdb-existencia-vendedor.js` nunca llegó a correr en el CI
 * y `test-newdb-dn-registro-negado.js` se cortaba en su sección [3].
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────
 * Agrega la columna que falte DENTRO de la transacción de la prueba (se revierte con ella), con el
 * tipo de la foto de prod (`docs/esquema-bd-prod-columnas.csv`) — nunca uno supuesto — y DEVUELVE
 * lo que agregó, para que la prueba lo declare en su salida. Sólo columnas que en prod son nulas y
 * sin default: otra cosa cambiaría lo que hacen los caminos que insertan, y eso no se finge.
 *
 * ⛔ No es el arreglo de fondo: ése es una migración que cree la columna en toda base nueva
 *    (deuda con nombre, anotada en la fase DN). Esto sólo deja medir el código contra la forma de prod.
 * ⚠️ El `ALTER TABLE` toma un candado exclusivo sobre la tabla hasta el final de la transacción:
 *    úsese sólo en suites que hacen TODO por esa transacción (`run-all-tests.js` las corre en serie).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CSV = path.join(__dirname, '..', '..', '..', 'docs', 'esquema-bd-prod-columnas.csv');

/** Un renglón de CSV con comillas dobles (un default puede traer comas). */
function campos(linea) {
  const out = [];
  let actual = '';
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (comillas) {
      if (ch === '"' && linea[i + 1] === '"') { actual += '"'; i++; } else if (ch === '"') comillas = false; else actual += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === ',') { out.push(actual); actual = ''; } else actual += ch;
  }
  out.push(actual);
  return out;
}

/** El tipo SQL de la columna según la foto de prod, o un error que dice por qué no se puede agregar. */
function tipoEnProd(esquema, tabla, columna, csv = fs.readFileSync(CSV, 'utf8')) {
  const lineas = csv.split(/\r?\n/);
  const cab = campos(lineas[0]);
  const i = (n) => {
    const k = cab.indexOf(n);
    if (k < 0) throw new Error(`la foto de prod no trae la columna «${n}» en su encabezado`);
    return k;
  };
  const [S, T, C, UDT, NUL, DEF, LEN] = ['schema', 'table', 'column', 'udt', 'nullable', 'column_default', 'maxlen'].map(i);
  for (const l of lineas.slice(1)) {
    if (!l) continue;
    const c = campos(l);
    if (c[S] !== esquema || c[T] !== tabla || c[C] !== columna) continue;
    if (c[NUL] !== 'YES') throw new Error(`${esquema}.${tabla}.${columna} es NOT NULL en prod: no se finge`);
    if (c[DEF]) throw new Error(`${esquema}.${tabla}.${columna} tiene default en prod (${c[DEF]}): no se finge`);
    if (!/^[a-z0-9_]+$/.test(c[UDT])) throw new Error(`tipo inesperado en la foto de prod: «${c[UDT]}»`);
    const largo = c[LEN] && /^\d+$/.test(c[LEN]) && ['varchar', 'bpchar'].includes(c[UDT]) ? `(${c[LEN]})` : '';
    return `${c[UDT]}${largo}`;
  }
  throw new Error(`${esquema}.${tabla}.${columna} no está en la foto de prod (docs/esquema-bd-prod-columnas.csv)`);
}

/**
 * Agrega, dentro de `trx`, las columnas de prod que la base no tenga.
 * @param trx      transacción de knex (la de la prueba; se revierte con ella)
 * @param columnas lista de [esquema, tabla, columna]
 * @returns        lo agregado, p. ej. ['catalog.products.articulo varchar(20)'] (vacío si no faltaba nada)
 */
async function asegurarColumnasDeProd(trx, columnas) {
  const agregadas = [];
  for (const [esquema, tabla, columna] of columnas) {
    const existe = (await trx.raw(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
      [esquema, tabla, columna],
    )).rows.length > 0;
    if (existe) continue;
    const tipo = tipoEnProd(esquema, tabla, columna);
    await trx.raw(`ALTER TABLE ??.?? ADD COLUMN ?? ${tipo}`, [esquema, tabla, columna]);
    agregadas.push(`${esquema}.${tabla}.${columna} ${tipo}`);
  }
  return agregadas;
}

module.exports = { asegurarColumnasDeProd, tipoEnProd, campos };
