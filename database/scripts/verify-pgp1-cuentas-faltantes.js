#!/usr/bin/env node
/**
 * `[PGP.1]` **Ejerce contra prod, en SÓLO LECTURA, el SQL de «a quién le falta cuenta de pago».**
 *
 *   node database/scripts/verify-pgp1-cuentas-faltantes.js [dias]
 *
 * Necesita `PROD_DB_URL` (la cuenta de sólo lectura `dev_ro`) en el `.env`.
 *
 * ⭐ **Lee el SQL DEL SERVICIO, no una copia.** Una copia a mano se desincroniza en silencio y
 * entonces el guión verifica una consulta que ya no existe — que es la forma más cara de tener
 * una verificación en verde. Si el servicio cambia la consulta, esto ejerce la nueva.
 *
 * ⛔ Por qué existe en vez de una prueba con doble de Knex: **un doble no ejecuta SQL**, así que
 * no dice nada del `WHERE`, del `LEFT JOIN` ni de los tipos que devuelve el driver. Lo que sí se
 * prueba sin base es el reparto (porcentajes, acumulado, corte), y eso vive en
 * `missing-accounts.engine.spec.ts` con sus 8 casos.
 *
 * Medido el 2026-10-22 con `dias=120`: 170 proveedores · $136,249,983.81 · 0 % cubierto ·
 * corte del 80 % en el renglón 38 · 0 fuera del catálogo · 141–158 ms.
 *
 * ⚠️ El monto **se mueve entre corridas del mismo día** y eso es correcto: la vista sale del ODS
 * vivo, no de una tabla con corte. Entre dos corridas con 20 minutos de diferencia subió
 * $488,518.62 — un pago real que entró en el medio. Una cifra de acá se cita **con su momento**.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });

const SRC = path.join(RAIZ, 'libs/commercial/src/lib/supplier-payment-accounts/supplier-payment-accounts.service.ts');

/** Saca el literal de una constante `const NOMBRE = \`…\`;` del servicio. */
function sqlDelServicio(src, nombre) {
  const ini = src.indexOf('const ' + nombre + ' = `');
  if (ini < 0) throw new Error(`No se encontró ${nombre} en el servicio — ¿lo renombraron?`);
  const desde = src.indexOf('`', ini) + 1;
  const hasta = src.indexOf('`', desde);
  return src.slice(desde, hasta);
}

const r2 = (n) => Math.round(n * 100) / 100;
/** El tenant de Mega Dulces. La consulta filtra `catalog.suppliers` por él. */
const TENANT = '00000000-0000-0000-0000-00000000d01c';
/** `pg-prod` en el servidor `md`. ⛔ Se verifica por identificador, nunca por el nombre de la base. */
const PROD_SYSTEM_ID = '7688376744939610156';

(async () => {
  const dias = Number(process.argv[2] || 120);
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en el .env (cuenta de sólo lectura)');

  const src = fs.readFileSync(SRC, 'utf8');
  const SQL_RANGO = sqlDelServicio(src, 'SQL_RANGO');
  const SQL_FALTANTES = sqlDelServicio(src, 'SQL_FALTANTES');

  const c = new Client({ connectionString: process.env.PROD_DB_URL });
  await c.connect();
  try {
    const id = await c.query('select system_identifier from pg_control_system()');
    if (String(id.rows[0].system_identifier) !== PROD_SYSTEM_ID) {
      throw new Error(`La base no es prod (system_identifier ${id.rows[0].system_identifier}). La vieja de Railway tiene el MISMO nombre.`);
    }

    const t0 = Date.now();
    const [rango, r] = await Promise.all([c.query(SQL_RANGO, [dias]), c.query(SQL_FALTANTES, [dias, TENANT])]);
    const ms = Date.now() - t0;

    const rows = r.rows;
    const montoTotal = rows.reduce((a, x) => a + Number(x.monto), 0);
    const sinCatalogo = rows.filter((x) => x.supplier_id == null);
    const conCuenta = rows.filter((x) => x.tiene_cuenta && x.supplier_id != null);
    const montoCubierto = conCuenta.reduce((a, x) => a + Number(x.monto), 0);
    const pctCubierto = montoTotal > 0 ? r2((montoCubierto / montoTotal) * 100) : 0;
    const pendientes = rows.filter((x) => x.supplier_id != null && !x.tiene_cuenta);

    let acum = pctCubierto;
    let corte = null;
    const faltantes = pendientes.map((x, i) => {
      const pct = montoTotal > 0 ? (Number(x.monto) / montoTotal) * 100 : 0;
      acum += pct;
      if (corte === null && acum >= 80) corte = i + 1;
      return {
        codigo: String(x.proveedor_code).trim(), nombre: x.nombre,
        monto: r2(Number(x.monto)), pct_del_total: r2(pct), acumulado_pct: r2(acum),
        ultimo_pago_date: String(x.ultimo_pago_date).slice(0, 10),
        ultimo_pago_monto: r2(Number(x.ultimo_pago_monto)),
      };
    });

    console.log(`\nconsulta: ${ms} ms  ·  ventana ${dias} días  ·  ${rango.rows[0].desde} → ${rango.rows[0].hasta}`);
    console.log(`universo: ${rows.length} proveedores cobran por banco · $${r2(montoTotal).toLocaleString('es-MX')}`);
    console.log(`cobertura: ${pctCubierto} % ($${r2(montoCubierto).toLocaleString('es-MX')}) · ${conCuenta.length} con cuenta`);
    console.log(`faltan: ${faltantes.length} · para cubrir el 80 % alcanza con las primeras ${corte ?? '—'}`);
    if (sinCatalogo.length) console.log(`⚠ fuera del catálogo: ${sinCatalogo.length} ($${r2(sinCatalogo.reduce((a, x) => a + Number(x.monto), 0)).toLocaleString('es-MX')}) — no se les puede abrir solicitud`);
    console.table(faltantes.slice(0, 8));

    // Controles: si alguno falla, la consulta cambió de forma y la pantalla estaría mintiendo.
    const checks = [
      ['las fechas salen en ISO',
        /^\d{4}-\d{2}-\d{2}$/.test(rango.rows[0].hasta) && faltantes.every((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.ultimo_pago_date))],
      ['el acumulado cierra en 100 % cuando no hay cuentas ni huérfanos',
        sinCatalogo.length > 0 || conCuenta.length > 0 || faltantes.length === 0 || Math.abs(faltantes[faltantes.length - 1].acumulado_pct - 100) < 0.05],
      ['todo faltante trae supplier_id (si no, no se le puede abrir solicitud)',
        pendientes.every((x) => x.supplier_id)],
      ['la suma de las partes es el universo',
        Math.abs(montoTotal - (montoCubierto + sinCatalogo.reduce((a, x) => a + Number(x.monto), 0) + pendientes.reduce((a, x) => a + Number(x.monto), 0))) < 0.01],
      ['el espejo del ERP trae su fecha de cálculo (alimenta la frescura de la pantalla)',
        rows.length === 0 || rows.some((x) => x.computed_at != null)],
    ];
    console.log('');
    for (const [n, ok] of checks) console.log(`${ok ? '  ✔' : '  ✖'} ${n}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
