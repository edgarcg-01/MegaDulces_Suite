'use strict';
/**
 * `[MKT.13]` Smoke HTTP del ranking de promociones e incentivos — con los payloads de la pantalla.
 *
 * Corre contra la API LOCAL (la que tiene la semilla `dev-seed-mkt-ranking.js`) y CRUZA cada cifra
 * contra una segunda implementación: SQL directo sobre la base. Probar el servicio contra sí mismo
 * pasa los errores en verde.
 *
 *   node database/scripts/dev-seed-mkt-ranking.js
 *   node database/tests/http-mkt-ranking-test.js [--api http://127.0.0.1:3334] [--user u --password p]
 *
 * Escribe (alta de una promo, objetivos, un incentivo) y lo BORRA al final, pase lo que pase.
 * ⛔ Sólo local.
 */
require('dotenv').config();
const { assertSafeTarget } = require('./_lib/assert-safe-target');
const { Client } = require('pg');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const API = arg('--api', 'http://127.0.0.1:3334').replace(/\/+$/, '') + '/api';
const USER = arg('--user', 'demo_flujo');
const PASS = arg('--password', 'demo_flujo');
const URL = (process.env.DATABASE_URL_NEW || '').replace('localhost', '127.0.0.1');

let ok = 0, mal = 0;
const check = (cond, msg, extra) => {
  if (cond) { ok++; console.log('  ✔ ' + msg); }
  else { mal++; console.log('  ✖ ' + msg + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
};
async function http(method, path, token, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, json };
}

(async () => {
  assertSafeTarget('http-mkt-ranking-test', { url: URL });
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(API)) throw new Error('Sólo contra la API local');
  const db = new Client({ connectionString: URL });
  await db.connect();
  const creados = { promo: null, incentivo: null };
  // Lo que «sugerir y aplicar» escriba en OTRAS promos también se deshace: la prueba no ensucia la semilla.
  const { rows: [{ t0 }] } = await db.query('SELECT now() t0');
  let token = null;
  try {
    const login = await http('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: USER, password: PASS });
    token = login.json?.access_token;
    if (!token) throw new Error('No se pudo iniciar sesión en la API local');

    console.log('\n[1] Permisos');
    check((await http('GET', '/commercial/mkt-ranking', null)).status === 401, 'sin sesión: 401');

    console.log('\n[2] Ranking de la última semana cerrada, mostrador');
    const r = await http('GET', '/commercial/mkt-ranking?canal=mostrador', token);
    check(r.status === 200, 'responde 200', r.status);
    const rk = r.json;
    check(rk.semana && rk.semana.en_curso === false, 'por omisión: la última semana CERRADA', rk.semana);
    check(rk.participantes.length === 8, 'las 8 sucursales participan', rk.participantes.length);
    const lugares = rk.participantes.filter((p) => p.lugar !== null).map((p) => p.puntaje);
    check(lugares.every((v, i) => i === 0 || lugares[i - 1] >= v), 'el lugar sigue al puntaje (descendente)');
    check(rk.participantes.every((p) => p.promos.every((x) => x.cubrimiento === null || x.cubrimiento <= 1)), '⭐ ningún cubrimiento pasa de 100 %');
    const sinObj = rk.participantes[0].promos.filter((x) => x.objetivo === null);
    check(sinObj.length === 2 && sinObj.every((x) => x.cubrimiento === null), '⭐ las 2 promos sin objetivo (DM007/DM008) van en NULL, no en 0', sinObj.map((x) => x.code));

    // Segunda implementación: la venta de DM001 en Padre Hidalgo esa semana, con SQL directo.
    const ph = rk.participantes.find((p) => p.warehouse_code === '01');
    const dm001 = ph.promos.find((x) => x.code === 'DM001');
    const { rows: [v] } = await db.query(
      `SELECT coalesce(sum(qty),0)::numeric q FROM analytics.v_kepler_sales_lines
        WHERE warehouse_code='01' AND sku='DM001' AND canal='mostrador' AND business_date BETWEEN $1 AND $2`,
      [rk.semana.lunes, rk.semana.domingo]);
    check(Number(v.q) === dm001.venta, '⭐ venta DM001 en Padre Hidalgo = SQL directo', { api: dm001.venta, sql: Number(v.q) });
    const { rows: [o] } = await db.query(
      `SELECT objetivo_semanal::numeric o FROM commercial.mkt_ranking_objectives o JOIN commercial.mkt_ranking_promos p ON p.id=o.promo_id
        WHERE p.code='DM001' AND o.warehouse_code='01' AND o.canal='mostrador' AND p.deleted_at IS NULL`);
    check(Math.abs(Math.min(1, Number(v.q) / Number(o.o)) - dm001.cubrimiento) < 1e-9, 'cubrimiento = min(1, venta/objetivo) con el objetivo de la tabla');
    const conObj = ph.promos.filter((x) => x.objetivo !== null);
    const prom = conObj.reduce((a, x) => a + x.cubrimiento, 0) / conObj.length;
    check(Math.abs(prom - ph.puntaje) < 1e-9, 'el puntaje es el promedio de las promos CON objetivo', { api: ph.puntaje, calc: prom });

    console.log('\n[2b] [MKT.15] El producto de cada promo (derivado del ticket)');
    check(dm001.productos_metodo === 'ticket_y_nombre' && dm001.productos.map((x) => x.sku).join() === 'DM201,DM202',
      '⭐ DM001 «3 LECHES» → sus dos leches, y nada más (el chocolate del mismo ticket no)', dm001.productos.map((x) => x.sku));
    const { rows: [lp] } = await db.query(
      `SELECT coalesce(sum(qty),0)::numeric q FROM analytics.v_kepler_sales_lines
        WHERE warehouse_code='01' AND sku='DM201' AND canal='mostrador' AND business_date BETWEEN $1 AND $2`,
      [rk.semana.lunes, rk.semana.domingo]);
    const le = dm001.productos.find((x) => x.sku === 'DM201');
    check(Number(lp.q) === le.unidades && Math.abs(le.cajas - Number(lp.q) / 12) < 0.01,
      '⭐ piezas de leche en Padre Hidalgo = SQL directo, cajas = piezas ÷ 12', { api: le, sql: Number(lp.q) });

    console.log('\n[3] Otros canales');
    for (const c of ['preventa', 'ruta', 'mayoreo']) {
      const x = await http('GET', `/commercial/mkt-ranking?canal=${c}`, token);
      check(x.status === 200 && x.json.participantes.length > 0 && x.json.participantes.every((p) => p.vendor_code), `${c}: participan vendedores`, x.json?.participantes?.length);
    }
    check((await http('GET', '/commercial/mkt-ranking?semana=2099-01-05', token)).status === 400, '[negativa] semana futura: 400');

    console.log('\n[4] Alta de una promoción (payload de la pantalla)');
    const cods = await http('GET', '/commercial/mkt-ranking/codigos-kepler?q=DM009', token);
    check(cods.status === 200 && cods.json.some((c) => c.code === 'DM009' && !c.ya_registrada), 'DM009 aparece y no está dada de alta');
    const alta = await http('POST', '/commercial/mkt-ranking/promos', token, {
      code: 'dm009', descripcion_kepler: '10 BLS PAQUETE DEMO = GRATIS 1 BLS', mecanica: '10 bolsas paquete = gratis 1',
      vigencia_desde: rk.semana.lunes, vigencia_hasta: null, canales: ['mostrador', 'ruta'], warehouse_codes: null,
    });
    check(alta.status === 201 && alta.json.code === 'DM009', 'alta 201, código normalizado a mayúsculas', alta.status);
    creados.promo = alta.json?.id;
    // ⭐ NEGATIVA [MKT.15]: DM009 se vende junto con otras promos y sus productos, pero ninguno se
    // llama como lo que pide: se DECLARA sin identificar, no se adivina el más frecuente.
    const lista = await http('GET', '/commercial/mkt-ranking/promos', token);
    const p9 = lista.json.find((p) => p.code === 'DM009');
    check(p9?.productos?.metodo === 'sin_identificar' && p9.productos.productos.length === 0 && p9.productos.tickets > 0,
      '⭐ [negativa] DM009 tiene tickets pero ningún producto coincide: «sin identificar»', p9?.productos);
    check((await http('POST', '/commercial/mkt-ranking/promos', token, { code: 'DM009', mecanica: 'x', vigencia_desde: '2026-11-10', vigencia_hasta: '2026-11-01' })).status === 400, '[negativa] fin antes de inicio: 400');
    check((await http('POST', '/commercial/mkt-ranking/promos', token, { code: 'DM009', mecanica: 'xxx', vigencia_desde: '2026-11-10', canales: ['vecinal'] })).status === 400, '[negativa] canal inventado: 400');

    console.log('\n[5] Objetivos');
    const sug = await http('POST', '/commercial/mkt-ranking/objetivos/sugerir', token, { semana: null, aplicar: false });
    const sugDm9 = sug.json.sugeridos.filter((s) => s.promo_id === creados.promo && s.canal === 'mostrador');
    const { rows: [dm1] } = await db.query(`SELECT id FROM commercial.mkt_ranking_promos WHERE code='DM001' AND deleted_at IS NULL`);
    const sugDm1 = sug.json.sugeridos.filter((s) => s.promo_id === dm1.id && s.canal === 'mostrador' && s.sugerido !== null);
    check(sug.status === 201 && sugDm1.length === 8 && sugDm1.every((s) => s.semanas_historia === 4), 'DM001 (vigente desde hace 5 semanas): sugerido en las 8 sucursales con 4 semanas de historia', sugDm1.length);
    // ⭐ DM009 empieza ESA semana: la venta de antes de su alta no cuenta (Kepler reutiliza códigos).
    check(sugDm9.length === 0, '⭐ una promo que empieza esa semana no tiene historia: no se inventa un sugerido', sugDm9.length);
    const sinAplicar = await db.query(`SELECT count(*) FROM commercial.mkt_ranking_objectives WHERE promo_id=$1`, [creados.promo]);
    check(Number(sinAplicar.rows[0].count) === 0, '⭐ sugerir SIN aplicar no escribe nada');
    const put = await http('PUT', `/commercial/mkt-ranking/promos/${creados.promo}/objetivos`, token, {
      items: [
        { warehouse_code: '01', canal: 'mostrador', vendor_code: '', objetivo_semanal: 5, fuente: 'manual' },
        { warehouse_code: '02', canal: 'mostrador', vendor_code: '', objetivo_semanal: sugDm9.find((s) => s.warehouse_code === '02')?.sugerido ?? 2, fuente: 'sugerido' },
      ],
    });
    check(put.status === 200 && put.json.guardados === 2, 'guardar 2 objetivos', put.json);
    const aplicar = await http('POST', '/commercial/mkt-ranking/objetivos/sugerir', token, { semana: null, aplicar: true, canal: 'mostrador' });
    const { rows: [pf] } = await db.query(`SELECT objetivo_semanal::numeric o, fuente FROM commercial.mkt_ranking_objectives WHERE promo_id=$1 AND warehouse_code='01'`, [creados.promo]);
    check(aplicar.status === 201 && Number(pf.o) === 5 && pf.fuente === 'manual', '⭐ sugerir y APLICAR no pisa el objetivo capturado a mano', pf);
    const quitar = await http('PUT', `/commercial/mkt-ranking/promos/${creados.promo}/objetivos`, token, {
      items: [{ warehouse_code: '01', canal: 'mostrador', vendor_code: '', objetivo_semanal: null }] });
    check(quitar.json?.quitados === 1, 'vaciar un objetivo lo quita (vuelve a «sin objetivo», no a 0)', quitar.json);
    check((await http('PUT', `/commercial/mkt-ranking/promos/${creados.promo}/objetivos`, token, { items: [{ warehouse_code: 'x', canal: 'mostrador', objetivo_semanal: 3 }] })).status === 400, '[negativa] sucursal inválida: 400');
    const r2 = await http('GET', '/commercial/mkt-ranking?canal=mostrador', token);
    check(r2.json.promos_vigentes === rk.promos_vigentes + 1, 'la promo dada de alta ya cuenta en el ranking', { antes: rk.promos_vigentes, despues: r2.json.promos_vigentes });

    console.log('\n[6] Dar de baja = terminar ayer (las semanas pasadas no cambian)');
    const baja = await http('PATCH', `/commercial/mkt-ranking/promos/${creados.promo}`, token, { vigencia_hasta: rk.semana.domingo });
    check(baja.status === 200 && baja.json.vigencia_hasta === rk.semana.domingo, 'termina el domingo de esa semana');
    const r3 = await http('GET', '/commercial/mkt-ranking?canal=mostrador', token);
    check(r3.json.promos_vigentes === rk.promos_vigentes + 1, 'la semana que ya pasó la sigue contando');

    console.log('\n[7] Incentivos');
    const inc = await http('GET', `/commercial/mkt-ranking/incentivos?semana=${rk.semana.lunes}`, token);
    check(inc.status === 200 && inc.json.incentivos.length >= 4, 'los 4 incentivos de la semilla', inc.json?.incentivos?.length);
    const choc = inc.json.incentivos.find((i) => i.skus.includes('DM101') && i.tipo === 'por_caja');
    // Segunda implementación: cajas acumuladas por vendedor = unidades / 14, desde el inicio hasta el domingo.
    const { rows: cajas } = await db.query(
      `SELECT vendor_code, sum(qty)/14.0 cajas FROM analytics.v_kepler_sales_lines
        WHERE sku='DM101' AND canal = ANY($1) AND business_date BETWEEN $2 AND $3 GROUP BY 1`,
      [choc.canales, choc.vigencia_desde, rk.semana.domingo]);
    const total = cajas.reduce((a, x) => a + Math.round(Number(x.cajas) * 100) / 100 * choc.pago, 0);
    check(Math.abs(total - choc.total_acumulado) < 0.05 * cajas.length, '⭐ pago por caja acumulado = SQL directo (unidades / factor 14 × $50)', { api: choc.total_acumulado, sql: Math.round(total * 100) / 100 });
    check(choc.regla === '$50.00 por caja vendida', 'la regla se lee igual que se paga', choc.regla);
    const monto = inc.json.incentivos.find((i) => i.tipo === 'por_monto');
    const r0 = monto.resultados[0];
    check(Math.abs(r0.acumulado_pago - r0.acumulado_unidades * 5) < 0.01 && r0.acumulado_cantidad > 0, 'por monto: pago = bloques de $120 × $5');
    const altaInc = await http('POST', '/commercial/mkt-ranking/incentivos', token, {
      nombre: 'Prueba HTTP', tipo: 'por_captura', pago: 5, base_monto: null, redondeo: 'proporcional', skus: [],
      vigencia_desde: rk.semana.lunes, vigencia_hasta: null, canales: ['ruta'], warehouse_codes: null,
    });
    check(altaInc.status === 201, 'alta de incentivo por captura', altaInc.status);
    creados.incentivo = altaInc.json?.id;
    const cap = await http('PUT', `/commercial/mkt-ranking/incentivos/${creados.incentivo}/capturas`, token, {
      semana: rk.semana.lunes, items: [{ warehouse_code: '01', vendor_code: '01:DMR01', cantidad: 3 }] });
    check(cap.status === 200 && cap.json.guardadas === 1, 'captura de exhibidores', cap.json);
    const inc2 = await http('GET', `/commercial/mkt-ranking/incentivos?semana=${rk.semana.lunes}`, token);
    const prueba = inc2.json.incentivos.find((i) => i.id === creados.incentivo);
    check(prueba && prueba.total_semana === 15, 'captura × pago = $15', prueba?.total_semana);
    check((await http('POST', '/commercial/mkt-ranking/incentivos', token, { nombre: 'x mal', tipo: 'por_monto', pago: 5, skus: ['DM103'], vigencia_desde: '2026-11-01' })).status === 400, '[negativa] por monto sin «cada cuántos pesos»: 400');
    check((await http('PUT', `/commercial/mkt-ranking/incentivos/${choc.id}/capturas`, token, { semana: rk.semana.lunes, items: [{ warehouse_code: '01', vendor_code: 'v', cantidad: 1 }] })).status === 400, '[negativa] capturar en un incentivo que sale de la venta: 400');
  } finally {
    if (creados.promo) await db.query(`DELETE FROM commercial.mkt_ranking_promos WHERE id=$1`, [creados.promo]);
    if (creados.incentivo) await db.query(`DELETE FROM commercial.mkt_incentives WHERE id=$1`, [creados.incentivo]);
    await db.query(`DELETE FROM commercial.mkt_ranking_objectives WHERE fuente = 'sugerido' AND created_at >= $1`, [t0]);
    await db.end();
  }
  console.log(`\n${ok} ✔ · ${mal} ✖`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
