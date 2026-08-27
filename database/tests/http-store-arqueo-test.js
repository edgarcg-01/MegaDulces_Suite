/* eslint-disable no-console */
/**
 * HTTP smoke — Arqueo de caja de TIENDA (`/store/arqueo`, SM.9 + `[ID.4]`).
 *
 * Cubre las tres reglas que separan a la cajera del supervisor:
 *
 *   1. **La cajera no ve el esperado ni su diferencia.** Ni al guardar ni en el
 *      historial. Se afirma sobre la AUSENCIA de las claves, no sobre su valor:
 *      un `esperado: null` seguiría siendo un contrato que filtra el día que
 *      alguien lo llene. Y `diff_real` se verifica junto con `esperado` porque
 *      publicar uno es publicar el otro (esperado = contado + diferencia).
 *   2. **Solo ve las sucursales que tiene asignadas** (`identity.user_scopes`,
 *      ADR-050). Se le dan 2 de 3 y se verifica que la tercera no aparece.
 *   3. **No puede capturar fuera de su alcance** — 403, no un filtro cosmético.
 *
 * Y el contraste: el supervisor (`RECONCILIATION_VER`) SÍ recibe los dos campos
 * sobre las mismas filas — si no, el test pasaría en verde con un endpoint roto
 * que no devuelve nada para nadie.
 *
 * Self-contained: siembra rol + usuario + alcance + 3 arqueos sintéticos en
 * sucursales `ZA/ZB/ZC` (aisladas de la data real) y limpia al final.
 * Requiere API en localhost:3334 con ENABLE_MULTITENANT=true y las migraciones
 * `20260826120000`/`20260826121000` (alcance) aplicadas.
 */

const BASE = `http://localhost:${process.env.RECON_TEST_PORT || 3334}/api`;
const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';

const M = '00000000-0000-0000-0000-00000000d01c';
const ROLE = 'cajera_smoke';
const USER = 'cajera_smoke';
const PASS = 'cajera_smoke';
/**
 * El supervisor también se siembra (no se usa `superoot`): así el test corre
 * igual contra la DB chica de dev y contra `platform_test`, que tiene el padrón
 * real y credenciales que el test no debe conocer. Y de paso prueba el camino
 * por PERMISO (`RECONCILIATION_VER`), no el atajo de admin de plataforma.
 */
const SUP_ROLE = 'supervisor_arqueo_smoke';
const SUP_USER = 'supervisor_arqueo_smoke';
const SUP_PASS = 'supervisor_arqueo_smoke';
/** Sucursales sintéticas: 2 asignadas + 1 fuera de alcance. */
const MIAS = ['ZA', 'ZB'];
const AJENA = 'ZC';
// Fecha de HOY: la ventana de turnos por arquear es de días recientes (el server
// la capa en 30), así que una fecha fija terminaría cayéndose sola con el tiempo.
const FECHA = new Date().toISOString().slice(0, 10);
/** La caja la asigna Kepler por turno — el test la fija por sucursal, como el ERP. */
const CAJA_DE = { ZA: '8', ZB: '7', ZC: '8' };
/** Folio del turno de Kepler. Es la llave que ata arqueo ↔ corte (SM.12). */
const TURNO_DE = { ZA: '7001', ZB: '7002', ZC: '7003' };
/**
 * El `username` ES el código de cajero de Kepler, en MAYÚSCULAS — verificado contra
 * `analytics.cash_cuts` (`upper(username) = upper(cajero_cierre)`). El backend lo
 * estampa solo; el test siembra los cortes con ese mismo código para que el motor
 * encuentre el turno.
 */
const CAJERO = USER.toUpperCase();

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, det) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; failures.push(name); }
}

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (e) { /* no json */ }
  return { status: r.status, body: json };
}

/** ¿La clave viene en el payload? (`in`, no `!= null`: nos importa el contrato.) */
const tiene = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

