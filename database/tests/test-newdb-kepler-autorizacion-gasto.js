/* eslint-disable no-console */
/**
 * `[PGP.79]` — El adaptador que AUTORIZA en Kepler la solicitud de un vale firmado
 * (`KeplerAutorizacionGastoAdapter`, `kdm1.c43: N → A`), ejercido contra un Postgres REAL.
 *
 * Carga el `.ts` real vía ts-node. Arma una base de prueba con un `md.kdm1` de los MISMOS tipos y
 * la MISMA llave primaria que Kepler (`pk_kdm1 (c1…c6)`, `c4/c5 numeric(2,0)`) y un rol con
 * exactamente el permiso que tiene `kepler_push` en producción desde el 2026-11-06:
 * `SELECT` + `UPDATE (c43)`. Así se prueba lo que un doble no ve: los tipos del WHERE, que el
 * UPDATE no pida otra columna, la idempotencia y que un error de Kepler no lance.
 *
 * Casos: N → escrito (y otra columna intacta) · reintento → ya_estaba A · F → ya_estaba ·
 * C → no_escrito sin tocar · inexistente → no_escrito · la misma solicitud de OTRA sucursal no se
 * toca · apagado → no se conecta · ⛔ NEGATIVA: sin el GRANT, no_escrito con el motivo y sin lanzar.
 *
 * ⛔ Crea y BORRA una base y un rol: sólo contra un destino seguro (`assertSafeTarget`). En CI es
 * el Postgres del job `pruebas-db`.
 *
 *   node database/tests/test-newdb-kepler-autorizacion-gasto.js
 */
'use strict';

require('reflect-metadata');
const path = require('path');
const { Client } = require('pg');

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
    experimentalDecorators: true, emitDecoratorMetadata: true,
    baseUrl: path.resolve(__dirname, '..', '..'),
    paths: { '@megadulces/platform-core': ['libs/platform-core/src/lib/kepler/kepler-servidor.ts'] },
  },
});
require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, '..', '..'),
  paths: { '@megadulces/platform-core': ['libs/platform-core/src/lib/kepler/kepler-servidor.ts'] },
});

const { assertSafeTarget } = require('./_lib/assert-safe-target');
const ADMIN_URL = process.env.DATABASE_URL_NEW;
assertSafeTarget('test-newdb-kepler-autorizacion-gasto', { url: ADMIN_URL });

const LIB = path.resolve(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'expense-proofs', 'autorizacion-kepler');
const { KeplerAutorizacionGastoAdapter } = require(path.join(LIB, 'kepler-autorizacion-gasto.adapter.ts'));

const BASE = 'kepler_prueba_pgp79';
const ROL = 'kepler_push_pgp79';
const CLAVE = 'pgp79_prueba';

let ok = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); }
};

