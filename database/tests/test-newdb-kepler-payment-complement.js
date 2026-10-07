/* eslint-disable no-console */
/**
 * [CB.48] CANDADO — el complemento de pago SAT trae la fecha REAL del cobro, y el decode de sus
 * columnas está anclado a un hecho verificable, no a una corazonada.
 *
 * Kepler guarda el complemento en `kepler_ods.kdfe33pagm1` y nadie lo leía. Adentro está la fecha
 * que CB.44 dio por perdida: la póliza (`kdm1.c9`) trae el día en que se TECLEÓ el cobro — en la
 * sucursal 01 es idéntica a `c68` (captura) — y por eso se declararon **$6,858,008.40** de
 * cobranza 2026 imposibles de conciliar por fecha, con la conclusión de que sólo se arreglaba
 * cambiando cómo captura la gente. Es falso: la fecha real SÍ se captura, en `c7`.
 *
 * El decode se verificó contra una CAPTURA DE PANTALLA del propio Kepler (documento
 * `UA0701-0000214`, sucursal 01), y este candado la convierte en aserción: si alguien renombra o
 * recorre las columnas del complemento, esto se pone rojo en vez de publicar otra cosa.
 *
 * Verifica:
 *   (1) el decode contra la pantalla: fecha+hora, forma de pago, moneda, paridad, monto y
 *       número de operación del documento de la foto;
 *   (2) que ese mismo documento tiene en `kdm1` la fecha valor == fecha captura (el síntoma) y
 *       que el complemento la mueve — o sea que el hallazgo sigue siendo cierto;
 *   (3) la MAGNITUD por sucursal, que es lo que justifica el cambio;
 *   (4) NEGATIVA: la vista no inventa cuentas — una CLABE con un número que no es de nadie no
 *       resuelve `account_label`, y el match exige ≥4 dígitos (con 3 casa por azar);
 *   (5) NEGATIVA: el filtro de réplicas (`c1 = sucursal`) descarta las copias de otra sucursal;
 *       sin él el mismo pago se contaría dos o tres veces;
 *   (6) el árbitro: la CLABE concuerda con el `account_label` que ya deriva el feed — y se
 *       DECLARA la discrepancia, porque un árbitro que nunca contradice es un espejo (ADR-059);
 *   (7) el límite declarado: cuántos documentos quedan fuera del pool de ±45 días del matcher.
 *
 *   node database/tests/test-newdb-kepler-payment-complement.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-00000000d01c';

function resolveUrl() {
  if (process.env.DATABASE_URL_NEW) return process.env.DATABASE_URL_NEW;
  if (process.env.DST_URL) return process.env.DST_URL;
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = env.match(/^FLEET_DB_URL=(.*)$/m);
  if (!m) throw new Error('falta FLEET_DB_URL en .env');
  const url = m[1].trim();
  const { classify } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');
  if (classify(url).kind !== 'prod') throw new Error('FLEET_DB_URL del .env no clasifica como prod');
  console.log('  ⓘ sin DATABASE_URL_NEW: uso FLEET_DB_URL del .env (prod, read-only)');
  return url;
}

/**
 * La vista puede no estar aplicada todavía (la migración va con el deploy). Para que el candado
 * sirva ANTES del deploy, se extrae su cuerpo de la migración y se corre como CTE. Si la vista
 * ya existe se usa la real: así el test vale en los dos mundos y no se queda obsoleto el día
 * que se aplique.
 */
