'use strict';
/**
 * `[ID.31]` — El sujeto se declara, y la invitación es representable.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * `identity.users.kind` metía en la misma bolsa (`interno`) a **109 personas y
 * 14 credenciales de puesto**, y la señal que supuestamente las distinguía
 * —`token_ttl_days IS NOT NULL`— está en **NULL en el 100%** de las filas. O sea
 * que no había ninguna forma de saber si una credencial es de un humano.
 *
 * Eso bloqueaba dos cosas concretas: encender `must_change_password` sin dejar
 * un turno afuera (un kiosco no puede cambiar su contraseña), y derivar la
 * asignación de un hallazgo sin dárselo a una etiquetera.
 *
 * ── Read-only, y la prueba negativa igual muerde ─────────────────────────────
 * Un CHECK sólo se comprueba **ejerciéndolo**: afirmar que existe leyendo
 * `pg_constraint` afirma que alguien escribió un `ADD CONSTRAINT`, no que la
 * base rechace la fila mala. El primer intento fue insertar dentro de una
 * transacción con ROLLBACK, y se descartó: `[IDG.1]` existe justamente porque
 * el 2026-08-29 el suite corrió apuntando a producción y dejó 5 cuentas de
 * prueba en el padrón real. Un rollback que casi siempre funciona no es una
 * garantía.
 *
 * En su lugar se **saca del catálogo la definición REAL del CHECK** y se evalúa
 * contra valores sintéticos con un `SELECT` sobre una subconsulta que aliasea
 * los nombres de columna. Así se ejerce el predicado que de verdad está en la
 * base —no una copia escrita acá, que sólo comprobaría que sé escribir un `OR`—
 * y no se toca una sola fila.
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
    console.log('\n[1] `kind` admite `dispositivo`, y los 5 valores viejos siguen');
    const { rows: chk } = await k.raw(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'identity.users'::regclass AND conname = 'users_kind_valido'`,
    );
    if (!chk.length) {
      declarar('no existe el CHECK users_kind_valido: el vocabulario de `kind` no está acotado');
    } else {
      const def = chk[0].def;
      const esperados = ['interno', 'dispositivo', 'cliente', 'proveedor', 'externo', 'servicio'];
      const faltan = esperados.filter((v) => !def.includes(`'${v}'`));
      check(faltan.length === 0, `el CHECK admite los 6 valores (faltan: ${faltan.join(', ') || 'ninguno'})`);
    }

    console.log('\n[2] Los dispositivos están declarados, y son los que corresponden');
    const { rows: cls } = await k.raw(
      `SELECT
         count(*) FILTER (WHERE kind = 'dispositivo')::int AS dispositivos,
         count(*) FILTER (WHERE kind = 'interno')::int AS personas,
         -- Una persona degradada a máquina es el error caro de esta etapa: un
         -- nombre de 2+ palabras que no es su propio username ES una persona.
         --
         -- [OR.9] La excepción dejó de ser el prefijo Etiquetas y pasó a ser la
         -- convención que esa familia siempre siguió: <función> - <lugar>.
         -- Medido en prod (2026-09-12): el separador " - " lo traen las 12
         -- estaciones (8 etiqueteras + 2 checadores + 2 verificadores) y CERO
         -- personas, así que generalizar no afloja el candado, lo aprieta. Con
         -- la regla vieja los 4 kioscos daban falso positivo acá («Checador -
         -- Padre Hidalgo» son 4 palabras) y falso negativo abajo.
         count(*) FILTER (WHERE kind = 'dispositivo' AND nombre IS NOT NULL
           AND nombre NOT LIKE '% - %' AND upper(btrim(nombre)) <> upper(username)
           AND array_length(regexp_split_to_array(btrim(nombre), '\\s+'), 1) >= 2)::int AS personas_mal,
         -- Y al revés: un nombre que es una estación o un código no es persona.
         -- Con la regla vieja, los 4 kioscos del 12-sep pasaban derecho.
         count(*) FILTER (WHERE kind = 'interno'
           AND (nombre LIKE '% - %' OR upper(btrim(nombre)) = upper(username)))::int AS sin_marcar
        FROM identity.users WHERE tenant_id = ? AND deleted_at IS NULL`,
      [TENANT],
    );
    const c0 = cls[0];
    console.log(`      ${c0.dispositivos} dispositivos · ${c0.personas} personas`);
    check(c0.dispositivos > 0, `hay dispositivos declarados (${c0.dispositivos})`);
    check(c0.personas_mal === 0, `0 personas marcadas como dispositivo (hay ${c0.personas_mal})`);
    check(c0.sin_marcar === 0, `0 credenciales de puesto todavía como interno (hay ${c0.sin_marcar})`);

    console.log('\n[2b] `[OR.9]` Las señales que el heurístico de [2] NO ve');
    /*
     * El 2026-09-12 entraron cuatro kioscos al padrón como `kind='interno'`
     * (`checador.01/03`, `verificador.01/03`) y el bloque [2] no los vio: su
     * heurística busca `nombre ~ '^Etiquetas'` o `nombre = username`, y
     * «Checador - Padre Hidalgo» no es ninguna de las dos.
     *
     * Costaba dos cosas medibles: el padrón reportaba 104 personas con 4 sin
     * puesto y 4 sin jefe (eran los kioscos), y ⛔ una estación con
     * `kind='interno'` **es elegible para recibir trabajo asignado**.
     *
     * Acá no hay heurística: hay una DECLARACIÓN. Los roles de estación se
     * listan con nombre, y la convención de username se escribe una vez.
     */
    const ROLES_DE_ESTACION = ['checador_kiosco', 'verificador_precios', 'etiquetas_anaquel'];
    const USERNAME_DE_ESTACION = '^[a-z_]+[.][0-9]+$';

    // ⚠️ La lista va INTERPOLADA, no como binding: knex expande un array a una
    // lista de bindings y rompe `= ANY(?)`. Son literales de este archivo, no
    // entrada de nadie. El regex sí va como binding.
    const EN_ROLES = `role_name IN (${ROLES_DE_ESTACION.map((r) => `'${r}'`).join(', ')})`;
    const { rows: est } = await k.raw(
      `SELECT
         count(*) FILTER (WHERE ${EN_ROLES})::int   AS por_rol,
         count(*) FILTER (WHERE username ~ ?)::int  AS por_username,
         count(*) FILTER (WHERE ${EN_ROLES} AND kind = 'interno')::int   AS rol_mal,
         count(*) FILTER (WHERE username ~ ? AND kind = 'interno')::int  AS username_mal
       FROM identity.users WHERE tenant_id = ? AND deleted_at IS NULL`,
      [USERNAME_DE_ESTACION, USERNAME_DE_ESTACION, TENANT],
    );
    const e0 = est[0];

    // CONTROL POSITIVO primero: una regla que no encuentra nada da «0 mal» por
    // vacío, y se lee idéntico a «todo bien». Si el universo es 0, se DECLARA.
    if (e0.por_rol === 0) {
      declarar('ningún rol de estación tiene cuentas: el candado por rol no prueba nada hoy');
    } else {
      check(e0.rol_mal === 0,
        `las ${e0.por_rol} cuentas con rol de estación son dispositivo (hay ${e0.rol_mal} como interno)`);
    }
    if (e0.por_username === 0) {
      declarar('ninguna cuenta usa `<función>.<sucursal>`: el candado por username no prueba nada hoy');
    } else {
      check(e0.username_mal === 0,
        `las ${e0.por_username} cuentas \`<función>.<sucursal>\` son dispositivo (hay ${e0.username_mal} como interno)`);
    }

    // Y que las dos señales sigan siendo INDEPENDIENTES: si una fuera
    // subconjunto perfecto de la otra, la segunda no agregaría nada y podría
    // retirarse. Hoy no lo son (12 por username · 12 por rol, distinto universo
    // en cuanto alguien agregue un kiosco sin la convención de nombre).
    console.log(`      ${e0.por_rol} por rol · ${e0.por_username} por username`);

    /*
     * ⚠️ ABIERTO — `ruta_505` («RUTA 505», rol `promotor_ruta`, alta el mismo
     * día que las tabletas `rvph0N` que sí son `dispositivo`, con ruta asignada
     * y login desde Android). Parece credencial de ruta compartida, pero
     * `promotor_ruta` lo tienen 13 personas reales, así que ninguna de las dos
     * señales aplica. Degradarla la sacaría del padrón y del reparto de
     * trabajo. Se declara para que no se pierda, no se adivina.
     */
    // ── PRUEBA NEGATIVA — el candado tiene que MORDER ─────────────────────
    // No se escribe una fila (ver el encabezado: [IDG.1] dejó 5 cuentas de
    // prueba en el padrón real). Se evalúan los DOS predicados contra filas
    // sintéticas, que es ejercerlos de verdad sin tocar el padrón.
    const clasifica = async (username, nombre, kind, role_name) => {
      const { rows } = await k.raw(
        `SELECT (kind = 'interno' AND (nombre LIKE '% - %' OR upper(btrim(nombre)) = upper(username))) AS sin_marcar,
                (kind = 'interno' AND (${EN_ROLES} OR username ~ ?)) AS es_estacion
           FROM (SELECT ?::varchar AS username, ?::varchar AS nombre,
                        ?::varchar AS kind, ?::varchar AS role_name) t`,
        [USERNAME_DE_ESTACION, username, nombre, kind, role_name],
      );
      return rows[0];
    };
    // El caso que se escapó el 12-sep: tiene que dar positivo en las dos.
    const kiosco = await clasifica('checador.99', 'Checador - Sucursal Nueva', 'interno', 'checador_kiosco');
    check(kiosco.sin_marcar === true && kiosco.es_estacion === true,
      'un kiosco nuevo dado de alta como interno lo atrapan los DOS candados');
    // Y el error caro al revés: una persona normal no puede dispararlos.
    const persona = await clasifica('ana_lopez', 'ANA LOPEZ MARTINEZ', 'interno', 'cajero');
    check(persona.sin_marcar === false && persona.es_estacion === false,
      'una persona con nombre y rol normales NO la toca ninguno de los dos');
    // Control del control: si el predicado dijera true a todo, lo de arriba
    // pasaría igual. Un kiosco YA marcado como dispositivo no debe reportarse.
    const yaOk = await clasifica('checador.99', 'Checador - Sucursal Nueva', 'dispositivo', 'checador_kiosco');
    check(yaOk.sin_marcar === false && yaOk.es_estacion === false,
      'y el mismo kiosco ya marcado como dispositivo deja de reportarse (el predicado discrimina)');

    const { rows: r505 } = await k.raw(
      `SELECT kind FROM identity.users WHERE tenant_id = ? AND username = 'ruta_505' AND deleted_at IS NULL`,
      [TENANT],
    );
    if (r505.length) declarar(`ruta_505 sigue como '${r505[0].kind}' — falta decisión humana (¿tableta o persona?)`);

    console.log('\n[3] Las 28 cuentas con username numérico NO son dispositivos');
    // El heurístico fácil (username que arranca en dígito) se equivocaba en 26
    // de 28: son cajeras cuyo usuario es su código de caja. Este bloque afirma
    // que no las barrimos por parecerse a un código.
    const { rows: num } = await k.raw(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE kind = 'dispositivo')::int AS marcadas
         FROM identity.users
        WHERE tenant_id = ? AND deleted_at IS NULL AND username ~ '^[0-9]'`,
      [TENANT],
    );
    check(num[0].marcadas === 0,
      `ninguna de las ${num[0].total} cuentas con username numérico quedó como dispositivo (${num[0].marcadas})`);

    console.log('\n[4] `status = invited` ya es representable');
    const { rows: col } = await k.raw(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'identity' AND table_name = 'users' AND column_name = 'password_hash'`,
    );
    check(col[0]?.is_nullable === 'YES', 'password_hash es nullable: un usuario sin contraseña cabe en la tabla');

    console.log('\n[5] PRUEBA NEGATIVA — se ejerce el CHECK REAL, sin escribir una fila');
    const { rows: cdef } = await k.raw(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'identity.users'::regclass
          AND conname = 'users_hash_solo_falta_si_corresponde'`,
    );
    if (!cdef.length) {
      declarar('no existe el CHECK users_hash_solo_falta_si_corresponde: nada que ejercer');
    } else {
      // Se le quita el envoltorio `CHECK (...)` y queda el predicado, que
      // referencia columnas por nombre. Aliasearlas en una subconsulta permite
      // evaluarlo con valores sintéticos.
      const pred = cdef[0].def.replace(/^CHECK\s*\(/, '').replace(/\)\s*$/, '');
      const evaluar = async (hash, kind, status) => {
        const { rows } = await k.raw(
          `SELECT (${pred}) AS acepta
             FROM (SELECT ?::varchar AS password_hash, ?::varchar AS kind, ?::varchar AS status) t`,
          [hash, kind, status],
        );
        return rows[0].acepta === true;
      };

      // La que tiene que MORDER: una persona activa sin contraseña.
      check(!(await evaluar(null, 'interno', 'active')),
        'un usuario interno+active sin password_hash lo RECHAZA el predicado real de la base');
      // Y las que tienen que pasar. Si el CHECK rechazara las tres, no habría
      // desbloqueado nada y el bloque [4] sería decorativo.
      check(await evaluar(null, 'interno', 'invited'),
        'una cuenta status=invited sin contraseña SÍ pasa — la invitación dejó de ser inrepresentable');
      check(await evaluar(null, 'servicio', 'active'),
        'la cuenta de servicio puede no tener hash (su login está cortado por `kind`, [ID.17])');
      check(await evaluar('$2a$dummy', 'interno', 'active'),
        'y el caso normal —persona con hash— sigue pasando');
    }

    console.log('\n[6] Nada quedó sin hash indebidamente en el padrón real');
    const { rows: sh } = await k.raw(
      `SELECT count(*)::int AS n FROM identity.users
        WHERE password_hash IS NULL AND kind <> 'servicio' AND status <> 'invited'`,
    );
    check(sh[0].n === 0, `0 filas sin hash fuera de servicio/invited (hay ${sh[0].n})`);

    console.log('\n[7] El login blinda el hash nulo ANTES de bcrypt');
    // `bcrypt.compare(x, null)` LANZA (`Illegal arguments`), o sea 500 en vez de
    // 401. Con la columna nullable eso deja de ser hipotético.
    const fs = require('fs');
    const REPO = path.resolve(__dirname, '..', '..');
    for (const f of [
      'apps/api/src/modules/auth/auth.service.ts',
      'apps/api/src/modules/auth-mt/auth-mt.service.ts',
    ]) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      // El guard tiene que estar en la MISMA expresión que el compare, no en un
      // `if` anterior que alguien pueda mover.
      check(/!!\s*\w+\.password_hash\s*&&\s*\(?await bcrypt\.compare/.test(src),
        `${f.split('/').pop()} corta antes de bcrypt.compare cuando el hash es nulo`);
    }

    console.log(`\n${fail === 0 ? '✅' : '❌'} [ID.31] sujeto declarado: ${ok} ok, ${fail} fallos, ${nomedido} no medido(s)`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\n❌ ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await k.destroy();
  }
})();
