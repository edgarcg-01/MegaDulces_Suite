/* eslint-disable no-console */
/**
 * [CB.49] CANDADO — las pestañas de /finanzas/bancos miran la MISMA fecha.
 *
 * CB.48 metió la fecha real del complemento SAT sólo en `runMatchTreasury`. Resultado medido: el
 * cobro `UA0701-0000214` quedó **casado en la base y «En ContPAQi» en pantalla, a la vez** — la
 * pestaña Cuadre arma su propio pareo con su propio pool, y ese pool seguía acotado por
 * `fecha_valor`. Arreglar un consumidor y no los demás no es un arreglo: es una desincronización.
 *
 * El resolvedor subió a la vista (`analytics.kepler_bank_movements.fecha_efectiva`) y este candado
 * cuida las dos mitades del invariante:
 *
 *   (A) EN LA BASE — la columna existe, `fecha_efectiva = COALESCE(complemento, póliza)` sin
 *       excepción, el LEFT JOIN no multiplica filas, y `fecha_valor` NO cambió de significado
 *       (la siguen leyendo Caja General, `mv_caja_movimientos` y `db-health`).
 *   (B) EN EL CÓDIGO — ninguna consulta del servicio de bancos vuelve a acotar la vista por
 *       `fecha_valor`. Es una compuerta de texto, y sirve para lo que sirve: detectar que alguien
 *       agregó una consulta nueva con el filtro viejo. No prueba que el resto esté bien — eso lo
 *       prueba (A) y el resto de la suite.
 *
 * Y mide el efecto que justifica todo: cuántos documentos cambian de mes al usar la fecha real, y
 * cuántos de ésos tienen su depósito esperándolos en el banco.
 *
 *   node database/tests/test-newdb-bank-fecha-efectiva.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SERVICIO = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'bank', 'finance-bank.service.ts');

function resolveUrl() {
  const e = process.env;
  const url = e.DATABASE_URL_NEW_PROD || e.PROD_DB_URL || e.DATABASE_URL_NEW || e.DST_URL || (() => {
    const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
    const m = env.match(/^FLEET_DB_URL=(.*)$/m);
    if (!m) throw new Error('falta una URL: definí PROD_DB_URL (192.168.0.222:5434/railway)');
    console.log('  ⚠️ sin PROD_DB_URL: uso FLEET_DB_URL, que en un escritorio es Railway — la prod VIEJA.');
    return m[1].trim();
  })();
  return url;
}
const n = (x) => Number(x) || 0;

(async () => {
  console.log('\n=== [CB.49] Candado fecha_efectiva: las pestañas miran la misma fecha ===\n');
  let ok = 0, fail = 0;
  const pass = (m) => { ok++; console.log('  ✔ ' + m); };
  const bad = (m) => { fail++; console.log('  ✖ ' + m); };

  // ── (B) EL CÓDIGO ─────────────────────────────────────────────────────────────────────────
  // Se corre PRIMERO y sin DB: es la mitad que atrapa la regresión más probable — alguien
  // agrega una consulta nueva copiando una vieja.
  const src = fs.readFileSync(SERVICIO, 'utf8');
  const filtrosViejos = src.split('\n')
    .map((l, i) => ({ l: l.trim(), i: i + 1 }))
    .filter((x) => /andWhere\(\s*'k?\.?fecha_valor'/.test(x.l) || /\bfecha_valor\s*>=\s*:/.test(x.l));
  if (!filtrosViejos.length) pass('Código: ninguna consulta del servicio acota la vista por `fecha_valor`');
  else bad(`Código: ${filtrosViejos.length} filtro(s) siguen en fecha_valor → ${filtrosViejos.map((x) => 'L' + x.i).join(', ')}`);

  // Y que sí se esté usando la nueva: si alguien revirtiera la vista, el grep de arriba pasaría
  // en verde por vacío. Una compuerta que se aprueba sola no es compuerta.
  const usos = (src.match(/fecha_efectiva/g) || []).length;
  if (usos >= 10) pass(`Código: ${usos} referencias a \`fecha_efectiva\` — la compuerta de arriba no está pasando por vacío`);
  else bad(`Código: sólo ${usos} referencias a fecha_efectiva; se esperaban ≥10 (¿se revirtió el cambio?)`);

  // ── (A) LA BASE ───────────────────────────────────────────────────────────────────────────
  const url = resolveUrl();
  const c = new Client({ connectionString: url, ssl: /rlwy|railway|proxy/i.test(url) && !/192\.168\./.test(url) ? { rejectUnauthorized: false } : false, statement_timeout: 240000 });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  const ident = (await q(`select current_database() db, (select system_identifier from pg_control_system())::text cid`))[0];
  console.log(`  ⓘ destino: ${ident.db} · cluster ${ident.cid}${ident.cid === '7688376744939610156' ? ' (PROD REAL)' : ' ⚠️ NO es el cluster de prod'}`);

  const tiene = await q(`select count(*)::int n from information_schema.columns
     where table_schema='analytics' and table_name='kepler_bank_movements' and column_name in ('fecha_efectiva','fecha_pago_sat')`);
  if (n(tiene[0].n) !== 2) {
    console.log('\n  ⓘ la vista todavía no tiene las columnas (migración 20260924230000 sin aplicar).');
    console.log('    NO MEDIDO — los bloques de base se saltan; esto no es un ✔.');
    console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
    await c.end();
    process.exit(fail ? 1 : 0);
  }
  pass('La vista expone `fecha_efectiva` y `fecha_pago_sat`');

  // El invariante de la columna, sin excepción posible.
  const mal = await q(`select count(*)::int n from analytics.kepler_bank_movements
     where fecha_efectiva is distinct from coalesce(fecha_pago_sat, fecha_valor)`);
  if (n(mal[0].n) === 0) pass('`fecha_efectiva` == COALESCE(complemento, póliza) en el 100% de las filas');
  else bad(`${n(mal[0].n)} filas donde fecha_efectiva no es el COALESCE esperado`);

  // NEGATIVA: el LEFT JOIN al complemento no puede multiplicar. Si multiplicara, cada importe se
  // contaría dos veces y TODO el módulo (cuadres, totales, conciliación) quedaría inflado.
  const dup = await q(`select count(*)::int n from (
      select sucursal, doc_tipo, folio, pierna, clave_banco, count(*) c
        from analytics.kepler_bank_movements group by 1,2,3,4,5 having count(*) > 1) x`);
  if (n(dup[0].n) === 0) pass('Negativa: el join al complemento NO multiplica filas (llave única por pierna)');
  else bad(`${n(dup[0].n)} llaves duplicadas: el join está multiplicando y todos los totales están inflados`);

  // `fecha_valor` sigue siendo la PÓLIZA. Lo cuidan los consumidores que no son de banco.
  const poliza = await q(`select count(*)::int n from analytics.kepler_bank_movements k
     where exists (select 1 from analytics.v_kepler_payment_complement v
                    where v.sucursal=k.sucursal and v.doc_tipo=k.doc_tipo and v.folio=k.folio
                      and v.fecha_pago <> k.fecha_valor)`);
  if (n(poliza[0].n) > 0) pass(`\`fecha_valor\` NO cambió: ${n(poliza[0].n)} filas la conservan distinta del pago real (la usan Caja General, mv_caja_movimientos y db-health)`);
  else console.log('    ⓘ ninguna fila difiere hoy: bloque «fecha_valor intacta» NO MEDIDO.');

  // ── El efecto que justifica el cambio ─────────────────────────────────────────────────────
  const efecto = await q(`
    select count(*)::int cruzan_de_mes, round(coalesce(sum(k.importe),0)) monto,
      count(*) FILTER (WHERE EXISTS (
        select 1 from finance.bank_movements bm
        join finance.bank_accounts ba on ba.id = bm.bank_account_id
        where bm.deleted_at is null and ba.account_label = k.account_label
          and round(bm.amount_in,2) = round(k.importe,2)
          and bm.movement_date between k.fecha_efectiva - 3 and k.fecha_efectiva + 3))::int con_deposito
    from analytics.kepler_bank_movements k
    where k.tenant_id = $1
      and to_char(k.fecha_efectiva,'YYYY-MM') <> to_char(k.fecha_valor,'YYYY-MM')`, [TENANT]);
  const e = efecto[0];
  if (n(e.cruzan_de_mes) > 0) {
    pass(`Efecto: ${e.cruzan_de_mes} documentos cambian de mes con la fecha real ($${Math.round(n(e.monto)).toLocaleString()}), y ${e.con_deposito} tienen su depósito esperándolos en el banco`);
  } else {
    console.log('    ⓘ ningún documento cruza de mes: NO MEDIDO. Si alguien empezó a retrofechar la');
    console.log('    póliza, este cambio dejó de aportar — y eso hay que decirlo, no dar un ✔ vacío.');
  }

  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
