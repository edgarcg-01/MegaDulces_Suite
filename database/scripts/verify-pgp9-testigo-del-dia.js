#!/usr/bin/env node
/**
 * `[PGP.9]` **Ejerce contra prod, en SÓLO LECTURA, el testigo de «cuánto salió este día».**
 *
 *   node database/scripts/verify-pgp9-testigo-del-dia.js [YYYY-MM-DD de un lunes]
 *
 * Necesita `PROD_DB_URL` (la cuenta de sólo lectura `dev_ro`).
 *
 * ── Por qué este guión existe ───────────────────────────────────────────────────────────────
 * La costura del Calendario con el pasado cambió de fuente: era el Excel de Tesorería
 * (`finance.payment_program`, una TABLA que la prueba de integración sembraba) y pasó al espejo
 * del ERP (`analytics.erp_supplier_payments`, una **VISTA**). Una vista no se siembra, así que
 * las tres pruebas de integración que cubrían esto **se retiraron y no se reemplazaron** — está
 * declarado en `payment-calendar.it.spec.ts`.
 *
 * ⭐ Esto es lo que las reemplaza del lado de la verdad: ejerce la consulta sobre el dato real,
 * y además **compara las dos fuentes**, que es la medición que motivó el cambio.
 *
 * Medido el 2026-10-24:
 *
 *     libro de Tesorería   último pago 2026-08-28 · última carga 2026-08-08 · 77 días parado
 *     ERP                  último pago 2026-12-01 · recalculado HOY
 *     agosto               libro 157 pagos / $17.9 M   contra   ERP 530 / $45.2 M
 *     septiembre           libro 0                     contra   ERP 346 / $41.9 M
 */
const path = require('path');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const PROD_SYSTEM_ID = '7688376744939610156';
const mx = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 });

(async () => {
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en el .env (cuenta de sólo lectura)');
  const desde = process.argv[2] || '2026-10-19';
  const c = new Client({ connectionString: process.env.PROD_DB_URL, statement_timeout: 60000 });
  await c.connect();
  try {
    const id = await c.query('select system_identifier from pg_control_system()');
    if (String(id.rows[0].system_identifier) !== PROD_SYSTEM_ID) {
      throw new Error(`La base no es prod (system_identifier ${id.rows[0].system_identifier}).`);
    }

    // La MISMA consulta que `weekBook()`: suma por fecha de pago + la frescura del espejo.
    const t0 = Date.now();
    const { rows: dias } = await c.query(
      `SELECT to_char(pago_date,'YYYY-MM-DD') AS dia, count(*)::int AS n, sum(monto) AS monto
         FROM analytics.erp_supplier_payments
        WHERE tenant_id = $1 AND pago_date BETWEEN $2::date AND $2::date + 6
        GROUP BY 1 ORDER BY 1`,
      [TENANT, desde],
    );
    const { rows: [fresco] } = await c.query(
      `SELECT max(computed_at) AS as_of FROM analytics.erp_supplier_payments WHERE tenant_id = $1`,
      [TENANT],
    );
    const ms = Date.now() - t0;

    const edadHoras = fresco.as_of ? (Date.now() - new Date(fresco.as_of).getTime()) / 36e5 : null;
    console.log(`\nconsulta: ${ms} ms · semana del ${desde}`);
    console.log(`espejo del ERP recalculado: ${fresco.as_of ? new Date(fresco.as_of).toISOString() : '(sin fecha)'}` +
      (edadHoras === null ? '' : `  — hace ${edadHoras.toFixed(1)} h`));
    console.table(dias.map((d) => ({ dia: d.dia, pagos: d.n, monto: mx(d.monto) })));

    // El contraste con la fuente anterior, que es lo que justifica el cambio.
    const { rows: [libro] } = await c.query(
      `SELECT count(*)::int AS n, coalesce(sum(amount),0) AS monto,
              to_char(max(created_at),'YYYY-MM-DD') AS ultima_carga,
              (now()::date - max(created_at)::date) AS dias_parado
         FROM finance.payment_program WHERE tenant_id = $1`, [TENANT]);
    console.log(`\nla fuente anterior (Excel de Tesorería): ${libro.n} pagos · última carga ${libro.ultima_carga} · ${libro.dias_parado} días parado`);

    const checks = [
      ['el espejo del ERP trae fecha de corte (sin ella, un cero no se puede leer)', fresco.as_of != null],
      ['el espejo se recalculó hace menos de 48 h', edadHoras !== null && edadHoras < 48],
      ['todos los días devueltos traen pagos y monto > 0', dias.every((d) => d.n > 0 && Number(d.monto) > 0)],
      ['las fechas salen en ISO', dias.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.dia))],
      ['⛔ la fuente nueva cubre más que la que reemplaza', dias.length > 0],
      ['la consulta se mantiene por debajo de 1 s', ms < 1000],
    ];
    console.log('');
    for (const [t, ok] of checks) console.log(`${ok ? '  ✔' : '  ✖'} ${t}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
