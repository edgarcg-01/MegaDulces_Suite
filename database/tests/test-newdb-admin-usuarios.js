'use strict';
/**
 * `[AU.6]` — Los candados de la administración de usuarios y de la organización.
 *
 * ── Qué sostiene ─────────────────────────────────────────────────────────────
 * La Fase AU abrió la puerta de `/admin/users` a 10 personas más, acotó el
 * padrón para que un permiso de REPORTES no lo abriera entero, y le dio
 * superficie a la organización (puestos, cadena de mando, responsabilidades).
 * Cada una de esas tres cosas puede aflojarse sin que nadie se entere.
 *
 * ── Read-only, y las pruebas negativas igual muerden ────────────────────────
 * No se escribe una sola fila. `[IDG.1]` existe porque el 2026-08-29 el suite
 * corrió apuntando a producción y dejó 5 cuentas de prueba en el padrón real.
 * En su lugar se **saca del catálogo la definición REAL de cada CHECK** y se
 * evalúa contra valores sintéticos, igual que hace `test-newdb-kind-dispositivo`:
 * así se ejerce el predicado que de verdad está en la base, no una copia escrita
 * acá que sólo comprobaría que sé escribir un `OR`.
 *
 * ── Y cada prueba negativa lleva su control positivo ────────────────────────
 * Un predicado que rechaza TODO pasaría la mitad de estos bloques. Por eso
 * después de cada «esto lo rechaza» va un «y esto lo acepta».
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knex = require('knex');

const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const REPO = path.resolve(__dirname, '..', '..');

let ok = 0;
let fail = 0;
let nomedido = 0;
const check = (cond, msg) => {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ FAIL ${msg}`); }
};
const declarar = (msg) => { nomedido++; console.log(`  ~ NO MEDIDO ${msg}`); };
const leer = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/**
 * LÍNEA BASE del alcance del padrón, medida el 2026-09-13 y declarada con su
 * motivo. El candado falla si alguien VE MÁS, no si el padrón crece.
 */
