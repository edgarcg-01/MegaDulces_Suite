/* eslint-disable no-console */
/**
 * `[PGP.123]` G.7 — El escritor que comprueba en Kepler el gasto de una solicitud viva (`KeplerGastoSinkAdapter`,
 * X-A-10 «Alta gasto CFDI»), ejercido contra un Postgres REAL.
 *
 * Carga los `.ts` reales vía ts-node. Arma una base de prueba con un `md` de los MISMOS tipos que Kepler —las
 * columnas de `kdm1`, `kdm6`, `kdxe`, la póliza `kdc22611`, `kdc126`, `kdcn26`, `kdxg`, `kdmm` y `kdc3`, generadas
 * de `KEPLER_ESTRUCTURA.json`— y un rol con EXACTAMENTE los permisos de
 * `ops/prod/kepler-grants/pgp123_comprobacion_gasto.sql` (se ejecuta el archivo real) más la tabla del mes.
 *
 * Casos (anexo G §9): el ensayo (la revisión real + ROLLBACK) da cero fallas y no deja nada · escrito: las 9
 * escrituras, una por una (el gasto clon de su solicitud, sus renglones, la solicitud en F con saldo 0, el contador,
 * la cuenta por pagar, la póliza D con su número y que cuadre, `kdc126` en los dos juegos con su mayor, `kdcn26`
 * con los padres que existen y `*`, `kdxg`) · otra vez → ya_estaba · la solicitud cancelada, aplicada o con un gasto
 * parcial → rechazado sin escribir · ⛔ una persona captura el gasto entre la lectura y el COMMIT → ya_estaba ·
 * ⛔ otro documento toma el número de póliza antes del COMMIT → nada escrito · cuenta sin fila en `kdc126` y acreedor
 * con dos filas en `kdxg` → rechazado (Kepler los crearía) · ⛔ sin permiso → apagado, no rechazado · tope · las 9
 * bases sin DG7 (G.1) · interruptor apagado.
 *
 * Lo que NO prueba (se declara): las llaves primarias reales de `kdm6`, `kdxe`, la póliza y `kdcn26` (no están
 * medidas), lo que Kepler además escriba al capturar un X-A-10 (lo cierra la captura de prueba G.1) y el estado
 * «en duda» (un COMMIT cuya respuesta se pierde no se reproduce en una prueba).
 *
 * ⛔ Crea y BORRA una base y un rol: sólo contra un destino seguro (`assertSafeTarget`). En CI es el Postgres del
 * job `pruebas-db`.
 *
 *   node database/tests/test-newdb-kepler-gasto-comprobacion.js
 */
'use strict';

require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..');
const MAPA = { '@megadulces/platform-core': path.join(RAIZ, 'libs/platform-core/src/lib/kepler/kepler-servidor.ts') };
const resolver = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return MAPA[req] || resolver.call(this, req, ...rest); };
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0',
    experimentalDecorators: true, emitDecoratorMetadata: true,
  },
});
const LIB = path.join(RAIZ, 'libs', 'finance', 'src', 'lib', 'expense-proofs', 'comprobacion-kepler');
const { KeplerGastoSinkAdapter } = require(path.join(LIB, 'kepler-gasto-sink.adapter.ts'));
const { revisarEscrituraGasto } = require(path.join(LIB, 'kepler-gasto-sink.revision.ts'));

const { assertSafeTarget } = require('./_lib/assert-safe-target');
const ADMIN_URL = process.env.DATABASE_URL_NEW;
assertSafeTarget('test-newdb-kepler-gasto-comprobacion', { url: ADMIN_URL });

const ESTRUCTURA = require(path.join(RAIZ, 'docs', 'IMPLEMENTACION', 'KEPLER_ESTRUCTURA.json'));
const columnas = (t, solo) => ESTRUCTURA.columns.filter((c) => c.table === t && (!solo || solo.includes(c.name))).sort((a, b) => a.pos - b.pos);
const tipo = (c) => c.type === 'character varying' ? (c.max_len ? `varchar(${c.max_len})` : 'varchar')
  : c.type === 'numeric' ? (c.precision != null ? `numeric(${c.precision},${c.scale ?? 0})` : 'numeric') : c.type;
