/**
 * AX.9 — candado de paridad: partir `customer_receivables` en dos NO puede mover un peso.
 *
 * Corre la definición NUEVA (leída de la migración, no reescrita a mano: si el test copia el
 * SQL, deja de probar lo que se despliega) como subconsulta, y la compara fila a fila contra
 * la vista que está viva. Sirve en los dos momentos:
 *   · ANTES de aplicar   -> la vista viva es la vieja  -> valida el cambio.
 *   · DESPUES de aplicar -> la vista viva es la nueva  -> vale como regresión (0 por construcción).
 * Por eso imprime cuál de los dos casos midió, en vez de ponerse verde en ambos sin decir nada.
 *
 * Read-only: no crea, no aplica, no borra. Uso: node database/tests/test-newdb-receivable-core-parity.js
 */
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

const mig = require('../migrations-newdb/20260905150000_erp_receivable_documents_core.js');

// Misma precedencia que el resto de la suite. Para validar contra prod ANTES de aplicar:
//   DATABASE_URL_NEW=<url de prod> node database/tests/test-newdb-receivable-core-parity.js
const URL = process.env.DATABASE_URL_NEW || process.env.FLEET_DB_URL;

/** `CREATE OR REPLACE VIEW x AS <cuerpo>` -> `<cuerpo>`. */
const cuerpo = (sql) => sql.replace(/^\s*CREATE\s+OR\s+REPLACE\s+VIEW\s+[\w.]+\s+AS\s*/i, '').trim();

/** La cartera nueva, con el núcleo inline (la vista aún puede no existir). */
function carteraNueva() {
  return cuerpo(mig.CARTERA_SQL).replace(
    'WITH base AS (SELECT * FROM analytics.erp_receivable_documents)',
    `WITH base AS (${cuerpo(mig.CORE_SQL)})`,
  );
}

// Las 29 columnas del contrato público, en su orden.
const COLS = [
  'tenant_id', 'sucursal', 'doc_code', 'doc_tipo', 'doc_label', 'folio', 'folio_digital',
  'cliente_code', 'grupo', 'zona', 'fecha', 'vencimiento', 'importe', 'cargo_abono',
  'signed_amount', 'referencia', 'vendedor', 'moneda', 'source_branch', 'saldo_documento',
  'aplicaciones', 'limite_credito', 'dias_credito', 'telefono', 'saldo_ajustado',
  'saldo_cliente', 'dias_pago', 'estatus',
]; // `computed_at` queda fuera a propósito: es now(), cambia entre las dos lecturas.

