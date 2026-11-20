/* eslint-disable no-console */
/**
 * `[PGP.122.11]` — El escritor que crea en Kepler la solicitud de gasto nacida en la Suite
 * (`KeplerSolicitudGastoSinkAdapter`, X-A-15-1 en `A`), ejercido contra un Postgres REAL.
 *
 * Carga los `.ts` reales vía ts-node. Arma una base de prueba con un `md` de los MISMOS tipos que
 * Kepler —las 200 columnas de `kdm1` y las 18 de `kdm6`, generadas de `KEPLER_ESTRUCTURA.json`, todas
 * NOT NULL— más el contador `sqliov` y los catálogos, y un rol con EXACTAMENTE los permisos que pide
 * `ops/prod/kepler-grants/pgp122_solicitud_gasto.sql`. Así se prueba lo que un doble no ve: los tipos
 * (`c17` texto, `c40` doble precisión, `kdm6.c7` numeric(3,0)), la copia de 200 columnas NOT NULL, el
 * candado del contador y que un error de Kepler deshaga TODO.
 *
 * Casos: el ensayo (la revisión real + ROLLBACK) da cero fallas y no deja nada · escrito (folio del
 * contador, el contador avanza, RFC/nombre del catálogo recortados, cuenta y texto del concepto, las dos
 * fechas, la plantilla intacta) · la misma marca otra vez → ya_estaba sin segunda fila · contador
 * atrasado → MAX+1 y se repara · contador adelantado → se respeta · tope diario · concepto sin cuenta,
 * proyecto y acreedor inexistentes, plantilla ausente o distinta → rechazado sin escribir · apagado ·
 * ⛔ NEGATIVAS: sin INSERT en kdm6, sin UPDATE en sqliov y con el contador tomado por otra sesión →
 * rechazado, nada escrito y el contador intacto.
 *
 * Lo que NO prueba (se declara): la llave primaria REAL de `kdm6` (aquí se supone `c1…c7`), lo que Kepler
 * además escriba al crear una solicitud (eso lo cierra la captura de prueba S.1) y el estado «en duda»
 * (un COMMIT cuya respuesta se pierde no se reproduce en una prueba).
 *
 * ⛔ Crea y BORRA una base y un rol: sólo contra un destino seguro (`assertSafeTarget`). En CI es el
 * Postgres del job `pruebas-db`.
 *
 *   node database/tests/test-newdb-kepler-solicitud-gasto.js
 */
'use strict';

require('reflect-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..');

// ── Los módulos REALES, con un mapa mínimo para los dos alias del monorepo ─────────────────────────
const STUB = path.join(os.tmpdir(), `.stub-pgp122-contracts-${process.pid}.js`);
fs.writeFileSync(STUB, `module.exports = {
  ...require(${JSON.stringify(path.join(RAIZ, 'libs/contracts/src/finance/forma-pago.contract.ts'))}),
  ...require(${JSON.stringify(path.join(RAIZ, 'libs/contracts/src/finance/solicitud-gasto.contract.ts'))}),
};`);
process.on('exit', () => { try { fs.unlinkSync(STUB); } catch { /* ya no está */ } });
const MAPA = {
  '@megadulces/platform-core': path.join(RAIZ, 'libs/platform-core/src/lib/kepler/kepler-servidor.ts'),
  '@megadulces/contracts': STUB,
};
const resolver = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return MAPA[req] || resolver.call(this, req, ...rest); };
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0',
    experimentalDecorators: true, emitDecoratorMetadata: true,
  },
});
const LIB = path.join(RAIZ, 'libs', 'finance', 'src', 'lib', 'expense-proofs', 'solicitud-kepler');
const { KeplerSolicitudGastoSinkAdapter } = require(path.join(LIB, 'kepler-solicitud-gasto-sink.adapter.ts'));
const { revisarEscrituraSolicitud } = require(path.join(LIB, 'kepler-solicitud-gasto-sink.revision.ts'));

const { assertSafeTarget } = require('./_lib/assert-safe-target');
const ADMIN_URL = process.env.DATABASE_URL_NEW;
assertSafeTarget('test-newdb-kepler-solicitud-gasto', { url: ADMIN_URL });

