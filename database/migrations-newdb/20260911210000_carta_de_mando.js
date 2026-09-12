'use strict';
/**
 * `[OR.8]` — La carta de mando, derivada del ORGANIGRAMA que entregó Dirección (2026-09-11).
 *
 * Cierra `DEUDA-OR-CARTA` en su mitad de jerarquía: los 23 puestos con gente y sin jefe.
 *
 * ── ⚠️ El hallazgo estructural: el organigrama está por ZONA ─────────────────────────────────
 * `[OR.1a]` construyó `reports_to_position_code` asumiendo que cada puesto tiene **un** jefe. El
 * organigrama dice otra cosa: **el mismo puesto existe tres veces con tres jefes distintos** — el
 * `supervisor_rd` de La Piedad reporta a la Gerencia de La Piedad, el de Morelia a la de Morelia.
 * Y `positions.code` es único por tenant: hay UNA fila `supervisor_rd`.
 *
 * **El modelo se salva leyéndolo en dos pasos: el PUESTO da el TIPO de jefe, la ZONA da CUÁL.**
 * Eso explica retroactivamente por qué `users.supervisor_id` tenía que sobrevivir como excepción:
 * no es decoración, es el desempate de zona. Verificado: los 3 `supervisor_rd` cubren exactamente
 * las 3 zonas del organigrama (ZAMORA · LA PIEDAD RD · MORELIA ABASTOS).
 *
 * ── Las tres decisiones del lead ────────────────────────────────────────────────────────────
 *  1. **`jefe_zona` se usa aunque esté VACANTE.** Un puesto vacante sigue siendo el lugar al que se
 *     reporta — mismo criterio que `direccion` en `[OR.1d]`. Cuando las 3 Gerencias de Zona tengan
 *     cuenta, el escalamiento funciona solo, sin tocar nada.
 *  2. **`repartidor` → ruta vecinal.** El organigrama lo pone en dos lados (CEDIS y Supervisor de
 *     Ventas Vecinal); el lead eligió vecinal para las 2 personas que hay.
 *  3. **Sólo se crea lo que ancla a gente real.** Resultado: **UN puesto nuevo**
 *     (`direccion_comercial`), porque todos los demás anclajes ya existían vacíos — `jefe_zona`,
 *     `supervisor_rv`, `encargado_cajas`, `jefe_finanzas`, `tesoreria`, `prevencion`,
 *     `gerente_compras`. El catálogo de `[UN.1]` era mejor de lo que parecía: le faltaba gente, no
 *     puestos.
 *
 * ── Lo que el organigrama corrigió de mis propuestas ────────────────────────────────────────
 *   `cajera` → `encargado_sucursal`            acerté
 *   `auxiliar_administrativo` → `jefe_zona`    **me equivoqué**: propuse `direccion`, y es Staff
 *                                              Administrativo de ZONA
 *   `encargado_cajas`                          **es real** («Coordinador de Cajas», Morelia Abastos)
 *
 * ── Lo que NO se ata, y se DECLARA (ADR-056) ────────────────────────────────────────────────
 *  · **La rama CEDIS** (`encargado_logistica`, `chofer_local`, `chofer_foraneo`, `auxiliar_chofer`,
 *    `chofer_rd`): su ancla es «Jefatura CEDIS y Operaciones Logísticas» / «Encargado de Almacén»,
 *    que no existen en el catálogo y **ninguno tiene gente hoy**. Crearlos sería inventar anclas
 *    vacías para colgar puestos vacíos.
 *  · **Telemarketing no aparece en el organigrama.** Tenemos 3 personas y un departamento. No se le
 *    inventa un jefe: queda sin atar y reportado.
 *  · **`auxiliar_rh`** (0 personas): su ancla es «Jefatura Capital Humano», que tampoco existe.
 *  · **Entre `auxiliar_contabilidad` y `jefe_finanzas` el organigrama tiene un «Encargado
 *    Contabilidad»** que no se crea (0 personas). La arista salta ese nivel, y queda dicho.
 *
 * Aditiva e idempotente. No toca personas, permisos ni alcance: sólo la cadena entre PUESTOS.
 *
 * @param { import("knex").Knex } knex
 */

/** El único puesto que hace falta crear para anclar gente real. */
const PUESTO_NUEVO = ['direccion_comercial', 'Dirección Comercial y Marketing', 'administracion', null, 'direccion'];

/**
 * [puesto, reporta_a] — leído del organigrama, rama por rama.
 * Se aplica sólo si los dos puestos existen y el hijo no tiene jefe ya declarado.
 */
