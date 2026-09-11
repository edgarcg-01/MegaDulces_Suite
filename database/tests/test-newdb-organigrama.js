'use strict';
/**
 * `[OR.0]` + `[OR.1]` — El puesto es la unidad organizacional.
 *
 * ── Qué afirma ──────────────────────────────────────────────────────────────
 * Que la persona tiene puesto, que el puesto tiene jefe y responsabilidades, y
 * —sobre todo— que los candados que sostienen eso **rechazan de verdad**.
 *
 * ADR-056: **un gate sin prueba negativa es una intención.** Acá hay cuatro
 * candados y cada uno se rompe a propósito, dentro de una transacción que hace
 * ROLLBACK. Prod queda igual; lo que se mide es el rechazo, no el estado.
 *
 * ⚠️ El bloque 3 lleva además un **control positivo**: una arista legítima tiene
 * que ser ACEPTADA. Sin él, un candado que bloqueara TODO se vería igual de
 * verde que uno que funciona — es el mismo defecto por el que
 * `test-authz-route-coverage` estuvo verde sobre un conjunto vacío.
 *
 * ── Lo que NO se afirma, y por qué ──────────────────────────────────────────
 * `position_responsibilities` está VACÍA a propósito (`[OR.1b]`): sembrarla
 * desde el permiso colapsaría la distinción «puede abrirlo» vs «responde de
 * ello». Por eso acá se **DECLARA** su conteo en vez de exigirlo > 0. Un 0 con
 * motivo escrito no es lo mismo que un 0 por olvido.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knex = require('knex');

const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;
const TENANT = '00000000-0000-0000-0000-00000000d01c';

let ok = 0;
let fail = 0;
let nomedido = 0;
const check = (cond, msg) => {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ FAIL ${msg}`); }
};
const declarar = (msg) => { nomedido++; console.log(`  ~ NO MEDIDO ${msg}`); };

/** Los 11 puestos que `[OR.0]` creó para la oficina. */
const PUESTOS_OFICINA = [
  'auxiliar_contabilidad', 'auxiliar_credito_cobranza', 'jefe_finanzas', 'auxiliar_finanzas',
  'tesoreria', 'jefe_marketing', 'comprador', 'gerente_compras', 'prevencion',
  'auxiliar_prevencion', 'repartidor',
];

/**
 * Las personas que a propósito quedaron SIN puesto, con su motivo.
 * Si aparece una que no está acá, es deriva y el test falla — ése es el punto:
 * lo declarado se tolera, la SORPRESA no.
 */
const SIN_PUESTO_ACEPTADAS = {
  claudia_mata: 'rol `supervisor` y SIN departamento: el candidato se busca dentro del departamento, así que no hay ninguno posible hasta que se le asigne uno.',
  brian_zavala: 'rol `almacenista` con 4 candidatos (almacenista | auxiliar_almacen | bodeguero | surtidor). Elegir por él sería adivinar.',
  luis_navarro: 'rol `almacenista` con los mismos 4 candidatos.',
};

