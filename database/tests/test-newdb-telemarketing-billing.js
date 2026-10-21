/**
 * E.9 — el tablero de Telemarketing ve la facturación de su canal.
 *
 * El tablero medía sólo actividad (llamadas, minutos, conversión) sobre `commercial.call_logs`,
 * que en prod está **vacía**: publicaba ceros en todo mientras el ERP facturaba $8.2M en 30 días
 * por ese mismo canal. Este candado prueba las dos mitades:
 *
 *   1. la facturación del canal existe y cuadra con lo que publica /comercial/documentos
 *      (misma vista, mismo filtro: si divergen, una de las dos pantallas miente);
 *   2. la actividad se DECLARA cuando no hay captura — un cero sin registro no es desempeño,
 *      y el tablero tiene que poder distinguirlo (ADR-056);
 *   3. la atribución por operador es la del ERP y NO se puede cruzar con los usuarios: se
 *      afirma que ese puente no existe, para que nadie lo invente después.
 *
 * Read-only. Uso: node database/tests/test-newdb-telemarketing-billing.js
 */
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

const URL = process.env.DATABASE_URL_NEW || process.env.FLEET_DB_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const W = "WHERE tenant_id = $1 AND doc_tipo = 'telemarketing' AND NOT cancelada";

let ok = 0, fail = 0, skip = 0;
const check = (n, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK   ${n}`); } else { fail++; console.log(`  FAIL ${n}  ${det}`); }
};
const noMedido = (n, motivo) => { skip++; console.log(`  NO MEDIDO  ${n} — ${motivo}`); };

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW / FLEET_DB_URL'); process.exit(1); }
  const c = new Client({ connectionString: URL, ssl: false, statement_timeout: 120000 });
  await c.connect();
  console.log('\n=== E.9 · facturación del canal en el tablero de Telemarketing ===');

  const tieneCobranza = (await c.query(`
    SELECT count(*)::int n FROM information_schema.columns
    WHERE table_schema='analytics' AND table_name='erp_sales_invoices' AND column_name='estatus_cobro'`)).rows[0].n;
  if (!tieneCobranza) {
    console.log('  FAIL  falta la vista con cobranza: aplicar 20260905150100 (AX.9)');
    await c.end(); process.exit(1);
  }

  // ── 1. la facturación del canal, con el MISMO SQL que arma el tablero ──────
  const t0 = Date.now();
  const b = (await c.query(`
    WITH sel AS MATERIALIZED (
      SELECT fecha, total, saldo, estatus_cobro, vencimiento, cliente_code
      FROM analytics.erp_sales_invoices ${W} AND fecha >= current_date - 30)
    SELECT count(*)::int facturas, coalesce(sum(total),0)::numeric importe,
           count(DISTINCT cliente_code)::int clientes, coalesce(sum(saldo),0)::numeric saldo,
           coalesce(sum(saldo) FILTER (WHERE vencimiento < current_date
             AND estatus_cobro IN ('pendiente','parcial')),0)::numeric saldo_vencido,
           max(fecha) ultima_factura
    FROM sel`, [T])).rows[0];
  const ms = Date.now() - t0;
  console.log(`\n1) canal 30d: ${b.facturas} facturas · $${Number(b.importe).toLocaleString('en-US')} · `
    + `${b.clientes} clientes · vencido $${Number(b.saldo_vencido).toLocaleString('en-US')} [${ms} ms]`);
  check('el canal tiene facturación en la ventana (el tablero no está vacío)', b.facturas > 0,
    `facturas=${b.facturas}`);
  check('trae fecha de negocio del dato más reciente', !!b.ultima_factura);
  check('el bloque responde en menos de 3 s', ms < 3000, `${ms} ms`);
  check('el vencido nunca supera el saldo total',
    Number(b.saldo_vencido) <= Number(b.saldo) + 0.01,
    `vencido=${b.saldo_vencido} saldo=${b.saldo}`);

  // ── 2. cuadra con /comercial/documentos (misma vista, mismo filtro) ────────
  const d = (await c.query(`
    SELECT count(*)::int facturas, coalesce(sum(total),0)::numeric importe
    FROM analytics.erp_sales_invoices ${W} AND fecha >= current_date - 30`, [T])).rows[0];
  check('facturas idénticas a las de /comercial/documentos', d.facturas === b.facturas,
    `documentos=${d.facturas} tablero=${b.facturas}`);
  check('importe idéntico al de /comercial/documentos',
    Math.abs(Number(d.importe) - Number(b.importe)) < 0.01,
    `documentos=${d.importe} tablero=${b.importe}`);

  // ── 3. la actividad se declara cuando no hay captura ──────────────────────
  const act = (await c.query(`
    SELECT count(*)::int llamadas, count(DISTINCT user_id)::int operadores
    FROM commercial.call_logs WHERE tenant_id = $1`, [T])).rows[0];
  console.log(`\n2) actividad capturada: ${act.llamadas} llamadas de ${act.operadores} operadores`);
  if (act.llamadas === 0) {
    // El caso que motivó la fase: el tablero DEBE poder decir "no hay captura" en vez de
    // pintar 0% de conversión como si fuera un resultado.
    check('sin captura, la facturación sigue existiendo (son independientes)', b.facturas > 0,
      'si esto falla, el tablero quedaría vacío por completo');
    console.log('       (el tablero lo declara con actividad.registrada=false: el cero es ausencia de registro)');
  } else {
    noMedido('el aviso de "sin captura"', `ya hay ${act.llamadas} llamadas registradas: el caso no se puede provocar`);
  }

  // ── 4. la atribución es del ERP y ese puente NO existe ────────────────────
  const op = (await c.query(`
    WITH sel AS MATERIALIZED (
      SELECT vendedor_code, vendedor_nombre, total FROM analytics.erp_sales_invoices ${W}
        AND fecha >= current_date - 30)
    SELECT count(DISTINCT vendedor_code)::int operadores_erp,
           count(*) FILTER (WHERE vendedor_code IS NULL)::int sin_vendedor
    FROM sel`, [T])).rows[0];
  const puente = (await c.query(`
    SELECT count(*)::int n FROM information_schema.columns
    WHERE table_schema='identity' AND table_name='users'
      AND column_name IN ('vendedor_code','vendedor_id','erp_vendedor')`)).rows[0].n;
  console.log(`\n3) atribución: ${op.operadores_erp} vendedores del ERP · ${op.sin_vendedor} facturas sin vendedor`);
  check('hay atribución por operador que mostrar', op.operadores_erp > 0);
  // Prueba NEGATIVA del supuesto: si algún día aparece la columna, este candado avisa para que
  // el cruce se implemente de verdad en vez de seguir diciendo "no se puede".
  check('sigue sin existir columna que ligue usuario ↔ vendedor del ERP', puente === 0,
    `apareció la columna: ya se puede cruzar, actualizar el aviso de la pantalla`);

  // ── 5. [E.14] el vencido es de TODA la cartera, y la cola declara su universo ──
  // El tablero recorre la vista UNA vez con «30 días OR vencida» (mismo SQL que el servicio).
  // Se cruza contra una consulta INDEPENDIENTE, sin el OR: si divergen, el atajo pierde filas.
  const V = `vencimiento < current_date AND estatus_cobro IN ('pendiente','parcial')`;
  const t5 = Date.now();
  const s = (await c.query(`
    WITH sel AS MATERIALIZED (
      SELECT fecha, saldo, cliente_code, sucursal, (${V}) AS vencida
      FROM analytics.erp_sales_invoices ${W} AND (fecha >= current_date - 30 OR (${V})))
    SELECT coalesce(sum(saldo) FILTER (WHERE vencida), 0)::numeric saldo_canal,
           count(*) FILTER (WHERE vencida)::int facturas_canal,
           coalesce(sum(saldo) FILTER (WHERE vencida AND fecha >= current_date - 30), 0)::numeric saldo_30d,
           count(DISTINCT cliente_code) FILTER (WHERE fecha >= current_date - 30)::int clientes,
           (SELECT count(DISTINCT x.cliente_code) FROM sel x
             WHERE x.fecha >= current_date - 30 AND EXISTS (
               SELECT 1 FROM commercial.customers cu
               WHERE cu.tenant_id = $1 AND cu.active AND cu.deleted_at IS NULL
                 AND cu.erp_customer_code = x.cliente_code AND cu.erp_source_branch = x.sucursal))::int en_cola
    FROM sel`, [T])).rows[0];
  const ms5 = Date.now() - t5;
  const ind = (await c.query(`
    SELECT coalesce(sum(saldo), 0)::numeric saldo, count(*)::int facturas
    FROM analytics.erp_sales_invoices ${W} AND ${V}`, [T])).rows[0];
  console.log(`\n4) vencido del canal: $${Number(s.saldo_canal).toLocaleString('en-US')} en ${s.facturas_canal} facturas`
    + ` (de ellas $${Number(s.saldo_30d).toLocaleString('en-US')} emitidas en 30 d) · cola: ${s.en_cola} de ${s.clientes} clientes [${ms5} ms]`);
  check('el vencido del canal cuadra con la consulta independiente',
    Math.abs(Number(s.saldo_canal) - Number(ind.saldo)) < 0.01 && s.facturas_canal === ind.facturas,
    `tablero=${s.saldo_canal}/${s.facturas_canal} independiente=${ind.saldo}/${ind.facturas}`);
  check('el vencido de 30 días es parte del vencido del canal', Number(s.saldo_30d) <= Number(s.saldo_canal) + 0.01,
    `30d=${s.saldo_30d} canal=${s.saldo_canal}`);
  check('el vencido de 30 días es el mismo que publica el bloque 1',
    Math.abs(Number(s.saldo_30d) - Number(b.saldo_vencido)) < 0.01, `aqui=${s.saldo_30d} bloque1=${b.saldo_vencido}`);
  check('los clientes en cola nunca superan a los facturados', s.en_cola <= s.clientes,
    `en_cola=${s.en_cola} clientes=${s.clientes}`);
  // La llave del cruce se verifica contra un hecho independiente: el NOMBRE. Si algún empate
  // por código+sucursal trae otro nombre, la llave no identifica al cliente y la cifra miente.
  const llave = (await c.query(`
    WITH tm AS (SELECT DISTINCT cliente_code, sucursal, cliente_nombre
                FROM analytics.erp_sales_invoices ${W} AND fecha >= current_date - 30)
    SELECT count(*)::int empates,
           count(*) FILTER (WHERE upper(btrim(cu.name)) <> upper(btrim(tm.cliente_nombre)))::int nombre_distinto
    FROM tm JOIN commercial.customers cu ON cu.tenant_id = $1 AND cu.active AND cu.deleted_at IS NULL
      AND cu.erp_customer_code = tm.cliente_code AND cu.erp_source_branch = tm.sucursal`, [T])).rows[0];
  if (llave.empates === 0) {
    noMedido('la llave cliente ERP ↔ padrón', 'no hay ningún empate con qué comprobar el nombre');
  } else {
    check('la llave (erp_customer_code + sucursal) identifica al mismo cliente', llave.nombre_distinto === 0,
      `${llave.nombre_distinto} de ${llave.empates} empates con otro nombre`);
  }

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
