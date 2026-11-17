'use strict';
/**
 * `[PGP.122]` **Un Kepler de prueba con los tipos de Kepler**, para las pruebas que ESCRIBEN en el ERP.
 *
 * Crea una base desechable con un esquema `md` cuyas tablas salen de `docs/IMPLEMENTACION/KEPLER_ESTRUCTURA.json`
 * (réplicas de prod, 2026-10-16): las 200 columnas de `kdm1` y las 18 de `kdm6` con sus tipos y NOT NULL, el
 * contador `sqliov` y los catálogos que lee el escritor de la solicitud de gasto. Y un rol con EXACTAMENTE los
 * permisos de `ops/prod/kepler-grants/pgp122_solicitud_gasto.sql`.
 *
 * ⚠️ La llave primaria real de `kdm6` no está medida (anexo §11): aquí se supone (c1…c7).
 * ⛔ Crea y borra una base y un rol: quien llama ya pasó por `assertSafeTarget`.
 */
const path = require('path');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const ESTRUCTURA = require(path.join(RAIZ, 'docs', 'IMPLEMENTACION', 'KEPLER_ESTRUCTURA.json'));

const columnas = (t, solo) => ESTRUCTURA.columns.filter((c) => c.table === t && (!solo || solo.includes(c.name))).sort((a, b) => a.pos - b.pos);
const tipo = (c) => c.type === 'character varying' ? (c.max_len ? `varchar(${c.max_len})` : 'varchar')
  : c.type === 'numeric' ? (c.precision != null ? `numeric(${c.precision},${c.scale ?? 0})` : 'numeric') : c.type;
const ddl = (t, solo) => columnas(t, solo).map((c) => `${c.name} ${tipo(c)}${c.nullable ? '' : ' NOT NULL'}`).join(', ');
const vacio = (c) => /char|text/.test(c.type) ? '' : /timestamp|date/.test(c.type) ? '1800-01-01 00:00:00' : /bool/.test(c.type) ? false : 0;

function urlCon(adminUrl, base, usuario, clave) {
  const u = new URL(adminUrl);
  u.pathname = `/${base}`;
  if (usuario) { u.username = usuario; u.password = clave; }
  return u.toString();
}

/** Una fila de `kdm1` como Kepler la deja: todo vacío salvo lo que se le pase. */
async function insertarKdm1(k, valores) {
  const cols = columnas('kdm1');
  const fila = Object.fromEntries(cols.map((c) => [c.name, valores[c.name] ?? vacio(c)]));
  await k.query(`INSERT INTO md.kdm1 (${cols.map((c) => c.name).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => fila[c.name]));
}

/**
 * Arma el Kepler de prueba de UNA sucursal, con la plantilla, una solicitud de una persona y el contador.
 * Devuelve el cliente de administración de esa base, la URL del rol (para `KEPLER_PUSH_URL_NN`) y `cerrar()`.
 */
async function crearKeplerDePrueba(adminUrl, { base, rol, clave, sucursal = '05', plantilla = '0000079', siguiente = '81', proyecto = '2-15-26-02' }) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${rol}`);
  await admin.query(`CREATE DATABASE ${base}`);
  await admin.query(`CREATE ROLE ${rol} LOGIN PASSWORD '${clave}'`);
  const k = new Client({ connectionString: urlCon(adminUrl, base) });
  await k.connect();
  await k.query('CREATE SCHEMA md');
  await k.query(`CREATE TABLE md.kdm1 (${ddl('kdm1')}, CONSTRAINT pk_kdm1 PRIMARY KEY (c1, c2, c3, c4, c5, c6))`);
  await k.query(`CREATE TABLE md.kdm6 (${ddl('kdm6')}, CONSTRAINT pk_kdm6 PRIMARY KEY (c1, c2, c3, c4, c5, c6, c7))`);
  await k.query(`CREATE TABLE md.sqliov (${ddl('sqliov')}, PRIMARY KEY (c1, c2, c3))`);
  await k.query(`CREATE TABLE md.kdxd (${ddl('kdxd', ['c1', 'c2', 'c3', 'c10'])})`);
  await k.query(`CREATE TABLE md.kdco (${ddl('kdco')})`);
  await k.query(`CREATE TABLE md.kdcp (${ddl('kdcp', ['c1', 'c2', 'c3', 'c4', 'c5'])})`);
  await k.query(`CREATE TABLE md.kdc3 (${ddl('kdc3', ['c1', 'c2', 'c3', 'c4', 'c5'])})`);
  await k.query(`INSERT INTO md.kdxd VALUES ($1, 'GA022', 'ACREEDOR DE PRUEBA CON UN NOMBRE MUCHO MAS LARGO QUE SESENTA CARACTERES SA DE CV', 'XAXX010101000')`, [sucursal]);
  await k.query(`INSERT INTO md.kdco VALUES ('240', 'MANTENIMIENTO VEHICULAR.', '602-008'), ('999', 'SIN CUENTA', ''), ('047', 'SUA', '601-015')`);
  await k.query(`INSERT INTO md.kdcp VALUES ($2, 'PRESUPUESTO DE PRUEBA', $1, '', 'A')`, [sucursal, proyecto]);
  await k.query(`INSERT INTO md.kdc3 VALUES ('1-02-32-15', 'DEPTO PRUEBA', '', '', '')`);
  await k.query(`INSERT INTO md.sqliov VALUES ($1, 0, 0, $2), ('CUENTAS', 1, 0, '149z')`, [`KFXA1501.${sucursal}`, siguiente]);
  const comun = { c1: sucursal, c2: 'X', c3: 'A', c4: 15, c5: 1, c7: 'PESOS', c31: 'Sol', c40: 1, c63: 'XA1501-', c10: 'GA022', c30: 'FINANZAS' };
  await insertarKdm1(k, { ...comun, c6: plantilla, c9: '2026-11-01', c16: 100, c18: '2026-11-01', c24: 'PLANTILLA', c32: 'X', c43: 'F', c48: 'JUAN', c67: '01JUAN', c68: '2026-11-01', c69: '10:00', c17: '0' });
  await insertarKdm1(k, { ...comun, c6: String(Number(siguiente) - 1).padStart(7, '0'), c9: '2026-11-12', c16: 50, c42: 50, c18: '2026-11-12', c24: 'HUMANA', c32: 'X', c43: 'N', c48: 'ANA', c67: '01ANA', c68: '2026-11-12', c69: '11:00', c17: '0' });
  // Exactamente lo que pide ops/prod/kepler-grants/pgp122_solicitud_gasto.sql.
  await k.query(`GRANT USAGE ON SCHEMA md TO ${rol}`);
  await k.query(`GRANT SELECT, INSERT ON md.kdm1, md.kdm6 TO ${rol}`);
  await k.query(`GRANT SELECT ON md.sqliov TO ${rol}`);
  await k.query(`GRANT UPDATE (c4) ON md.sqliov TO ${rol}`);
  await k.query(`GRANT SELECT ON md.kdxd, md.kdco, md.kdcp, md.kdc3 TO ${rol}`);
  return {
    k,
    url: urlCon(adminUrl, base, rol, clave),
    async cerrar() {
      await k.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${base} WITH (FORCE)`).catch((e) => console.log(`  ! no se pudo borrar ${base}: ${e.message}`));
      await admin.query(`DROP ROLE IF EXISTS ${rol}`).catch((e) => console.log(`  ! no se pudo borrar ${rol}: ${e.message}`));
      await admin.end();
    },
  };
}

module.exports = { crearKeplerDePrueba, insertarKdm1, columnas, ddl };
