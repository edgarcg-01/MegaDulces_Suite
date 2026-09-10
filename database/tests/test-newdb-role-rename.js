'use strict';
/**
 * `[ID.32]` — Renombrar un rol es un `UPDATE`, y cada clave del catálogo la
 * concede alguien.
 *
 * ── Por qué existe el primer bloque ──────────────────────────────────────────
 * Hay **14 roles `retirado_*`** en prod. No son roles: son **nombres liberados**.
 * Existen porque las FK compuestas `(tenant_id, role_name)` estaban en
 * `ON UPDATE NO ACTION`, así que cambiar el nombre de un rol reventaba con
 * violación de FK y la salida fue prefijar el viejo y crear otro al lado.
 *
 * ⚠️ Son **CUATRO** FK, no tres como decía el plan: la cuarta es
 * `positions_default_role_fk`, sobre el rol que un PUESTO propone por default.
 * Dejarla afuera habría hecho que el renombre siguiera fallando justo en los
 * roles más usados.
 *
 * ── Por qué existe el segundo bloque (`[LC.6.2]`, G4 de la Etapa 1) ──────────
 * La lección de `[LC.6.2]`: **un módulo no está entregado hasta que su permiso
 * está REPARTIDO en prod, no sólo declarado en el enum.** Ahí el par
 * `FISCAL_PURCHASE_BOOK_*` vivió en el enum sin que ningún rol lo concediera, y
 * nadie podía abrir el módulo. Este bloque mide la cobertura y declara el
 * residuo con nombre en vez de dejarlo pasar.
 *
 * ── Read-only ────────────────────────────────────────────────────────────────
 * La cascada se **ejerció de verdad** en la migración `20260910140000`, dentro
 * de su propia transacción y sobre un rol ya retirado (renombrar → verificar que
 * las 6 filas de alcance siguieron → renombrar de vuelta). Acá se afirma el
 * estado, que es lo que puede regresar: una FK nueva agregada sin `CASCADE`, o
 * un trigger apagado.
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

/** Claves sin repartir que están aceptadas, CON motivo escrito. Sin motivo no entra. */
const SIN_REPARTIR_ACEPTADAS = {
  COMMERCIAL_PREVENTION_GESTIONAR:
    'el módulo de prevención existe en lectura (COMMERCIAL_PREVENTION_VER) y su gestión no se ' +
    'entregó todavía: no hay rol que deba escribirlo hasta que se decida quién audita.',
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
    console.log('\n[1] Las FK del rol cascadean el renombre');
    const { rows: fks } = await k.raw(
      `SELECT c.conname, c.conrelid::regclass::text AS tabla, c.confupdtype, c.confdeltype
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confrelid = 'identity.role_permissions'::regclass
        ORDER BY 2, 1`,
    );
    console.log(`      ${fks.length} FK apuntan a role_permissions`);
    const sinCascade = fks.filter((r) => r.confupdtype !== 'c');
    check(fks.length >= 4, `hay al menos las 4 FK conocidas (hay ${fks.length})`);
    check(sinCascade.length === 0,
      `todas en ON UPDATE CASCADE (sin cascada: ${sinCascade.map((r) => `${r.tabla}.${r.conname}`).join(', ') || 'ninguna'})`);
    // El `ON DELETE` NO se uniformó a propósito y hay que afirmarlo: `RESTRICT`
    // en `users` es lo que impide borrar un rol con gente adentro. Si alguien lo
    // pasa a CASCADE «por consistencia», borrar un rol se lleva a las personas.
    // ⚠️ `conrelid::regclass::text` devuelve `users`, SIN el prefijo del schema,
    // porque `identity` está en el `search_path`. Comparar contra
    // `'identity.users'` daba `undefined` y la aserción fallaba por el lookup,
    // no por el dato — el `confdeltype` real siempre fue `r`.
    const users = fks.find((r) => r.tabla.replace(/^identity\./, '') === 'users');
    check(users?.confdeltype === 'r',
      `identity.users conserva ON DELETE RESTRICT (es ${users?.confdeltype ?? 'no encontrada'}): borrar un rol con gente adentro sigue fallando`);

    console.log('\n[2] Los triggers de esas FK están ENCENDIDOS');
    // `[IDG.6]`: prod tuvo `identity.users` con 144 de sus 195 triggers
    // deshabilitados, y `pg_constraint.convalidated` decía `true` todo el
    // tiempo. Se mira `tgenabled`, no la metadata que ya mintió una vez.
    const { rows: trg } = await k.raw(
      `SELECT t.tgname, t.tgenabled, c.relname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_constraint x ON x.oid = t.tgconstraint
        WHERE x.confrelid = 'identity.role_permissions'::regclass`,
    );
    const apagados = trg.filter((r) => r.tgenabled !== 'O');
    check(trg.length > 0, `se encontraron ${trg.length} triggers de FK que vigilan el rol`);
    check(apagados.length === 0,
      `ninguno apagado (apagados: ${apagados.map((r) => `${r.relname}.${r.tgname}`).join(', ') || 'ninguno'})`);

    console.log('\n[3] `[LC.6.2]` — cada clave del catálogo la concede alguien');
    const jsonbTodas = `SELECT DISTINCT e.k FROM identity.role_permissions rp
                          CROSS JOIN LATERAL jsonb_each(rp.permissions) e(k, v)`;
    const jsonbConcedidas = `SELECT DISTINCT e.k FROM identity.role_permissions rp
                               CROSS JOIN LATERAL jsonb_each(rp.permissions) e(k, v)
                              WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL AND e.v = 'true'::jsonb`;
    const { rows: cob } = await k.raw(
      `SELECT (SELECT count(*) FROM (${jsonbTodas}) a)::int AS total,
              (SELECT count(*) FROM (${jsonbConcedidas}) b)::int AS concedidas`,
      [TENANT],
    );
    console.log(`      ${cob[0].concedidas} de ${cob[0].total} claves las concede al menos un rol vivo`);
    check(cob[0].total > 100, `el catálogo se pudo leer (${cob[0].total} claves — un 0 no es cobertura perfecta)`);

    const { rows: huerfanas } = await k.raw(
      `SELECT t.k FROM (${jsonbTodas}) t
        WHERE NOT EXISTS (SELECT 1 FROM (${jsonbConcedidas}) c2 WHERE c2.k = t.k) ORDER BY 1`,
      [TENANT],
    );
    const inesperadas = huerfanas.map((r) => r.k).filter((kk) => !SIN_REPARTIR_ACEPTADAS[kk]);
    check(inesperadas.length === 0,
      `ninguna clave sin repartir fuera de la lista con motivo (inesperadas: ${inesperadas.join(', ') || 'ninguna'})`);
    for (const kk of huerfanas.map((r) => r.k)) {
      if (SIN_REPARTIR_ACEPTADAS[kk]) console.log(`      · ${kk} — aceptada: ${SIN_REPARTIR_ACEPTADAS[kk]}`);
    }

    console.log('\n[4] Y las que concede un rol que NADIE tiene');
    // Distinto de lo anterior y peor de detectar: la clave está repartida en el
    // papel, pero el rol que la concede no le toca a ninguna persona activa. Es
    // el estado en que el módulo «existe» y nadie puede abrirlo.
    const { rows: sinGente } = await k.raw(
      `WITH concedidas AS (${jsonbConcedidas}),
            con_gente AS (
              SELECT DISTINCT e.k FROM identity.role_permissions rp
                CROSS JOIN LATERAL jsonb_each(rp.permissions) e(k, v)
               WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL AND e.v = 'true'::jsonb
                 AND (EXISTS (SELECT 1 FROM identity.users u
                               WHERE u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
                                 AND u.activo AND u.deleted_at IS NULL)
                   OR EXISTS (SELECT 1 FROM identity.user_roles ur
                                JOIN identity.users u2 ON u2.id = ur.user_id
                               WHERE ur.tenant_id = rp.tenant_id AND ur.role_name = rp.role_name
                                 AND u2.activo AND u2.deleted_at IS NULL)))
       SELECT c.k FROM concedidas c
        WHERE NOT EXISTS (SELECT 1 FROM con_gente g WHERE g.k = c.k) ORDER BY 1`,
      [TENANT, TENANT],
    );
    if (sinGente.length) {
      // NO es un fallo: un permiso puede estar listo antes que su gente. Se
      // DECLARA con nombre, que es lo que permite decidirlo.
      declarar(
        `${sinGente.length} clave(s) las concede un rol sin una sola persona activa: ` +
          `${sinGente.map((r) => r.k).join(', ')} → el módulo existe y nadie puede abrirlo`,
      );
    } else {
      check(true, 'toda clave concedida le toca a alguien activo');
    }

    console.log('\n[5] Los `retirado_*` siguen parados y sin gente');
    // Con la cascada puesta ya no hace falta crear más. Los 14 que existen
    // quedan: hard-borrar filas de rol es autorización aparte, y son inertes.
    const { rows: ret } = await k.raw(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE rp.deleted_at IS NULL)::int AS vigentes,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = ? AND u.role_name LIKE 'retirado%' AND u.deleted_at IS NULL) AS con_usuarios
         FROM identity.role_permissions rp
        WHERE rp.tenant_id = ? AND rp.role_name LIKE 'retirado%'`,
      [TENANT, TENANT],
    );
    console.log(`      ${ret[0].total} roles retirado_* · ${ret[0].vigentes} sin dar de baja`);
    check(ret[0].con_usuarios === 0, `ninguna persona cuelga de un retirado_* (hay ${ret[0].con_usuarios})`);

    console.log(`\n${fail === 0 ? '✅' : '❌'} [ID.32] renombre y reparto: ${ok} ok, ${fail} fallos, ${nomedido} no medido(s)`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\n❌ ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await k.destroy();
  }
})();