const BASE = 'kepler_prueba_pgp122';
const ROL = 'kepler_push_pgp122';
const CLAVE = 'pgp122_prueba';
const SUC = '05';
const PLANTILLA = '0000079';

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

// ── El md de prueba, con los tipos de Kepler (las piezas viven en _lib, una sola vez) ──────────────
const { columnas, ddl, insertarKdm1 } = require('./_lib/kepler-de-prueba');

class Adaptador extends KeplerSolicitudGastoSinkAdapter {
  constructor(env) { super(); this._env = env; }
  get env() { return this._env; }
}

/** El adaptador real con `confirmar` cambiado por la revisión del ensayo + ROLLBACK. */
class AdaptadorEnsayo extends Adaptador {
  async confirmar(c, w) {
    const r = await revisarEscrituraSolicitud(c, w);
    this.revision = r;
    await c.query('ROLLBACK');
  }
}

const pedido = (marca, extra = {}) => ({
  sucursal: SUC, acreedor: 'GA022', fechaSolicitud: '2026-11-13', fechaPago: null,
  renglones: [{ concepto: '240', proyecto: '2-15-26-02', departamento: '1-02-32-15', importe: 100 }],
  iva: 16, comprobante: { tipo: 'ticket', folio: '1198', fecha: '2026-11-12' }, comentario: 'Mantenimiento vehicular',
  solicita: 'usuario_prueba', formaPago: 'transferencia', marca, estado: 'A',
  capturadaEn: { fecha: '2026-11-13', hora: '17:42' }, tope_dia: null, ...extra,
});