(async () => {
  if (!URL) { console.error('Falta FLEET_DB_URL / DATABASE_URL_NEW'); process.exit(1); }
  const k = knex({
    client: 'pg',
    pool: { min: 0, max: 2 },
    connection: /rlwy|railway/i.test(URL)
      ? { connectionString: URL, ssl: { rejectUnauthorized: false } }
      : URL,
  });

  try {
    // ── 1. El catálogo cubre la oficina ───────────────────────────────────
    console.log('\n── 1. El catálogo de puestos cubre la oficina');
    const cat = await k('identity.positions')
      .where({ tenant_id: TENANT })
      .whereNull('deleted_at')
      .select('code', 'department_code', 'default_role');
    const codes = new Set(cat.map((x) => x.code));
    const faltan = PUESTOS_OFICINA.filter((c) => !codes.has(c));
    check(faltan.length === 0, `los 11 puestos de oficina existen (faltan: ${faltan.join(', ') || 'ninguno'})`);

    const mkt = cat.find((x) => x.code === 'auxiliar_mkt');
    check(mkt && mkt.default_role === 'marketing',
      `auxiliar_mkt propone "marketing" (dice: ${mkt ? mkt.default_role : 'no existe'}) — es lo que desambiguó a los 3 "administrativo"`);

    const admin = cat.filter((x) => x.department_code === 'administracion');
    check(admin.length >= 10,
      `administracion tiene ${admin.length} puestos (antes 4, para 17 personas)`);

    // ── 2. El padrón tiene puesto, y lo que falta está DECLARADO ──────────
    console.log('\n── 2. El padrón');
    const padron = await k.raw(
      `SELECT username, position_code FROM identity.users
        WHERE tenant_id = ? AND activo AND deleted_at IS NULL AND kind = 'interno'`,
      [TENANT],
    );
    const sinPuesto = padron.rows.filter((x) => !x.position_code).map((x) => x.username);
    const conPuesto = padron.rows.length - sinPuesto.length;
    console.log(`     ${conPuesto}/${padron.rows.length} personas con puesto`);

    const sorpresa = sinPuesto.filter((u) => !SIN_PUESTO_ACEPTADAS[u]);
    check(sorpresa.length === 0,
      `ninguna persona sin puesto fuera de las declaradas (sorpresa: ${sorpresa.join(', ') || 'ninguna'})`);
    sinPuesto
      .filter((u) => SIN_PUESTO_ACEPTADAS[u])
      .forEach((u) => declarar(`${u} sin puesto — ${SIN_PUESTO_ACEPTADAS[u]}`));

    // El evento que la bitácora nunca había visto.
    const ev = await k('identity.user_events')
      .where({ tenant_id: TENANT, event: 'puesto_asignado' })
      .count('* as n')
      .first();
    check(Number(ev.n) >= 38,
      `user_events registra ${ev.n} "puesto_asignado" (antes de [OR.1c] había 0 eventos de puesto)`);

    // ── 3. La cadena de mando y sus candados ──────────────────────────────
    console.log('\n── 3. Cadena de mando: los candados se rompen a propósito');
    const vr = cat.find((x) => x.code === 'vendedor_ruta');
    const chain = await k('identity.positions')
      .where({ tenant_id: TENANT, code: 'vendedor_ruta' })
      .first('reports_to_position_code');
    check(chain && chain.reports_to_position_code === 'supervisor_rd',
      `vendedor_ruta reporta a supervisor_rd (la única arista que el dato prueba: 29 personas)`);
    if (!vr) declarar('vendedor_ruta no existe en este tenant');

    const trx = await k.transaction();
    try {
      // 3a. ciclo INDIRECTO (el CHECK por sí solo no lo ve: sólo mira la fila)
      let rechazo = false;
      try {
        await trx.raw(
          `UPDATE identity.positions SET reports_to_position_code = 'vendedor_ruta'
            WHERE tenant_id = ? AND code = 'supervisor_rd'`, [TENANT]);
      } catch { rechazo = true; }
      check(rechazo, 'ciclo INDIRECTO (supervisor_rd -> vendedor_ruta -> supervisor_rd) RECHAZADO');
      if (rechazo) await trx.raw('ROLLBACK; BEGIN');

      // 3b. auto-reporte directo
      rechazo = false;
      try {
        await trx.raw(
          `UPDATE identity.positions SET reports_to_position_code = 'cajera'
            WHERE tenant_id = ? AND code = 'cajera'`, [TENANT]);
      } catch { rechazo = true; }
      check(rechazo, 'auto-reporte (cajera -> cajera) RECHAZADO');
      if (rechazo) await trx.raw('ROLLBACK; BEGIN');

      // 3c. jefe inexistente (FK)
      rechazo = false;
      try {
        await trx.raw(
          `UPDATE identity.positions SET reports_to_position_code = 'puesto_que_no_existe'
            WHERE tenant_id = ? AND code = 'cajera'`, [TENANT]);
      } catch { rechazo = true; }
      check(rechazo, 'jefe inexistente RECHAZADO por la FK compuesta');
      if (rechazo) await trx.raw('ROLLBACK; BEGIN');

      // 3d. CONTROL POSITIVO — sin esto, un candado que bloquee TODO se ve verde
      let aceptado = false;
      try {
        await trx.raw(
          `UPDATE identity.positions SET reports_to_position_code = 'encargado_sucursal'
            WHERE tenant_id = ? AND code = 'cajera'`, [TENANT]);
        aceptado = true;
      } catch (e) { console.log(`       (rechazo inesperado: ${e.message.slice(0, 70)})`); }
      check(aceptado, 'CONTROL: una arista legítima (cajera -> encargado_sucursal) SÍ se acepta');
    } finally {
      await trx.rollback();
    }

    const tocado = await k('identity.positions')
      .where({ tenant_id: TENANT })
      .whereNotNull('reports_to_position_code')
      .count('* as n')
      .first();
    check(Number(tocado.n) === 1,
      `prod intacto tras las pruebas: ${tocado.n} arista(s), la sembrada`);

    // ── 4. El catálogo de responsabilidades ───────────────────────────────
    console.log('\n── 4. Responsabilidades');
    const resp = await k('identity.responsibilities').select('key', 'dimension');
    check(resp.length === 8, `el catálogo tiene ${resp.length} responsabilidades (una por bandeja de me-work.ts)`);

    const sinEje = resp.filter((x) => !x.dimension).map((x) => x.key);
    check(sinEje.length === 5,
      `${sinEje.length} colas SIN eje de ruteo — medido, no asumido: ${sinEje.join(', ')}`);

    // Es catálogo de PRODUCTO: sin RLS, sólo lectura para la app.
    const meta = await k.raw(
      `SELECT c.relrowsecurity AS rls,
              has_table_privilege('app_runtime', 'identity.responsibilities', 'SELECT') AS lee,
              has_table_privilege('app_runtime', 'identity.responsibilities', 'INSERT') AS escribe
         FROM pg_class c WHERE c.oid = 'identity.responsibilities'::regclass`);
    const m = meta.rows[0];
    check(m.rls === false, 'identity.responsibilities SIN RLS (es catálogo de producto, patrón scope_dimensions)');
    check(m.lee === true && m.escribe === false, 'app_runtime la LEE y no la escribe');

    for (const t of ['position_responsibilities', 'user_responsibilities']) {
      const r = await k.raw(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forzado,
                (SELECT count(*)::int FROM pg_policies WHERE schemaname='identity' AND tablename=?) AS pol
           FROM pg_class c WHERE c.oid = ?::regclass`, [t, `identity.${t}`]);
      const x = r.rows[0];
      check(x.rls && x.forzado && x.pol > 0, `identity.${t}: RLS FORZADO con política de tenant`);
    }

    // ── 5. La excepción por persona CUESTA (prueba negativa) ──────────────
    console.log('\n── 5. La excepción por persona tiene que costar');
    const alguien = await k('identity.users')
      .where({ tenant_id: TENANT, kind: 'interno', activo: true })
      .whereNull('deleted_at')
      .first('id');
    const trx2 = await k.transaction();
    try {
      let rechazo = false;
      try {
        await trx2('identity.user_responsibilities').insert({
          tenant_id: TENANT, user_id: alguien.id, responsibility_key: 'finanzas.hallazgos',
          accion: 'suma', nota: '   ',
        });
      } catch { rechazo = true; }
      check(rechazo, 'una excepción con `nota` en blanco RECHAZADA — es lo que evita que se vuelva user_roles (129 de 134 filas espejo)');
      if (rechazo) await trx2.raw('ROLLBACK; BEGIN');

      rechazo = false;
      try {
        await trx2('identity.user_responsibilities').insert({
          tenant_id: TENANT, user_id: alguien.id, responsibility_key: 'finanzas.hallazgos',
          accion: 'suma', nota: 'motivo real', valid_from: '2026-12-31', valid_to: '2026-01-01',
        });
      } catch { rechazo = true; }
      check(rechazo, 'una vigencia invertida (valid_to < valid_from) RECHAZADA');
      if (rechazo) await trx2.raw('ROLLBACK; BEGIN');

      rechazo = false;
      try {
        await trx2('identity.user_responsibilities').insert({
          tenant_id: TENANT, user_id: alguien.id, responsibility_key: 'no.existe',
          accion: 'suma', nota: 'motivo real',
        });
      } catch { rechazo = true; }
      check(rechazo, 'una responsabilidad fuera del catálogo RECHAZADA');
      if (rechazo) await trx2.raw('ROLLBACK; BEGIN');

      // CONTROL POSITIVO otra vez: con nota y clave válidas, entra.
      let aceptado = false;
      try {
        await trx2('identity.user_responsibilities').insert({
          tenant_id: TENANT, user_id: alguien.id, responsibility_key: 'finanzas.hallazgos',
          accion: 'suma', nota: 'control del smoke — se revierte',
        });
        aceptado = true;
      } catch (e) { console.log(`       (rechazo inesperado: ${e.message.slice(0, 70)})`); }
      check(aceptado, 'CONTROL: una excepción bien formada SÍ se acepta');
    } finally {
      await trx2.rollback();
    }

    const ur = await k('identity.user_responsibilities').count('* as n').first();
    check(Number(ur.n) === 0, `prod intacto: ${ur.n} excepciones por persona`);

    // ── 6. Lo que falta, declarado ────────────────────────────────────────
    console.log('\n── 6. Lo que todavía no se decidió');
    const pr = await k('identity.position_responsibilities')
      .where({ tenant_id: TENANT })
      .whereNull('deleted_at')
      .count('* as n')
      .first();
    if (Number(pr.n) === 0) {
      declarar(
        'position_responsibilities está VACÍA: ningún puesto responde de nada todavía. Es deliberado ' +
        '([OR.1b]): sembrarla desde el permiso haría responsable de los 82,289 hallazgos de finanzas a ' +
        'auxiliar_mkt, que puede ABRIR 6 de las 8 bandejas. Hasta que se decida, [OR.3] reporta sin_dueño.',
      );
    } else {
      check(true, `${pr.n} asignaciones puesto x responsabilidad`);
    }

    const sinJefe = await k.raw(
      `SELECT count(*)::int n FROM identity.positions p
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.reports_to_position_code IS NULL
          AND EXISTS (SELECT 1 FROM identity.users u WHERE u.tenant_id = p.tenant_id
                       AND u.position_code = p.code AND u.activo AND u.deleted_at IS NULL)`,
      [TENANT]);
    if (sinJefe.rows[0].n > 0) {
      declarar(
        `${sinJefe.rows[0].n} puesto(s) CON gente y sin jefe declarado. NULL acá es "no se decidió", ` +
        'no "no tiene jefe": el dato sólo probaba la arista supervisor_rd <- vendedor_ruta y el resto ' +
        'se decide con el lead, puesto por puesto.',
      );
    }

    console.log(
      `\n${fail === 0 ? '✅' : '❌'} [OR.0/OR.1] el puesto es la unidad organizacional: ` +
      `${ok} ok, ${fail} fallos, ${nomedido} no medido(s)`,
    );
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\n❌ ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await k.destroy();
  }
})();