const CARTA = [
  // ── Bajo DIRECCIÓN GENERAL ────────────────────────────────────────────────
  ['jefe_zona', 'direccion'],
  ['jefe_finanzas', 'direccion'],              // Gerencia Administrativa y Financiera
  ['direccion_comercial', 'direccion'],
  ['sistemas', 'direccion'],                   // Jefatura Sistemas y Transformación Digital

  // ── Bajo GERENCIA DE ZONA (×3; el desempate lo da la zona de la persona) ──
  ['supervisor_rd', 'jefe_zona'],
  ['supervisor_rv', 'jefe_zona'],
  ['supervisor_zona', 'jefe_zona'],
  ['encargado_sucursal', 'jefe_zona'],
  ['encargado_operaciones', 'jefe_zona'],      // Coordinador de OPERACIONES ZONA
  ['auxiliar_administrativo', 'jefe_zona'],    // Staff Administrativo de Zona
  ['vendedor_mayoreo', 'jefe_zona'],

  // ── Bajo SUPERVISOR DE VENTAS RD ──────────────────────────────────────────
  ['vendedor_ruta', 'supervisor_rd'],
  ['vendedor_suplente', 'supervisor_rd'],
  ['chofer_rd', 'supervisor_rd'],

  // ── Bajo SUPERVISOR DE VENTAS VECINAL ─────────────────────────────────────
  ['vendedor_vecinal', 'supervisor_rv'],
  ['cajero_rv_promotor', 'supervisor_rv'],     // Cajero Vecinal
  ['repartidor', 'supervisor_rv'],             // decisión del lead
  ['almacenista_surtidor_rv', 'supervisor_rv'],

  // ── Bajo ENCARGADO DE SUCURSAL ────────────────────────────────────────────
  ['auxiliar_encargado', 'encargado_sucursal'],
  ['encargado_cajas', 'encargado_sucursal'],   // Coordinador de Cajas (Morelia Abastos)
  ['cajera', 'encargado_sucursal'],
  ['anaquelista', 'encargado_sucursal'],
  ['bodeguero', 'encargado_sucursal'],
  ['almacenista', 'encargado_sucursal'],
  ['vendedor_piso', 'encargado_sucursal'],
  ['vendedor_promociones', 'encargado_sucursal'],
  ['auxiliar_piso_venta', 'encargado_sucursal'],
  ['surtidor_tienda', 'encargado_sucursal'],
  ['intendencia', 'encargado_sucursal'],

  // ── Bajo COORDINADOR DE OPERACIONES DE ZONA ───────────────────────────────
  ['receptor_mercancia', 'encargado_operaciones'],
  ['empaquetador', 'encargado_operaciones'],
  ['surtidor', 'encargado_operaciones'],
  ['checador', 'encargado_operaciones'],
  ['facturador', 'encargado_operaciones'],

  // ── Bajo GERENCIA ADMINISTRATIVA Y FINANCIERA ─────────────────────────────
  ['tesoreria', 'jefe_finanzas'],              // Jefe de Tesorería
  ['prevencion', 'jefe_finanzas'],             // Auditoría Interna
  // ⚠️ El organigrama tiene un «Encargado Contabilidad» en medio; no se crea (0 personas).
  ['auxiliar_contabilidad', 'jefe_finanzas'],

  // ── Bajo JEFE DE TESORERÍA ────────────────────────────────────────────────
  ['auxiliar_credito_cobranza', 'tesoreria'],  // Crédito y Cobranza
  ['auxiliar_finanzas', 'tesoreria'],          // Analista de Ingresos / de Egresos
  ['caja_general', 'tesoreria'],

  // ── Bajo AUDITORÍA INTERNA ────────────────────────────────────────────────
  ['auxiliar_prevencion', 'prevencion'],

  // ── Bajo DIRECCIÓN COMERCIAL Y MARKETING ──────────────────────────────────
  ['jefe_marketing', 'direccion_comercial'],
  ['gerente_compras', 'direccion_comercial'],  // Coordinación de Compras

  // ── Bajo COORDINACIÓN DE COMPRAS / JEFE DE MARKETING ──────────────────────
  ['comprador', 'gerente_compras'],
  ['auxiliar_compras', 'gerente_compras'],     // Staff de analistas de abastecimiento comercial
  ['auxiliar_mkt', 'jefe_marketing'],          // Staff de auxiliares de marketing de zona
];

