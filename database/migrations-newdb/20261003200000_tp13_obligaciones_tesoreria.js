/**
 * `[TP.13]` — Tesorería entra a Obligaciones a proveedor: María de la Paz ve y ajusta plazos,
 * Julio Torres ve. Por PERSONA, con motivo, y asentado en la Historia de cada uno.
 *
 * ── El pedido (Francisco, 2026-10-01 → 2026-10-03) ─────────────────────────────
 *   · **María de la Paz Gutiérrez** (`maria_gutierrez`, Jefe de Tesorería, rol `tesoreria`)
 *     tiene que ajustar las obligaciones con proveedores: el **plazo pactado**.
 *   · **Julio César Torres** (`julio_torres`, Auxiliar de finanzas, rol `finanzas_operativo`)
 *     arma, a pedido de Tesorería, el expediente físico de lo que se va a pagar y se lo entrega
 *     a Caja General, que hace la dispersión. **Cuando María de la Paz no está, él hace el
 *     programa de pagos** → necesita ver la deuda de toda la red.
 *   Pedido explícito: hacerlo por migración, no a mano desde `/admin/personas`.
 *
 * ── Lo medido en prod antes de escribir (2026-10-03, sólo lectura) ─────────────
 *   · Ninguno de los dos tenía excepciones en `identity.user_permissions`.
 *   · Hoy los dos sólo entran a `/compras/obligaciones` por `FINANCE_PAYMENTS_GESTIONAR`
 *     (el `anyPermissionGuard` de RE.32) → ven SÓLO la pestaña «Entregas».
 *   · Los roles `tesoreria`, `finanzas_operativo` y `finanzas` NO declaran ninguna de las tres
 *     claves (`permissions -> 'KEY' IS NULL`): no hay un `false` puesto a mano que se pise.
 *
 * ── ⚠️ Por qué por PERSONA y no por ROL ────────────────────────────────────────
 *   · `finanzas_operativo` lo tienen **6 personas activas** (4 auxiliares de finanzas, la
 *     auxiliar de Caja General de Zona y el jefe de finanzas). Sólo Julio arma el expediente y
 *     suple a Tesorería; los otros tres auxiliares sólo confirman Entregas. Darlo al rol le
 *     abriría la deuda de toda la red a quien nadie nombró.
 *   · `COMPRAS_PLAZOS_AUTORIZAR` es negociación con el proveedor (RE.30: compras + dirección).
 *     Dárselo a María de la Paz es una excepción nominal, visible y reversible — no un cambio
 *     del puesto de Tesorería para quien lo ocupe mañana.
 *
 * ── Lo que NO hace, a propósito ─────────────────────────────────────────────────
 *   · **Julio NO recibe plazos.** Hacer el programa no exige negociar el plazo; quedó como
 *     pregunta abierta al usuario. El candado 3 lo vigila.
 *   · **Ninguno recibe `COMPRAS_OBLIGACIONES_GESTIONAR`** (capturar/cancelar obligaciones):
 *     Tesorería paga, Compras registra la deuda. Separación de funciones de ADR-065.
 *   · **Ninguno recibe `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`**: quien arma el programa no lo
 *     autoriza (TP.6).
 *   · No filtra por lugar: hoy Obligaciones no aplica alcance (ver `[TP.14]`), así que «ver»
 *     equivale a toda la red — que es justo lo que les corresponde a los dos.
 *
 * ── Mecánica ───────────────────────────────────────────────────────────────────
 *   · Misma forma que `20261001160100_obligaciones_gestionar_tres.js` (`[TP.12]`).
 *   · Además asienta `permissions_changed` en `identity.user_events` (la misma forma que
 *     `UsersService.setPermissions`), para que la pestaña **Historia** de cada persona diga
 *     quién se lo dio y por qué. El precedente `[TP.12]` no lo hacía.
 *   · Idempotente: el upsert no duplica, y el evento sólo se asienta si algo cambió.
 *   · ⚠️ El permiso viaja en el JWT → **los dos tienen que volver a entrar**.
 */