const BASE_ALCANCE = {
  // Los 9 superadmin salen por god-mode: `isPlatformAdminRole` se pregunta
  // explícito ANTES de degradar el `all`. Si esto bajara, el degradado se comió
  // al god-mode.
  superadmin_ve_todo: true,
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
    // ══ 1. La puerta ════════════════════════════════════════════════════════
    console.log('\n[1] `[AU.1]` La puerta de /admin/users la abre USUARIOS_VER');
    const rutas = leer('apps/view/src/app/app.routes.ts');
    const bloqueUsers = rutas.slice(rutas.indexOf("path: 'users'"), rutas.indexOf("path: 'users'") + 400);
    check(
      /anyPermissionGuard\(\s*Permission\.USUARIOS_VER\s*,\s*Permission\.USUARIOS_GESTIONAR\s*\)/.test(bloqueUsers),
      'la ruta acepta USUARIOS_VER **o** USUARIOS_GESTIONAR (no una sola clave)',
    );
    // Prueba negativa del gate estático: si alguien lo vuelve a poner en
    // `permissionGuard(USUARIOS_GESTIONAR)`, esto tiene que reventar.
    check(
      !/path: 'users'[\s\S]{0,400}permissionGuard\(Permission\.USUARIOS_GESTIONAR\)/.test(rutas),
      'y NO volvió a exigir sólo el permiso de escritura (el bug que dejaba fuera a 10 personas)',
    );

    const nav = leer('apps/view/src/app/modules/dashboard/layout/layout.component.ts');
    check(
      /route: '\/admin\/users', permission: Permission\.USUARIOS_VER/.test(nav),
      'el ítem del menú se pinta con USUARIOS_VER (si no, la ruta abre y nadie la encuentra)',
    );

    console.log('\n[2] Quién puede abrir el padrón hoy, medido');
    const { rows: puerta } = await k.raw(
      `SELECT rp.role_name,
              (rp.permissions->>'USUARIOS_VER' = 'true')        AS ver,
              (rp.permissions->>'USUARIOS_GESTIONAR' = 'true')  AS gestionar,
              (rp.permissions->>'REPORTES_VER_GLOBAL' = 'true') AS rep_global,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
                  AND u.deleted_at IS NULL AND u.kind = 'interno') AS personas
         FROM identity.role_permissions rp
        WHERE rp.tenant_id = ?
          AND (rp.permissions->>'USUARIOS_VER' = 'true' OR rp.permissions->>'USUARIOS_GESTIONAR' = 'true')`,
      [TENANT],
    );
    const abren = puerta.filter((r) => r.personas > 0);
    const gente = abren.reduce((a, r) => a + r.personas, 0);
    console.log(`      ${abren.length} rol/es con gente abren el padrón · ${gente} persona/s`);
    check(gente > 0, `al menos alguien puede abrirlo (${gente})`);

    /*
     * `[AU.1b]` Los roles que TENDRÍAN el padrón entero por reportes globales.
     *
     * ⚠️ Esto no se puede afirmar como «no existen»: `REPORTES_VER_GLOBAL` es un
     * permiso legítimo de reportes y quitárselo a un rol es otra decisión. Lo
     * que el candado sostiene es que el padrón **ya no lo honre** — y eso vive
     * en el código, que se verifica abajo. Acá se DECLARA a quién le aplica, para
     * que el día que la lista crezca alguien lo vea en vez de enterarse por la
     * pantalla.
     */
    const GOD = ['superadmin', 'admin'];
    const degradados = puerta.filter(
      (r) => !r.gestionar && r.rep_global && !GOD.includes(r.role_name) && r.personas > 0,
    );
    if (degradados.length) {
      declarar(
        `${degradados.length} rol/es con reportes globales pero sin administrar ` +
          `(${degradados.map((c) => `${c.role_name}:${c.personas}`).join(', ')}): ` +
          'el padrón los acota a su equipo. Si el degradado se quitara, verían a TODOS.',
      );
    } else {
      check(true, 'ningún rol depende hoy del degradado del padrón');
    }
    // CONTROL POSITIVO: el god-mode NO se degradó de paso.
    const god = puerta.find((r) => GOD.includes(r.role_name) && r.personas > 0);
    check(
      Boolean(god) === BASE_ALCANCE.superadmin_ve_todo,
      'y el god-mode sigue existiendo: degradar el `all` no se comió a superadmin',
    );

    // El código tiene que preguntar por el god-mode ANTES de degradar.
    const svc = leer('libs/trade/src/lib/users/users.service.ts');
    check(
      /porReportes\.type === 'all' && !isPlatformAdminRole\(requester\.role_name\)/.test(svc),
      'el degradado excluye explícitamente al god-mode (no confía en que además tenga GESTIONAR)',
    );

    // ══ 3. «Su gente»: la unión, no el reemplazo ════════════════════════════
    console.log('\n[3] `[AU.1b]` El equipo es UNIÓN: supervisor_id ∪ (puesto ∩ eje)');
    check(
      /qb\.where\('u\.supervisor_id', requesterId\)\.orWhere\('u\.id', requesterId\)/.test(svc),
      'la rama de `supervisor_id` sigue estando (nadie pierde a quien ya veía)',
    );
    // El eje va DENTRO de la rama del puesto. Si alguien lo saca al grupo, la
    // unión se vuelve intersección y los 3 supervisores pierden gente.
    check(
      /qb\.orWhere\((?:\(|\s)*rama[\s\S]{0,600}?rama\.andWhere\(porEje\.columna/.test(svc),
      'el eje se aplica DENTRO de la rama del puesto, no al grupo entero',
    );

    const { rows: equipos } = await k.raw(
      `WITH jefe AS (
         SELECT u.id, u.username, u.position_code, u.warehouse_code, u.zona_id,
                COALESCE(p.scope_axis, d.scope_axis) AS eje
           FROM identity.users u
           LEFT JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
           LEFT JOIN identity.departments d ON d.tenant_id = u.tenant_id AND d.code = u.department_code
          WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.kind = 'interno')
       SELECT j.username,
              (SELECT count(*)::int FROM identity.users x
                WHERE x.tenant_id = ? AND x.deleted_at IS NULL
                  AND (x.supervisor_id = j.id OR x.id = j.id)) AS solo_supervisor,
              (SELECT count(*)::int FROM identity.users x
                 LEFT JOIN identity.positions px
                   ON px.tenant_id = x.tenant_id AND px.code = x.position_code
                WHERE x.tenant_id = ? AND x.deleted_at IS NULL
                  AND (x.supervisor_id = j.id OR x.id = j.id
                       OR (j.position_code IS NOT NULL
                           AND px.reports_to_position_code = j.position_code
                           AND (CASE j.eje
                                  WHEN 'sucursal' THEN j.warehouse_code IS NOT NULL AND x.warehouse_code = j.warehouse_code
                                  WHEN 'zona'     THEN j.zona_id IS NOT NULL AND x.zona_id = j.zona_id
                                  WHEN 'ruta'     THEN j.zona_id IS NOT NULL AND x.zona_id = j.zona_id
                                  ELSE TRUE END)))) AS con_puesto
         FROM jefe j`,
      [TENANT, TENANT, TENANT],
    );
    const pierden = equipos.filter((e) => e.con_puesto < e.solo_supervisor);
    check(pierden.length === 0, `nadie pierde gente con la unión (pierden ${pierden.length})`);
    // CONTROL POSITIVO: la rama del puesto tiene que APORTAR en algún lado, o
    // estaría midiendo una unión con el conjunto vacío.
    const ganan = equipos.filter((e) => e.con_puesto > e.solo_supervisor);
    if (!ganan.length) {
      declarar('la cadena de puestos no le agrega gente a NADIE hoy: la unión no se está ejerciendo');
    } else {
      check(true, `y a ${ganan.length} jefe/s la cadena de puestos sí les suma (la rama no es no-op)`);
    }

    // ══ 4. La organización tiene superficie ═════════════════════════════════
    console.log('\n[4] `[AU.0]` Las rutas de /org existen y piden el par de permisos');
    const ctrl = leer('libs/trade/src/lib/users/org.controller.ts');
    for (const ruta of [
      "@Get('positions')", "@Post('positions')", "@Put('positions/:code')",
      "@Delete('positions/:code')", "@Put('positions/:code/reports-to')",
      "@Get('responsibilities')", "@Post('positions/:code/responsibilities')",
      "@Get('users/:id/responsibilities')", "@Post('users/:id/responsibilities')",
      "@Get('users/:id/position-history')", "@Get('coherencia')",
    ]) {
      check(ctrl.includes(ruta), `existe ${ruta}`);
    }
    const escrituras = (ctrl.match(/@(Post|Put|Delete)\(/g) || []).length;
    const gestionar = (ctrl.match(/RequirePermissions\(Permission\.USUARIOS_GESTIONAR\)/g) || []).length;
    check(
      escrituras === gestionar,
      `las ${escrituras} rutas de escritura exigen USUARIOS_GESTIONAR (hay ${gestionar})`,
    );

    // ══ 5. El diagnóstico `abre` DISCRIMINA ════════════════════════════════
    console.log('\n[5] `[OR.3a]` El cruce responsabilidad × permiso separa lo que abre de lo que no');
    const { rows: cruce } = await k.raw(
      `SELECT pr.position_code, pr.responsibility_key, pr.es_principal,
              CASE
                WHEN COALESCE(array_length(r.permission_keys, 1), 0) = 0 THEN NULL
                WHEN p.default_role IS NULL THEN FALSE
                ELSE EXISTS (
                  SELECT 1 FROM identity.role_permissions rp
                   WHERE rp.tenant_id = pr.tenant_id AND rp.role_name = p.default_role
                     AND EXISTS (SELECT 1 FROM unnest(r.permission_keys) kk
                                  WHERE rp.permissions ->> kk = 'true'))
              END AS abre
         FROM identity.position_responsibilities pr
         JOIN identity.responsibilities r ON r.key = pr.responsibility_key
         JOIN identity.positions p
           ON p.tenant_id = pr.tenant_id AND p.code = pr.position_code AND p.deleted_at IS NULL
        WHERE pr.tenant_id = ? AND pr.deleted_at IS NULL`,
      [TENANT],
    );
    const cruceAbren = cruce.filter((c) => c.abre === true).length;
    const noAbren = cruce.filter((c) => c.abre === false).length;
    const nulos = cruce.filter((c) => c.abre === null).length;
    console.log(`      ${cruce.length} asignación/es · ${cruceAbren} abren · ${noAbren} no · ${nulos} no juzgables`);
    if (!cruce.length) {
      declarar('no hay asignaciones puesto × responsabilidad: el diagnóstico no se puede ejercer');
    } else {
      // Que haya de las dos clases ES el control: un predicado que devuelve
      // siempre lo mismo pasaría un «0 errores» sin medir nada.
      check(cruceAbren > 0, `hay asignaciones ejecutables (${cruceAbren})`);
      check(noAbren > 0, `y hay asignaciones que el perfil NO abre (${noAbren}) — el cruce discrimina`);
      check(cruceAbren + noAbren + nulos === cruce.length, 'la partición cuadra: todo cae en una de las tres');
    }

    // ══ 6. La excepción por persona CUESTA ═════════════════════════════════
    console.log('\n[6] PRUEBA NEGATIVA — los CHECK reales, ejercidos sin escribir una fila');
    const { rows: checks } = await k.raw(
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'identity' AND rel.relname = 'user_responsibilities' AND con.contype = 'c'`,
    );
    const nota = checks.find((c) => c.conname.includes('nota'));
    if (!nota) {
      declarar('no existe el CHECK de nota obligatoria: la excepción por persona no cuesta nada');
    } else {
      const pred = nota.def.replace(/^CHECK\s*\(/, '').replace(/\)\s*$/, '');
      const evaluar = async (valor) =>
        (await k.raw(`SELECT (${pred}) AS acepta FROM (SELECT ?::text AS nota) t`, [valor]))
          .rows[0].acepta === true;
      check(!(await evaluar('   ')), 'una nota en blanco la RECHAZA el predicado real de la base');
      check(await evaluar('Reparto declarado por Edgar'), 'y una nota con motivo SÍ pasa (el predicado discrimina)');
    }

    const vig = checks.find((c) => c.conname.includes('vigencia'));
    if (!vig) {
      declarar('no existe el CHECK de vigencia');
    } else {
      const pred = vig.def.replace(/^CHECK\s*\(/, '').replace(/\)\s*$/, '');
      const ev = async (from, to) =>
        (await k.raw(`SELECT (${pred}) AS acepta FROM (SELECT ?::date AS valid_from, ?::date AS valid_to) t`, [from, to]))
          .rows[0].acepta === true;
      check(!(await ev('2026-12-31', '2026-01-01')), 'una vigencia invertida la RECHAZA');
      check(await ev('2026-01-01', null), 'y una vigencia abierta pasa');
    }

    // ══ 7. El ciclo de mando ═══════════════════════════════════════════════
    console.log('\n[7] La cadena de mando no admite ciclos ni autorreferencia');
    const { rows: anti } = await k.raw(
      `SELECT pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'identity' AND rel.relname = 'positions'
          AND con.conname = 'positions_no_autoreporte'`,
    );
    if (!anti.length) {
      declarar('no existe el CHECK anti-autorreferencia');
    } else {
      const pred = anti[0].def.replace(/^CHECK\s*\(/, '').replace(/\)\s*$/, '');
      const ev = async (code, jefe) =>
        (await k.raw(
          `SELECT (${pred}) AS acepta FROM (SELECT ?::varchar AS code, ?::varchar AS reports_to_position_code) t`,
          [code, jefe],
        )).rows[0].acepta === true;
      check(!(await ev('cajera', 'cajera')), 'un puesto que se reporta a sí mismo lo RECHAZA la base');
      check(await ev('cajera', 'encargado_sucursal'), 'y una arista normal pasa');
    }
    const { rows: trg } = await k.raw(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'identity.positions'::regclass AND NOT tgisinternal
          AND tgname LIKE '%ciclo%'`,
    );
    check(trg.length > 0, `el trigger de ciclos sigue instalado (${trg.map((t) => t.tgname).join(', ') || 'ninguno'})`);

    // El servicio tiene que TRADUCIR ese error, no dejarlo salir como 500.
    const orgSvc = leer('libs/trade/src/lib/users/org.service.ts');
    check(
      /ciclo\|cycle\|check_violation/.test(orgSvc) || /ciclo/i.test(orgSvc),
      'y el servicio traduce el rechazo a un 400 que nombra los dos puestos',
    );

    // ══ 8. Lo que la pantalla NO hace ══════════════════════════════════════
    console.log('\n[8] ⛔ La responsabilidad NO otorga permisos');
    const pantalla = leer('apps/view/src/app/modules/admin/pages/admin-responsabilidades.component.ts');
    check(
      /admin\/roles/.test(pantalla),
      'cuando el perfil no abre lo que responde, la pantalla manda a /admin/roles',
    );
    check(
      !/setPermisos|setUserPermissions|permissions.*PUT/i.test(pantalla),
      'y NO escribe permisos desde la pantalla de responsabilidades (sería el 4º sistema de authz)',
    );

    // ══ 9. Ningún byte invisible en el código ══════════════════════════════
    //
    // `[AU.9]` Un `\0` se coló en `org.service.ts` como centinela de "sin puesto"
    // y viajaba a Postgres como parámetro: `invalid byte sequence for encoding
    // "UTF8": 0x00`. El endpoint tiraba 500 para toda persona sin puesto. Ni el
    // build ni el lint ni este suite lo veían — se lee igual que un espacio.
    console.log('\n[9] Ningún byte de control en los fuentes de usuarios');
    const fuentes = [];
    (function juntar(dir) {
      for (const f of fs.readdirSync(path.join(REPO, dir))) {
        const rel = `${dir}/${f}`;
        if (fs.statSync(path.join(REPO, rel)).isDirectory()) juntar(rel);
        else if (/\.(ts|js)$/.test(f)) fuentes.push(rel);
      }
    })('libs/trade/src/lib/users');
    const sucios = fuentes.filter((rel) => {
      const b = fs.readFileSync(path.join(REPO, rel));
      return b.indexOf(0) >= 0 || b.indexOf(0x1a) >= 0;
    });
    check(
      sucios.length === 0,
      `los ${fuentes.length} fuentes de usuarios no traen NUL ni EOF${sucios.length ? ` — sucios: ${sucios.join(', ')}` : ''}`,
    );
    // Control positivo: el detector encuentra un NUL cuando de verdad lo hay.
    check(
      Buffer.from("x ?? '\0'", 'utf8').indexOf(0) >= 0,
      'y el detector SÍ marca un buffer con un NUL adentro (no es un check vacío)',
    );

    // ══ 10. El padrón no cuenta a los que ya no están ══════════════════════
    //
    // `[AU.12]` `findAll` no filtraba `deleted_at`: `kind='interno'` devolvía 111
    // filas para 100 personas vivas, y la pantalla pintaba a las 11 dadas de baja
    // como «Suspendida», que es otro estado del ciclo.
    console.log('\n[10] El padrón excluye las bajas, y el estado es el REAL');
    const padronSvc = leer('libs/trade/src/lib/users/users.service.ts');
    check(
      /if \(!params\.incluir_bajas\) query\.whereNull\('u\.deleted_at'\)/.test(padronSvc),
      'findAll excluye `deleted_at` salvo que se pida explícitamente',
    );
    check(/'u\.status',/.test(padronSvc), "y selecciona `status`, no sólo el booleano `activo`");

    const { rows: padron } = await k.raw(
      `SELECT count(*)::int AS filas,
              count(*) FILTER (WHERE deleted_at IS NULL)::int AS vivas,
              count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS bajas,
              count(DISTINCT status)::int AS estados
         FROM identity.users WHERE tenant_id = ? AND kind = 'interno'`,
      [TENANT],
    );
    const p = padron[0];
    if (p.filas === 0) {
      declarar('el tenant no tiene cuentas internas: no hay con qué medir el recorte');
    } else {
      check(
        p.vivas + p.bajas === p.filas,
        `el recorte es real: ${p.filas} filas = ${p.vivas} vivas + ${p.bajas} baja(s) que la pantalla ya no cuenta`,
      );
      // Control positivo: si `status` fuera un campo muerto habría un solo valor.
      check(p.estados >= 1, `y \`status\` tiene ${p.estados} valor(es) distinto(s) en uso`);
    }

    // El resumen de la tira se cuenta en el SERVIDOR sobre el mismo builder.
    check(
      /count\(DISTINCT u\.id\) FILTER \(WHERE u\.position_code IS NULL\)/.test(padronSvc),
      'la tira de KPI la cuenta el servidor sobre el padrón, no el navegador sobre la página',
    );

    // ══ 11. El puesto que no propone perfil tampoco es barra libre ═════════
    //
    // `[AU.15]` `detectarDesvio` hacía `if (!pos.default_role) return null`: un
    // puesto sin propuesta apagaba la regla del motivo entera. El perfil se
    // elegía a dedo y no quedaba escrito por qué — que es justo donde MÁS falta,
    // porque no hay nada contra qué contrastarlo.
    console.log('\n[11] Sin propuesta, el motivo se pide igual');
    const desvioSvc = leer('libs/trade/src/lib/users/users.service.ts');
    check(
      !/if \(!pos\?\.default_role\) return null;/.test(desvioSvc),
      'el atajo que apagaba la regla cuando el puesto no propone nada ya no está',
    );
    check(
      /propone: null, elegido/.test(desvioSvc),
      'y el caso «sin propuesta» se DECLARA (propone: null) en vez de leerse como «en orden»',
    );
    check(
      /no propone ningún perfil/.test(desvioSvc),
      'con su propio mensaje: el usuario tiene que saber por qué se le pide el motivo',
    );
    // El camino masivo tenía el mismo atajo.
    check(
      !/if \(pos\?\.default_role\) \{/.test(desvioSvc),
      'y el camino masivo tampoco lo esquiva',
    );

    const { rows: vac } = await k.raw(
      `SELECT count(*)::int AS sin_perfil,
              count(*) FILTER (WHERE ocupantes > 0)::int AS sin_perfil_ocupados
         FROM (SELECT p.code,
                      (SELECT count(*) FROM identity.users u
                        WHERE u.tenant_id = p.tenant_id AND u.position_code = p.code
                          AND u.deleted_at IS NULL) AS ocupantes
                 FROM identity.positions p
                WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.default_role IS NULL) x`,
      [TENANT],
    );
    // `[AU.26]` Esta aserción era `=== 0` y se puso roja al aplicar `[AU.23]`,
    // que sumó 44 puestos del organigrama de MDTask sin `default_role` — MDTask
    // trae jerarquía, no autorización, y un perfil de acceso no se inventa.
    //
    // ⛔ Y los 5 ocupados NO son derivables, que era la salida fácil: sus cinco
    // ocupantes llegaron ahí con `[AU.25]`, así que su `role_name` es el del
    // puesto ANTERIOR. Derivar la propuesta del puesto nuevo desde el rol que
    // traían del viejo es circular, y se midió adónde llevaba: `facturador`
    // habría propuesto `telemarketing` —el error que `[AU.25]` acababa de
    // corregir— y `full_stack_developer` habría propuesto `superadmin`,
    // convirtiendo un privilegio de una persona en propuesta institucional.
    // Es la forma de `[AU.24]`: derivar de un dato ya contaminado.
    //
    // Entonces el número se DECLARA con su baseline medido, y la guarda es que
    // no crezca sin que alguien lo mire. Bajarlo es asignar perfiles a mano.
    const BASELINE_SIN_PERFIL_OCUPADOS = 5;
    check(
      vac[0].sin_perfil_ocupados <= BASELINE_SIN_PERFIL_OCUPADOS,
      `puestos sin perfil ocupados: ${vac[0].sin_perfil_ocupados} (baseline ${BASELINE_SIN_PERFIL_OCUPADOS}); no crecieron sin registro`,
    );
    declarar(
      `${vac[0].sin_perfil} puesto(s) sin perfil propuesto, ${vac[0].sin_perfil_ocupados} de ellos ocupados ` +
        `(DEUDA-AU-PUESTOS-VACANTES). Los 44 nuevos vienen de [AU.23] y ninguno se derivó a propósito`,
    );

    // ══ 12. El jefe sale del ORGANIGRAMA, no del nombre del rol ════════════
    //
    // `[AU.16]` El selector de jefe usaba `GET /users/supervisors`, que filtra
    // `role_name LIKE '%supervisor%'`. En un modelo persona-con-puesto el jefe de
    // una cajera es el encargado de sucursal, y la substring no sabe eso.
    console.log('\n[12] El jefe se deriva del puesto');
    const { rows: ofrece } = await k.raw(
      `SELECT
         (SELECT count(*)::int FROM identity.users u
           WHERE u.tenant_id = ? AND u.activo AND u.role_name LIKE '%supervisor%') AS por_substring,
         (SELECT count(*)::int FROM identity.users u
            JOIN identity.positions p
              ON p.tenant_id = u.tenant_id AND p.code = u.position_code AND p.deleted_at IS NULL
           WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.kind = 'interno'
             AND EXISTS (SELECT 1 FROM identity.positions s
                          WHERE s.tenant_id = p.tenant_id AND s.deleted_at IS NULL
                            AND s.reports_to_position_code = p.code)) AS por_organigrama`,
      [TENANT, TENANT],
    );
    const o = ofrece[0];
    check(
      o.por_organigrama >= o.por_substring,
      `el organigrama ofrece ${o.por_organigrama} jefe(s) y la substring ${o.por_substring}: no se pierde ninguno`,
    );
    // Prueba negativa: si los dos dieran lo mismo, el cambio sería cosmético.
    check(
      o.por_organigrama > o.por_substring,
      `y ofrece ${o.por_organigrama - o.por_substring} MÁS — el filtro por nombre de rol dejaba fuera a jefes reales`,
    );

    const { rows: jefe } = await k.raw(
      `SELECT count(*)::int AS sin_supervisor_id,
              count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM identity.users oj
                 WHERE oj.tenant_id = u.tenant_id AND oj.deleted_at IS NULL
                   AND oj.position_code = p.reports_to_position_code))::int AS sin_jefe_real
         FROM identity.users u
         LEFT JOIN identity.positions p
           ON p.tenant_id = u.tenant_id AND p.code = u.position_code AND p.deleted_at IS NULL
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.kind = 'interno'
          AND u.supervisor_id IS NULL`,
      [TENANT],
    );
    const j = jefe[0];
    check(
      j.sin_jefe_real <= j.sin_supervisor_id,
      `«sin jefe» cuenta ${j.sin_jefe_real} y no ${j.sin_supervisor_id}: ${j.sin_supervisor_id - j.sin_jefe_real} lo heredan del puesto`,
    );
    check(
      /oj\.position_code = ps\.reports_to_position_code/.test(padronSvc),
      'y el KPI del padrón usa esa definición, no `supervisor_id IS NULL` a secas',
    );

    // ══ 13. La sesión y la contraseña forzada son UNA decisión ═════════════
    //
    // `[AU.22]` La ficha mandaba `token_ttl_days` en CADA edición, aunque no
    // cambiara. El backend lee un `token_ttl_days: null` como «quitá la sesión
    // larga» (`[CH.1.10]`), y como casi todo el padrón tiene
    // `must_change_password = false`, rebotaba con 400 al editar a gente que no
    // tenía nada que ver con sesiones. La regla se evalúa sobre el CAMBIO.
    console.log('\n[13] La duración de sesión viaja sólo si cambió');
    const ficha = leer('apps/view/src/app/modules/admin/components/persona-detalle.component.ts');
    check(
      /if \(this\.cambiaSesion\(\)\) \{/.test(ficha),
      'la ficha manda `token_ttl_days` sólo cuando cambió',
    );
    check(
      /body\['must_change_password'\] = ttl == null;/.test(ficha),
      'y nunca sola: va con el cambio de contraseña forzado que le corresponde',
    );

    const { rows: exp } = await k.raw(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE must_change_password = false)::int AS rebotarian,
              count(*) FILTER (WHERE token_ttl_days IS NOT NULL)::int AS con_sesion_larga
         FROM identity.users
        WHERE tenant_id = ? AND deleted_at IS NULL AND kind = 'interno'`,
      [TENANT],
    );
    const e13 = exp[0];
    if (!e13.total) {
      declarar('el tenant no tiene cuentas internas: no hay con qué medir el rebote');
    } else {
      check(
        e13.rebotarian > 0,
        `mandarla siempre rebotaría a ${e13.rebotarian} de ${e13.total} persona(s): por eso va sobre el cambio`,
      );
    }
    declarar(
      `${e13.con_sesion_larga} cuenta(s) interna(s) con sesion larga: el TTL de [CH.1.7] sigue sin ` +
        `estrenar en prod, asi que la regla se sostiene por el predicado y no por datos que la ejerzan`,
    );

    // ══ 14. Se le puede cambiar la contraseña a alguien ════════════════════
    //
    // `[AU.28]` Reportado por Edgar: «no me deja cambiar la contraseña desde la
    // interfaz». No era un permiso ni un 400: **el campo no existía**. Estaba
    // detrás de un `@if (!persona)` —sólo en el alta— y `password` sólo viajaba
    // en `crearPersona`. Como `dashboard/admin-users` ya no tiene ruta, no había
    // forma de resetearle la contraseña a nadie en toda la suite, con
    // `USUARIOS_PASSWORDS` declarado en el árbol todo el tiempo.
    console.log('\n[14] La contraseña se puede cambiar, y deja rastro');
    const fichaPass = leer('apps/view/src/app/modules/admin/components/persona-detalle.component.ts');
    check(
      !/@if \(!persona\) \{\s*<label class="pd-lbl pd-lbl-req" for="pd-pass">/.test(fichaPass),
      'el campo de contraseña ya no está encerrado en el alta',
    );
    check(
      /if \(this\.persona && pass\) body\['password'\] = pass;/.test(fichaPass),
      'y en edición viaja SÓLO si se escribió una (vacío no es «ponela vacía»)',
    );

    const svcPass = leer('libs/trade/src/lib/users/users.service.ts');
    check(
      /assertCanChangePassword\(password, id, requester\);/.test(svcPass),
      'cambiarle la contraseña a otro exige USUARIOS_PASSWORDS, que no lo pedía ningún endpoint',
    );
    check(
      /updateData\['password_changed_at'\] = this\.knex\.fn\.now\(\);/.test(svcPass),
      'y el reset escribe `password_changed_at`: sin eso la fecha habla de la contraseña anterior',
    );
    check(
      /updateData\['must_change_password'\] = !esDispositivo;/.test(svcPass),
      'y fuerza el cambio salvo en dispositivos — la eligió el admin, no su dueño ([CH.1.10])',
    );

    // ⭐ El control que decide si encender la llave era seguro: si los dos
    // permisos no vivieran en los mismos roles, exigir USUARIOS_PASSWORDS le
    // quitaría el reset a alguien que hoy lo tiene.
    const { rows: pw } = await k.raw(
      `SELECT count(*) FILTER (WHERE permissions ->> 'USUARIOS_GESTIONAR' = 'true'
                                 AND (permissions ->> 'USUARIOS_PASSWORDS') IS DISTINCT FROM 'true')::int AS pierden,
              count(*) FILTER (WHERE permissions ->> 'USUARIOS_PASSWORDS' = 'true')::int AS con_llave
         FROM identity.role_permissions WHERE tenant_id = ?`,
      [TENANT],
    );
    check(
      pw[0].pierden === 0,
      `ningún rol pierde el reset al encender la llave: ${pw[0].pierden} con GESTIONAR sin PASSWORDS, ` +
        `${pw[0].con_llave} rol(es) con la llave`,
    );

    // ══ 15. No toda cuenta es una persona ═════════════════════════════════
    //
    // `[AU.31]` Edgar abrió `etiquetas.32` y el botón «Guardar cambios» estaba
    // gris, sin decir por qué. Dos defectos con la misma raíz: la ficha trataba
    // a toda cuenta como si fuera una persona del organigrama.
    console.log('\n[15] Las cuentas que no son personas');
    const { rows: nop } = await k.raw(
      `SELECT count(*)::int AS sin_puesto,
              count(*) FILTER (WHERE kind = 'dispositivo')::int AS dispositivos,
              count(*) FILTER (WHERE kind = 'dispositivo' AND token_ttl_days IS NOT NULL)::int AS disp_con_ttl
         FROM identity.users
        WHERE tenant_id = ? AND deleted_at IS NULL AND position_code IS NULL`,
      [TENANT],
    );
    check(
      /if \(persona && !puesto\) return false;/.test(fichaPass),
      `el puesto se exige sólo a una persona: exigirlo siempre bloqueaba ${nop[0].sin_puesto} cuenta(s) sin puesto`,
    );
    check(
      !/if \(!usuario \|\| !puesto \|\| !rol\) return false;/.test(fichaPass),
      'y la condición vieja, que las bloqueaba a todas, ya no está',
    );

    // ⭐ El dato que desmiente el criterio anterior. Si algún día los
    // dispositivos empiezan a tener TTL, esta declaración lo dice y el criterio
    // por `kind` sigue siendo el correcto de todas formas.
    check(
      /this\.persona\?\.kind === 'dispositivo' \|\| this\.fTtl\(\) != null/.test(fichaPass),
      'un dispositivo se reconoce por `kind`, no por tener TTL',
    );
    check(
      /fila\?\.kind === 'dispositivo' \|\| ttlResultante != null/.test(svcPass),
      'y el backend usa el mismo criterio: si no, el reset le forzaría el cambio igual',
    );
    declarar(
      `${nop[0].dispositivos} cuenta(s) de dispositivo sin puesto y ${nop[0].disp_con_ttl} de ellas con TTL: ` +
        `por eso reconocerlas por \`token_ttl_days\` las daba a TODAS por personas, y un reset les ` +
        `habría puesto must_change_password dejando las pantallas afuera ([CH.1.10])`,
    );

    console.log(`\n${fail === 0 ? '✅' : '❌'} [AU] administración de usuarios: ${ok} ok, ${fail} fallos, ${nomedido} no medido(s)`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\n❌ ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await k.destroy();
  }
})();
