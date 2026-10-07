/* eslint-disable no-console */
/**
 * `[GX.68]` — Smoke DB-directo del **alcance con que se abre el expediente de un vale**.
 *
 * ## Qué defecto vigila
 * `GET /finance/expenses/proofs/:id` —el endpoint que trae el expediente CON SUS ARCHIVOS—
 * exigía `FINANCE_EXPENSES_VER` y nada más: era el único read del módulo que no aceptaba
 * `CAPTURAR` ni `COMPROBAR`. Resultado medido en esta misma base: **11 roles tienen
 * `CAPTURAR` sin `VER` = 76 usuarios**, o sea que justo quien levanta el vale recibía 403 al
 * abrir su propia evidencia.
 *
 * Ahora el permiso abre la puerta y el servicio pone el alcance: sin `VER` ni `COMPROBAR`,
 * el vale tiene que ser suyo (`esDuenoDelVale`).
 *
 * ## ⭐ La PREMISA que este archivo vigila, y por qué no es un detalle
 * El token de sesión trae `username`, **no** `full_name`. Y los vales se guardan con
 * `full_name || username`. Si la resolución contra el padrón (`users.nombre`) se quitara por
 * "redundante", el alcance compararía sólo el username y **le negaría el vale a su propio
 * dueño** en todos los que se guardaron con el nombre.
 *
 * No es hipotético: **medido en esta base, la mayoría de los vales se guarda con el NOMBRE**.
 * Este smoke mide esa proporción contra la tabla real y falla si alguien la da por cero —
 * que es justo lo que haría pensar que el padrón sobra.
 *
 * ⚠️ El alcance en sí (quién puede ver qué) se prueba sin base en
 * `libs/contracts/src/finance/ver-expediente.spec.ts`: es una decisión pura. Acá se prueba lo
 * que esa decisión NECESITA de la base, que es lo que un spec con mocks no puede ver.
 *
 * Todo corre en una transacción con rollback.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

/** La misma normalización del contrato (mayúsculas, sin `link:`, espacios colapsados). */
const norm = (v) => String(v ?? '').replace(/^\s*link:/i, '').trim().replace(/\s+/g, ' ').toUpperCase();

