'use strict';
/**
 * [EXP.0] Candado del reparto de `COMMERCIAL_PREVENTION_*`.
 *
 *   node database/tests/test-newdb-prevention-perms.js
 *
 * Sólo lee.
 *
 * ── Por qué este candado y no una migración a secas ─────────────────────────────────────
 *
 * El modo de falla que cerró la migración **vuelve solo**. `/admin/roles` escribe el JSONB
 * COMPLETO del rol que se guarda, así que cualquier clave que el enum tenga y el mapa no,
 * aterriza en **`false`**. Así fue como `almacenista` terminó siendo la única fila del sistema
 * que mencionaba `COMMERCIAL_PREVENTION_VER`, y en `false`. Mismo mecanismo que `[LC.6.2]`.
 *
 * Consecuencia medida antes del arreglo (2026-09-30): el módulo de Prevención llevaba en prod
 * desde agosto y lo abrían **2 personas, ambas de `direccion`** — el equipo que le da nombre al
 * rol, no. Y el número que lo delata: **1 expediente en toda la historia**, contra **7,301
 * renglones con diferencia sólo en sep-2026**.
 *
 * ── Lo que vigila ───────────────────────────────────────────────────────────────────────
 *
 * 1. Que el equipo de Prevención SIGA entrando (lo positivo).
 * 2. ⛔ Que `almacenista` SIGA sin entrar (lo negativo). **Quien cuenta no dictamina la causa
 *    de su propia diferencia** — misma segregación que IC.2 al quitarle `SUPERVISAR`. Si algún
 *    día esto se pone verde porque «ya todos tienen todo», el candado deja de significar algo.
 * 3. Que `GESTIONAR` NO se haya derramado al auxiliar: consultar el expediente y cerrar el caso
 *    son dos actos distintos.
 * 4. Que un permiso repartido alcance **personas**, no sólo roles — un rol sin gente es el
 *    defecto original con otra cara.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0, nm = 0;
const t = (n, c, x) => { if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { bad++; console.log(`  ✘ ${n}${x ? ' — ' + x : ''}`); } };
const noMedido = (n, m) => { nm++; console.log(`  ◻ NO MEDIDO: ${n} — ${m}`); };

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [EXP.0] el equipo de Prevención puede abrir Prevención ===\n');
  try {
    const { rows } = await db.raw(`
      SELECT r.role_name,
             (r.permissions->>'COMMERCIAL_PREVENTION_VER')::boolean       AS ver,
             (r.permissions->>'COMMERCIAL_PREVENTION_GESTIONAR')::boolean AS gestionar,
             -- Flecha y NO el operador interrogante de JSONB: knex no lo escapa y lo
             -- convierte en un binding posicional. Regla de la casa, y me la comi en la
             -- primera corrida de este mismo candado.
             (r.permissions -> 'COMMERCIAL_PREVENTION_GESTIONAR' IS NOT NULL) AS tiene_clave_gest,
             (SELECT count(*)::int FROM identity.users u
               WHERE u.role_name = r.role_name AND u.deleted_at IS NULL)  AS usuarios
        FROM identity.role_permissions r`);
    const m = Object.fromEntries(rows.map((r) => [r.role_name, r]));

    if (!m['prevencion']) {
      noMedido('todo el candado', 'no existe el rol `prevencion` en este destino');
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy(); process.exit(0);
    }

    // ── 1. Lo positivo: el equipo entra ────────────────────────────────────────────────
    t('`prevencion` puede VER el expediente', m['prevencion'].ver === true);
    t('`prevencion` puede GESTIONARLO (clasificar la causa y cerrar el caso)',
      m['prevencion'].gestionar === true);
    t('`prevencion_auxiliar` puede VER',
      m['prevencion_auxiliar'] ? m['prevencion_auxiliar'].ver === true : false,
      m['prevencion_auxiliar'] ? '' : 'el rol no existe acá');

    // ── 2. ⛔ Lo NEGATIVO, que es lo que hace útil al candado ──────────────────────────
    t('⛔ `almacenista` NO entra — quien cuenta no dictamina su propia diferencia',
      m['almacenista'] ? m['almacenista'].ver !== true : true,
      m['almacenista'] ? `ver=${m['almacenista'].ver}` : '');
    t('⛔ `prevencion_auxiliar` NO gestiona — consultar y cerrar son actos distintos',
      m['prevencion_auxiliar'] ? m['prevencion_auxiliar'].gestionar !== true : true);
    const retirados = rows.filter((r) => /^retirado/.test(r.role_name) && r.ver === true);
    t('⛔ ningún rol `retirado_*` recibió el permiso', retirados.length === 0,
      retirados.map((r) => r.role_name).join(','));

    // ── 3. Alcanza PERSONAS, no sólo roles ────────────────────────────────────────────
    {
      const [{ personas }] = (await db.raw(`
        SELECT count(DISTINCT u.id)::int AS personas
          FROM identity.role_permissions r
          JOIN identity.users u ON u.role_name = r.role_name AND u.deleted_at IS NULL
         WHERE (r.permissions->>'COMMERCIAL_PREVENTION_VER')::boolean`)).rows;
      t(`el expediente alcanza a personas reales (${personas})`, Number(personas) >= 3,
        `personas=${personas} — un rol sin gente es el defecto original con otra cara`);
      const prev = (m['prevencion'].usuarios || 0) + (m['prevencion_auxiliar']?.usuarios || 0);
      console.log(`      ⓘ ${personas} personas en total · ${prev} del equipo de Prevención`);
    }

    // ── 4. Lo declarado, que NO se arregló acá ────────────────────────────────────────
    if (m['supervisor'] && m['supervisor'].ver !== true) {
      noMedido('`supervisor`',
        'tampoco tiene la clave; quedó fuera del alcance aprobado y va en su propia migración');
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message); bad++;
  } finally { await db.destroy(); }
  process.exit(bad > 0 ? 1 : 0);
})();