const TAG = '[TP.13]';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const VER = 'COMPRAS_OBLIGACIONES_VER';
const PLAZOS = 'COMPRAS_PLAZOS_AUTORIZAR';
const GESTIONAR = 'COMPRAS_OBLIGACIONES_GESTIONAR';

const OTORGA = [
  {
    username: 'maria_gutierrez',
    keys: [VER, PLAZOS],
    nota:
      '[TP.13] Jefe de Tesoreria: paga a proveedores de toda la red y ajusta el plazo pactado ' +
      'de las obligaciones. Va por persona: el plazo es negociacion (RE.30) y no se le da al ' +
      'puesto de Tesoreria. Pedido por Francisco, 2026-10-03.',
  },
  {
    username: 'julio_torres',
    keys: [VER],
    nota:
      '[TP.13] Arma para Tesoreria el expediente fisico de lo que se va a pagar (lo entrega a ' +
      'Caja General, que dispersa) y hace el programa de pagos cuando no esta la Jefe de ' +
      'Tesoreria: necesita ver la deuda de toda la red. Solo ver; sin plazos ni captura. ' +
      'Va por persona: finanzas_operativo lo comparten 6. Pedido por Francisco, 2026-10-03.',
  },
];

const ELEVADOS = ['superadmin', 'admin'];

