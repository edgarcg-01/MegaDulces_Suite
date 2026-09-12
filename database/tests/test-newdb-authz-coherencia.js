'use strict';
/**
 * `[OR.7]` — Sincronía entre puesto, rol y permiso.
 *
 * ── Qué afirma ──────────────────────────────────────────────────────────────
 * Que los tres ejes de autorización —el **puesto** (Fase OR), el **permiso**
 * (ADR-054) y el **alcance** (`ScopeService`)— no se contradigan en silencio.
 *
 * ⛔ **Sincronizar no es fusionar.** El permiso decide si podés abrirlo; la
 * responsabilidad decide si es tuyo. Si un eje otorgara lo del otro, habría un
 * cuarto sistema de autorización — el defecto que ADR-054 retiró tras medir 4
 * compuertas muertas por tener la autorización en dos lugares. Por eso
 * `identity.v_authz_coherencia` **nombra** y no corrige.
 *
 * ── Y tampoco puede significar derivar uno del otro ─────────────────────────
 * Un rol sirve hasta a 6 puestos; hay roles con gente que ningún puesto propone.
 * Derivar cualquiera del otro perdería información real. Este smoke mide **la
 * distancia entre los ejes**, con una línea base declarada, y falla si crece.
 *
 * ADR-056: cada candado se rompe a propósito, y cada bloque lleva su **control
 * positivo** — sin él, un candado que bloquee TODO se ve igual de verde.
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

/**
 * La línea base ACEPTADA por tipo, con su motivo. Un desacuerdo de más hace
 * fallar el test; para aceptarlo hay que escribir acá por qué. Ése es el costo
 * deliberado: lo declarado se tolera, la deriva no.
 */
const BASE = {
  puesto_con_dos_roles: {
    max: 1,
    motivo:
      '`vendedor_ruta` con 13 `promotor_ruta` + 11 `vendedor_ruta`. El lead decidió NO crear el ' +
      'puesto (`DEUDA-OR7-RUTA`): los roles convergen. ⚠️ Y el dato dice que NO es un recorte — ' +
      'cada rol tiene permisos que el otro no tiene — así que la dirección de la convergencia ' +
      'toca dinero (PAYMENTS_REGISTRAR, CARTERA_GESTIONAR) y necesita autorización propia.',
  },
  rol_huerfano: {
    max: 1,
    motivo: '`promotor_ruta`, el mismo caso: deja de serlo cuando se resuelva `DEUDA-OR7-RUTA`.',
  },
  complemento_universal: {
    max: 1,
    motivo:
      '`tesoreria` + `analisis_ventas` con 1 de 1 persona. [OR.7.0b] NO lo sube: con una sola ' +
      'persona «todas lo tienen» es trivialmente cierto y no distingue el perfil del puesto de ' +
      'una excepción suya. Sube solo cuando el puesto tenga 2 personas.',
  },
  override_masivo: {
    max: 1,
    motivo:
      '`ernesto_zarate` con 28 claves sueltas sobre `contabilidad`. Un override de ese tamaño ' +
      'dice que el rol no le queda: o le falta un rol o le falta un puesto. Sin decidir.',
  },
  scope_override_masivo: {
    max: 1,
    motivo:
      'la dimensión `warehouse` con ~36 excepciones por persona. Si un rol necesita 36 ' +
      'excepciones, el que está mal es el rol — pero recortarlo cambia qué ve la gente y va aparte.',
  },
};

/**
 * `[OR.3a]` El SEXTO tipo, en su propia vista: un puesto que responde de algo que su perfil no le
 * deja abrir. `[OR.7.1]` lo había dejado fuera «porque una rama que siempre da cero se lee igual
 * que no hay problemas»; ahora hay 15 asignaciones que cruzar y 4 que no cierran.
 *
 * ⚠️ Que existan NO es una falla: es la responsabilidad **revelando permisos que faltan** en vez de
 * heredarlos. Lo que sí sería una falla es que crezcan sin que nadie lo note, o que alguno pierda
 * su motivo escrito.
 */
