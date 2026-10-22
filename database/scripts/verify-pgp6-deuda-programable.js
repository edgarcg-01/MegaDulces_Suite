#!/usr/bin/env node
/**
 * `[PGP.6]` **Ejerce contra prod, en SÓLO LECTURA, el SQL de «la deuda que falta programar».**
 *
 *   node database/scripts/verify-pgp6-deuda-programable.js
 *
 * Necesita `PROD_DB_URL` (la cuenta de sólo lectura `dev_ro`).
 *
 * ⭐ Lee el SQL **del servicio**, no una copia: si la consulta cambia y esto no se vuelve a
 * correr, se nota. Lo que no se puede ejercer acá —el `POST` que crea la obligación— queda
 * declarado en el plan de fase: escribe, y escribir se prueba en el CI o en un entorno de
 * pruebas, nunca desde esta máquina contra prod.
 *
 * ⛔⛔ **Y mide el costo, porque esta consulta tiene una trampa medida.** El 2026-10-22, tres
 * corridas de cada forma contra prod:
 *
 *     sin filtro de sucursal (1,738 documentos) .......  450 –   550 ms
 *     AND sucursal = <CEDIS>  (1,122 documentos) ...... 43,616 – 47,743 ms
 *     filtrando por sucursal AFUERA de la vista ....... 42,675 – 52,786 ms
 *
 * ~90x, y **no es el predicado empujado**: afuera tarda igual. La causa exacta queda NO
 * DETERMINADA. Lo accionable sí está medido: **por acá no se filtra por sucursal**.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });

const SRC = path.join(RAIZ, 'libs/commercial/src/lib/supplier-payment-obligations/supplier-payment-obligations.service.ts');
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const PROD_SYSTEM_ID = '7688376744939610156';

function sqlDelServicio(src, nombre) {
  const ini = src.indexOf('const ' + nombre + ' = `');
  if (ini < 0) throw new Error(`No se encontró ${nombre} en el servicio — ¿lo renombraron?`);
  const desde = src.indexOf('`', ini) + 1;
  return src.slice(desde, src.indexOf('`', desde));
}

const r2 = (n) => Math.round(n * 100) / 100;
const mx = (n) => '$' + r2(n).toLocaleString('es-MX');

(async () => {
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en el .env (cuenta de sólo lectura)');
  const src = fs.readFileSync(SRC, 'utf8');
  // knex usa `?` como marcador; `pg` usa $1/$2. Se traducen en orden.
  let i = 0;
  const SQL = sqlDelServicio(src, 'SQL_DEUDA_PROGRAMABLE').replace(/\?/g, () => `$${++i}`);

  const c = new Client({ connectionString: process.env.PROD_DB_URL, statement_timeout: 120000 });
  await c.connect();
  try {
    const id = await c.query('select system_identifier from pg_control_system()');
    if (String(id.rows[0].system_identifier) !== PROD_SYSTEM_ID) {
      throw new Error(`La base no es prod (system_identifier ${id.rows[0].system_identifier}).`);
    }

    const t0 = Date.now();
    const { rows } = await c.query(SQL, [TENANT, TENANT]);
    const ms = Date.now() - t0;

    const n = (v) => Number(v || 0);
    const total = rows.reduce((a, x) => a + n(x.pendiente), 0);
    const prog = rows.filter((x) => x.programado);
    const progMonto = prog.reduce((a, x) => a + n(x.pendiente), 0);
    const sinCat = rows.filter((x) => !x.programado && x.supplier_id == null);
    const ofrecibles = rows.filter((x) => !x.programado && x.supplier_id != null);

    console.log(`\nconsulta: ${ms} ms · ${rows.length} documentos con saldo vivo`);
    console.log(`deuda ................. ${mx(total)}`);
    console.log(`ya programada ......... ${prog.length} documentos · ${mx(progMonto)} (${r2((progMonto / total) * 100)} %)`);
    console.log(`se puede programar .... ${ofrecibles.length} documentos · ${mx(ofrecibles.reduce((a, x) => a + n(x.pendiente), 0))}`);
    if (sinCat.length) console.log(`⚠ fuera del catálogo .. ${sinCat.length} · ${mx(sinCat.reduce((a, x) => a + n(x.pendiente), 0))}`);

    console.log('\nlos 6 primeros que ofrecería la pantalla:');
    console.table(ofrecibles.slice(0, 6).map((x) => ({
      sucursal: x.sucursal, proveedor: x.proveedor,
      nombre: String(x.proveedor_nombre || '').slice(0, 24),
      doc: `${x.doc_tipo}/${x.doc_sub}`, folio: String(x.folio).trim(),
      vence: x.vencimiento, dias: x.dias_vencido, pendiente: r2(n(x.pendiente)),
    })));

    const checks = [
      ['la fecha de vencimiento sale en ISO (o null)',
        rows.every((x) => x.vencimiento == null || /^\d{4}-\d{2}-\d{2}$/.test(String(x.vencimiento)))],
      ['ningún documento aparece dos veces (la llave es sucursal+proveedor+folio)',
        new Set(rows.map((x) => `${x.sucursal}|${x.proveedor}|${String(x.folio).trim()}`)).size === rows.length],
      ['todo documento ofrecible resuelve a un proveedor del catálogo',
        ofrecibles.every((x) => x.supplier_id)],
      ['todo lo listado debe dinero (pendiente > 0)', rows.every((x) => n(x.pendiente) > 0)],
      ['lo ya programado no se vuelve a ofrecer', ofrecibles.every((x) => !x.programado)],
      ['el costo se mantiene por debajo de 2 s (⛔ si se acerca a 40 s, alguien le puso un filtro de sucursal)', ms < 2000],
    ];
    console.log('');
    for (const [t, ok] of checks) console.log(`${ok ? '  ✔' : '  ✖'} ${t}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
