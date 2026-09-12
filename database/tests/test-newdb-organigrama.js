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
 * Personas que a propósito pueden quedar SIN puesto, con su motivo.
 *
 * **Está vacío, y ése es el resultado**: `[OR.1c]` cerró en 97/100 dejando 3 casos declarados
 * (claudia_mata sin departamento, brian_zavala y luis_navarro con 4 candidatos) y `[OR.1d]` los
 * resolvió con la decisión del lead. Hoy son **100/100**.
 *
 * Si mañana aparece alguien sin puesto, el test FALLA con su nombre. Para aceptarlo hay que
 * escribir acá el motivo — que es el costo deliberado: lo declarado se tolera, la SORPRESA no.
 */
const SIN_PUESTO_ACEPTADAS = {};

/** Los 2 puestos que `[OR.1d]` agregó al resolver las 3 personas. */
const PUESTOS_DECIDIDOS = ['direccion', 'supervisor_inventarios'];

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

    // ⚠️ Esta aserción cambió de significado con `[OR.7.0]`: antes medía que
    // `administracion` hubiera dejado de tener 4 puestos para 17 personas; ahora
    // esa bolsa se PARTIÓ en departamentos reales, así que lo que hay que medir
    // es que los puestos de oficina existan **repartidos**, no amontonados.
    const OFICINA_POR_DEPTO = {
      auxiliar_contabilidad: 'contabilidad',
      jefe_finanzas: 'finanzas', auxiliar_finanzas: 'finanzas',
      tesoreria: 'tesoreria',
      auxiliar_credito_cobranza: 'credito_cobranza',
      jefe_marketing: 'mercadotecnia', auxiliar_mkt: 'mercadotecnia',
      gerente_compras: 'compras', comprador: 'compras', auxiliar_compras: 'compras',
      prevencion: 'prevencion_auditoria', auxiliar_prevencion: 'prevencion_auditoria',
    };
    const malUbicados = Object.entries(OFICINA_POR_DEPTO)
      .filter(([code, dep]) => {
        const p = cat.find((x) => x.code === code);
        return p && p.department_code !== dep;
      })
      .map(([c]) => c);
    check(malUbicados.length === 0,
      `los ${Object.keys(OFICINA_POR_DEPTO).length} puestos de oficina viven en su departamento real ` +
      `(mal ubicados: ${malUbicados.join(', ') || 'ninguno'})`);
    const admin = cat.filter((x) => x.department_code === 'administracion');
    check(admin.length <= 4,
      `administracion quedó como residual: ${admin.length} puestos (tenía 10 antes de [OR.7.0])`);

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
    check(sinPuesto.length === 0,
      `el padrón está COMPLETO: ${conPuesto}/${padron.rows.length} con puesto`);

    // El evento que la bitácora nunca había visto.
    const ev = await k('identity.user_events')
      .where({ tenant_id: TENANT, event: 'puesto_asignado' })
      .count('* as n')
      .first();
    check(Number(ev.n) >= 41,
      `user_events registra ${ev.n} "puesto_asignado" (antes de [OR.1c] había 0 eventos de puesto)`);

    // ⚠️ El CHECK parcial `kind='interno' AND status='active' => position_code NOT NULL` NO está
    // puesto todavía, a propósito: el alta (`users.service.ts#create`) deja `position_code`
    // opcional, así que hoy el candado convertiría un alta incompleta en un error crudo de
    // Postgres en vez de una validación con mensaje. Va después de [OR.2], que es donde el
    // servicio pasa a exigir el puesto. Mientras tanto el invariante lo sostiene ESTE bloque.
    const chk = await k.raw(
      `SELECT 1 FROM pg_constraint WHERE conrelid = 'identity.users'::regclass
        AND conname = 'users_interno_con_puesto'`);
    if (!chk.rows.length) {
      declarar(
        'el CHECK users_interno_con_puesto NO está aplicado: el alta todavía admite position_code ' +
        'nulo y el candado daría un 500 en vez de una validación. Se aplica tras [OR.2].',
      );
    } else {
      check(true, 'CHECK users_interno_con_puesto aplicado');
    }

    // ── 3. La cadena de mando y sus candados ──────────────────────────────
    console.log('\n── 3. Cadena de mando: los candados se rompen a propósito');
    const vr = cat.find((x) => x.code === 'vendedor_ruta');
    const chain = await k('identity.positions')
      .where({ tenant_id: TENANT, code: 'vendedor_ruta' })
      .first('reports_to_position_code');
    check(chain && chain.reports_to_position_code === 'supervisor_rd',
      `vendedor_ruta reporta a supervisor_rd (la única arista que el dato prueba: 29 personas)`);
    if (!vr) declarar('vendedor_ruta no existe en este tenant');

    // La RAÍZ. Sin ella «reporta directo a Dirección» es inexpresable — y no existía:
    // el rol `direccion` tenía 88 permisos y CERO personas, y los puestos de mando de
    // direccion_zona estaban vacíos. Un puesto vacante sigue siendo un lugar al que reportar,
    // que es justo lo que `supervisor_id` (persona a persona) no puede representar.
    const raiz = await k('identity.positions')
      .where({ tenant_id: TENANT, code: 'direccion' })
      .whereNull('deleted_at')
      .first('code', 'reports_to_position_code', 'default_role');
    check(!!raiz, 'existe el puesto `direccion` — la raíz del organigrama');
    check(raiz && raiz.reports_to_position_code === null,
      'la raíz no reporta a nadie (reports_to_position_code NULL)');

    const faltanDec = PUESTOS_DECIDIDOS.filter((c) => !codes.has(c));
    check(faltanDec.length === 0,
      `los puestos de [OR.1d] existen (faltan: ${faltanDec.join(', ') || 'ninguno'})`);

    // La profundidad es lo que [OR.1] vino a conseguir: antes era UN nivel y ningún jefe
    // tenía jefe.
    const prof = await k.raw(
      `WITH RECURSIVE ch AS (
         SELECT code, reports_to_position_code AS jefe, 1 AS nivel
           FROM identity.positions WHERE tenant_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT p.code, p.reports_to_position_code, ch.nivel + 1
           FROM identity.positions p JOIN ch ON p.code = ch.jefe
          WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND ch.nivel < 20)
       SELECT max(nivel)::int niveles FROM ch`, [TENANT, TENANT]);
    check(prof.rows[0].niveles >= 4,
      `la cadena de mando tiene ${prof.rows[0].niveles} nivel(es) — era 1 antes de [OR.1a] y 2 antes de la carta de [OR.8]`);

    // `[OR.8]` La carta salió del ORGANIGRAMA que entregó Dirección, no de mi criterio.
    // ⚠️ El organigrama está por ZONA: el mismo puesto existe 3 veces con 3 jefes.
    // El puesto da el TIPO de jefe; la zona de la persona da CUÁL — por eso
    // `users.supervisor_id` sobrevive como desempate y no como decoración.
    const carta = await k('identity.positions')
      .where({ tenant_id: TENANT })
      .whereNull('deleted_at')
      .whereNotNull('reports_to_position_code')
      .count('* as n')
      .first();
    check(Number(carta.n) >= 45, `${carta.n} aristas declaradas en la carta de mando`);

    const cobCarta = await k.raw(
      `SELECT count(*)::int con_gente,
              count(*) FILTER (WHERE p.reports_to_position_code IS NOT NULL)::int con_jefe
         FROM identity.positions p
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM identity.users u
                       WHERE u.tenant_id = p.tenant_id AND u.position_code = p.code
                         AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno')`, [TENANT]);
    check(cobCarta.rows[0].con_jefe >= cobCarta.rows[0].con_gente - 1,
      `${cobCarta.rows[0].con_jefe}/${cobCarta.rows[0].con_gente} puestos CON gente declaran jefe`);

    const heredan = await k.raw(
      `SELECT count(*)::int n FROM identity.users u
         JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'
          AND p.reports_to_position_code IS NOT NULL`, [TENANT]);
    check(heredan.rows[0].n >= 95,
      `${heredan.rows[0].n}/100 personas heredan jefe de su PUESTO (antes: 24 por supervisor_id)`);

    // `jefe_zona` vacante a propósito: un puesto sin ocupante sigue siendo el
    // lugar al que se reporta. De él cuelga TODA la operación.
    const zona = await k.raw(
      `SELECT (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = ? AND u.position_code = 'jefe_zona'
                  AND u.activo AND u.deleted_at IS NULL) AS ocupantes,
              (SELECT count(*)::int FROM identity.positions p
                WHERE p.tenant_id = ? AND p.deleted_at IS NULL
                  AND p.reports_to_position_code = 'jefe_zona') AS cuelgan`, [TENANT, TENANT]);
    check(zona.rows[0].cuelgan >= 6,
      `${zona.rows[0].cuelgan} puestos cuelgan de jefe_zona (supervisores, encargados, operaciones, mayoreo)`);
    if (zona.rows[0].ocupantes === 0) {
      declarar(
        'las 3 Gerencias de Zona (`jefe_zona`) NO tienen cuenta: la cúpula operativa del organigrama ' +
        'no está en el padrón. La carta se armó igual —decisión del lead— porque un puesto vacante ' +
        'sigue siendo el lugar al que se reporta; cuando tengan cuenta, el escalamiento funciona solo.',
      );
    }

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

      // 3d. CONTROL POSITIVO — sin esto, un candado que bloquee TODO se ve verde.
      // ⚠️ El conejillo cambió: `cajera -> encargado_sucursal` pasó a ser una
      // arista REAL con `[OR.8]`, así que ese UPDATE ya no probaba nada (escribía
      // lo que ya estaba). Se usa un puesto que HOY no declara jefe.
      let aceptado = false;
      try {
        await trx.raw(
          `UPDATE identity.positions SET reports_to_position_code = 'direccion'
            WHERE tenant_id = ? AND code = 'auxiliar_rh'`, [TENANT]);
        aceptado = true;
      } catch (e) { console.log(`       (rechazo inesperado: ${e.message.slice(0, 70)})`); }
      check(aceptado, 'CONTROL: una arista legítima (auxiliar_rh -> direccion) SÍ se acepta');
    } finally {
      await trx.rollback();
    }

    // Prod tiene que haber quedado igual tras romper los candados: las aristas decididas y
    // ninguna de las que el bloque de arriba intentó meter (cajera -> encargado_sucursal).
    const aristas = await k('identity.positions')
      .where({ tenant_id: TENANT })
      .whereNotNull('reports_to_position_code')
      .whereNull('deleted_at')
      .select('code', 'reports_to_position_code');
    const mapa = Object.fromEntries(aristas.map((x) => [x.code, x.reports_to_position_code]));
    check(mapa.auxiliar_rh === undefined,
      `prod intacto: el rollback deshizo la arista de prueba (auxiliar_rh -> ${mapa.auxiliar_rh ?? 'nada'})`);
    check(mapa.cajera === 'encargado_sucursal',
      `la carta de [OR.8] sigue en pie: cajera -> ${mapa.cajera}`);

    // ── 4. El catálogo de responsabilidades ───────────────────────────────
    console.log('\n── 4. Responsabilidades');
    const resp = await k('identity.responsibilities').select('key', 'dimension');
    /*
     * ⚠️ Ya NO es «una por bandeja». `[SN.17]` (2026-09-12) agregó dos que
     * **parten una bandeja en dos trabajos**: conciliación de ingresos y de
     * egresos viven las dos en /finanzas/bancos. O sea que el catálogo mide
     * RESPONSABILIDADES, no pantallas, y puede ser más fino que el registro de
     * bandejas. Se afirma el piso (las 8 originales), no la igualdad.
     */
    check(resp.length >= 8, `el catálogo tiene ${resp.length} responsabilidades (piso: las 8 de me-work.ts)`);

    // Cuántas colas no tienen eje es una MEDICIÓN, no un invariante: sube cuando
    // alguien agrega una responsabilidad sin dimensión. Lo que el candado
    // sostiene es que estén NOMBRADAS, y que no crezcan sin que nadie lo note.
    const BASE_SIN_EJE = 7; // 5 de [OR.1b] + las 2 de [SN.17], que tampoco tienen eje
    const sinEje = resp.filter((x) => !x.dimension).map((x) => x.key);
    check(sinEje.length <= BASE_SIN_EJE,
      `${sinEje.length} colas SIN eje de ruteo (base ${BASE_SIN_EJE}) — medido, no asumido: ${sinEje.join(', ')}`);

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
    // Se fotografía ANTES: el «prod intacto» de abajo se compara contra esto,
    // no contra cero. Otras sesiones escriben en esta tabla.
    const urAntes = Number((await k('identity.user_responsibilities').count('* as n').first()).n);
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

    /*
     * «prod intacto» se mide contra el conteo de ANTES, no contra cero.
     * Clavarlo en 0 afirmaba que nadie más usa la tabla, y `[SN.17]` la empezó a
     * usar en serio el 2026-09-12 (Ivonne ingresos / Mayra egresos). Un candado
     * que se pone rojo porque el modelo se está usando mide la cosa equivocada:
     * lo que tiene que probar es que el ROLLBACK de esta prueba funcionó.
     */
    const ur = await k('identity.user_responsibilities').count('* as n').first();
    check(Number(ur.n) === urAntes,
      `prod intacto: ${ur.n} excepciones por persona, las mismas que antes de la prueba (${urAntes})`);

    // ── 6. Lo que falta, declarado ────────────────────────────────────────
    console.log('\n── 6. Lo que todavía no se decidió');
    const pr = await k('identity.position_responsibilities')
      .where({ tenant_id: TENANT })
      .whereNull('deleted_at')
      .count('* as n')
      .first();
    if (Number(pr.n) === 0) {
      declarar(
        'position_responsibilities está VACÍA: ningún puesto responde de nada todavía. Era deliberado ' +
        '([OR.1b]): sembrarla desde el permiso haría responsable de los 82,289 hallazgos de finanzas a ' +
        'auxiliar_mkt, que puede ABRIR 6 de las 8 bandejas.',
      );
    } else {
      check(Number(pr.n) >= 15, `${pr.n} asignaciones puesto × responsabilidad ([OR.3a])`);
    }

    // Toda bandeja necesita un responsable PRINCIPAL: sin eso el reparto de
    // [OR.3] no tiene a quién apuntar y el trabajo vuelve a ser cola compartida.
    /*
     * ⚠️ La afirmación se corrige: lo que importa no es que haya un PUESTO
     * principal, sino que **alguien responda**. `[SN.17]` repartió conciliación
     * de ingresos y egresos **por persona a propósito** — las dos auxiliares
     * comparten el puesto `auxiliar_finanzas`, que son 6 personas, así que el
     * puesto no distingue los dos trabajos. Exigir puesto principal declaraba
     * huérfano un reparto que existe y tiene nombre, fecha y motivo escrito.
     *
     * Lo que sí sigue siendo cierto: una responsabilidad sin NADIE —ni puesto
     * ni persona— es trabajo que el reparto de [OR.3] no puede dirigir.
     */
    const sinNadie = await k.raw(
      `SELECT r.key FROM identity.responsibilities r
        WHERE NOT EXISTS (
                SELECT 1 FROM identity.position_responsibilities pr
                 WHERE pr.tenant_id = ? AND pr.responsibility_key = r.key
                   AND pr.es_principal AND pr.deleted_at IS NULL)
          AND NOT EXISTS (
                SELECT 1 FROM identity.user_responsibilities ur
                 WHERE ur.tenant_id = ? AND ur.responsibility_key = r.key
                   AND ur.accion = 'suma'
                   AND (ur.valid_to IS NULL OR ur.valid_to >= current_date))`, [TENANT, TENANT]);
    check(sinNadie.rows.length === 0,
      `toda responsabilidad tiene responsable, por puesto o por persona (sin nadie: ${sinNadie.rows.map((r) => r.key).join(', ') || 'ninguna'})`);

    // `[OR.3a]` El catálogo declara qué permiso lo abre. Sin esto, el cruce
    // responsabilidad × permiso vivía SÓLO en TypeScript y la base no podía
    // contestar si un puesto puede abrir lo que responde.
    /*
     * LÍNEA BASE DECLARADA, no cero. Las dos de `[SN.17]` nacieron sin claves el
     * 2026-09-12, y es un hueco REAL: Ivonne y Mayra responden de algo y la base
     * no puede contestar qué permiso lo abre, así que `v_authz_coherencia_resp`
     * no las puede juzgar. No se pinta de verde y tampoco se deja el suite en
     * rojo permanente: se congela el conjunto conocido y **el candado muerde si
     * CRECE**. Dueño: la sesión de [SN.17]. Se quita esta base al cablearlas.
     */
    const BASE_SIN_CLAVE = ['finanzas.conciliacion_ingresos', 'finanzas.conciliacion_egresos'];
    const sinClave = await k('identity.responsibilities')
      .whereRaw(`array_length(permission_keys, 1) IS NULL`)
      .pluck('key');
    const nuevasSinClave = sinClave.filter((x) => !BASE_SIN_CLAVE.includes(x));
    check(nuevasSinClave.length === 0,
      `ninguna responsabilidad NUEVA sin declarar qué permiso la abre (nuevas: ${nuevasSinClave.join(', ') || 'ninguna'})`);
    if (sinClave.length) {
      declarar(
        `${sinClave.length} responsabilidad/es de la base conocida siguen sin permission_keys ` +
        `(${sinClave.join(', ')}): el cruce responsabilidad × permiso no las puede juzgar. Deuda de [SN.17].`,
      );
    }

    const sinJefe = await k.raw(
      `SELECT count(*)::int n FROM identity.positions p
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.reports_to_position_code IS NULL
          AND EXISTS (SELECT 1 FROM identity.users u WHERE u.tenant_id = p.tenant_id
                       AND u.position_code = p.code AND u.activo AND u.deleted_at IS NULL)`,
      [TENANT]);
    // `[OR.8]` Lo que la carta deja sin atar, CON motivo. Un puesto sin jefe y sin
    // motivo escrito es deriva; con motivo es una decisión. El que no esté acá
    // hace fallar el test.
    const SIN_JEFE_ACEPTADOS = {
      vendedor_tlmk: 'TELEMARKETING no aparece en el organigrama entregado por Dirección (3 personas en ese departamento)',
      coordinador_tlmk: 'idem: telemarketing no está en el organigrama',
      encargado_logistica: 'su ancla es «Jefatura CEDIS y Operaciones Logísticas», que no existe en el catálogo',
      chofer_local: 'rama CEDIS: sin ancla y sin gente',
      chofer_foraneo: 'rama CEDIS: sin ancla y sin gente',
      auxiliar_chofer: 'rama CEDIS: sin ancla y sin gente',
      auxiliar_almacen: 'el organigrama no lo nombra',
      auxiliar_rh: 'su ancla es «Jefatura Capital Humano», que no existe en el catálogo',
      vendedor_local: 'el organigrama nombra «VENDEDORES MAYOREO» (→ `vendedor_mayoreo`) y no este puesto de `mayoreo`. Lo destapó el propio gate de [OR.8] al no encontrarle motivo.',
    };
    const huerfanos = await k('identity.positions')
      .where({ tenant_id: TENANT })
      .whereNull('deleted_at')
      .whereNull('reports_to_position_code')
      .whereNot({ code: 'direccion' })
      .pluck('code');
    const sinMotivo = huerfanos.filter((c) => !SIN_JEFE_ACEPTADOS[c]);
    check(sinMotivo.length === 0,
      `todo puesto sin jefe tiene MOTIVO escrito (sin motivo: ${sinMotivo.join(', ') || 'ninguno'})`);
    huerfanos
      .filter((c) => SIN_JEFE_ACEPTADOS[c])
      .forEach((c) => declarar(`${c} sin jefe — ${SIN_JEFE_ACEPTADOS[c]}`));

    if (sinJefe.rows[0].n > 0) {
      declarar(
        `${sinJefe.rows[0].n} puesto(s) CON gente y sin jefe declarado (de los de arriba).`,
      );
    }

    // ── 7. `[OR.2]` El desvío del puesto ──────────────────────────────────
    console.log('\n── 7. Apartarse del puesto queda escrito');
    const desv = await k.raw(
      `SELECT u.username, u.role_name AS elegido, p.code AS puesto, p.default_role AS propone
         FROM identity.users u
         JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'
          AND p.default_role IS NOT NULL AND p.default_role <> u.role_name
        ORDER BY p.code, u.username`, [TENANT]);

    const eventos = await k('identity.user_events')
      .where({ tenant_id: TENANT, event: 'desvio_de_puesto' })
      .select('user_id');
    const conEvento = new Set(eventos.map((e) => e.user_id));

    // El catálogo de puestos tiene que poder proponer: si nadie propusiera nada,
    // "cero desvíos" sería verdad por vacío y no por salud.
    const proponen = await k('identity.positions')
      .where({ tenant_id: TENANT })
      .whereNull('deleted_at')
      .whereNotNull('default_role')
      .count('* as n')
      .first();
    check(Number(proponen.n) > 20,
      `${proponen.n} puestos proponen un perfil — sin esto "cero desvíos" sería verdad por vacío`);

    if (desv.rows.length) {
      const porCaso = {};
      desv.rows.forEach((x) => {
        const clave = `${x.puesto}: ${x.propone} -> ${x.elegido}`;
        porCaso[clave] = (porCaso[clave] ?? 0) + 1;
      });
      declarar(
        `${desv.rows.length} persona(s) con un perfil distinto al que propone su puesto, ` +
        `SIN motivo registrado (son anteriores a [OR.2], que sólo le cobra el motivo a quien ` +
        `CREA la divergencia): ${Object.entries(porCaso).map(([c, n]) => `${n}x ${c}`).join(' · ')}`,
      );
    } else {
      check(true, 'nadie lleva un perfil distinto al que propone su puesto');
    }

    // ⚠️ La regla vive en el servicio (`detectarDesvio` + `exigirMotivo`), no en
    // la base: un CHECK no puede expresar "sólo si el CAMBIO crea la
    // divergencia". Acá se mide el RASTRO; que el 400 salga y que el motivo se
    // exija se prueba contra el API arriba, y los dev servers son de Edgar.
    declarar(
      `el rechazo 400 sin motivo y el asiento del evento NO se ejercen acá: son del servicio ` +
      `(users.service#create/update/bulkAssign) y necesitan el API corriendo. ` +
      `Eventos desvio_de_puesto hoy: ${eventos.length} (cubren ${conEvento.size} persona(s)).`,
    );

    // ── 8. `[OR.6]` La historia de puesto ─────────────────────────────────
    console.log('\n── 8. Historia de puesto: se alimenta sola y dice qué tan cierta es');
    const vista = await k.raw(
      `SELECT c.reloptions, has_table_privilege('app_runtime','identity.v_position_history','SELECT') AS lee
         FROM pg_class c WHERE c.oid = 'identity.v_position_history'::regclass`);
    const opts = (vista.rows[0].reloptions || []).join(',');
    check(/security_invoker=(true|on)/i.test(opts),
      `la vista tiene security_invoker (lee user_events, que tiene RLS forzado) — reloptions: ${opts || 'ninguna'}`);
    check(vista.rows[0].lee === true, 'app_runtime puede leer la historia');

    const cob = await k.raw(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM identity.v_position_history h
                 WHERE h.tenant_id = u.tenant_id AND h.user_id = u.id AND h.vigente))::int con_tramo
         FROM identity.users u
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'`, [TENANT]);
    check(cob.rows[0].con_tramo === cob.rows[0].total,
      `${cob.rows[0].con_tramo}/${cob.rows[0].total} personas con tramo VIGENTE`);

    const origenes = await k('identity.v_position_history')
      .where({ tenant_id: TENANT })
      .groupBy('desde_origen')
      .select('desde_origen')
      .count('* as n');
    const validos = new Set(['cambio', 'registro_sistema', 'estimado_alta']);
    const raros = origenes.filter((o) => !validos.has(o.desde_origen)).map((o) => o.desde_origen);
    check(raros.length === 0,
      `desde_origen sólo toma los 3 valores declarados (raros: ${raros.join(', ') || 'ninguno'})`);
    origenes
      .filter((o) => o.desde_origen !== 'cambio')
      .forEach((o) =>
        declarar(
          `${o.n} tramo(s) con desde_origen="${o.desde_origen}": ` +
          (o.desde_origen === 'estimado_alta'
            ? 'no se sabe desde cuándo ocupan el puesto; se usa la fecha de alta como PISO, no como hecho'
            : 'es la fecha en que el sistema lo supo, NO en que la persona tomó el puesto'),
        ));

    // PRUEBA EN VIVO: el trigger tiene que ver pasar un cambio real.
    const trx3 = await k.transaction();
    try {
      const victima = await trx3('identity.users')
        .where({ tenant_id: TENANT, kind: 'interno', activo: true })
        .whereNotNull('position_code')
        .whereNull('deleted_at')
        .first('id', 'position_code');
      const otro = await trx3('identity.positions')
        .where({ tenant_id: TENANT })
        .whereNot({ code: victima.position_code })
        .whereNull('deleted_at')
        .first('code');

      const antes = await trx3('identity.user_events')
        .where({ tenant_id: TENANT, user_id: victima.id })
        .whereIn('event', ['puesto_asignado', 'puesto_retirado'])
        .count('* as n')
        .first();

      // 8a. CONTROL: un UPDATE que NO toca el puesto no debe escribir nada.
      await trx3('identity.users')
        .where({ tenant_id: TENANT, id: victima.id })
        .update({ meta_puntos: 1 });
      const igual = await trx3('identity.user_events')
        .where({ tenant_id: TENANT, user_id: victima.id })
        .whereIn('event', ['puesto_asignado', 'puesto_retirado'])
        .count('* as n')
        .first();
      check(Number(igual.n) === Number(antes.n),
        'CONTROL: un cambio que NO toca el puesto no escribe en la historia (un trigger que dispara de más la llenaría de ruido)');

      // 8b. El cambio real SÍ queda.
      await trx3('identity.users')
        .where({ tenant_id: TENANT, id: victima.id })
        .update({ position_code: otro.code });
      const nuevo = await trx3('identity.user_events')
        .where({ tenant_id: TENANT, user_id: victima.id, event: 'puesto_asignado' })
        .orderBy('created_at', 'desc')
        .first('detalle');
      check(
        nuevo && nuevo.detalle.position_code === otro.code && nuevo.detalle.desde_origen === 'cambio',
        `un cambio de puesto REAL queda asentado por el trigger, con desde_origen="cambio" ` +
          `(vio: ${nuevo ? `${nuevo.detalle.position_code}/${nuevo.detalle.desde_origen}` : 'nada'})`,
      );
      check(
        nuevo && nuevo.detalle.position_code_anterior === victima.position_code,
        'y guarda de qué puesto venía — sin eso el tramo anterior no se puede explicar',
      );

      // 8c. El tramo anterior se CIERRA: es lo que hace de esto una historia.
      const tramos = await trx3('identity.v_position_history')
        .where({ tenant_id: TENANT, user_id: victima.id })
        .orderBy('desde')
        .select('position_code', 'vigente');
      check(
        tramos.length >= 2 && tramos.filter((t) => t.vigente).length === 1,
        `${tramos.length} tramos y exactamente 1 vigente — el anterior quedó cerrado`,
      );
      check(
        tramos[tramos.length - 1].position_code === otro.code,
        'el tramo vigente es el puesto nuevo',
      );
    } finally {
      await trx3.rollback();
    }

    const postHist = await k('identity.v_position_history')
      .where({ tenant_id: TENANT, desde_origen: 'cambio' })
      .count('* as n')
      .first();
    check(Number(postHist.n) === 0,
      `prod intacto: ${postHist.n} tramos con desde_origen="cambio" (el de la prueba se revirtió)`);

    // ⚠️ La pregunta que la fase existe para contestar — «¿quién respondía de
    // esto en marzo?» — hoy se puede FORMULAR pero devuelve vacío, y eso no es
    // un bug: la historia no tiene fondo todavía. Lo honesto es medir hasta
    // dónde llega y declararlo, no presentar la capacidad como si ya sirviera.
    const cerrados = await k('identity.v_position_history')
      .where({ tenant_id: TENANT })
      .whereNotNull('hasta')
      .count('* as n')
      .first();
    const reales = await k('identity.v_position_history')
      .where({ tenant_id: TENANT, desde_origen: 'cambio' })
      .count('* as n')
      .first();
    declarar(
      `la historia tiene ${cerrados.n} tramo(s) CERRADO(s) y ${reales.n} con fecha de inicio real: ` +
      `la consulta "¿quién ocupaba X en marzo?" se puede escribir y hoy devuelve vacío, porque ` +
      `el registro arranca ahora. El mecanismo está; la profundidad se acumula a partir de este cambio.`,
    );

    console.log(
      `\n${fail === 0 ? '✅' : '❌'} [OR.0/OR.1/OR.2/OR.6] el puesto es la unidad organizacional: ` +
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
