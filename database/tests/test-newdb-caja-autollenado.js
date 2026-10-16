'use strict';
/**
 * ⭐⭐ `[CG.189]`/`[CG.190]` Candado del **autollenado de Caja General**: las propiedades que
 * sostienen el arreglo de la sucursal compuesta y los límites del motor que escribe solo.
 *
 *   node database/tests/test-newdb-caja-autollenado.js
 *
 * **Sólo lee.** No escribe una fila ni dispara el motor.
 *
 * ── Qué sostiene, medido (prod, `system_identifier 7688376744939610156`, 2026-10-16) ────────
 *
 * El resolvedor de la bandeja buscaba la contracuenta del documento con la sucursal **cruda**, y
 * Padre Hidalgo la trae **compuesta** (`01-001`, `01-002`, `01-004`, `01-005`, los códigos que
 * nacieron del corte del 1-oct). Como `analytics.v_caja_doc_contracuenta` está indexada por la
 * sucursal **base**, esas filas no encontraban nada y caían a `sin_mapa` — que se lee como *«falta
 * declarar la ruta»* cuando en realidad **la póliza del propio documento ya traía la cuenta**
 * (`115 ABONO A CLIENTES` → concepto `071`, por coincidencia exacta de nombre).
 *
 *     en el alcance vigente (desde el 10-oct) ....  3 ingresos · $32,083.89
 *     en la bandeja completa .....................  29 movimientos · $527,631.59
 *
 * `[CG.189]` normaliza con `sucursalBase()` en los **tres** puntos de búsqueda. Este archivo
 * candadea las dos premisas que vuelven SEGURO normalizar — y que son invariantes de los datos,
 * no del código, así que jest no las puede afirmar.
 *
 * ⛔ **Las dos premisas, y por qué cada una importa:**
 *   P1 · las vistas del catálogo contable NO tienen sucursales compuestas. Si mañana tuvieran una,
 *        normalizar **taparía la fila específica con la general** y el dinero iría a otra cuenta.
 *   P2 · cada llave `(base, tipo_pol, folio)` de las compuestas resuelve a **a lo sumo una** fila.
 *        Si resolviera a dos, normalizar elegiría una al azar.
 *
 * ⚠️ Las cifras NO se escriben como literales: `29` es la cola de hoy y mañana es otra. Lo que se
 * afirma es la **propiedad**, que sobrevive a los datos.
 *
 * ⚠️ **Este archivo NO corre en CI** — deuda **VP.5** de `CLAUDE.md`. Es un candado **dormido**, y
 * se dice en voz alta. Aun así vale: una medición vive en una sesión y se pierde; esto lo
 * encuentra la próxima persona.
 */

require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
/** El mismo default que `caja-autollenado.engine.ts`. Si uno cambia, el otro tiene que cambiar. */
const PISO = process.env.CAJA_AUTOLLENADO_PISO || '2026-10-10';
const SVC_ID = '00000000-0000-0000-0000-0000000ca11e';

let ok = 0;
let fail = 0;
let nomedido = 0;
const check = (cond, txt, detalle = '') => {
  if (cond) { ok++; console.log(`  ✓ ${txt}`); }
  else { fail++; console.log(`  ✗ ${txt}${detalle ? '\n      ' + detalle : ''}`); }
};
const declarar = (txt) => { nomedido++; console.log(`  ⓘ NO MEDIDO — ${txt}`); };