async function efectivo(knex, username, clave) {
  // Rol principal + adicionales (identity.user_roles, la misma unión del login) y el override.
  const { rows: [r] } = await knex.raw(
    `WITH u AS (SELECT id, tenant_id, role_name FROM identity.users
                 WHERE tenant_id = ? AND username = ? AND deleted_at IS NULL),
          roles AS (SELECT lower(u.role_name) AS role_name FROM u
                    UNION SELECT lower(ur.role_name) FROM identity.user_roles ur JOIN u ON ur.user_id = u.id)
     SELECT (SELECT up.allow FROM identity.user_permissions up JOIN u ON up.user_id = u.id
              WHERE up.tenant_id = u.tenant_id AND up.permission_key = ?) AS por_persona,
            coalesce((SELECT bool_or((rp.permissions ->> ?)::bool) FROM identity.role_permissions rp
                       JOIN roles ON lower(rp.role_name) = roles.role_name
                      WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL), false) AS por_rol`,
    [TENANT, username, clave, clave, TENANT],
  );
  if (!r) return false;
  return r.por_persona === null ? !!r.por_rol : !!r.por_persona;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  // ── Candado 1: las claves existen en el padrón ───────────────────────────────
  for (const clave of [VER, PLAZOS]) {
    const { rows } = await knex.raw(
      `SELECT 1 FROM identity.role_permissions WHERE permissions -> ? IS NOT NULL LIMIT 1`,
      [clave],
    );
    if (!rows.length) throw new Error(`${TAG} Ningún rol declara "${clave}": ¿la clave cambió de nombre?`);
  }

  for (const o of OTORGA) {
    const u = await knex('identity.users')
      .where({ tenant_id: TENANT, username: o.username })
      .whereNull('deleted_at')
      .first('id', 'role_name', 'activo');

    // ── Candado 2: la persona existe, está activa y no es de plataforma ─────────
    if (!u) throw new Error(`${TAG} No existe "${o.username}".`);
    if (!u.activo) throw new Error(`${TAG} "${o.username}" está inactiva: no se le otorga nada.`);
    if (ELEVADOS.includes(String(u.role_name).toLowerCase())) {
      throw new Error(`${TAG} "${o.username}" ya es ${u.role_name}: una excepción no le aplica.`);
    }

    const previos = await knex('identity.user_permissions')
      .where({ tenant_id: TENANT, user_id: u.id })
      .whereIn('permission_key', o.keys)
      .select('permission_key', 'allow');
    const yaTenia = new Set(previos.filter((p) => p.allow === true).map((p) => p.permission_key));
    const enFalse = previos.filter((p) => p.allow === false).map((p) => p.permission_key);
    if (enFalse.length) {
      throw new Error(
        `${TAG} "${o.username}" tiene ${enFalse.join(', ')} QUITADO a mano. Un "le quita" es una ` +
          `decisión: se para y se mira, no se pisa.`,
      );
    }

    for (const clave of o.keys) {
      const fila = {
        tenant_id: TENANT,
        user_id: u.id,
        permission_key: clave,
        allow: true,
        nota: o.nota,
        granted_by_username: `migracion ${TAG}`,
        updated_at: knex.fn.now(),
      };
      await knex('identity.user_permissions')
        .insert(fila)
        .onConflict(['tenant_id', 'user_id', 'permission_key'])
        .merge(fila);
    }

    const nuevos = o.keys.filter((k) => !yaTenia.has(k));
    if (nuevos.length) {
      await knex('identity.user_events').insert({
        tenant_id: TENANT,
        user_id: u.id,
        event: 'permissions_changed',
        detalle: JSON.stringify({
          concedidos: nuevos,
          revocados: [],
          vueltos_al_puesto: [],
          perfil_base: u.role_name,
          motivo: o.nota,
          origen: `migracion ${TAG}`,
        }),
        actor_user_id: null,
        actor_username: `migracion ${TAG}`,
      });
    }
    console.log(`${TAG} ${o.username.padEnd(16)} ${nuevos.length ? 'concedido: ' + nuevos.join(', ') : 'ya lo tenía'}`);
  }

  // ── Candado 3: el EFECTO, no «el insert corrió» ───────────────────────────────
  const esperado = [
    ['maria_gutierrez', VER, true],
    ['maria_gutierrez', PLAZOS, true],
    ['maria_gutierrez', GESTIONAR, false],
    ['julio_torres', VER, true],
    ['julio_torres', PLAZOS, false], // pregunta abierta: hacer el programa no exige negociar plazos
    ['julio_torres', GESTIONAR, false],
  ];
  const mal = [];
  for (const [username, clave, debe] of esperado) {
    const tiene = await efectivo(knex, username, clave);
    if (tiene !== debe) mal.push(`${username} ${clave}: ${tiene} (se esperaba ${debe})`);
  }
  if (mal.length) throw new Error(`${TAG} El efecto no es el pedido — se revierte:\n  ${mal.join('\n  ')}`);

  // ── Candado 4: los roles no se tocaron (la razón de ir por persona) ────────────
  const { rows: roles } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE tenant_id = ? AND deleted_at IS NULL AND lower(role_name) IN ('tesoreria','finanzas_operativo')
        AND ((permissions ->> ?)::bool IS TRUE OR (permissions ->> ?)::bool IS TRUE)`,
    [TENANT, VER, PLAZOS],
  );
  if (roles.length) {
    throw new Error(`${TAG} El rol ${roles.map((r) => r.role_name).join(', ')} quedó con el permiso: era justo lo que se evitaba.`);
  }

  console.log(`${TAG} ⚠️ maria_gutierrez y julio_torres tienen que volver a entrar: el permiso va en el JWT.`);
};

exports.down = async function down(knex) {
  // Quita SÓLO lo que esta migración puso (por su nota). Una excepción dada después a mano
  // desde /admin/personas lleva otra nota y no se toca.
  for (const o of OTORGA) {
    const u = await knex('identity.users').where({ tenant_id: TENANT, username: o.username }).first('id');
    if (!u) continue;
    await knex('identity.user_permissions')
      .where({ tenant_id: TENANT, user_id: u.id })
      .whereIn('permission_key', o.keys)
      .andWhere('nota', 'like', `${TAG}%`)
      .del();
  }
};