/** Lo que queda sin atar, con su motivo. Se imprime; no se inventa un jefe. */
const SIN_ATAR = {
  encargado_logistica: 'su ancla es «Jefatura CEDIS y Operaciones Logísticas», que no existe en el catálogo y no tiene gente',
  chofer_local: 'rama CEDIS: sin ancla y sin gente',
  chofer_foraneo: 'rama CEDIS: sin ancla y sin gente',
  auxiliar_chofer: 'rama CEDIS: sin ancla y sin gente',
  auxiliar_almacen: 'el organigrama no lo nombra; en CEDIS el ancla sería «Encargado de Almacén», que no existe',
  coordinador_tlmk: 'TELEMARKETING no aparece en el organigrama entregado',
  vendedor_tlmk: 'TELEMARKETING no aparece en el organigrama entregado (3 personas en ese departamento)',
  auxiliar_rh: 'su ancla es «Jefatura Capital Humano», que no existe en el catálogo',
};

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');

  for (const tenant of tenants) {
    // ── 1. El único puesto nuevo ────────────────────────────────────────────
    const [code, name, dept, rol, jefe] = PUESTO_NUEVO;
    const res = await knex.raw(
      `INSERT INTO identity.positions
         (tenant_id, code, name, org_labels, orden, department_code, default_role, reports_to_position_code)
       VALUES (?, ?, ?, ARRAY['DIRECCIÓN COMERCIAL Y MARKETING'], 580, ?, ?, ?)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenant, code, name, dept, rol, jefe]);
    console.log(res.rowCount
      ? `  [OR.8] + puesto ${code} (ancla de jefe_marketing y gerente_compras)`
      : `  [OR.8] ${code} ya existía`);

    // ── 2. La carta ─────────────────────────────────────────────────────────
    // Sólo se escribe sobre puestos SIN jefe: una arista ya decidida no se pisa.
    let puestas = 0;
    let yaTenian = 0;
    const faltantes = [];
    for (const [hijo, padre] of CARTA) {
      const h = await knex('identity.positions')
        .where({ tenant_id: tenant, code: hijo })
        .whereNull('deleted_at')
        .first('code', 'reports_to_position_code');
      const p = await knex('identity.positions')
        .where({ tenant_id: tenant, code: padre })
        .whereNull('deleted_at')
        .first('code');
      if (!h || !p) { faltantes.push(`${hijo} -> ${padre}`); continue; }
      if (h.reports_to_position_code) { yaTenian++; continue; }
      await knex('identity.positions')
        .where({ tenant_id: tenant, code: hijo })
        .update({ reports_to_position_code: padre, updated_at: knex.fn.now() });
      puestas++;
    }
    console.log(`  [OR.8] ${puestas} arista/s nuevas · ${yaTenian} ya declarada/s · ${faltantes.length} sin puesto en el catálogo`);
    if (faltantes.length) faltantes.forEach((f) => console.log(`     ~ ${f}`));

    // ── 3. La prueba de que es una jerarquía y no una lista ─────────────────
    const prof = await knex.raw(
      `WITH RECURSIVE ch AS (
         SELECT code, reports_to_position_code AS jefe, 1 AS nivel
           FROM identity.positions WHERE tenant_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT p.code, p.reports_to_position_code, ch.nivel + 1
           FROM identity.positions p JOIN ch ON p.code = ch.jefe
          WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND ch.nivel < 20)
       SELECT max(nivel)::int niveles FROM ch`, [tenant, tenant]);
    console.log(`  [OR.8] profundidad de la cadena: ${prof.rows[0].niveles} niveles`);

    const cobertura = await knex.raw(
      `SELECT count(*)::int con_gente,
              count(*) FILTER (WHERE p.reports_to_position_code IS NOT NULL)::int con_jefe
         FROM identity.positions p
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM identity.users u
                       WHERE u.tenant_id = p.tenant_id AND u.position_code = p.code
                         AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno')`, [tenant]);
    const cob = cobertura.rows[0];
    console.log(`  [OR.8] puestos CON gente que ya declaran jefe: ${cob.con_jefe}/${cob.con_gente}`);

    const personas = await knex.raw(
      `SELECT count(*)::int n FROM identity.users u
         JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'
          AND p.reports_to_position_code IS NOT NULL`, [tenant]);
    console.log(`  [OR.8] personas que ya heredan jefe de su PUESTO: ${personas.rows[0].n}/100`);

    // ── 4. Lo que queda sin atar, declarado ─────────────────────────────────
    const huerfanos = await knex.raw(
      `SELECT p.code,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = p.tenant_id AND u.position_code = p.code
                  AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno') AS gente
         FROM identity.positions p
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL
          AND p.reports_to_position_code IS NULL AND p.code <> 'direccion'
        ORDER BY gente DESC, p.code`, [tenant]);
    console.log(`\n  [OR.8] ${huerfanos.rows.length} puesto/s sin jefe declarado (la raíz no cuenta):`);
    huerfanos.rows.forEach((r) => {
      const motivo = SIN_ATAR[r.code] ?? '⚠️ SIN MOTIVO REGISTRADO — revisar';
      console.log(`     · ${String(r.code).padEnd(26)} ${r.gente} persona/s — ${motivo}`);
    });
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  for (const tenant of await knex('identity.tenants').pluck('id')) {
    for (const [hijo] of CARTA) {
      // No se toca la arista que sembró [OR.1a] con evidencia de datos.
      if (hijo === 'vendedor_ruta') continue;
      await knex('identity.positions')
        .where({ tenant_id: tenant, code: hijo })
        .update({ reports_to_position_code: null });
    }
    const ocupado = await knex('identity.users')
      .where({ tenant_id: tenant, position_code: PUESTO_NUEVO[0] })
      .whereNull('deleted_at')
      .first('id');
    if (!ocupado) {
      await knex('identity.positions').where({ tenant_id: tenant, code: PUESTO_NUEVO[0] }).del();
    }
  }
  console.log('  [OR.8] down: carta retirada; se conserva vendedor_ruta -> supervisor_rd ([OR.1a], con evidencia de datos).');
};