async function cleanup(pg, userIds) {
  const sucs = [...MIAS, AJENA];
  const ids = (userIds || []).filter(Boolean);
  await pg.query(`DELETE FROM reconciliation.discrepancies WHERE tenant_id=$1 AND (entity->>'sucursal') = ANY($2)`, [M, sucs]).catch(() => {});
  await pg.query(`DELETE FROM reconciliation.blind_counts WHERE tenant_id=$1 AND warehouse_code = ANY($2)`, [M, sucs]).catch(() => {});
  await pg.query(`DELETE FROM analytics.cash_cuts WHERE tenant_id=$1 AND warehouse_code = ANY($2)`, [M, sucs]).catch(() => {});
  // Turnos sintéticos en el ODS. Las sucursales ZA/ZB/ZC no existen en Kepler, así
  // que el CDC nunca las toca — pero se limpian igual, no se dejan colgadas.
  await pg.query(`DELETE FROM kepler_ods.kdpv_folio_caja WHERE sucursal = ANY($1)`, [sucs]).catch(() => {});
  if (ids.length) await pg.query(`DELETE FROM identity.user_scopes WHERE tenant_id=$1 AND user_id = ANY($2::uuid[])`, [M, ids]).catch(() => {});
  await pg.query(`DELETE FROM identity.users WHERE tenant_id=$1 AND username = ANY($2)`, [M, [USER, SUP_USER]]).catch(() => {});
  await pg.query(`DELETE FROM identity.role_scopes WHERE tenant_id=$1 AND role_name = ANY($2)`, [M, [ROLE, SUP_ROLE]]).catch(() => {});
  await pg.query(`DELETE FROM identity.role_permissions WHERE tenant_id=$1 AND role_name = ANY($2)`, [M, [ROLE, SUP_ROLE]]).catch(() => {});
}

/** Siembra rol + usuario con password conocido y devuelve su id. */
async function seedUser(pg, bcrypt, { role, perms, username, password, warehouse }) {
  await pg.query(
    `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
     VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (tenant_id, role_name) DO UPDATE SET permissions = EXCLUDED.permissions`,
    [M, role, JSON.stringify(perms)],
  );
  const hash = await bcrypt.hash(password, 10);
  const u = await pg.query(
    `INSERT INTO identity.users (tenant_id, username, password_hash, nombre, role_name, activo, warehouse_code)
     VALUES ($1,$2,$3,$4,$5,true,$6)
     ON CONFLICT (tenant_id, username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role_name=EXCLUDED.role_name, activo=true, warehouse_code=EXCLUDED.warehouse_code
     RETURNING id`,
    [M, username, hash, username, role, warehouse || null],
  );
  return u.rows[0].id;
}