const BASE_RESP = {
  'supervisor_rd|comercial.thot':
    'PRINCIPAL. Le falta COMMERCIAL_THOT_GESTIONAR, que hoy tienen los 30 `vendedor_ruta` — o sea ' +
    'que los vendedores aprueban las sugerencias dirigidas a ellos mismos. Decisión de negocio.',
  'encargado_logistica|logistica.flota':
    'PRINCIPAL y el puesto NO TIENE ROL (default_role NULL): no puede abrir nada. Medido aparte: ' +
    'las alertas de flota sólo las abren `jefe_finanzas` y `sistemas` — nadie que pueda mover un camión.',
  'encargado_sucursal|almacen.conteo':
    'secundario; el principal (`supervisor_inventarios`) sí abre la bandeja. Le falta COMMERCIAL_INVENTORY_CONTAR.',
  'auxiliar_encargado|tienda.caducidades':
    'secundario; el principal (`encargado_sucursal`) sí abre la bandeja. Le falta COMMERCIAL_EXPIRY_VER.',
};

/** Los 8 departamentos que [OR.7.0] creó al partir la oficina. */
const DEPTOS_NUEVOS = [
  'compras', 'prevencion_auditoria', 'contabilidad', 'finanzas',
  'tesoreria', 'credito_cobranza', 'mercadotecnia', 'rh',
];

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
    // ── 1. Un solo catálogo de la organización ────────────────────────────
    console.log('\n── 1. `administracion` dejó de ser la bolsa de toda la oficina');
    const deps = await k('identity.departments')
      .where({ tenant_id: TENANT })
      .whereNull('deleted_at')
      .select('code', 'scope_axis');
    const codes = new Set(deps.map((d) => d.code));
    const faltan = DEPTOS_NUEVOS.filter((d) => !codes.has(d));
    check(faltan.length === 0, `los 8 departamentos de oficina existen (faltan: ${faltan.join(', ') || 'ninguno'})`);

    const sinEje = deps.filter((d) => !d.scope_axis).map((d) => d.code);
    check(sinEje.length === 0,
      `los ${deps.length} departamentos declaran eje (sin eje: ${sinEje.join(', ') || 'ninguno'}) — ` +
      `el eje se resuelve coalesce(puesto, departamento) y uno sin eje deja a su gente sin alcance`);

    const nuevosRed = deps.filter((d) => DEPTOS_NUEVOS.includes(d.code) && d.scope_axis !== 'red');
    check(nuevosRed.length === 0,
      `los 8 nuevos heredan eje "red" como sus padres (distintos: ${nuevosRed.map((d) => d.code).join(', ') || 'ninguno'})`);

    const admin = await k('identity.users')
      .where({ tenant_id: TENANT, department_code: 'administracion', kind: 'interno', activo: true })
      .whereNull('deleted_at')
      .count('* as n')
      .first();
    check(Number(admin.n) <= 5,
      `\`administracion\` quedó como residual: ${admin.n} persona(s) (era 17)`);

    // El puesto y la persona tienen que estar en el mismo departamento.
    const incoh = await k.raw(
      `SELECT u.username, u.department_code AS d_persona, p.department_code AS d_puesto
         FROM identity.users u
         JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'
          AND p.department_code IS DISTINCT FROM u.department_code`, [TENANT]);
    if (incoh.rows.length) {
      incoh.rows.forEach((r) =>
        declarar(
          `${r.username}: departamento "${r.d_persona}" y su puesto vive en "${r.d_puesto}". ` +
          `Preexistente ([ID.15] ya lo reportaba); corregirlo exige saber cuál de los dos es el correcto.`));
    } else {
      check(true, 'toda persona está en el departamento de su puesto');
    }

    // ── 2. La vista de coherencia ─────────────────────────────────────────
    console.log('\n── 2. La vista nombra los desacuerdos, y la línea base está declarada');
    const meta = await k.raw(
      `SELECT c.reloptions,
              has_table_privilege('app_runtime','identity.v_authz_coherencia','SELECT') AS lee
         FROM pg_class c WHERE c.oid = 'identity.v_authz_coherencia'::regclass`);
    check(/security_invoker=(true|on)/i.test((meta.rows[0].reloptions || []).join(',')),
      'la vista tiene security_invoker');
    check(meta.rows[0].lee === true, 'app_runtime puede leerla');

    const hoy = await k('identity.v_authz_coherencia')
      .where({ tenant_id: TENANT })
      .select('tipo', 'dice');
    const porTipo = {};
    hoy.forEach((r) => { porTipo[r.tipo] = (porTipo[r.tipo] ?? 0) + 1; });

    for (const [tipo, { max, motivo }] of Object.entries(BASE)) {
      const n = porTipo[tipo] ?? 0;
      check(n <= max,
        `${tipo}: ${n} (línea base ${max}) — si crece, alguien introdujo un desacuerdo nuevo`);
      if (n > 0) declarar(`${tipo} × ${n} — ${motivo}`);
    }
    const inesperados = Object.keys(porTipo).filter((t) => !BASE[t]);
    check(inesperados.length === 0,
      `ningún tipo de desacuerdo fuera de la línea base (nuevos: ${inesperados.join(', ') || 'ninguno'})`);
    hoy.forEach((r) => console.log(`       · ${r.dice}`));

    // ── 2b. El sexto tipo: responder de algo que no podés abrir ──────────
    console.log('\n── 2b. La responsabilidad revela permisos que faltan');
    const resp = await k('identity.v_authz_coherencia_resp')
      .where({ tenant_id: TENANT })
      .select('sujeto', 'detalle', 'dice');
    const clave = (r) => `${r.sujeto}|${r.detalle}`;
    const nuevos = resp.filter((r) => !BASE_RESP[clave(r)]).map(clave);
    check(nuevos.length === 0,
      `ninguna responsabilidad sin permiso fuera de la línea base (nuevas: ${nuevos.join(', ') || 'ninguna'})`);
    resp.filter((r) => BASE_RESP[clave(r)]).forEach((r) => declarar(`${clave(r)} — ${BASE_RESP[clave(r)]}`));

    // CONTROL: que la vista no esté vacía por estar rota. Tiene que ver también
    // las que SÍ cierran — si no, un 0 se leería como salud.
    const total = await k('identity.position_responsibilities')
      .where({ tenant_id: TENANT })
      .whereNull('deleted_at')
      .count('* as n')
      .first();
    check(Number(total.n) >= 15 && resp.length < Number(total.n),
      `CONTROL: ${resp.length} sin permiso de ${total.n} asignaciones — la vista discrimina, no marca todo`);

    // ── 3. PRUEBA NEGATIVA: la vista tiene que VER un desacuerdo nuevo ────
    console.log('\n── 3. Se inyecta un desacuerdo a propósito');
    const trx = await k.transaction();
    try {
      // Un puesto sano hoy: `cajera`, 19 personas, todas con rol `cajero`.
      const antes = await trx('identity.v_authz_coherencia')
        .where({ tenant_id: TENANT, tipo: 'puesto_con_dos_roles' })
        .count('* as n')
        .first();

      const victima = await trx('identity.users')
        .where({ tenant_id: TENANT, position_code: 'cajera', activo: true })
        .whereNull('deleted_at')
        .first('id', 'username', 'role_name');
      // Se le cambia el rol a uno que existe y no es el que su puesto propone.
      await trx('identity.users')
        .where({ tenant_id: TENANT, id: victima.id })
        .update({ role_name: 'almacenista' });

      const despues = await trx('identity.v_authz_coherencia')
        .where({ tenant_id: TENANT, tipo: 'puesto_con_dos_roles' })
        .select('sujeto', 'detalle');
      check(
        despues.some((r) => r.sujeto === 'cajera' && r.detalle === 'almacenista'),
        `la vista DETECTA que "cajera" pasó a tener dos roles adentro (antes ${antes.n}, ahora ${despues.length})`,
      );
    } finally {
      await trx.rollback();
    }
    const post = await k('identity.v_authz_coherencia')
      .where({ tenant_id: TENANT, tipo: 'puesto_con_dos_roles', sujeto: 'cajera' })
      .count('* as n')
      .first();
    check(Number(post.n) === 0, `prod intacto: "cajera" vuelve a tener un solo rol (rollback)`);

    // ── 4. El perfil compuesto del puesto ─────────────────────────────────
    console.log('\n── 4. El puesto puede proponer un perfil compuesto');
    const comp = await k('identity.positions')
      .where({ tenant_id: TENANT, code: 'auxiliar_administrativo' })
      .whereNull('deleted_at')
      .first('default_role', 'default_complements');
    check(
      comp && (comp.default_complements || []).includes('analisis_ventas'),
      `auxiliar_administrativo propone ${comp?.default_role} + [${(comp?.default_complements || []).join(', ')}] ` +
      `— lo tenían las 3 de 3 personas: era el perfil, no una excepción`,
    );

    // ⚠️ El puesto PROPONE; quien concede sigue siendo user_roles. Si esas filas
    // se hubieran borrado al subir el complemento, 3 personas perderían el permiso.
    const conceden = await k.raw(
      `SELECT count(*)::int n FROM identity.user_roles ur
         JOIN identity.users u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id
        WHERE ur.tenant_id = ? AND ur.role_name = 'analisis_ventas'`, [TENANT]);
    check(conceden.rows[0].n >= 3,
      `las ${conceden.rows[0].n} filas de user_roles que CONCEDEN analisis_ventas siguen ahí — ` +
      `el puesto propone, ellas otorgan`);

    const trx2 = await k.transaction();
    try {
      let rechazo = false;
      try {
        await trx2('identity.positions')
          .where({ tenant_id: TENANT, code: 'cajera' })
          .update({ default_complements: k.raw(`ARRAY['rol_que_no_existe']::text[]`) });
      } catch { rechazo = true; }
      check(rechazo, 'un complemento que apunta a un rol INEXISTENTE es RECHAZADO (un text[] no puede tener FK: lo hace el trigger)');
      if (rechazo) await trx2.raw('ROLLBACK; BEGIN');

      rechazo = false;
      try {
        await trx2('identity.positions')
          .where({ tenant_id: TENANT, code: 'cajera' })
          .update({ default_complements: k.raw(`ARRAY['cajero']::text[]`) });
      } catch { rechazo = true; }
      check(rechazo, 'un complemento que REPITE el perfil base es rechazado');
      if (rechazo) await trx2.raw('ROLLBACK; BEGIN');

      let aceptado = false;
      try {
        await trx2('identity.positions')
          .where({ tenant_id: TENANT, code: 'cajera' })
          .update({ default_complements: k.raw(`ARRAY['analisis_ventas']::text[]`) });
        aceptado = true;
      } catch (e) { console.log(`       (rechazo inesperado: ${e.message.slice(0, 70)})`); }
      check(aceptado, 'CONTROL: un complemento válido SÍ se acepta');
    } finally {
      await trx2.rollback();
    }

    // ── 5. El rol propuesto por un puesto no se puede borrar ──────────────
    console.log('\n── 5. Borrar un rol dejó de ignorar a los puestos');
    const enRiesgo = await k.raw(
      `SELECT rp.role_name,
              (SELECT string_agg(p.code, ', ') FROM identity.positions p
                WHERE p.tenant_id = rp.tenant_id AND p.deleted_at IS NULL
                  AND (p.default_role = rp.role_name OR rp.role_name = ANY(p.default_complements))) AS puestos
         FROM identity.role_permissions rp
        WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM identity.users u
                           WHERE u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
                             AND u.deleted_at IS NULL)
          AND EXISTS (SELECT 1 FROM identity.positions p
                       WHERE p.tenant_id = rp.tenant_id AND p.deleted_at IS NULL
                         AND (p.default_role = rp.role_name OR rp.role_name = ANY(p.default_complements)))
        ORDER BY 1`, [TENANT]);
    console.log(`     ${enRiesgo.rows.length} rol(es) SIN usuarios pero propuestos por un puesto:`);
    enRiesgo.rows.slice(0, 8).forEach((r) => console.log(`       · ${String(r.role_name).padEnd(24)} ${r.puestos}`));
    check(true, `${enRiesgo.rows.length} rol(es) que antes se podían borrar dejando al puesto sin propuesta`);

    // La FK es ON DELETE SET NULL: la base NO frena. La barrera vive en el
    // servicio, así que acá se afirma la FORMA (que sigue siendo SET NULL) y se
    // DECLARA que el rechazo se prueba contra el API.
    const fk = await k.raw(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'positions_default_role_fk'`);
    check(fk.rows[0]?.confdeltype === 'n',
      `la FK sigue en ON DELETE SET NULL (confdeltype=${fk.rows[0]?.confdeltype}) — por eso la barrera tiene que estar en el servicio`);
    declarar(
      'el rechazo 409 al borrar un rol propuesto por un puesto vive en catalogs.service#delete y ' +
      'necesita el API arriba: no se ejerce acá. Lo que sí se mide es la superficie de riesgo (arriba).',
    );

    console.log(
      `\n${fail === 0 ? '✅' : '❌'} [OR.7] sincronía puesto / rol / permiso: ${ok} ok, ${fail} fallos, ${nomedido} declarado(s)`,
    );
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\n❌ ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await k.destroy();
  }
})();