function urlCon(base, usuario, clave) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${base}`;
  if (usuario) { u.username = usuario; u.password = clave; }
  return u.toString();
}

class Adaptador extends KeplerAutorizacionGastoAdapter {
  constructor(env) { super(); this._env = env; }
  get env() { return this._env; }
}

async function main() {
  console.log('[PGP.79] autorizar en Kepler la solicitud del vale firmado (kdm1.c43 N→A)');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${BASE}`);
  await admin.query(`DROP ROLE IF EXISTS ${ROL}`);
  await admin.query(`CREATE DATABASE ${BASE}`);
  await admin.query(`CREATE ROLE ${ROL} LOGIN PASSWORD '${CLAVE}'`);

  const k = new Client({ connectionString: urlCon(BASE) });
  await k.connect();
  try {
    await k.query(`CREATE SCHEMA md`);
    await k.query(`CREATE TABLE md.kdm1 (
      c1 varchar(7) NOT NULL, c2 varchar(1) NOT NULL, c3 varchar(1) NOT NULL,
      c4 numeric(2,0) NOT NULL, c5 numeric(2,0) NOT NULL, c6 varchar(7) NOT NULL,
      c16 numeric(16,2) NOT NULL, c43 varchar(1) NOT NULL,
      CONSTRAINT pk_kdm1 PRIMARY KEY (c1, c2, c3, c4, c5, c6))`);
    await k.query(`INSERT INTO md.kdm1 VALUES
      ('00','X','A',15,1,'0010721',2666.83,'N'),
      ('00','X','A',15,1,'0010705',1858.52,'F'),
      ('00','X','A',15,1,'0010600',100.00,'C'),
      ('01','X','A',15,1,'0010721',50.00,'N'),
      ('00','X','A',10,1,'0010721',2666.83,'N')`);
    // Exactamente el permiso de kepler_push en producción (2026-11-06).
    await k.query(`GRANT USAGE ON SCHEMA md TO ${ROL}`);
    await k.query(`GRANT SELECT ON md.kdm1 TO ${ROL}`);
    await k.query(`GRANT UPDATE (c43) ON md.kdm1 TO ${ROL}`);

    const env = { KEPLER_GASTO_AUTORIZACION: 'encendida', KEPLER_PUSH_URL_00: urlCon(BASE, ROL, CLAVE) };
    const ad = new Adaptador(env);
    const c43 = async (c1, c4, c6) => (await k.query(`SELECT c43, c16::text c16 FROM md.kdm1 WHERE c1=$1 AND c2='X' AND c3='A' AND c4=$2 AND c5=1 AND c6=$3`, [c1, c4, c6])).rows[0];

    let r = await ad.autorizar({ sucursal: '00', folio_solicitud: '0010721' });
    let f = await c43('00', 15, '0010721');
    check(r.estado === 'escrito', `N → escrito (${JSON.stringify(r)})`);
    check(f.c43 === 'A' && f.c16 === '2666.83', `la solicitud quedó en A y su importe intacto (${f.c43}, ${f.c16})`);
    check((await c43('01', 15, '0010721')).c43 === 'N', 'la misma solicitud en OTRA sucursal no se toca');
    check((await c43('00', 10, '0010721')).c43 === 'N', 'el GASTO X-A-10 con el mismo folio no se toca');

    r = await ad.autorizar({ sucursal: '00', folio_solicitud: '0010721' });
    check(r.estado === 'ya_estaba' && r.kepler === 'A', `reintentar no escribe otra vez: ya_estaba A (${JSON.stringify(r)})`);

    r = await ad.autorizar({ sucursal: '00', folio_solicitud: '0010705' });
    check(r.estado === 'ya_estaba' && r.kepler === 'F', `aplicada (F): ya_estaba F, sin tocar (${JSON.stringify(r)})`);
    check((await c43('00', 15, '0010705')).c43 === 'F', 'la F sigue en F');

    r = await ad.autorizar({ sucursal: '00', folio_solicitud: '0010600' });
    check(r.estado === 'no_escrito' && /cancelada/.test(r.motivo), `cancelada (C): no_escrito (${JSON.stringify(r)})`);
    check((await c43('00', 15, '0010600')).c43 === 'C', 'la C sigue en C');

    r = await ad.autorizar({ sucursal: '00', folio_solicitud: '0099999' });
    check(r.estado === 'no_escrito' && /no tiene esa solicitud/.test(r.motivo), `inexistente: no_escrito (${JSON.stringify(r)})`);

    const apagado = new Adaptador({ KEPLER_PUSH_URL_00: env.KEPLER_PUSH_URL_00 });
    await k.query(`UPDATE md.kdm1 SET c43='N' WHERE c1='00' AND c4=15 AND c6='0010721'`);
    r = await apagado.autorizar({ sucursal: '00', folio_solicitud: '0010721' });
    check(r.estado === 'no_escrito' && /apagada/.test(r.motivo), 'apagado: no escribe');
    check((await c43('00', 15, '0010721')).c43 === 'N', 'apagado: la solicitud sigue en N');

    // ⛔ NEGATIVA: sin el GRANT de c43 el adaptador NO lanza, devuelve el motivo y no deja nada.
    await k.query(`REVOKE UPDATE (c43) ON md.kdm1 FROM ${ROL}`);
    const sinPermiso = new Adaptador(env);
    r = await sinPermiso.autorizar({ sucursal: '00', folio_solicitud: '0010721' });
    check(r.estado === 'no_escrito' && /rechazó la escritura/.test(r.motivo), `sin el GRANT: no_escrito con el error de Kepler (${JSON.stringify(r)})`);
    check((await c43('00', 15, '0010721')).c43 === 'N', 'sin el GRANT: la solicitud sigue en N');
    await sinPermiso.onModuleDestroy();
    await ad.onModuleDestroy();
  } finally {
    await k.end();
    await admin.query(`DROP DATABASE IF EXISTS ${BASE} WITH (FORCE)`).catch((e) => console.log(`  ! no se pudo borrar ${BASE}: ${e.message}`));
    await admin.query(`DROP ROLE IF EXISTS ${ROL}`).catch((e) => console.log(`  ! no se pudo borrar ${ROL}: ${e.message}`));
    await admin.end();
  }
  console.log(`\n[PGP.79] ${ok} ✓ · ${fail} ✗`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