(async () => {
  const pg = new Client({ connectionString: DST, ssl: /rlwy|proxy|railway/.test(DST) ? { rejectUnauthorized: false } : false });
  await pg.connect();

  await cleanup(pg, []); // idempotente: limpia corridas previas

  console.log('\n── 1. Fixtures: supervisor + cajera (sin RECONCILIATION_VER) + alcance 2 de 3 ──');
  let userId = null, supId = null;
  try {
    const bcrypt = require('bcryptjs');
    supId = await seedUser(pg, bcrypt, {
      role: SUP_ROLE, username: SUP_USER, password: SUP_PASS,
      perms: { RECONCILIATION_VER: true, STORE_ARQUEO_VER: true },
    });
    // La cajera: lo justo para arquear. Sin `RECONCILIATION_VER` a propósito —
    // es la clave que separa "cuenta el dinero" de "audita el cuadre".
    userId = await seedUser(pg, bcrypt, {
      role: ROLE, username: USER, password: PASS, warehouse: MIAS[0],
      perms: { STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true },
    });
    // El supervisor ve todo; la cajera `listed` con 2 sucursales — el caso que el
    // modelo viejo (`users.warehouse_code` a secas) no podía ni expresar.
    await pg.query(
      `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, values)
       VALUES ($1,$2,'warehouse','all',NULL)
       ON CONFLICT (tenant_id, user_id, dimension) DO UPDATE SET mode='all', values=NULL`,
      [M, supId],
    );
    await pg.query(
      `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, values)
       VALUES ($1,$2,'warehouse','listed',$3::text[])
       ON CONFLICT (tenant_id, user_id, dimension) DO UPDATE SET mode='listed', values=EXCLUDED.values`,
      [M, userId, MIAS],
    );
    check('roles + usuarios + alcance sembrados', !!userId && !!supId);
  } catch (e) { check('roles + usuarios + alcance sembrados', false, e.message); await cleanup(pg, [userId, supId]); await pg.end(); process.exit(1); }

  const supLogin = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: SUP_USER, password: SUP_PASS });
  const admin = supLogin.body?.access_token;
  check('login supervisor', !!admin, `status=${supLogin.status} body=${JSON.stringify(supLogin.body).slice(0, 120)}`);
  if (!admin) { await cleanup(pg, [userId, supId]); await pg.end(); process.exit(1); }

  // Un corte de Kepler por sucursal (es lo que da un `esperado` que revelar) + su arqueo.
  for (const wh of [...MIAS, AJENA]) {
    await pg.query(
      `INSERT INTO analytics.cash_cuts (tenant_id, warehouse_code, caja, folio, business_date, cajero_cierre, efectivo_esperado, efectivo_contado, efectivo_diff, total_venta)
       VALUES ($1,$2,$3,$4,$5,$6,5000,5000,0,5000) ON CONFLICT DO NOTHING`,
      [M, wh, CAJA_DE[wh], TURNO_DE[wh], FECHA, CAJERO],
    );
    await pg.query(
      `INSERT INTO reconciliation.blind_counts (tenant_id, tipo, warehouse_code, caja, business_date, cajero_code, denominations, total_contado, captured_by)
       VALUES ($1,'cierre',$2,$3,$4,$5,'{"1000":4}'::jsonb,4000,'smoke')
       ON CONFLICT DO NOTHING`,
      [M, wh, CAJA_DE[wh], FECHA, CAJERO],
    );
  }
  // Una compañera en otra caja de la MISMA sucursal: es lo que la cajera NO debe
  // ver y la encargada sí.
  await pg.query(
    `INSERT INTO reconciliation.blind_counts (tenant_id, tipo, warehouse_code, caja, business_date, cajero_code, denominations, total_contado, captured_by)
     VALUES ($1,'cierre',$2,'5',$3,'OTRA_CAJERA','{"500":2}'::jsonb,1000,'otra_cajera')
     ON CONFLICT DO NOTHING`,
    [M, MIAS[0], FECHA],
  );
  check('3 cortes + 3 arqueos sintéticos + 1 de otra cajera sembrados', true);

  // SM.12 — Los TURNOS que Kepler abre. `c8` = cajera asignada, `c2` = caja,
  // `c6` = hora de apertura, `c10='1800-01-01'` = todavía abierto.
  // ZB va CERRADO (su corte ya existe en cash_cuts) y los otros dos ABIERTOS: el
  // endpoint tiene que listar los dos estados — lo que decide si toca arquear es
  // que Kepler abrió el turno y todavía no hay conteo, no que ya haya cerrado.
  for (const wh of [...MIAS, AJENA]) {
    const cerrado = wh === MIAS[1];
    await pg.query(
      `INSERT INTO kepler_ods.kdpv_folio_caja (sucursal, c1, c2, c3, c5, c6, c7, c8, c10, c11, c13, c15, c25, c35)
       VALUES ($1,$1,$2,$3::numeric,$4::timestamp,'08:15:00','GERENTE',$5,$6::timestamp,$7,'01',0,0,0)
       ON CONFLICT (sucursal, c1, c2, c3) DO NOTHING`,
      [wh, CAJA_DE[wh], TURNO_DE[wh], FECHA, CAJERO, cerrado ? FECHA : '1800-01-01', cerrado ? '20:30:00' : null],
    );
  }
  check('3 turnos sembrados en el ODS (2 abiertos + 1 cerrado)', true);

  console.log('\n── 2b. Kepler dice cuándo: turnos por arquear ──');
  const clPre = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: USER, password: PASS });
  const cajeraPre = clPre.body?.access_token;
  const tur = await req('GET', '/store/arqueo/turnos?dias=90', cajeraPre);
  const turnos = Array.isArray(tur.body) ? tur.body : [];
  check('GET /store/arqueo/turnos 200', tur.status === 200, `status=${tur.status} body=${JSON.stringify(tur.body).slice(0, 120)}`);
  check('solo los turnos de SUS sucursales (2 de 3)', turnos.length === 2, `n=${turnos.length} sucs=${turnos.map((t) => t.warehouse_code).join(',')}`);
  check(`el turno de la sucursal ajena (${AJENA}) no aparece`, !turnos.some((t) => t.warehouse_code === AJENA));
  check('el turno trae caja, hora y cajero (lo que Kepler ya sabe)',
    turnos.every((t) => t.caja && t.hora_apertura && t.cajero_code === CAJERO),
    JSON.stringify(turnos[0] || {}).slice(0, 140));
  check('el turno NO trae montos (sigue siendo ciego)',
    turnos.every((t) => !tiene(t, 'esperado') && !tiene(t, 'efectivo_esperado') && !tiene(t, 'total_venta')));
  check('la caja la dice Kepler, no la cajera',
    turnos.find((t) => t.warehouse_code === MIAS[1])?.caja === CAJA_DE[MIAS[1]],
    `caja=${turnos.find((t) => t.warehouse_code === MIAS[1])?.caja}`);
  check('distingue turno abierto de cerrado',
    turnos.find((t) => t.warehouse_code === MIAS[0])?.abierto === true
    && turnos.find((t) => t.warehouse_code === MIAS[1])?.abierto === false,
    turnos.map((t) => `${t.warehouse_code}:abierto=${t.abierto}:hc=${t.hora_cierre}`).join(' '));

  console.log('\n── 2. Supervisor: SÍ ve esperado y diferencia ──');
  const sup = await req('GET', '/store/arqueo?limit=200', admin);
  const supRows = Array.isArray(sup.body) ? sup.body.filter((r) => [...MIAS, AJENA].includes(r.warehouse_code)) : [];
  check('GET /store/arqueo 200 (supervisor)', sup.status === 200, `status=${sup.status}`);
  check('supervisor ve los 4 arqueos sintéticos (3 sucursales + otra cajera)', supRows.length === 4, `n=${supRows.length}`);
  check('supervisor recibe `esperado`', supRows.length > 0 && supRows.every((r) => tiene(r, 'esperado')));
  check('supervisor recibe `diff_real`', supRows.length > 0 && supRows.every((r) => tiene(r, 'diff_real')));
  const conCuadre = supRows.find((r) => r.esperado != null);
  check('el esperado llega con valor (5000) y la diferencia calculada (+1000)',
    !!conCuadre && Number(conCuadre.esperado) === 5000 && Number(conCuadre.diff_real) === 1000,
    conCuadre ? `esperado=${conCuadre.esperado} diff=${conCuadre.diff_real}` : 'sin fila con corte');

  console.log('\n── 3. Cajera: alcance de lectura acotado ──');
  const cl = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: USER, password: PASS });
  const cajera = cl.body?.access_token;
  check('login cajera', !!cajera, `status=${cl.status}`);
  if (!cajera) { await cleanup(pg, [userId, supId]); await pg.end(); process.exit(1); }

  const hist = await req('GET', '/store/arqueo?limit=200', cajera);
  const rows = Array.isArray(hist.body) ? hist.body : [];
  check('GET /store/arqueo 200 (cajera)', hist.status === 200, `status=${hist.status}`);
  check('ve las 2 sucursales asignadas', MIAS.every((w) => rows.some((r) => r.warehouse_code === w)), `sucs=${[...new Set(rows.map((r) => r.warehouse_code))].join(',')}`);
  check(`NO ve la sucursal ajena (${AJENA})`, !rows.some((r) => r.warehouse_code === AJENA));
  check('no se cuela ninguna sucursal fuera del alcance', rows.every((r) => MIAS.includes(r.warehouse_code)), `sucs=${[...new Set(rows.map((r) => r.warehouse_code))].join(',')}`);
  // La sucursal sola no alcanza: en una tienda con 5 cajas le mostraría el conteo
  // de sus compañeras (y con eso, cuánto entregó cada una).
  check('y SOLO ve sus propios arqueos, no los de otras cajas',
    rows.every((r) => (r.cajero_code || '').toUpperCase() === CAJERO),
    `cajeros=${[...new Set(rows.map((r) => r.cajero_code))].join(',')}`);
  const supTodos = await req('GET', '/store/arqueo?limit=200', admin);
  check('la encargada SÍ ve los de toda la tienda (varias cajeras)',
    Array.isArray(supTodos.body) && supTodos.body.some((r) => (r.cajero_code || '').toUpperCase() !== CAJERO),
    `n=${(supTodos.body || []).length}`);

  console.log('\n── 4. Cajera: el historial no trae el cuadre ──');
  check('historial SIN `esperado`', rows.length > 0 && rows.every((r) => !tiene(r, 'esperado')));
  check('historial SIN `diff_real`', rows.length > 0 && rows.every((r) => !tiene(r, 'diff_real')));
  check('historial SIN `kepler_diff` / `kepler_enmascaro`', rows.every((r) => !tiene(r, 'kepler_diff') && !tiene(r, 'kepler_enmascaro')));
  check('pero SÍ trae su total contado', rows.length > 0 && rows.every((r) => tiene(r, 'total_contado')));

  console.log('\n── 5. Cajera: captura dentro y fuera del alcance ──');
  // Se manda un `cajero_code` FALSEADO a propósito: el arqueo tiene que quedar a
  // nombre de quien lo captura, no de quien diga el body. Si el backend lo
  // respetara, el motor no encontraría el turno (el corte es de CAJERA_SMOKE) y
  // el paso 6 se caería solo. Contado $3,000 vs esperado $5,000 → faltante de
  // $2,000 que la cajera NO debe ver y el supervisor SÍ debe recibir.
  const sinTurno = await req('POST', '/store/arqueo', cajera, {
    warehouse_code: MIAS[1], caja: '99', business_date: FECHA, tipo: 'cierre',
    denominations: { '500': 1 },
  });
  check('sin turno de Kepler NO se puede arquear (400)', sinTurno.status === 400, `status=${sinTurno.status}`);
  const turnoAjeno = await req('POST', '/store/arqueo', cajera, {
    warehouse_code: MIAS[0], cash_cut_folio: TURNO_DE[AJENA], caja: '1', business_date: FECHA, tipo: 'cierre',
    denominations: { '500': 1 },
  });
  check('tampoco un turno que no es suyo (400)', turnoAjeno.status === 400, `status=${turnoAjeno.status}`);

  // Se manda una CAJA y un CAJERO falseados a propósito: los dos los manda Kepler
  // vía el turno, no el body. Contado $3,000 vs esperado $5,000 → faltante de
  // $2,000 que la cajera NO debe ver y el supervisor SÍ debe recibir.
  const okPost = await req('POST', '/store/arqueo', cajera, {
    warehouse_code: MIAS[1], cash_cut_folio: TURNO_DE[MIAS[1]],
    caja: '99', business_date: '2020-01-01', tipo: 'cierre',
    cajero_code: 'OTRA_PERSONA', denominations: { '500': 6 },
  });
  check('captura en sucursal asignada 200/201', [200, 201].includes(okPost.status), `status=${okPost.status} body=${JSON.stringify(okPost.body).slice(0, 120)}`);
  check('la respuesta dice reveal=false', okPost.body?.reveal === false, `reveal=${okPost.body?.reveal}`);
  check('la respuesta NO trae `esperado`', !tiene(okPost.body, 'esperado'));
  check('la respuesta NO trae `diff_real`', !tiene(okPost.body, 'diff_real'));
  check('la respuesta NO trae `ambiguous` (filtraría que hay varios cortes)', !tiene(okPost.body, 'ambiguous'));
  check('la respuesta confirma su total contado ($3,000)', Number(okPost.body?.total_contado) === 3000, `total=${okPost.body?.total_contado}`);
  const atrib = await pg.query(
    `SELECT id, cajero_code, captured_by FROM reconciliation.blind_counts
      WHERE tenant_id=$1 AND warehouse_code=$2 AND caja=$3 AND business_date=$4`, [M, MIAS[1], CAJA_DE[MIAS[1]], FECHA]);
  check('el arqueo queda a nombre de QUIEN lo captura, no del body',
    atrib.rows.length === 1 && atrib.rows[0].cajero_code === CAJERO,
    `cajero_code=${atrib.rows[0]?.cajero_code} (esperado ${CAJERO}), filas=${atrib.rows.length}`);
  check('y se sella quién lo capturó', atrib.rows[0]?.captured_by === USER, `captured_by=${atrib.rows[0]?.captured_by}`);

  const badPost = await req('POST', '/store/arqueo', cajera, {
    warehouse_code: AJENA, cash_cut_folio: TURNO_DE[AJENA], caja: CAJA_DE[AJENA], business_date: FECHA, tipo: 'cierre',
    cajero_code: 'SMOKE3', denominations: { '500': 2 },
  });
  check('captura en sucursal AJENA rechazada con 403', badPost.status === 403, `status=${badPost.status}`);
  const noEscribio = await pg.query(
    `SELECT count(*)::int AS n FROM reconciliation.blind_counts WHERE tenant_id=$1 AND warehouse_code=$2 AND cajero_code='SMOKE3'`, [M, AJENA]);
  check('y no escribió nada en la sucursal ajena', noEscribio.rows[0].n === 0, `n=${noEscribio.rows[0].n}`);

  console.log('\n── 6. El descuadre igual llega al supervisor (autolineado SM.9) ──');
  // La cajera no vio la diferencia, pero el hueco tiene que estar en la bandeja:
  // ocultar el número a la cajera no puede significar dejar de detectarlo.
  const disc = await pg.query(
    `SELECT diferencia::numeric AS d FROM reconciliation.discrepancies
      WHERE tenant_id=$1 AND rule_key='arqueo_ciego_divergente' AND (entity->>'sucursal')=$2`, [M, MIAS[1]]);
  check('el arqueo divergente levantó el descuadre igual', disc.rows.length >= 1, `n=${disc.rows.length}`);
  check('con el faltante REAL que la cajera no vio (+$2,000)',
    disc.rows.length > 0 && Number(disc.rows[0].d) === 2000, `diferencia=${disc.rows[0]?.d}`);

  console.log('\n── 7. La encargada valida presencialmente ──');
  const arqId = atrib.rows[0]?.id;
  const noPuede = await req('POST', `/store/arqueo/${arqId}/validar`, cajera, {});
  check('la cajera NO puede validar su propio arqueo (403)', noPuede.status === 403, `status=${noPuede.status}`);
  const val = await req('POST', `/store/arqueo/${arqId}/validar`, admin, { nota: 'contado en el lugar' });
  check('la encargada sí valida (200/201)', [200, 201].includes(val.status), `status=${val.status} body=${JSON.stringify(val.body).slice(0, 120)}`);
  const firmado = await pg.query(
    `SELECT validado_por, validado_at, validado_nota, cash_cut_folio, caja_kepler
       FROM reconciliation.blind_counts WHERE tenant_id=$1 AND id=$2`, [M, arqId]);
  check('queda firmado con quién y cuándo',
    firmado.rows[0]?.validado_por === SUP_USER && !!firmado.rows[0]?.validado_at,
    `por=${firmado.rows[0]?.validado_por} at=${firmado.rows[0]?.validado_at}`);
  check('y el arqueo quedó atado al turno de Kepler',
    firmado.rows[0]?.cash_cut_folio === TURNO_DE[MIAS[1]] && firmado.rows[0]?.caja_kepler === CAJA_DE[MIAS[1]],
    `folio=${firmado.rows[0]?.cash_cut_folio} caja=${firmado.rows[0]?.caja_kepler}`);

  // Recontar borra la firma: un arqueo distinto es un arqueo sin validar.
  await req('POST', '/store/arqueo', cajera, {
    warehouse_code: MIAS[1], cash_cut_folio: TURNO_DE[MIAS[1]], caja: CAJA_DE[MIAS[1]], business_date: FECHA,
    tipo: 'cierre', denominations: { '500': 8 },
  });
  const refirma = await pg.query(
    `SELECT validado_at, total_contado::numeric t FROM reconciliation.blind_counts WHERE tenant_id=$1 AND id=$2`, [M, arqId]);
  check('recapturar el conteo BORRA la validación', refirma.rows[0]?.validado_at === null && Number(refirma.rows[0]?.t) === 4000,
    `validado_at=${refirma.rows[0]?.validado_at} total=${refirma.rows[0]?.t}`);

  console.log('\n── 8. Cleanup ──');
  await cleanup(pg, [userId, supId]);
  check('fixtures eliminados', true);

  await pg.end();
  console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLAS'} — ${pass} OK / ${fail} FAIL`);
  if (failures.length) console.log('fallidos: ' + failures.join(' · '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