(async () => {
  try {
    const reg = await knex.raw(`SELECT to_regclass('finance.expense_proofs') t`);
    ok(!!reg.rows[0].t, 'finance.expense_proofs existe');

    // ── 1. ⭐ La premisa: ¿cuántos vales se guardan con el NOMBRE y no con el username? ──
    const { rows: [f] } = await knex.raw(`
      SELECT
        COUNT(*) FILTER (WHERE created_by ~ '^[a-z0-9_.]+$')::int AS por_username,
        COUNT(*) FILTER (WHERE created_by IS NOT NULL
                           AND created_by !~ '^[a-z0-9_.]+$'
                           AND created_by NOT ILIKE 'link:%')::int AS por_nombre,
        COUNT(*) FILTER (WHERE created_by ILIKE 'link:%')::int AS por_link,
        COUNT(*)::int AS total
      FROM finance.expense_proofs WHERE tenant_id = ?`, [T]);
    console.log(`     (universo: ${f.total} vales — ${f.por_username} por username, ${f.por_nombre} por nombre, ${f.por_link} por link)`);
    ok(f.total > 0, `hay vales con qué medir (${f.total})`);
    ok(f.por_nombre > 0,
      `⭐ ${f.por_nombre} vales se guardan con el NOMBRE: sin resolver el padrón, a ésos se les niega su propio vale`);
    // Los dos formatos conviven: si alguna vez queda uno solo, esta línea lo avisa antes de
    // que alguien "simplifique" la comparación a un solo campo.
    ok(f.por_username > 0 && f.por_nombre > 0,
      'conviven las DOS formas (username y nombre) — comparar una sola no alcanza');

    // ── 2. El padrón resuelve: username → nombre ─────────────────────────────
    const muestra = await knex('finance.expense_proofs as p')
      .join('users as u', function () { this.on(knex.raw('lower(u.username) = lower(p.created_by)')); })
      .where('p.tenant_id', T).whereNotNull('u.nombre').whereRaw("btrim(u.nombre) <> ''")
      .first('p.created_by', 'u.username', 'u.nombre');
    if (muestra) {
      ok(norm(muestra.nombre).length > 0,
        `el padrón resuelve el nombre de un capturista real ('${muestra.username}' → '${muestra.nombre}')`);
    } else {
      // ⛔ NO se da por bueno en silencio: se DECLARA que no se pudo medir (ADR-056).
      console.log('  — NO MEDIDO: ningún vale de esta base casa con un usuario del padrón');
    }

    // ── 3. El alcance, sobre filas sembradas ─────────────────────────────────
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const base = {
        tenant_id: T, sucursal: '00', departamento: 'SMOKE-GX68', importe: 50,
        solicitante: 'SMOKE GX68', proveedor: 'PROVEEDOR SMOKE', status: 'recibida',
      };
      const mk = async (sufijo, extra) => {
        const [r] = await trx('finance.expense_proofs')
          .insert({ ...base, folio_solicitud: `GX68-${sufijo}`, ...extra }).returning(['id', 'created_by', 'evidencia_por']);
        return r;
      };
      // Quien abre: el token sólo trae el username; el nombre lo pondrá el padrón.
      const YO = { username: 'cajera_smoke', full_name: 'Ana Ruiz Smoke' };

      const porUsuario = await mk('USR', { created_by: YO.username });
      const porNombre = await mk('NOM', { created_by: YO.full_name });
      const porLink = await mk('LNK', { created_by: `link:  ${YO.full_name.toLowerCase()} ` });
      const porEvidencia = await mk('EVI', { created_by: 'otra_persona', evidencia_por: YO.full_name });
      const ajeno = await mk('AJENO', { created_by: 'otro_cajero', evidencia_por: 'Luis Pérez' });

      // Réplica EXACTA de `esDuenoDelVale` del contrato (acá no se puede importar TS).
      const esDueno = (v, quien) => {
        const duenos = [v.created_by, v.evidencia_por].map(norm).filter(Boolean);
        const yo = [quien.username, quien.full_name].map(norm).filter(Boolean);
        return yo.some((y) => duenos.includes(y));
      };
      // ⚠️ SIN el nombre del padrón: es lo que pasaría si se quitara `identidadConNombre`.
      const soloToken = { username: YO.username, full_name: '' };

      ok(esDueno(porUsuario, YO), 'abre el vale que levantó con su username');
      ok(esDueno(porNombre, YO), 'abre el que quedó guardado con su nombre completo');
      ok(esDueno(porLink, YO), 'abre el capturado por link (`link:NOMBRE`, con espacios y minúsculas)');
      ok(esDueno(porEvidencia, YO), 'abre aquel al que le subió la evidencia');
      ok(!esDueno(ajeno, YO), '⛔ NEGATIVA: NO abre el vale de otra persona');

      // ⭐ La prueba negativa de la premisa: sin el padrón, se le cae la mayoría.
      ok(!esDueno(porNombre, soloToken),
        '⭐ NEGATIVA: sin resolver el padrón, su propio vale guardado con el nombre le queda NEGADO');
      ok(esDueno(porUsuario, soloToken), 'y el guardado con username seguiría abriendo — por eso el defecto sería parcial y silencioso');

      throw new Error('ROLLBACK_SMOKE');
    }).catch((e) => { if (e.message !== 'ROLLBACK_SMOKE') throw e; });

    const [quedo] = await knex('finance.expense_proofs')
      .where({ tenant_id: T }).whereLike('folio_solicitud', 'GX68-%').count('* as n');
    ok(Number(quedo.n) === 0, 'el rollback dejó la base como estaba (0 filas de prueba)');
  } catch (e) {
    fail++; console.log('  ✗ excepción:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n[GX.68] alcance del expediente — ${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