/** `doc_tipo` (`U-A-5`) → `tipo_pol` compacto (`UA0501`). Mismo cálculo que `tipoPolCompacto()`. */
const TIPO_POL = `split_part(p.doc_tipo,'-',1) || split_part(p.doc_tipo,'-',2)
                  || lpad(split_part(p.doc_tipo,'-',3),2,'0') || '01'`;

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW (o PROD_DB_URL).'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  // ⛔ Sin esto las vistas de `finance.*` devuelven CERO filas, y cero se lee igual que «no hay
  // nada mal». Es la trampa declarada en `FASE_CG_PATRONES_Y_ACCESIBILIDAD` §14.
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
  await c.query('SET default_transaction_read_only = on');

  // ── 0. ¿Hay con qué comprobarlo? ─────────────────────────────────────────────────────────
  // Un candado sobre un conjunto vacío pasa «por vacío, no por sano».
  console.log('\n[0] Hay universo con qué medir');
  const { rows: [u] } = await c.query(`
    SELECT (SELECT count(*)::int FROM finance.v_caja_movimientos_pendientes WHERE tenant_id=$1) AS cola,
           (SELECT count(*)::int FROM finance.v_caja_movimientos_pendientes
             WHERE tenant_id=$1 AND sucursal LIKE '%-%') AS compuestas,
           (SELECT count(*)::int FROM analytics.v_caja_doc_contracuenta WHERE tenant_id=$1) AS contras`,
    [TENANT]);
  check(u.cola > 0 && u.contras > 0,
    `cola de ${u.cola} · catálogo de contracuentas con ${u.contras} filas · ${u.compuestas} filas de sucursal compuesta`);
  if (!u.compuestas) {
    declarar('la cola NO tiene sucursales compuestas hoy: el arreglo de [CG.189] no se ejerce con datos reales');
  }

  // ── 1. P1 — las vistas del catálogo NO tienen sucursales compuestas ──────────────────────
  // Es lo que vuelve seguro normalizar. Si esto se pone rojo, `sucursalBase()` pasó de arreglar
  // a TAPAR: estaría mandando el dinero a la cuenta de la plaza en vez de a la de la sub-plaza.
  console.log('\n[1] El catálogo contable está indexado por sucursal BASE, nunca compuesta');
  for (const vista of ['analytics.v_caja_doc_contracuenta', 'analytics.v_kepler_conceptos']) {
    const { rows: [v] } = await c.query(
      `SELECT count(*) FILTER (WHERE sucursal LIKE '%-%')::int AS compuestas,
              count(DISTINCT sucursal)::int AS sucursales
         FROM ${vista} WHERE tenant_id=$1`, [TENANT]);
    check(v.compuestas === 0,
      `${vista}: ${v.sucursales} sucursales, ${v.compuestas} compuestas`,
      'si aparecen compuestas, normalizar la sucursal TAPA la fila específica — revisar [CG.189] antes de seguir');
  }

  // ── 2. P2 — normalizar no puede volver ambigua la llave ──────────────────────────────────
  console.log('\n[2] Cada llave (base, tipo_pol, folio) de las compuestas resuelve a ≤1 fila');
  const { rows: [amb] } = await c.query(`
    WITH comp AS (
      SELECT DISTINCT split_part(p.sucursal,'-',1) AS suc, ${TIPO_POL} AS tipo_pol, p.folio
        FROM finance.v_caja_movimientos_pendientes p
       WHERE p.tenant_id=$1 AND p.sucursal LIKE '%-%')
    SELECT count(*)::int AS llaves,
           count(*) FILTER (WHERE d.n > 1)::int AS ambiguas,
           count(*) FILTER (WHERE coalesce(d.n,0) = 0)::int AS sin_fila
      FROM comp
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n FROM analytics.v_caja_doc_contracuenta v
         WHERE v.tenant_id=$1 AND v.sucursal=comp.suc
           AND v.tipo_pol=comp.tipo_pol AND v.folio=comp.folio) d ON true`, [TENANT]);
  if (!amb.llaves) {
    declarar('no hay llaves compuestas en la cola: P2 no se ejerce');
  } else {
    check(amb.ambiguas === 0,
      `${amb.llaves} llaves compuestas, ${amb.ambiguas} ambiguas (${amb.sin_fila} todavía sin póliza)`,
      'una llave que resuelve a 2 filas haría que normalizar elija una al azar');
  }

  // ── 3. PRUEBA NEGATIVA: con la sucursal CRUDA no se encuentra nada ───────────────────────
  // Sin esto, el [1] y el [2] pasarían igual aunque el arreglo no hiciera falta. Esto es lo que
  // demuestra que la normalización ESTÁ haciendo el trabajo y no es decorativa.
  console.log('\n[3] Prueba negativa: buscar con la sucursal CRUDA no encuentra la contracuenta');
  if (!u.compuestas) {
    declarar('sin filas compuestas no se puede ejercer la prueba negativa');
  } else {
    const { rows: [neg] } = await c.query(`
      WITH comp AS (
        SELECT DISTINCT p.sucursal AS cruda, split_part(p.sucursal,'-',1) AS base,
               ${TIPO_POL} AS tipo_pol, p.folio
          FROM finance.v_caja_movimientos_pendientes p
         WHERE p.tenant_id=$1 AND p.sucursal LIKE '%-%')
      SELECT count(*) FILTER (WHERE cru.n > 0)::int AS halla_cruda,
             count(*) FILTER (WHERE bas.n > 0)::int AS halla_base,
             count(*)::int AS llaves
        FROM comp
        LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM analytics.v_caja_doc_contracuenta v
                            WHERE v.tenant_id=$1 AND v.sucursal=comp.cruda
                              AND v.tipo_pol=comp.tipo_pol AND v.folio=comp.folio) cru ON true
        LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM analytics.v_caja_doc_contracuenta v
                            WHERE v.tenant_id=$1 AND v.sucursal=comp.base
                              AND v.tipo_pol=comp.tipo_pol AND v.folio=comp.folio) bas ON true`,
      [TENANT]);
    check(neg.halla_cruda === 0 && neg.halla_base > 0,
      `con la sucursal cruda: ${neg.halla_cruda}/${neg.llaves} · con la base: ${neg.halla_base}/${neg.llaves}`,
      'si la cruda también encontrara, el arreglo no sería lo que destraba estas filas');
  }

  // ── 4. La idempotencia que hace seguro correr el motor en bucle ──────────────────────────
  // El autollenado corre cada 15 min sobre la misma ventana. Lo único que impide que escriba el
  // mismo documento dos veces es este índice.
  console.log('\n[4] El candado de idempotencia existe');
  const { rows: [ix] } = await c.query(`
    SELECT count(*)::int AS n FROM pg_indexes
     WHERE schemaname='finance' AND tablename='cash_ledger' AND indexname='ux_cash_ledger_origen_vivo'`);
  check(ix.n === 1,
    'ux_cash_ledger_origen_vivo está',
    'sin él, cada corrida del autollenado volvería a escribir lo ya escrito');

  // ── 5. La cuenta de servicio (migración 20261016105305) ──────────────────────────────────
  console.log('\n[5] La cuenta de servicio con la que firma el autollenado');
  const { rows: [svc] } = await c.query(
    `SELECT username, kind, activo FROM identity.users WHERE id=$1 AND tenant_id=$2`, [SVC_ID, TENANT]);
  if (!svc) {
    declarar('la migración 20261016105305 NO está aplicada: sin ella cada movimiento automático quedaría firmado por un UUID que la pantalla no resuelve a un nombre');
  } else {
    check(svc.kind === 'servicio' && svc.activo === true,
      `${svc.username} · kind=${svc.kind} · activo=${svc.activo}`,
      'kind debe ser `servicio`: es lo que permite password_hash NULL y lo que impide que la cuenta se autentique');
  }

  // ── 6. ⛔ El motor NUNCA escribe antes del piso de alcance ────────────────────────────────
  // Es la aserción más cara de las de acá: lo anterior al 10-oct ya está conciliado en el Access,
  // y escribirlo duplicaría $162 M. Si el piso se mueve hacia atrás por error, esto lo ve.
  console.log(`\n[6] Nada firmado por el autollenado cae antes del piso (${PISO})`);
  const { rows: [esc] } = await c.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE fecha < $3::date)::int AS antes_del_piso,
           coalesce(sum(monto) FILTER (WHERE fecha < $3::date),0)::numeric AS monto_antes
      FROM finance.cash_ledger
     WHERE tenant_id=$1 AND created_by=$2 AND deleted_at IS NULL`, [TENANT, SVC_ID, PISO]);
  if (!esc.total) {
    declarar('el autollenado todavía no escribió nada: la aserción del piso no se ejerce (correr con ?aplicar=1 una vez)');
  } else {
    check(esc.antes_del_piso === 0,
      `${esc.total} movimientos del autollenado, ${esc.antes_del_piso} antes del piso`,
      `escribir antes del piso duplica lo que el Access ya tiene conciliado ($${Number(esc.monto_antes).toLocaleString('es-MX')})`);
  }

  // ── 7. ⛔ El motor NUNCA escribe un documento fechado adelante ────────────────────────────
  console.log('\n[7] Nada firmado por el autollenado viene fechado después de hoy');
  if (!esc.total) {
    declarar('el autollenado todavía no escribió nada: la aserción de fecha futura no se ejerce');
  } else {
    const { rows: [fut] } = await c.query(`
      SELECT count(*)::int AS n FROM finance.cash_ledger
       WHERE tenant_id=$1 AND created_by=$2 AND deleted_at IS NULL
         AND fecha > (now() AT TIME ZONE 'America/Mexico_City')::date`, [TENANT, SVC_ID]);
    check(fut.n === 0, `${fut.n} movimientos automáticos con fecha futura`,
      'un documento mal fechado por Kepler entrando solo mueve los totales de un mes que no llegó ([CG.24])');
  }

  // ── 8. Todo lo que escribió el motor está VINCULADO ──────────────────────────────────────
  // `[CG.124]`: ningún movimiento sin `origen_ref`. En el camino automático no hay excusa posible
  // — el movimiento NACE de un documento.
  console.log('\n[8] Todo movimiento automático tiene su documento de origen');
  if (!esc.total) {
    declarar('el autollenado todavía no escribió nada: la aserción de vínculo no se ejerce');
  } else {
    const { rows: [sv] } = await c.query(`
      SELECT count(*) FILTER (WHERE origen_ref IS NULL OR origen_ref = '')::int AS sin_vinculo
        FROM finance.cash_ledger
       WHERE tenant_id=$1 AND created_by=$2 AND deleted_at IS NULL`, [TENANT, SVC_ID]);
    check(sv.sin_vinculo === 0, `${sv.sin_vinculo} movimientos automáticos sin origen_ref`);
  }

  await c.end();
  console.log(`\n${ok} ✓ · ${fail} ✗ · ${nomedido} no medidos`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