const ddl = (t, solo) => columnas(t, solo).map((c) => `${c.name} ${tipo(c)}${c.nullable ? '' : ' NOT NULL'}`).join(', ');
const vacio = (c) => /char|text/.test(c.type) ? '' : /timestamp|date/.test(c.type) ? '1800-01-01 00:00:00' : 0;

const BASE = 'kepler_prueba_pgp123';
const ROL = 'kepler_push_pgp123';
const CLAVE = 'pgp123_prueba';
const SUC = '05';
const HOY = '2026-11-13';

let ok = 0;
let fail = 0;
const check = (cond, label, extra) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`); }
};

function urlCon(base, usuario, clave) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${base}`;
  if (usuario) { u.username = usuario; u.password = clave; }
  return u.toString();
}

/** Una fila completa de `tabla` (la estructura de Kepler): todo vacío salvo lo que se le pase. */
async function insertar(k, tablaMd, tablaEstructura, valores, solo) {
  const cols = columnas(tablaEstructura, solo);
  const fila = Object.fromEntries(cols.map((c) => [c.name, valores[c.name] ?? vacio(c)]));
  await k.query(`INSERT INTO md.${tablaMd} (${cols.map((c) => c.name).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => fila[c.name]));
}

class Adaptador extends KeplerGastoSinkAdapter {
  constructor(env) { super(); this._env = env; }
  get env() { return this._env; }
}
/** El escritor real con `confirmar` cambiado por la revisión del ensayo + ROLLBACK. */
class AdaptadorEnsayo extends Adaptador {
  async confirmar(c, w) { this.revision = await revisarEscrituraGasto(c, w); await c.query('ROLLBACK'); }
}

/** Lo que aprobó G.5 en el ODS para las solicitudes que siembra esta prueba (`solicitud()`: 116, GA022, 12-nov). */
const ESPERADO = { total: 116, acreedor: 'GA022', fecha: '2026-11-12' };
const pedido = (solicitud, extra = {}) => ({
  sucursal: SUC, solicitud, fecha: HOY, capturadoEn: { fecha: HOY, hora: '18:05' }, formaPagoVale: '03', vale: `vale-${solicitud}`, tope_dia: null,
  esperado: ESPERADO, ...extra,
});

async function main() {
  console.log('[PGP.123] G.7 la Suite escribe en Kepler el gasto (X-A-10) de una solicitud viva, con su póliza y sus acumulados');
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
    // ── El md de prueba, con los tipos de Kepler ───────────────────────────────────────────────────────────────────
    await k.query('CREATE SCHEMA md');
    await k.query(`CREATE TABLE md.kdm1 (${ddl('kdm1')}, CONSTRAINT pk_kdm1 PRIMARY KEY (c1, c2, c3, c4, c5, c6))`);
    await k.query(`CREATE TABLE md.kdm6 (${ddl('kdm6')}, CONSTRAINT pk_kdm6 PRIMARY KEY (c1, c2, c3, c4, c5, c6, c7))`);
    await k.query(`CREATE TABLE md.sqliov (${ddl('sqliov')}, PRIMARY KEY (c1, c2, c3))`);
    await k.query(`CREATE TABLE md.kdxe (${ddl('kdxe')})`);
    await k.query(`CREATE TABLE md.kdc22611 (${ddl('kdc22611')})`);
    await k.query(`CREATE TABLE md.kdc126 (${ddl('kdc126')})`);
    await k.query(`CREATE TABLE md.kdcn26 (${ddl('kdcn26')})`);
    await k.query(`CREATE TABLE md.kdxg (${ddl('kdxg')})`);
    const MM = ['c1', 'c2', 'c3', 'c4', 'c18', 'c20', 'c21', 'c22'];
    await k.query(`CREATE TABLE md.kdmm (${ddl('kdmm', MM)})`);
    await k.query(`CREATE TABLE md.kdc3 (${ddl('kdc3', ['c1', 'c2', 'c3', 'c4', 'c5'])})`);
    check(columnas('kdxe').length === 31 && columnas('kdc22611').length === 50 && columnas('kdc126').length === 100 && columnas('kdxg').length === 58,
      'md con kdxe (31), la póliza (50), kdc126 (100) y kdxg (58) columnas, con los tipos de Kepler');

    await insertar(k, 'kdmm', 'kdmm', { c1: 'X', c2: 'A', c3: 10, c4: 1, c18: 'D', c20: '201', c21: '122-001', c22: '122-003' }, MM);
    // Los departamentos: el renglón va al 1-02-32-15; existen sus padres 1 y 1-02 (no 1-02-32).
    for (const d of ['1-02-32-15', '1-02', '1']) await k.query(`INSERT INTO md.kdc3 VALUES ($1, 'DEPTO', '', '', '')`, [d]);
    await k.query(`INSERT INTO md.sqliov VALUES ('KFXA1001.05', 0, 0, '51'), ('KFXA1501.05', 0, 0, '140')`);
    for (const cuenta of ['201', '122-001', '122', '602-008', '602']) await insertar(k, 'kdc126', 'kdc126', { c1: cuenta, c2: `CUENTA ${cuenta}` });
    await insertar(k, 'kdxg', 'kdxg', { c1: 'PESOS', c2: SUC, c3: 'GA022', c4: '2026-11-01', c6: '2026-11-01', c7: '2026-11-01' });
    await insertar(k, 'kdxg', 'kdxg', { c1: 'PESOS', c2: SUC, c3: 'GA077', c4: '2026-11-01', c6: '2026-11-01', c7: '2026-11-01' });
    await insertar(k, 'kdxg', 'kdxg', { c1: 'PESOS', c2: SUC, c3: 'GA077', c4: '2026-11-01', c6: '2026-11-01', c7: '2026-11-01' }); // ⛔ dos filas
    // Una celda del ejercido ya existe (el renglón suma); las demás nacen.
    await k.query(`INSERT INTO md.kdcn26 VALUES ('240', '1-02-32-15', '2-15-26-02', '2611', '', 0, 50, 0)`);
    // Pólizas D del mes de otros documentos: la siguiente es la 4. Una E con número mayor no cuenta.
    for (const [n, tipoP] of [[1, 'D'], [2, 'D'], [3, 'D'], [9, 'E']]) {
      await insertar(k, 'kdc22611', 'kdc22611', { c1: n, c2: '2026-11-02', c3: '601-001', c4: 'C', c5: 1, c8: tipoP, c9: 1, c10: 1, c14: SUC, c15: 'X', c16: 'D', c17: 26, c18: 1, c19: '0000900', c31: '1800-01-01' });
    }
    // Un gasto capturado por una persona (otro folio, otra solicitud): el contador va en 51.
    const comun = { c1: SUC, c2: 'X', c3: 'A', c5: 1, c7: 'PESOS', c40: 1, c10: 'GA022', c30: 'FINANZAS' };
    await insertarKdm1(k, { ...comun, c4: 10, c6: '0000050', c9: '2026-11-03', c16: 10, c42: 10, c31: 'Gas', c36: 'A', c37: 15, c38: 1, c39: '0000099', c43: 'N', c63: 'XA1001-', c67: '01ANA', c68: '2026-11-03', c69: '10:00', c41: '2000-01-01', c17: '0' });

    /** Una solicitud viva con sus renglones. */
    const solicitud = async (folio, over = {}, renglones = [{ c7: 1, c8: '602-008', c9: 'MANTENIMIENTO VEHICULAR', c11: 100, c12: '240', c13: '2-15-26-02', c16: '1-02-32-15' }]) => {
      await insertarKdm1(k, {
        ...comun, c4: 15, c6: folio, c9: '2026-11-12', c11: 'F-1198', c14: 16, c15: 0, c16: 116, c42: 116, c17: '0', c18: '2026-11-12',
        c24: 'GASTO DE PRUEBA', c25: 'AMPARA TICKET 1198 DEL 12/11/2026', c26: 'SUITE SG-0A0A0A0A', c31: 'Sol', c32: 'ACREEDOR DE PRUEBA SA DE CV',
        c43: 'A', c48: 'ANA', c63: 'XA1501-', c67: '01ANA', c68: '2026-11-12', c69: '11:00', c41: '1800-01-01', c90: '', ...over,
      });
      for (const r of renglones) {
        await insertar(k, 'kdm6', 'kdm6', { c1: SUC, c2: 'X', c3: 'A', c4: 15, c5: 1, c6: folio, c10: 'C', ...r });
      }
    };
    await solicitud('0000120');

    // ── El rol: EXACTAMENTE el archivo de permisos (con el nombre del rol de prueba) + la tabla del mes ────────────
    const grants = fs.readFileSync(path.join(RAIZ, 'ops/prod/kepler-grants/pgp123_comprobacion_gasto.sql'), 'utf8').replace(/kepler_push\b/g, ROL);
    await k.query(`GRANT USAGE ON SCHEMA md TO ${ROL}`);
    await k.query(grants);
    // El bloque del archivo da la del mes en curso y el siguiente (por el reloj); la prueba vive en noviembre de 2026.
    await k.query(`GRANT SELECT, INSERT ON md.kdc22611 TO ${ROL}`);

    const env = { KEPLER_GASTO_COMPROBACION: 'encendida', [`KEPLER_PUSH_URL_${SUC}`]: urlCon(BASE, ROL, CLAVE), KEPLER_PUSH_URL_00: urlCon(BASE, ROL, CLAVE) };
    const contador = async () => (await k.query(`SELECT btrim(c4) c4 FROM md.sqliov WHERE c1 = 'KFXA1001.05'`)).rows[0].c4;
    const gastos = async () => Number((await k.query(`SELECT count(*)::int n FROM md.kdm1 WHERE c4 = 10`)).rows[0].n);
    const polizas = async () => Number((await k.query(`SELECT count(*)::int n FROM md.kdc22611`)).rows[0].n);
    const sol = async (folio) => (await k.query(`SELECT btrim(c43) c43, c42::text c42 FROM md.kdm1 WHERE c1 = $1 AND c4 = 15 AND c6 = $2`, [SUC, folio])).rows[0];
    const foto = async () => JSON.stringify({
      g: await gastos(), p: await polizas(), c: await contador(),
      e: (await k.query('SELECT count(*)::int n FROM md.kdxe')).rows[0].n,
      n: (await k.query('SELECT count(*)::int n, sum(c7)::text s FROM md.kdcn26')).rows[0],
      k: (await k.query('SELECT sum(c37 + c61 + c73 + c85)::text s FROM md.kdc126')).rows[0].s,
      x: (await k.query('SELECT sum(c57)::text s FROM md.kdxg')).rows[0].s,
    });

    console.log('\n[1] El ensayo: la revisión real, en el lugar del único paso que escribe, y ROLLBACK');
    const antes = await foto();
    const ens = nuevo(AdaptadorEnsayo, env);
    let r = await ens.entregar(pedido('0000120'));
    check(ens.revision && ens.revision.fallas.length === 0, 'la revisión no encuentra fallas', ens.revision?.fallas);
    check(ens.revision && Object.values(ens.revision.revisado.permisos).every(Boolean), 'los permisos del archivo alcanzan para escribir de verdad', ens.revision?.revisado?.permisos);
    check(ens.revision && ens.revision.avisos.some((a) => /kdcn26: \d+ celdas nuevas/.test(a)), 'avisa las celdas nuevas del ejercido', ens.revision?.avisos);
    check(await foto() === antes && (await sol('0000120')).c43 === 'A', 'tras el ROLLBACK no quedó nada: ni el gasto, ni la póliza, ni el contador, ni los acumulados');

    console.log('\n[2] Escrito: las 9 escrituras');
    const ad = nuevo(Adaptador, env);
    r = await ad.entregar(pedido('0000120'));
    check(r.estado === 'escrito' && r.folio === '0000051' && r.poliza === 4 && r.tablaPoliza === 'kdc22611' && r.total === 116, 'escrito: X-A-10 0000051, póliza D 4 de kdc22611, $116', r);
    const g = (await k.query(
      `SELECT btrim(c6) c6, btrim(c39) c39, btrim(c36) c36, c37::text c37, c38::text c38, btrim(c43) c43, c42::text c42, c16::text c16, to_char(c9, 'YYYY-MM-DD') c9,
              btrim(c31) c31, btrim(c63) c63, to_char(c41, 'YYYY-MM-DD') c41, btrim(c67) c67, to_char(c68, 'YYYY-MM-DD') c68, btrim(c69) c69, btrim(c90) c90,
              btrim(c10) c10, btrim(c11) c11, btrim(c24) c24, btrim(c25) c25, btrim(c26) c26, btrim(c32) c32, c14::text c14
         FROM md.kdm1 WHERE c1 = $1 AND c4 = 10 AND c6 = '0000051'`, [SUC])).rows[0];
    check(g && g.c39 === '0000120' && g.c36 === 'A' && g.c37 === '15' && g.c38 === '1' && g.c43 === 'N' && Number(g.c42) === 116 && Number(g.c16) === 116,
      '1 · el gasto en N, apuntando a su solicitud, con su saldo = total', g);
    check(g && g.c9 === HOY && g.c31 === 'Gas' && g.c63 === 'XA1001-' && g.c41 === '2000-01-01' && g.c67 === 'SUITE' && g.c68 === HOY && g.c69 === '18:05',
      '1 · las constantes del gasto, la fecha (DG1) y quién/cuándo', g);
    check(g && g.c90 === '03', '1 · DG3: la solicitud no trae forma de pago → la del vale (03)', g?.c90);
    check(g && g.c10 === 'GA022' && g.c11 === 'F-1198' && g.c24 === 'GASTO DE PRUEBA' && g.c26 === 'SUITE SG-0A0A0A0A' && g.c32 === 'ACREEDOR DE PRUEBA SA DE CV' && Number(g.c14) === 16,
      '1 · lo demás se copia de la solicitud (acreedor, referencia, textos, marca, IVA)', g);
    const l = (await k.query(`SELECT c4::text c4, btrim(c6) c6, c7::int c7, c11::text c11, btrim(c12) c12, btrim(c8) c8 FROM md.kdm6 WHERE c4 = 10`)).rows;
    check(l.length === 1 && l[0].c6 === '0000051' && Number(l[0].c11) === 100 && l[0].c12 === '240' && l[0].c8 === '602-008', '2 · el renglón, copia del de la solicitud', l);
    const s = await sol('0000120');
    check(s.c43 === 'F' && Number(s.c42) === 0, '3 · la solicitud quedó aplicada (F) y sin saldo', s);
    check(await contador() === '52', '4 · el contador KFXA1001.05 avanzó a 52');
    const e = (await k.query(
      `SELECT btrim(c6) c6, c11::text c11, c13::text c13, c17::text c17, c20::text c20, btrim(c16) c16, to_char(c7, 'YYYY-MM-DD') c7, to_char(c10, 'YYYY-MM-DD') c10,
              btrim(c9) c9, btrim(c28) c28, btrim(c29) c29, c12::text c12, btrim(c18) c18 FROM md.kdxe WHERE btrim(c1) = $1 AND c4 = 10`, [SUC])).rows;
    check(e.length === 1 && e[0].c6 === '0000051' && Number(e[0].c11) === 116 && Number(e[0].c17) === 116 && Number(e[0].c20) === 116 && Number(e[0].c13) === 16
      && e[0].c16 === 'F-1198' && e[0].c7 === HOY && e[0].c10 === '2026-11-12' && e[0].c9 === '0' && e[0].c28 === 'X' && e[0].c29 === 'A' && Number(e[0].c12) === 0 && e[0].c18 === '',
    '5 · la cuenta por pagar: total, IVA, saldo, referencia, plazo y vencimiento; lo demás en cero o vacío', e);
    const p = (await k.query(
      `SELECT c1::int c1, btrim(c3) c3, c4, c5::text c5, c9::text c9, btrim(c6) c6, btrim(c7) c7, c10::int c10, btrim(c13) c13, btrim(c20) c20, btrim(c21) c21,
              btrim(c23) c23, btrim(c14) c14, btrim(c19) c19, to_char(c2, 'YYYY-MM-DD') c2
         FROM md.kdc22611 WHERE btrim(c16) = 'A' AND c17 = 10 ORDER BY c10`)).rows;
    check(p.length === 3 && p.every((x) => x.c1 === 4 && x.c19 === '0000051' && x.c7 === 'F-1198' && x.c23 === 'F' && x.c14 === SUC && x.c2 === HOY && Number(x.c5) === Number(x.c9)),
      '6 · la póliza D 4: tres renglones con el documento, la referencia y su primera letra', p);
    check(p[0]?.c3 === '201' && p[0]?.c4 === 'A' && Number(p[0]?.c5) === 116 && p[1]?.c3 === '122-001' && p[1]?.c4 === 'C' && Number(p[1]?.c5) === 16
      && p[2]?.c3 === '602-008' && p[2]?.c4 === 'C' && Number(p[2]?.c5) === 100 && p[2]?.c20 === '240' && p[2]?.c13 === '1-02-32-15' && p[2]?.c21 === '2-15-26-02',
    '6 · abono al acreedor (201), IVA (122-001) y el cargo del renglón con sus segmentos: cuadra', p);
    const k126 = Object.fromEntries((await k.query(`SELECT btrim(c1) c, (c37 + 0)::text cargo1, (c61 + 0)::text cargo2, (c73 + 0)::text abono1, (c85 + 0)::text abono2 FROM md.kdc126`)).rows.map((x) => [x.c, x]));
    const sube = (cta, cargo, abono) => Number(k126[cta].cargo1) === cargo && Number(k126[cta].cargo2) === cargo && Number(k126[cta].abono1) === abono && Number(k126[cta].abono2) === abono;
    check(sube('201', 0, 116) && sube('122-001', 16, 0) && sube('122', 16, 0) && sube('602-008', 100, 0) && sube('602', 100, 0),
      '7 · kdc126 de noviembre: los dos juegos, en la cuenta y en su mayor', k126);
    const cn = Object.fromEntries((await k.query(`SELECT btrim(c1) || '|' || btrim(c2) || '|' || btrim(c3) k, c7::text c7, btrim(c5) c5, c6::text c6, c8::text c8 FROM md.kdcn26 WHERE c4 = '2611'`)).rows.map((x) => [x.k, x]));
    const v = (kk) => (cn[kk] ? Number(cn[kk].c7) : null);
    check(v('240|1-02-32-15|2-15-26-02') === 150 && v('240|1-02-32-15|*') === 100 && v('240|1-02|2-15-26-02') === 100 && v('240|1|*') === 100 && v('240|*|*') === 100,
      '8 · kdcn26: la celda que existía suma; nacen el proyecto *, los padres que existen (1, 1-02) y el departamento *', cn);
    check(v('240|1-02-32|2-15-26-02') === null, '8 · ⛔ el padre que NO existe en kdc3 (1-02-32) no tiene celda');
    check(v('||') === -100 && v('|*|*') === -100 && cn['240|1-02|*'] && cn['240|1-02|*'].c5 === '' && Number(cn['240|1-02|*'].c6) === 0,
      '8 · el abono y el IVA (sin segmentos) van a las 4 celdas vacías/* con −100; la celda nueva nace con c5 vacío y c6/c8 en 0', cn);
    const xg = (await k.query(`SELECT c57::text c57, to_char(c4, 'YYYY-MM-DD') c4, to_char(c6, 'YYYY-MM-DD') c6, to_char(c7, 'YYYY-MM-DD') c7 FROM md.kdxg WHERE btrim(c3) = 'GA022'`)).rows[0];
    check(Number(xg.c57) === 116 && xg.c4 === HOY && xg.c6 === HOY && xg.c7 === '2026-11-01', '9 · kdxg: el cargo de noviembre (c57) y el último movimiento y cargo; el último abono no se toca', xg);

    console.log('\n[3] Otra vez la misma solicitud → no escribe otro');
    const antes3 = await foto();
    r = await ad.entregar(pedido('0000120'));
    check(r.estado === 'ya_estaba' && r.folio === '0000051', 'ya_estaba con el folio 0000051', r);
    check(await foto() === antes3, 'nada cambió');

    console.log('\n[4] Solicitudes que no se comprueban solas');
    await solicitud('0000121', { c43: 'C' });
    await solicitud('0000122', { c43: 'F', c42: 0 });
    await solicitud('0000123', { c42: 60 });
    const antes4 = await foto();
    r = await ad.entregar(pedido('0000121'));
    check(r.estado === 'rechazado' && !r.reintentable && /cancelada/.test(r.motivo), 'cancelada en Kepler → rechazado', r);
    r = await ad.entregar(pedido('0000122'));
    check(r.estado === 'rechazado' && /ya está aplicada/.test(r.motivo), 'ya aplicada (F) sin gasto vivo → rechazado', r);
    r = await ad.entregar(pedido('0000123'));
    check(r.estado === 'rechazado' && /saldo de la solicitud/.test(r.motivo), 'con un gasto parcial (saldo ≠ total) → rechazado', r);
    r = await ad.entregar(pedido('0000999'));
    check(r.estado === 'rechazado' && /no existe/.test(r.motivo), 'una solicitud que no existe → rechazado', r);
    check(await foto() === antes4, 'ninguno escribió nada');

    console.log('\n[5] ⛔ Una persona captura el gasto de la misma solicitud mientras la Suite lo arma');
    await solicitud('0000125');
    class Carrera extends Adaptador {
      async antesDelCandado() {
        await insertarKdm1(k, { ...comun, c4: 10, c6: '0000077', c9: HOY, c16: 116, c42: 116, c31: 'Gas', c36: 'A', c37: 15, c38: 1, c39: '0000125', c43: 'N', c63: 'XA1001-', c67: '01ANA', c68: HOY, c69: '18:06', c41: '2000-01-01', c17: '0' });
      }
    }
    const contadorAntes5 = await contador();
    r = await nuevo(Carrera, env).entregar(pedido('0000125'));
    check(r.estado === 'ya_estaba' && r.folio === '0000077', 'ya_estaba: el de la persona, y no se escribe otro', r);
    check(await contador() === contadorAntes5 && (await sol('0000125')).c43 === 'A', 'el contador y la solicitud quedan como estaban (ROLLBACK)');

    console.log('\n[6] ⛔ Otro documento toma el número de póliza antes del COMMIT');
    await solicitud('0000126');
    class Ganada extends Adaptador {
      async confirmar(c, w) {
        await insertar(k, 'kdc22611', 'kdc22611', { c1: w.poliza, c2: HOY, c3: '601-001', c4: 'C', c5: 1, c8: 'D', c9: 1, c10: 1, c14: SUC, c15: 'X', c16: 'D', c17: 26, c18: 1, c19: '0000901', c31: '1800-01-01' });
        return super.confirmar(c, w);
      }
    }
    const antes6 = JSON.parse(await foto());
    r = await nuevo(Ganada, env).entregar(pedido('0000126'));
    const despues6 = JSON.parse(await foto());
    check(r.estado === 'rechazado' && r.reintentable && /número de póliza/.test(r.motivo), 'rechazado (reintentable): otro tomó la póliza', r);
    check(despues6.g === antes6.g && despues6.c === antes6.c && despues6.p === antes6.p + 1 && despues6.k === antes6.k && (await sol('0000126')).c43 === 'A',
      'nada de la Suite quedó escrito (sólo la póliza ajena); la solicitud sigue en A', { antes6, despues6 });

    console.log('\n[7] Lo que Kepler crearía, la Suite no lo crea');
    await solicitud('0000127', {}, [{ c7: 1, c8: '603-001', c9: 'OTRO GASTO', c11: 100, c12: '241', c13: '2-15-26-02', c16: '1-02-32-15' }]);
    await solicitud('0000128', { c10: 'GA077' });
    const antes7 = await foto();
    r = await ad.entregar(pedido('0000127'));
    check(r.estado === 'rechazado' && /603-001/.test(r.motivo) && /crearía/.test(r.motivo), 'la cuenta 603-001 no está en kdc126 → rechazado', r);
    r = await ad.entregar(pedido('0000128', { esperado: { ...ESPERADO, acreedor: 'GA077' } }));
    check(r.estado === 'rechazado' && /GA077/.test(r.motivo) && /2 filas/.test(r.motivo), 'el acreedor con dos filas en kdxg → rechazado', r);
    check(await foto() === antes7, 'ninguno escribió nada');

    console.log('\n[8] ⛔ Sin permiso: apagado (el servidor no está configurado), no rechazado');
    await solicitud('0000129');
    await k.query(`REVOKE INSERT ON md.kdxe FROM ${ROL}`);
    const antes8 = await foto();
    r = await ad.entregar(pedido('0000129'));
    check(r.estado === 'apagado' && /permiso/.test(r.motivo) && /pgp123_comprobacion_gasto\.sql/.test(r.motivo), 'apagado, y dice qué archivo de permisos falta', r);
    check(await foto() === antes8 && (await sol('0000129')).c43 === 'A', 'nada escrito: el ROLLBACK deshizo el gasto y el contador');
    await k.query(`GRANT INSERT ON md.kdxe TO ${ROL}`);

    console.log('\n[9] Tope del día, las 9 bases (DG7 retirado por G.1) y el interruptor');
    r = await ad.entregar(pedido('0000129', { tope_dia: 1 }));
    check(r.estado === 'rechazado' && r.porTope && r.reintentable, 'con un gasto de la Suite hoy y tope 1 → rechazado por tope (se reintenta mañana)', r);
    r = await ad.entregar(pedido('0000129', { tope_dia: 2 }));
    // La persona de [5] capturó el 0000077 sin avanzar el contador (52): el folio es greatest(52, MAX+1) y se repara.
    check(r.estado === 'escrito' && r.folio === '0000078' && r.contador.atrasado && r.contador.nuevo === '79' && r.poliza === 6,
      'con tope 2 → escrito: folio 0000078 (MAX+1; el contador venía atrasado y queda reparado en 79), póliza 6 (la 5 era ajena)', r);
    const antes9 = await foto();
    r = await ad.entregar(pedido('0000129', { sucursal: '00' }));
    // G.1 (2026-11-20): no hay contador escondido; 00 ya no se apaga por DG7. La base de prueba no tiene esa solicitud en
    // 00: se rechaza al leerla y no se escribe nada.
    check(r.estado !== 'apagado' && !/DG7/.test(JSON.stringify(r)), 'G.1: en 00 ya no hay candado DG7 (llega a leer la solicitud)', r);
    check(await foto() === antes9, 'y no escribió nada: la solicitud no existe en 00');
    r = await nuevo(Adaptador, { ...env, KEPLER_GASTO_COMPROBACION: 'apagada' }).entregar(pedido('0000129'));
    check(r.estado === 'apagado' && /KEPLER_GASTO_COMPROBACION/.test(r.motivo), 'con el interruptor apagado → apagado', r);

    console.log('\n[10] ⛔ La solicitud viva no es la que aprobó G.5 (el ODS iba atrasado o la editaron en Kepler): no se escribe');
    await solicitud('0000130');
    const antes10 = await foto();
    for (const [que, cual, esperado] of [['total', 'el total', { ...ESPERADO, total: 100 }], ['acreedor', 'el acreedor', { ...ESPERADO, acreedor: 'GA077' }], ['fecha', 'la fecha', { ...ESPERADO, fecha: '2026-11-10' }]]) {
      r = await ad.entregar(pedido('0000130', { esperado }));
      check(r.estado === 'rechazado' && r.reintentable === true && /cambió en Kepler/.test(r.motivo) && new RegExp(que).test(r.motivo),
        `cambió ${cual} que aprobó G.5 → rechazado (reintentable: la siguiente vuelta relee el ODS)`, r);
    }
    check(await foto() === antes10 && (await sol('0000130')).c43 === 'A', 'ninguno escribió nada: el ROLLBACK soltó la solicitud y sigue en A');
    r = await ad.entregar(pedido('0000130'));
    check(r.estado === 'escrito', 'con lo mismo que aprobó G.5 → escrito', r);
  } finally {
    for (const a of adaptadores) await a.onModuleDestroy().catch(() => undefined);
    await k.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${BASE} WITH (FORCE)`).catch((e) => console.log(`  ! no se pudo borrar ${BASE}: ${e.message}`));
    await admin.query(`DROP ROLE IF EXISTS ${ROL}`).catch((e) => console.log(`  ! no se pudo borrar ${ROL}: ${e.message}`));
    await admin.end().catch(() => undefined);
  }
  console.log(`\n  ${ok} ✓ · ${fail} ✗`);
  if (fail) process.exitCode = 1;
}

/** Una fila de `kdm1` como Kepler la deja: todo vacío salvo lo que se le pase. */
async function insertarKdm1(k, valores) { await insertar(k, 'kdm1', 'kdm1', valores); }

main().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