function cuerpoDeLaVista() {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations-newdb', '20260924190000_v_kepler_payment_complement.js'), 'utf8');
  const m = mig.match(/CREATE OR REPLACE VIEW analytics\.v_kepler_payment_complement AS([\s\S]*?)\n {2}`\);/);
  if (!m) throw new Error('no pude extraer el cuerpo de la vista de su migración');
  return m[1];
}
const n = (x) => Number(x) || 0;

(async () => {
  console.log('\n=== [CB.48] Candado complemento de pago SAT: la fecha real del cobro ===\n');
  let ok = 0, fail = 0;
  const pass = (m) => { ok++; console.log('  ✔ ' + m); };
  const bad = (m) => { fail++; console.log('  ✖ ' + m); };

  const url = resolveUrl();
  const c = new Client({ connectionString: url, ssl: /rlwy|railway|proxy/i.test(url) ? { rejectUnauthorized: false } : false, statement_timeout: 240000 });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  if ((await q('select current_database() d'))[0].d !== 'railway') { console.error('ABORT: no es railway'); process.exit(2); }

  const existe = (await q(`select to_regclass('analytics.v_kepler_payment_complement') r`))[0].r;
  const V = existe ? 'analytics.v_kepler_payment_complement' : `(${cuerpoDeLaVista()})`;
  console.log(existe ? '  ⓘ la vista ya existe en la base: se usa la real.'
    : '  ⓘ la vista aún no está aplicada: se ejerce su SQL desde la migración.');

  // ── 1. El decode, contra la pantalla ──────────────────────────────────────────────────────
  const foto = await q(`select sucursal, doc_tipo, folio, pago_at::text pago_at, forma_pago_sat,
      forma_pago_label, moneda, tipo_cambio, monto, num_operacion
    from ${V} v where v.sucursal='01' and v.folio='0000214' and v.doc_tipo='U-A-7'`);
  if (foto.length !== 1) {
    bad(`El documento de la captura (01 / U-A-7 / 0000214) devolvió ${foto.length} filas, esperaba 1`);
  } else {
    const f = foto[0];
    // Los seis valores que se leen en la pantalla de Kepler. Si alguno deja de coincidir, el
    // decode dejó de ser válido y NO se debe seguir publicando la fecha como si fuera cierta.
    const esperado = {
      pago_at: '2026-07-31 16:52:00', forma_pago_sat: '01', forma_pago_label: 'Efectivo',
      moneda: 'MXN', tipo_cambio: 1, monto: 6784, num_operacion: '0000214',
    };
    const difs = Object.entries(esperado).filter(([k, v]) =>
      (typeof v === 'number' ? Math.abs(n(f[k]) - v) > 0.005 : String(f[k]) !== v));
    if (!difs.length) pass('Decode: los 7 campos del doc UA0701-0000214 coinciden con la pantalla de Kepler (31/07/2026 16:52 · Efectivo · MXN · 1.0 · $6,784.00 · op 0000214)');
    else bad(`Decode roto en: ${difs.map(([k, v]) => `${k} esperaba "${v}" y dio "${f[k]}"`).join('; ')}`);
  }

  // ── 2. El síntoma sigue vivo: la póliza no tiene la fecha real ────────────────────────────
  const pol = await q(`select m.c9::date fval, m.c68::date fcap, m.c69 hcap, m.c16::numeric importe
     from kepler_ods.kdm1 m
    where m.sucursal='01' and m.c2='U' and m.c3='A' and m.c4=7 and btrim(m.c6)='0000214'`);
  if (pol.length === 1 && foto.length === 1) {
    const mismaFecha = String(pol[0].fval).slice(0, 10) === String(pol[0].fcap).slice(0, 10);
    const complementoMueve = String(pol[0].fval).slice(0, 10) !== foto[0].pago_at.slice(0, 10);
    if (mismaFecha && complementoMueve) pass(`El síntoma sigue: la póliza trae fecha valor == fecha captura, y el complemento la mueve 12 días atrás`);
    else if (!mismaFecha) console.log('    ⓘ la póliza de este doc ya NO tiene fecha valor == captura: alguien empezó a retrofechar. Revisar si el bloque 3 sigue teniendo magnitud.');
    else bad('El complemento ya no mueve la fecha de este documento: o se corrigió la póliza, o el decode cambió');
  } else bad(`No encontré la póliza del documento de la foto en kdm1 (${pol.length} filas)`);

  // ── 3. La magnitud, que es lo que justifica el cambio ─────────────────────────────────────
  const mag = await q(`
    select k.sucursal, count(*)::int n,
      count(*) FILTER (WHERE k.fecha_valor <> v.fecha_pago)::int n_mueve,
      round(avg(abs(k.fecha_valor - v.fecha_pago)) FILTER (WHERE k.fecha_valor <> v.fecha_pago), 1) dias,
      round(sum(v.monto) FILTER (WHERE k.fecha_valor <> v.fecha_pago), 2) monto
      FROM analytics.kepler_bank_movements k
      JOIN ${V} v ON v.sucursal = k.sucursal AND v.doc_tipo = k.doc_tipo AND v.folio = k.folio
     WHERE k.tenant_id = $1
     GROUP BY 1 ORDER BY 1`, [TENANT]);
  const mueven = mag.filter((r) => n(r.n_mueve) > 0);
  if (mueven.length) {
    const tot = mueven.reduce((s, r) => s + n(r.monto), 0);
    pass(`Magnitud: ${mueven.map((r) => `suc ${r.sucursal} ${r.n_mueve}/${r.n} (${r.dias}d)`).join(' · ')} — $${Math.round(tot).toLocaleString()} que la póliza fechaba mal`);
  } else {
    console.log('    NO MEDIDO — ningún documento mueve la fecha. Si alguien empezó a retrofechar la');
    console.log('    póliza, este cambio dejó de aportar y hay que decirlo, no dar un ✔ vacío.');
  }

  // ── 4. NEGATIVA: la vista no inventa cuentas ──────────────────────────────────────────────
  const inventada = await q(`select count(*)::int n from ${V} v
     where v.account_label IS NOT NULL
       and not exists (select 1 from finance.bank_accounts ba
                        where ba.tenant_id=$1 and ba.account_label = v.account_label)`, [TENANT]);
  if (n(inventada[0].n) === 0) pass('Negativa: toda cuenta resuelta existe en finance.bank_accounts — la vista no inventa');
  else bad(`${n(inventada[0].n)} filas resuelven a una cuenta que no existe`);

  const cortas = await q(`select count(*)::int n from finance.bank_accounts
     where tenant_id=$1 and account_label is not null and length(account_label) < 4`, [TENANT]);
  const usaCortas = await q(`select count(*)::int n from ${V} v
     join finance.bank_accounts ba on ba.tenant_id=$1 and ba.account_label = v.account_label
     where length(ba.account_label) < 4`, [TENANT]);
  if (n(usaCortas[0].n) === 0) pass(`Negativa: las ${n(cortas[0].n)} cuentas de <4 dígitos nunca resuelven una CLABE (con 3 dígitos casa por azar)`);
  else bad(`${n(usaCortas[0].n)} filas resolvieron con una cuenta de menos de 4 dígitos`);

  // ── 5. NEGATIVA: el filtro de réplicas ────────────────────────────────────────────────────
  const crudo = (await q(`select count(*)::int n from kepler_ods.kdfe33pagm1`))[0];
  const filtrado = (await q(`select count(*)::int n from ${V} v`))[0];
  const replicas = n(crudo.n) - n(filtrado.n);
  if (replicas > 0) pass(`Negativa: el filtro c1=sucursal descarta ${replicas} réplica(s) de otra sucursal (${crudo.n} crudas → ${filtrado.n})`);
  else if (replicas === 0) console.log('    ⓘ hoy no hay réplicas cruzadas en el complemento: bloque 5 NO MEDIDO (el filtro sigue puesto).');
  else bad('La vista devuelve MÁS filas que la tabla cruda: el join está multiplicando');

  const dup = await q(`select count(*)::int n from (select sucursal, doc_tipo, folio from ${V} v
     group by 1,2,3 having count(*) > 1) x`);
  if (n(dup[0].n) === 0) pass('La llave (sucursal, doc_tipo, folio) es única — el complemento no duplica pagos');
  else bad(`${n(dup[0].n)} llaves duplicadas: el mismo pago contaría dos veces`);

  // ── 6. El árbitro: la CLABE contra el account_label que ya deriva el feed ─────────────────
  const arb = await q(`
    select count(*)::int total,
           count(*) FILTER (WHERE k.account_label = v.account_label)::int coincide,
           count(*) FILTER (WHERE k.account_label <> v.account_label)::int contradice
      FROM analytics.kepler_bank_movements k
      JOIN ${V} v ON v.sucursal = k.sucursal AND v.doc_tipo = k.doc_tipo AND v.folio = k.folio
     WHERE k.tenant_id = $1 AND v.account_label IS NOT NULL AND k.account_label IS NOT NULL`, [TENANT]);
  const a = arb[0];
  if (n(a.total) === 0) console.log('    ⓘ sin transferencias con CLABE: bloque 6 NO MEDIDO.');
  else {
    // Un decimal, y nunca "100%" con contradicciones vivas: 201/202 redondea a 100 y quedaba
    // un ✔ que decía "perfecto" con una discrepancia impresa dos renglones abajo.
    const crudo2 = (100 * n(a.coincide)) / n(a.total);
    const pct = n(a.contradice) > 0 ? Math.min(99.9, Math.floor(crudo2 * 10) / 10) : 100;
    pass(`Árbitro: la CLABE del complemento concuerda con el account_label del feed en ${a.coincide}/${a.total} (${pct}%)`);
    // ADR-059: un árbitro que nunca contradice es un espejo. Si contradice, se DECLARA — no se
    // rompe el test, porque la discrepancia es el hallazgo, no el fallo.
    if (n(a.contradice) > 0) {
      const detalle = await q(`select k.sucursal, k.folio, k.account_label feed, v.account_label clabe, v.monto
          FROM analytics.kepler_bank_movements k
          JOIN ${V} v ON v.sucursal=k.sucursal AND v.doc_tipo=k.doc_tipo AND v.folio=k.folio
         WHERE k.tenant_id=$1 AND v.account_label IS NOT NULL AND k.account_label IS NOT NULL
           AND k.account_label <> v.account_label
         ORDER BY v.monto DESC LIMIT 5`, [TENANT]);
      console.log(`    ⚠️ DECLARADO: ${a.contradice} caso(s) donde los dos testigos NO coinciden —`);
      for (const d of detalle) console.log(`       suc ${d.sucursal} folio ${d.folio}: feed dice ${d.feed}, la CLABE dice ${d.clabe} ($${Math.round(n(d.monto)).toLocaleString()})`);
      console.log('       Dos fuentes independientes discrepando es señal, no ruido: hay que arbitrarlo.');
    } else {
      console.log('    ⓘ cero contradicciones. Ojo: un árbitro que NUNCA contradice puede ser un espejo');
      console.log('       de la misma fuente (ADR-059) — vale la pena confirmar que son independientes.');
    }
  }

  // ── 7. El límite declarado del pool de ±45 días ───────────────────────────────────────────
  const fuera = await q(`
    select count(*)::int n, round(coalesce(sum(v.monto),0), 2) monto
      FROM analytics.kepler_bank_movements k
      JOIN ${V} v ON v.sucursal = k.sucursal AND v.doc_tipo = k.doc_tipo AND v.folio = k.folio
     WHERE k.tenant_id = $1 AND abs(k.fecha_valor - v.fecha_pago) > 45`, [TENANT]);
  console.log(`    ⓘ LÍMITE declarado: ${n(fuera[0].n)} documento(s) ($${Math.round(n(fuera[0].monto)).toLocaleString()}) tienen la póliza a más de`);
  console.log('       45 días de su pago real, así que quedan fuera del pool del matcher, que se acota por fecha_valor.');
  if (n(fuera[0].n) <= 10) pass(`El límite del pool de ±45 días deja fuera ${n(fuera[0].n)} documento(s) — marginal y declarado`);
  else bad(`${n(fuera[0].n)} documentos fuera del pool: dejó de ser marginal, hay que ampliar la ventana o filtrar por fecha efectiva`);

  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
