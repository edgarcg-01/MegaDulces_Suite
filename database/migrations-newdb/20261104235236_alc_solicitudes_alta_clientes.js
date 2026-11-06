'use strict';
/**
 * `[ALC.0.4]` + `[ALC.0.5]` — **Solicitudes de alta de clientes** y sus dos llaves, repartidas.
 *
 * Plan: docs/IMPLEMENTACION/FASES/FASE_ALC_ALTA_DE_CLIENTES.md (§7 D1–D5, §9 C0).
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-04) ──
 *  · 497 clientes de la Suite (`V-…`) sin clave de Kepler, 187 con más de 90 días; 0 traen RFC.
 *  · 0 de 1,894 clientes de la Suite con régimen fiscal, uso de CFDI o CP fiscal.
 *  · En el maestro de Kepler (`kdud`), 63 de 801 RFC distintos mal capturados (24 con el dígito
 *    verificador mal, 38 con la forma mal, 1 con fecha imposible).
 *
 * ── Qué es esta tabla ────────────────────────────────────────────────────────────────────────
 * Dato PROPIO (HITL): lo que la persona capturó —desde la constancia o a mano—, quién lo capturó,
 * la decisión de crédito y la liga con la clave que Kepler le dio. NO es copia de Kepler: el
 * maestro se lee del ODS (`kepler_ods.kdud`) al buscar duplicados y al ligar. La ficha de la Suite
 * sigue siendo `commercial.customers` (al ligar se llenan sus `rfc`, `legal_name`,
 * `regimen_fiscal` y `billing_address.zip`, columnas que ya existen).
 *
 * Un RFC propio sólo puede tener UNA solicitud abierta (índice parcial): evita la doble alta que
 * hoy no detiene nada. El genérico (`XAXX…`/`XEXX…`) queda fuera del índice.
 *
 * ── Las llaves (decisión de Francisco, 2026-11-04) ──────────────────────────────────────────
 *  · `COMMERCIAL_ALTA_CLIENTES` — capturar y ver solicitudes: caja, encargados, auxiliar de
 *    tienda, vendedores (ruta, telemarketing, supervisor de ventas, promotor de ruta),
 *    facturación, gerente y Dirección.
 *  · `COMMERCIAL_ALTA_CLIENTES_CREDITO` — decidir crédito, plazo y descuento. *«La persona que
 *    autoriza es Perla, de Crédito y Cobranza»*: se le da **por PERSONA** (`perla_garcia`), porque
 *    su rol es `finanzas_operativo` y lo comparten 8 personas (medido). El rol `credito_cobranza`
 *    NO la recibe: ahí están las gestoras (Paula Alanis y Gloria Vera, medido). En ausencia de
 *    Perla, la Gerencia Administrativa y Financiera (rol `finanzas`, puesto `jefe_finanzas`) y
 *    Dirección General (`direccion`). El mecanismo es el de `[RQ.12]`: `identity.user_permissions`
 *    gana sobre el rol en los dos sentidos.
 *
 * Idempotente: tabla con IF NOT EXISTS; el reparto sólo toca el rol al que le FALTA la clave
 * (`permissions -> 'KEY' IS NULL`, nunca el operador `?`: knex no lo escapa); la fila de Perla se
 * reafirma si ya existe.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[alc_solicitudes_alta_clientes]';

const LLAVES = {
  COMMERCIAL_ALTA_CLIENTES: [
    'cajero', 'encargado_tienda', 'encargado_bodega', 'auxiliar_tienda',
    'vendedor_ruta', 'vendedor_telemarketing', 'telemarketing', 'supervisor_ventas', 'promotor_ruta',
    'facturacion', 'gerente_compras', 'direccion', 'superadmin',
  ],
  // Por rol, sólo quien la recibe EN AUSENCIA de Perla. Perla va por persona (abajo).
  COMMERCIAL_ALTA_CLIENTES_CREDITO: ['finanzas', 'direccion', 'superadmin'],
};

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const POR_PERSONA = [{
  username: 'perla_garcia',
  llave: 'COMMERCIAL_ALTA_CLIENTES_CREDITO',
  nota: '[ALC] Autoriza el crédito, plazo y descuento de los clientes nuevos (Crédito y Cobranza). '
    + 'Por PERSONA: su rol finanzas_operativo lo comparten 8. Decisión de Francisco, 2026-11-04.',
}];
const OTORGADO_POR = 'migracion_20261104235236';

/** `?,?,?` para una lista: knex EXPANDE un arreglo en varios `?`. */
const marcas = (xs) => xs.map(() => '?').join(',');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commercial.customer_onboarding_requests (
      id                    uuid          NOT NULL DEFAULT gen_random_uuid(),
      tenant_id             uuid          NOT NULL,
      folio_num             bigint        GENERATED ALWAYS AS IDENTITY,
      status                text          NOT NULL,
      origin                text          NOT NULL,
      branch                varchar(4)    NOT NULL,
      person_type           text          NOT NULL,
      rfc                   varchar(13)   NOT NULL,
      curp                  varchar(18),
      fiscal_name           text          NOT NULL,
      capital_regime        text,
      trade_name            text,
      tax_regime            varchar(3)    NOT NULL,
      fiscal_zip            varchar(5)    NOT NULL,
      kepler_sheet          jsonb         NOT NULL,
      seller_code           varchar(20),
      group_code            varchar(20),
      zone_code             varchar(20),
      credit_requested      numeric(14,2) NOT NULL DEFAULT 0,
      term_days             integer       NOT NULL DEFAULT 0,
      discount_pct          numeric(6,2)  NOT NULL DEFAULT 0,
      comments              text,
      credit_decision       text,
      credit_decided_by     uuid,
      credit_decided_role   text,
      credit_decided_at     timestamptz,
      credit_reason         text,
      credit_approved       numeric(14,2),
      term_approved         integer,
      discount_approved     numeric(6,2),
      constancia_key        text,
      constancia_reading    jsonb,
      constancia_issued_on  date,
      customer_id           uuid,
      erp_customer_code     varchar(20),
      linked_at             timestamptz,
      linked_by             uuid,
      created_at            timestamptz   NOT NULL DEFAULT now(),
      created_by            uuid,
      updated_at            timestamptz   NOT NULL DEFAULT now(),
      updated_by            uuid,
      deleted_at            timestamptz,
      deleted_by            uuid,
      CONSTRAINT customer_onboarding_requests_pkey PRIMARY KEY (id),
      -- ⚠️ identity.tenants, NO public.tenants: ésa es una VISTA (relkind 'v' en prod, medido 2026-11-06)
      -- y una FK a una vista aborta la migración («referenced relation "tenants" is not a table»).
      CONSTRAINT customer_onboarding_requests_tenant_fk FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT,
      CONSTRAINT customer_onboarding_requests_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES commercial.customers(tenant_id, id) ON DELETE SET NULL (customer_id),
      CONSTRAINT customer_onboarding_requests_status_ck
        CHECK (status IN ('credito_por_aprobar', 'lista_para_kepler', 'ligada', 'cancelada')),
      CONSTRAINT customer_onboarding_requests_origin_ck CHECK (origin IN ('constancia', 'manual')),
      CONSTRAINT customer_onboarding_requests_person_ck CHECK (person_type IN ('fisica', 'moral')),
      CONSTRAINT customer_onboarding_requests_credit_ck CHECK (credit_decision IS NULL OR credit_decision IN ('aprobado', 'rechazado')),
      CONSTRAINT customer_onboarding_requests_amounts_ck
        CHECK (credit_requested >= 0 AND term_days >= 0 AND discount_pct BETWEEN 0 AND 100),
      CONSTRAINT customer_onboarding_requests_linked_ck CHECK (status <> 'ligada' OR erp_customer_code IS NOT NULL)
    )`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_customer_onboarding_requests_status
    ON commercial.customer_onboarding_requests (tenant_id, status) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_customer_onboarding_requests_rfc
    ON commercial.customer_onboarding_requests (tenant_id, rfc)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_onboarding_requests_rfc_abierta
    ON commercial.customer_onboarding_requests (tenant_id, rfc)
    WHERE deleted_at IS NULL AND status IN ('credito_por_aprobar', 'lista_para_kepler')
      AND rfc NOT IN ('XAXX010101000', 'XEXX010101000')`);

  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.customer_onboarding_requests`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.customer_onboarding_requests
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  // Sin DELETE: una solicitud se cancela (status) y queda el registro.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.customer_onboarding_requests TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE commercial.customer_onboarding_requests IS
    'ALC.0.4 — solicitudes de alta de cliente (dato propio, HITL): lo capturado desde la constancia del SAT o a mano, la decisión de crédito y la liga con la clave de Kepler. El maestro de Kepler NO se copia: se lee de kepler_ods.kdud.'`);

  // ── Reparto de las llaves (regla 20) ──────────────────────────────────────────────────────
  const { rows: [hay] } = await knex.raw('SELECT count(*)::int n FROM identity.role_permissions WHERE deleted_at IS NULL');
  for (const [llave, roles] of Object.entries(LLAVES)) {
    const res = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, (role_name IN (${marcas(roles)})))
        WHERE permissions -> ?::text IS NULL
          AND role_name NOT LIKE 'retirado%'
          AND deleted_at IS NULL`,
      [llave, ...roles, llave],
    );
    const { rows } = await knex.raw(
      `SELECT role_name FROM identity.role_permissions
        WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL
        ORDER BY 1`,
      [llave],
    );
    if (hay.n > 0 && !rows.length) {
      throw new Error(`${TAG} Ningun rol (fuera de superadmin) quedo con ${llave}: la pantalla naceria sin dueno (regla 20)`);
    }
    console.log(`  ${TAG} ${llave}: ${res.rowCount ?? 0} fila(s) tocada(s) · en true → ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
  }

  // ── La llave de crédito, por persona (como `[RQ.12]`) ─────────────────────────────────────
  for (const p of POR_PERSONA) {
    const u = await knex('identity.users').where({ tenant_id: TENANT, username: p.username }).first('id', 'activo');
    // ⛔ No se inventa el destinatario: sin la persona (la base del CI no la tiene), se DICE y no se otorga nada.
    if (!u) { console.log(`  ${TAG} ⚠️ NO MEDIDO: no existe '${p.username}' en este tenant — ${p.llave} no se otorgó por persona.`); continue; }
    if (!u.activo) console.log(`  ${TAG} ⚠️ '${p.username}' está INACTIVO: se otorga, pero no podrá entrar hasta reactivarlo.`);
    const r = await knex.raw(
      `INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota, granted_by_username, created_at, updated_at)
            VALUES (?, ?, ?, true, ?, ?, now(), now())
       ON CONFLICT (tenant_id, user_id, permission_key)
       DO UPDATE SET allow = true, nota = EXCLUDED.nota, updated_at = now()
         RETURNING (xmax = 0) AS insertada`,
      [TENANT, u.id, p.llave, p.nota, OTORGADO_POR],
    );
    console.log(`  ${TAG} ${p.llave} -> ${p.username}: ${r.rows?.[0]?.insertada ? 'otorgado' : 'ya lo tenía (se reafirmó allow=true)'}.`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: las dos llaves (nuevas), la fila por persona que puso ella y la tabla. */
exports.down = async function down(knex) {
  for (const p of POR_PERSONA) {
    await knex.raw(
      `DELETE FROM identity.user_permissions up USING identity.users u
        WHERE up.user_id = u.id AND up.tenant_id = ? AND u.username = ? AND up.permission_key = ? AND up.granted_by_username = ?`,
      [TENANT, p.username, p.llave, OTORGADO_POR],
    );
  }
  for (const llave of Object.keys(LLAVES)) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`,
      [llave, llave],
    );
  }
  await knex.raw('DROP TABLE IF EXISTS commercial.customer_onboarding_requests');
};