let ok = 0, fail = 0, skip = 0;
const check = (nombre, cond, detalle = '') => {
  if (cond) { ok++; console.log(`  OK   ${nombre}`); }
  else { fail++; console.log(`  FAIL ${nombre} ${detalle}`); }
};
/** Lo que no se pudo medir se DECLARA; nunca se pone verde por falta de datos (ADR-056). */
const noMedido = (nombre, motivo) => { skip++; console.log(`  NO MEDIDO  ${nombre} — ${motivo}`); };

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW_PROD / FLEET_DB_URL'); process.exit(1); }
  const c = new Client({ connectionString: URL, ssl: false });
  await c.connect();
  console.log('\n=== AX.9 paridad customer_receivables (vieja vs núcleo) ===');

  const yaAplicada = (await c.query(
    `SELECT count(*)::int n FROM pg_views WHERE schemaname='analytics' AND viewname='erp_receivable_documents'`,
  )).rows[0].n > 0;
  console.log(`  modo: ${yaAplicada ? 'REGRESION (la migración ya está aplicada)' : 'PRE-APLICACION (valida el cambio)'}`);

  const NUEVA = carteraNueva();
  const sel = COLS.map((k) => `${k}::text AS ${k}`).join(', ');

  // 1) mismo número de filas
  const conteo = (await c.query(`
    SELECT (SELECT count(*) FROM analytics.customer_receivables)::bigint AS vieja,
           (SELECT count(*) FROM (${NUEVA}) x)::bigint AS nueva`)).rows[0];
  check('mismo número de filas', conteo.vieja === conteo.nueva, `vieja=${conteo.vieja} nueva=${conteo.nueva}`);

  // 2) diferencia simétrica sobre las 29 columnas -> tiene que ser cero en ambos sentidos
  const diff = (await c.query(`
    WITH v AS (SELECT ${sel} FROM analytics.customer_receivables),
         n AS (SELECT ${sel} FROM (${NUEVA}) x)
    SELECT (SELECT count(*) FROM (SELECT * FROM v EXCEPT ALL SELECT * FROM n) a)::bigint AS solo_vieja,
           (SELECT count(*) FROM (SELECT * FROM n EXCEPT ALL SELECT * FROM v) b)::bigint AS solo_nueva`)).rows[0];
  check('cero filas sólo en la vieja', diff.solo_vieja === '0', `solo_vieja=${diff.solo_vieja}`);
  check('cero filas sólo en la nueva', diff.solo_nueva === '0', `solo_nueva=${diff.solo_nueva}`);

  // 3) los totales de dinero, explícitos (una diferencia compensada entre filas no aparecería arriba)
  const money = (await c.query(`
    SELECT round((SELECT sum(saldo_ajustado) FROM analytics.customer_receivables),2) AS aj_vieja,
           round((SELECT sum(saldo_ajustado) FROM (${NUEVA}) x),2) AS aj_nueva,
           round((SELECT sum(signed_amount) FROM analytics.customer_receivables),2) AS sg_vieja,
           round((SELECT sum(signed_amount) FROM (${NUEVA}) y),2) AS sg_nueva`)).rows[0];
  check('Σ saldo_ajustado idéntico', money.aj_vieja === money.aj_nueva, `${money.aj_vieja} vs ${money.aj_nueva}`);
  check('Σ signed_amount idéntico', money.sg_vieja === money.sg_nueva, `${money.sg_vieja} vs ${money.sg_nueva}`);

  // 4) cobertura del núcleo sobre las facturas de venta que consume /comercial/documentos.
  //
  // Se mide SÓLO sobre documentos MADUROS (>= 30 días). Un documento de ayer que todavía no
  // está en `kdue` no es un hueco, es replicación en camino: medido en el `.245`, los faltantes
  // caen 64.7% (mes en curso) -> 12.6% -> 2.2% -> 0% (hace 3 meses). En prod, al día, son 9 de
  // 738 (1.2%). Un umbral sobre la ventana completa convertiría el rezago de un entorno de
  // desarrollo en un rojo permanente, y a un rojo permanente nadie le hace caso.
  if (yaAplicada) {
    const cob = (await c.query(`
      SELECT count(*) FILTER (WHERE i.fecha <= current_date - 30)::int maduros,
             count(*) FILTER (WHERE i.fecha <= current_date - 30 AND d.folio IS NULL)::int maduros_sin,
             count(*) FILTER (WHERE i.fecha > current_date - 30)::int recientes,
             count(*) FILTER (WHERE i.fecha > current_date - 30 AND d.folio IS NULL)::int recientes_sin
      FROM analytics.erp_sales_invoices i
      LEFT JOIN analytics.erp_receivable_documents d
        ON d.sucursal=i.sucursal AND d.doc_code=i.doc_prefix AND d.folio=i.folio AND d.cargo_abono='C'
      WHERE i.fecha >= current_date - 180 AND NOT i.cancelada`)).rows[0];
    if (cob.maduros > 0) {
      const pct = (100 * (cob.maduros - cob.maduros_sin)) / cob.maduros;
      check('cobertura del núcleo sobre facturas maduras (>= 30d) ≥ 97%', pct >= 97,
        `${pct.toFixed(1)}% (${cob.maduros - cob.maduros_sin}/${cob.maduros})`);
      console.log(`       maduras: ${pct.toFixed(2)}% cubiertas · ${cob.maduros_sin} sin rastro en cartera`);
    } else {
      noMedido('cobertura sobre facturas maduras', 'no hay facturas de más de 30 días en la ventana');
    }
    // Las recientes se INFORMAN, no se asertan: acá el faltante todavía puede ser rezago.
    const pctR = cob.recientes ? (100 * (cob.recientes - cob.recientes_sin)) / cob.recientes : 0;
    console.log(`       recientes (<30d): ${pctR.toFixed(2)}% cubiertas · ${cob.recientes_sin} aún sin llegar `
      + '(informativo: en este tramo el faltante puede ser replicación en camino)');
  } else {
    noMedido('cobertura del núcleo', 'la vista aún no existe; se mide tras aplicar la migración');
  }

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