async function main() {
  console.log('[PGP.122.11] la Suite escribe en Kepler la solicitud de gasto (X-A-15-1 en A)');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${BASE} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${ROL}`);
  await admin.query(`CREATE DATABASE ${BASE}`);
  await admin.query(`CREATE ROLE ${ROL} LOGIN PASSWORD '${CLAVE}'`);

  const k = new Client({ connectionString: urlCon(BASE) });
  await k.connect();
  const adaptadores = [];
  const nuevo = (Clase, env) => { const a = new Clase(env); adaptadores.push(a); return a; };
  try {
    await k.query('CREATE SCHEMA md');
    await k.query(`CREATE TABLE md.kdm1 (${ddl('kdm1')}, CONSTRAINT pk_kdm1 PRIMARY KEY (c1, c2, c3, c4, c5, c6))`);
    // ⚠️ La PK real de kdm6 no está medida (anexo §11): aquí se supone (c1…c7).
    await k.query(`CREATE TABLE md.kdm6 (${ddl('kdm6')}, CONSTRAINT pk_kdm6 PRIMARY KEY (c1, c2, c3, c4, c5, c6, c7))`);
    await k.query(`CREATE TABLE md.sqliov (${ddl('sqliov')}, PRIMARY KEY (c1, c2, c3))`);
    await k.query(`CREATE TABLE md.kdxd (${ddl('kdxd', ['c1', 'c2', 'c3', 'c10'])})`);
    await k.query(`CREATE TABLE md.kdco (${ddl('kdco')})`);
    await k.query(`CREATE TABLE md.kdcp (${ddl('kdcp', ['c1', 'c2', 'c3', 'c4', 'c5'])})`);
    await k.query(`CREATE TABLE md.kdc3 (${ddl('kdc3', ['c1', 'c2', 'c3', 'c4', 'c5'])})`);
    check(columnas('kdm1').length === 200 && columnas('kdm6').length === 18, 'md.kdm1 con sus 200 columnas y md.kdm6 con sus 18, con los tipos de Kepler');

    const NOMBRE_LARGO = 'ACREEDOR DE PRUEBA CON UN NOMBRE MUCHO MAS LARGO QUE SESENTA CARACTERES SA DE CV';
    await k.query(`INSERT INTO md.kdxd VALUES ('05', 'GA022', $1, 'XAXX010101000')`, [NOMBRE_LARGO]);
    await k.query(`INSERT INTO md.kdco VALUES ('240', 'MANTENIMIENTO VEHICULAR.', '602-008'), ('999', 'SIN CUENTA', ''), ('047', 'SUA', '601-015')`);
    await k.query(`INSERT INTO md.kdcp VALUES ('2-15-26-02', 'PRESUPUESTO 2026', '05', '', 'A')`);
    await k.query(`INSERT INTO md.kdc3 VALUES ('1-02-32-15', 'DEPTO PRUEBA', '', '', '')`);
    await k.query(`INSERT INTO md.sqliov VALUES ('KFXA1501.05', 0, 0, '81'), ('CUENTAS', 1, 0, '149z')`);
    // La plantilla (una solicitud aplicada de 1 renglón, como las candidatas del anexo) y una solicitud humana.
    const comun = { c1: SUC, c2: 'X', c3: 'A', c4: 15, c5: 1, c7: 'PESOS', c31: 'Sol', c40: 1, c63: 'XA1501-', c10: 'GA022', c30: 'FINANZAS' };
    await insertarKdm1(k, { ...comun, c6: PLANTILLA, c9: '2026-11-01', c16: 100, c18: '2026-11-01', c24: 'PLANTILLA', c32: 'X', c43: 'F', c48: 'JUAN', c67: '01JUAN', c68: '2026-11-01', c69: '10:00', c17: '0' });
    await insertarKdm1(k, { ...comun, c6: '0000080', c9: '2026-11-12', c16: 50, c42: 50, c18: '2026-11-12', c24: 'HUMANA', c32: 'X', c43: 'N', c48: 'ANA', c67: '01ANA', c68: '2026-11-12', c69: '11:00', c17: '0' });
    await insertarKdm1(k, { ...comun, c6: '0000070', c9: '2026-11-01', c16: 1, c43: 'F', c31: 'Gas', c17: '0' });

    // Exactamente lo que pide ops/prod/kepler-grants/pgp122_solicitud_gasto.sql.
    await k.query(`GRANT USAGE ON SCHEMA md TO ${ROL}`);
    await k.query(`GRANT SELECT, INSERT ON md.kdm1, md.kdm6 TO ${ROL}`);
    await k.query(`GRANT SELECT ON md.sqliov TO ${ROL}`);
    await k.query(`GRANT UPDATE (c4) ON md.sqliov TO ${ROL}`);
    await k.query(`GRANT SELECT ON md.kdxd, md.kdco, md.kdcp, md.kdc3 TO ${ROL}`);

    const env = { KEPLER_GASTO_SOLICITUD: 'encendida', [`KEPLER_PUSH_URL_${SUC}`]: urlCon(BASE, ROL, CLAVE), [`KEPLER_SOLGASTO_TEMPLATE_FOLIO_${SUC}`]: PLANTILLA };
    const contador = async () => (await k.query(`SELECT c4 FROM md.sqliov WHERE c1 = 'KFXA1501.05'`)).rows[0].c4;
    const filas = async () => (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c4 = 15`)).rows[0].n;
    const sol = async (folio) => (await k.query(
      `SELECT btrim(c43) c43, c16::text c16, c42::text c42, c14::text c14, btrim(c26) c26, btrim(c25) c25, btrim(c11) c11, btrim(c22) c22, btrim(c32) c32,
              to_char(c9, 'YYYY-MM-DD') c9, to_char(c18, 'YYYY-MM-DD') c18, btrim(c17) c17, btrim(c67) c67, btrim(c48) c48, btrim(c90) c90, btrim(c31) c31, btrim(c63) c63, c40::text c40
         FROM md.kdm1 WHERE c1 = $1 AND c4 = 15 AND c6 = $2`, [SUC, folio])).rows[0];

    console.log('\n[1] El ensayo: la revisión real, en el lugar del único paso que escribe, y ROLLBACK');
    const ens = nuevo(AdaptadorEnsayo, env);
    let r = await ens.entregar(pedido('SUITE SG-E0E0E0E0'));
    check(ens.revision && ens.revision.fallas.length === 0, `la revisión no encuentra fallas (${JSON.stringify(ens.revision?.fallas)})`);
    check(ens.revision && ens.revision.avisos.length === 0, `la plantilla es como las medidas: sin avisos (${JSON.stringify(ens.revision?.avisos)})`);
    check(ens.revision && Object.values(ens.revision.revisado.permisos).every(Boolean), 'los 9 permisos que pide escribir de verdad: presentes');
    check(await filas() === 3 && await contador() === '81', 'tras el ROLLBACK no quedó ninguna fila y el contador sigue en 81');

    console.log('\n[2] Escrito');
    const ad = nuevo(Adaptador, env);
    r = await ad.entregar(pedido('SUITE SG-6F9A1B2C'));
    check(r.estado === 'escrito' && r.folio === '0000081', `escrito con el folio del contador (${JSON.stringify(r)})`);
    check(await contador() === '82', 'el contador avanzó a 82 (la próxima captura de una persona no choca)');
    const s = await sol('0000081');
    check(s && s.c43 === 'A' && s.c16 === '116.00' && s.c42 === '116.00' && s.c14 === '16.00', `nace autorizada, total = renglones + IVA y saldo = total (${JSON.stringify(s)})`);
    check(s && s.c9 === '2026-11-13' && s.c25 === 'AMPARA TICKET 1198 DEL 12/11/2026' && s.c11 === '1198', 'las dos fechas: c9 = solicitud y c25 = AMPARA con la fecha del documento; c11 = su folio');
    check(s && s.c22 === 'XAXX010101000' && s.c32 === NOMBRE_LARGO.slice(0, 60), 'RFC y nombre del catálogo del servidor, el nombre recortado a 60');
    check(s && s.c17 === '0' && s.c18 === '2026-11-13' && s.c67 === 'SUITE' && s.c48 === 'USUARIO_PRUEBA' && s.c90 === '03', 'plazo (c17 texto), fecha de pago, capturista SUITE, quién solicita y forma de pago SAT');
    check(s && s.c31 === 'Sol' && s.c63 === 'XA1501-' && s.c40 === '1', 'las constantes vienen de la plantilla');
    const ren = (await k.query(`SELECT c7::int c7, btrim(c8) c8, btrim(c9) c9, c11::text c11 FROM md.kdm6 WHERE c1 = $1 AND c6 = '0000081'`, [SUC])).rows;
    check(ren.length === 1 && ren[0].c8 === '602-008' && ren[0].c9 === 'MANTENIMIENTO VEHICULAR.' && ren[0].c11 === '100.00', `el renglón lleva la cuenta y el texto del concepto en kdco (${JSON.stringify(ren)})`);
    const pl = await sol(PLANTILLA);
    check(pl.c43 === 'F' && pl.c16 === '100.00', 'la plantilla quedó intacta');

    console.log('\n[3] Idempotencia: la misma marca no escribe dos veces');
    r = await ad.entregar(pedido('SUITE SG-6F9A1B2C'));
    check(r.estado === 'ya_estaba' && r.folio === '0000081', `ya_estaba con el mismo folio (${JSON.stringify(r)})`);
    check(await filas() === 4 && await contador() === '82', 'sin segunda fila y sin mover el contador');
    const m = await ad.buscarPorMarca(SUC, 'SUITE SG-6F9A1B2C');
    check(m.ok && m.encontrada && m.encontrada.folio === '0000081', 'buscarPorMarca la encuentra');
    const nada = await ad.buscarPorMarca(SUC, 'SUITE SG-00000000');
    check(nada.ok && nada.encontrada === null, 'una marca que no existe: null (no es un error)');

    console.log('\n[4] El contador');
    await k.query(`UPDATE md.sqliov SET c4 = '21' WHERE c1 = 'KFXA1501.05'`);
    r = await ad.entregar(pedido('SUITE SG-AAAA0001'));
    check(r.estado === 'escrito' && r.folio === '0000082' && r.contador.atrasado === true, `contador atrasado (21 con el último en 81): folio MAX+1 = 82 (${JSON.stringify(r)})`);
    check(await contador() === '83', 'y el contador quedó reparado en 83');
    await k.query(`UPDATE md.sqliov SET c4 = '90' WHERE c1 = 'KFXA1501.05'`);
    r = await ad.entregar(pedido('SUITE SG-AAAA0002'));
    check(r.estado === 'escrito' && r.folio === '0000090', `contador adelantado (Kepler reservó hasta 89): se respeta, folio 90 (${JSON.stringify(r)})`);
    check(await contador() === '91', 'contador en 91');

    console.log('\n[5] El tope diario, contado en Kepler');
    r = await ad.entregar(pedido('SUITE SG-AAAA0003', { tope_dia: 3 }));
    check(r.estado === 'rechazado' && r.reintentable === true && /Tope/.test(r.motivo), `con 3 de la Suite hoy y tope 3: rechazado y se reintenta mañana (${JSON.stringify(r)})`);

    console.log('\n[6] Lo que Kepler no aceptaría: rechazado, sin escribir y sin mover el contador');
    // Una plantilla «rara»: trae algo en una de las 169 columnas que en las solicitudes medidas van vacías (c33).
    await insertarKdm1(k, { ...comun, c6: '0000071', c9: '2026-11-01', c16: 1, c43: 'F', c17: '0', c33: 'RARO' });
    const antes = { n: await filas(), c: await contador() };
    const casos = [
      ['concepto sin cuenta', pedido('SUITE SG-BBBB0001', { renglones: [{ concepto: '999', proyecto: '2-15-26-02', departamento: '1-02-32-15', importe: 10 }] }), /concepto 999/],
      ['proyecto inexistente', pedido('SUITE SG-BBBB0002', { renglones: [{ concepto: '240', proyecto: '9-99-26-99', departamento: '1-02-32-15', importe: 10 }] }), /proyecto/],
      ['acreedor inexistente', pedido('SUITE SG-BBBB0003', { acreedor: 'GZ999' }), /acreedor GZ999/],
    ];
    for (const [nombre, p, rx] of casos) {
      r = await ad.entregar(p);
      check(r.estado === 'rechazado' && r.reintentable === false && rx.test(r.motivo), `${nombre}: rechazado, no se reintenta (${JSON.stringify(r)})`);
    }
    const otraPlantilla = nuevo(Adaptador, { ...env, [`KEPLER_SOLGASTO_TEMPLATE_FOLIO_${SUC}`]: '0000070' });
    r = await otraPlantilla.entregar(pedido('SUITE SG-BBBB0004'));
    check(r.estado === 'apagado' && /no es como las solicitudes medidas/.test(r.motivo) && /espera/.test(r.motivo), `plantilla distinta (c31 = Gas): el servidor no escribe y la solicitud ESPERA, sin gastar intentos (${JSON.stringify(r)})`);
    const rara = nuevo(Adaptador, { ...env, [`KEPLER_SOLGASTO_TEMPLATE_FOLIO_${SUC}`]: '0000071' });
    r = await rara.entregar(pedido('SUITE SG-BBBB0007'));
    check(r.estado === 'apagado' && /c33=«RARO»/.test(r.motivo), `fail-closed: una plantilla con algo en las 169 columnas que van vacías no se usa (${JSON.stringify(r)})`);
    const sinPlantilla = nuevo(Adaptador, { ...env, [`KEPLER_SOLGASTO_TEMPLATE_FOLIO_${SUC}`]: '0000001' });
    r = await sinPlantilla.entregar(pedido('SUITE SG-BBBB0005'));
    check(r.estado === 'apagado' && /No existe la solicitud plantilla/.test(r.motivo), `plantilla inexistente: apagado, la solicitud espera (${JSON.stringify(r)})`);
    check(await filas() === antes.n && await contador() === antes.c, 'ninguno escribió ni movió el contador');
    await k.query(`DELETE FROM md.kdm1 WHERE c1 = $1 AND c4 = 15 AND c6 = '0000071'`, [SUC]);
    antes.n = await filas();

    const apagado = nuevo(Adaptador, { ...env, KEPLER_GASTO_SOLICITUD: '' });
    r = await apagado.entregar(pedido('SUITE SG-BBBB0006'));
    check(r.estado === 'apagado', 'apagado: no se intenta (no es un rechazo)');

    console.log('\n[6b] Dentro del candado del contador: otro escritor entra justo antes (la costura antesDelCandado)');
    const conIntruso = (alAntes) => { const a = nuevo(Adaptador, env); a.antesDelCandado = async (e) => { await alAntes(e); }; return a; };
    const fila = (c6, extra) => insertarKdm1(k, { ...comun, c6, c9: '2026-11-13', c16: 116, c43: 'A', c17: '0', c67: 'SUITE', c68: '2026-11-13', c69: '17:00', ...extra });
    // a) la MARCA: el otro escritor confirmó la misma solicitud (folio 0000500) después del primer vistazo
    r = await conIntruso((e) => fila('0000500', { c26: e.marca })).entregar(pedido('SUITE SG-DDDD0001'));
    const conLaMarca = (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE btrim(c26) = 'SUITE SG-DDDD0001'`)).rows[0].n;
    check(r.estado === 'ya_estaba' && r.folio === '0000500' && conLaMarca === 1, `la marca se vuelve a buscar con el candado tomado: ya_estaba 0000500 y UNA sola fila (${JSON.stringify(r)}, ${conLaMarca})`);
    check(await contador() === antes.c, 'y el contador no se movió (ROLLBACK)');
    // b) el TOPE: con el conteo previo pasaba; el otro escritor agrega una del día y dentro del candado ya no
    const hechas = (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c1 = $1 AND c4 = 15 AND btrim(c26) LIKE 'SUITE SG-%' AND c68::date = '2026-11-13'`, [SUC])).rows[0].n;
    r = await conIntruso(() => fila('0000501', { c26: 'SUITE SG-DDDD00FF' })).entregar(pedido('SUITE SG-DDDD0002', { tope_dia: hechas + 1 }));
    check(r.estado === 'rechazado' && r.porTope === true && r.reintentable === true, `el tope se cuenta con el candado tomado: ${hechas} + 1 del otro escritor = tope ${hechas + 1} → mañana (${JSON.stringify(r)})`);
    check(await contador() === antes.c, 'sin mover el contador');
    // c) FOLIO OCUPADO: una persona captura el mismo folio en Kepler justo antes del INSERT → todo o nada
    const carrera = nuevo(Adaptador, env);
    let folioCarrera = null;
    carrera.confirmar = async function (c, w) { folioCarrera = w.folio; await fila(w.folio, { c26: '', c67: '01ANA', c24: 'CAPTURA HUMANA' }); return Adaptador.prototype.confirmar.call(this, c, w); };
    r = await carrera.entregar(pedido('SUITE SG-DDDD0003'));
    const suya = (await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE btrim(c26) = 'SUITE SG-DDDD0003'`)).rows[0].n;
    const renglonesSuyos = (await k.query(`SELECT count(*)::int n FROM md.kdm6 WHERE c1 = $1 AND c6 = $2`, [SUC, folioCarrera])).rows[0].n;
    check(r.estado === 'rechazado' && r.reintentable === true && suya === 0 && renglonesSuyos === 0, `folio ${folioCarrera} ganado por una captura de Kepler: rechazado y se reintenta, sin cabecera ni renglones (${JSON.stringify(r)})`);
    check(await contador() === antes.c, 'y el contador regresó a donde estaba (ROLLBACK total)');
    await k.query(`DELETE FROM md.kdm1 WHERE c1 = $1 AND c4 = 15 AND c6 = ANY($2::text[])`, [SUC, ['0000500', '0000501', folioCarrera]]);
    check(await filas() === antes.n, 'limpieza de [6b]: quedan las mismas filas que antes');

    console.log('\n[7] ⛔ NEGATIVAS: sin un permiso, o con el contador tomado, nada se escribe');
    await k.query(`REVOKE INSERT ON md.kdm6 FROM ${ROL}`);
    r = await nuevo(Adaptador, env).entregar(pedido('SUITE SG-CCCC0001'));
    check(r.estado === 'rechazado' && r.reintentable === false, `sin INSERT en kdm6: rechazado y no se reintenta (${JSON.stringify(r)})`);
    check(await filas() === antes.n && await contador() === antes.c, 'sin INSERT en kdm6: ni la cabecera ni el contador quedaron (todo o nada)');
    await k.query(`GRANT INSERT ON md.kdm6 TO ${ROL}`);

    await k.query(`REVOKE UPDATE (c4) ON md.sqliov FROM ${ROL}`);
    r = await nuevo(Adaptador, env).entregar(pedido('SUITE SG-CCCC0002'));
    check(r.estado === 'rechazado', `sin UPDATE (c4) en sqliov: rechazado (${JSON.stringify(r)})`);
    check(await filas() === antes.n && await contador() === antes.c, 'sin UPDATE en el contador: nada escrito');
    await k.query(`GRANT UPDATE (c4) ON md.sqliov TO ${ROL}`);

    const otra = new Client({ connectionString: urlCon(BASE) });
    await otra.connect();
    await otra.query('BEGIN');
    await otra.query(`SELECT c4 FROM md.sqliov WHERE c1 = 'KFXA1501.05' FOR UPDATE`);
    const t0 = Date.now();
    r = await nuevo(Adaptador, env).entregar(pedido('SUITE SG-CCCC0003'));
    await otra.query('ROLLBACK');
    await otra.end();
    check(r.estado === 'rechazado' && r.reintentable === true && Date.now() - t0 < 15000, `con el contador tomado por otra sesión: espera 5 s y rechaza, reintentable (${JSON.stringify(r)})`);
    check(await filas() === antes.n && await contador() === antes.c, 'con el contador tomado: nada escrito');

    r = await nuevo(Adaptador, env).entregar(pedido('SUITE SG-CCCC0004'));
    check(r.estado === 'escrito' && r.folio === '0000091', `control positivo: con todo en su lugar vuelve a escribir, folio 91 (${JSON.stringify(r)})`);

    console.log('\n[8] [PGP.122.6] «Cancela sol gasto»: la capturada en Kepler (sin marca, candado por total) y la de la Suite (F3)');
    // Lo que ya tiene kepler_push en los 9 servidores (PQ.110, verificado el 2026-11-17): UPDATE de esas columnas.
    await k.query(`GRANT UPDATE (c14, c16, c42, c43, c67, c68, c69) ON md.kdm1 TO ${ROL}`);
    await k.query(`INSERT INTO md.kdm6 (c1, c2, c3, c4, c5, c6, c7, c8, c9, c11) VALUES ($1, 'X', 'A', 15, 1, '0000080', 1, '602-008', 'RENGLON HUMANO', 50)`, [SUC]);
    const cancelar = (folio, marca) => ad.cancelar({ sucursal: SUC, folio, marca, fecha: '2026-11-19', hora: '12:00' });
    r = await cancelar('0000080', null);
    let h = await sol('0000080');
    check(r.estado === 'cancelada' && r.original && r.original.estado === 'N' && r.original.total === '50.00' && r.original.capturista === '01ANA',
      `la capturada en Kepler (0000080, N, $50, 01ANA): cancelada, y devuelve la cabecera de antes para la bitácora (${JSON.stringify(r)})`);
    check(h.c43 === 'C' && h.c16 === '0.00' && h.c42 === '0.00' && h.c14 === '0.00' && h.c67 === 'SUITE', `queda como la cancela Kepler: C, total/saldo/IVA en 0, quién cancela (${JSON.stringify(h)})`);
    const renH = (await k.query(`SELECT count(*)::int n FROM md.kdm6 WHERE c1 = $1 AND c6 = '0000080'`, [SUC])).rows[0].n;
    check(renH === 1, 'los renglones se conservan (Kepler no los borra al cancelar una solicitud)');
    r = await cancelar('0000080', null);
    check(r.estado === 'ya_estaba', `otra vez: ya_estaba, sin escribir (${JSON.stringify(r)})`);
    // ⛔ La que escribió la Suite no se cancela por este camino (va por su vale, que guarda la marca).
    r = await cancelar('0000081', null);
    check(r.estado === 'rechazado' && /la escribió la Suite/.test(r.motivo) && (await sol('0000081')).c43 === 'A', `0000081 trae marca de la Suite: rechazada sin marca, intacta (${JSON.stringify(r)})`);
    // ⛔ DS40: con un gasto X-A-10 vivo no se cancela.
    await insertarKdm1(k, { ...comun, c6: '0000600', c9: '2026-11-15', c16: 200, c42: 200, c18: '2026-11-15', c43: 'A', c17: '0', c67: '01ANA' });
    await insertarKdm1(k, { ...comun, c4: 10, c6: '0000700', c9: '2026-11-16', c16: 200, c43: 'A', c17: '0', c37: 15, c38: 1, c39: '0000600' });
    r = await cancelar('0000600', null);
    check(r.estado === 'rechazado' && /0000700/.test(r.motivo) && (await sol('0000600')).c43 === 'A', `con el gasto 0000700 vivo: rechazada, intacta (${JSON.stringify(r)})`);
    // ⛔ Sin el permiso de escribir c43: rechazada y nada cambia.
    await k.query(`DELETE FROM md.kdm1 WHERE c1 = $1 AND c4 = 10 AND c6 = '0000700'`, [SUC]);
    await k.query(`REVOKE UPDATE (c43) ON md.kdm1 FROM ${ROL}`);
    r = await cancelar('0000600', null);
    h = await sol('0000600');
    check(r.estado === 'rechazado' && h.c43 === 'A' && h.c16 === '200.00', `sin UPDATE (c43): rechazada y la solicitud quedó igual (${JSON.stringify(r)})`);
    await k.query(`GRANT UPDATE (c43) ON md.kdm1 TO ${ROL}`);
    // ⛔ El candado por total: otra sesión le cambió el total entre la lectura y la escritura → 0 filas, nada escrito.
    const conCambio = nuevo(Adaptador, env);
    conCambio.poolDe = function (url) {
      const pool = Adaptador.prototype.poolDe.call(this, url);
      return { connect: async () => {
        const c = await pool.connect();
        const q = c.query.bind(c);
        c.query = async (sql, params) => {
          if (/^UPDATE md\.kdm1 SET c43 = 'C'/.test(String(sql).trim())) await q(`UPDATE md.kdm1 SET c16 = 201 WHERE c1 = $1 AND c4 = 15 AND c6 = '0000600'`, [SUC]);
          return q(sql, params);
        };
        return c;
      } };
    };
    r = await conCambio.cancelar({ sucursal: SUC, folio: '0000600', marca: null, fecha: '2026-11-19', hora: '12:00' });
    h = await sol('0000600');
    check(r.estado === 'rechazado' && r.reintentable === true && h.c43 === 'A' && h.c16 === '200.00', `el total cambió a la mitad: 0 filas, ROLLBACK, intacta (${JSON.stringify(r)}, ${JSON.stringify(h)})`);
    // Control positivo: la misma, sin cambios de por medio, sí se cancela.
    r = await cancelar('0000600', null);
    check(r.estado === 'cancelada' && (await sol('0000600')).c43 === 'C', `control positivo: 0000600 se cancela (${JSON.stringify(r)})`);
    // La F3 (con la marca del vale) sigue igual.
    r = await cancelar('0000081', 'SUITE SG-6F9A1B2C');
    check(r.estado === 'cancelada' && (await sol('0000081')).c43 === 'C', `F3: la de la Suite, con su marca, se cancela (${JSON.stringify(r)})`);
  } finally {
    for (const a of adaptadores) await a.onModuleDestroy().catch(() => undefined);
    await k.end();
    await admin.query(`DROP DATABASE IF EXISTS ${BASE} WITH (FORCE)`).catch((e) => console.log(`  ! no se pudo borrar ${BASE}: ${e.message}`));
    await admin.query(`DROP ROLE IF EXISTS ${ROL}`).catch((e) => console.log(`  ! no se pudo borrar ${ROL}: ${e.message}`));
    await admin.end();
  }
  console.log(`\n[PGP.122.11] ${ok} ✓ · ${fail} ✗`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
