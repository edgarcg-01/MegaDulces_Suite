'use strict';
/**
 * `[SN.38]` — **Los dos últimos puestos donde repartir una clave cambia algo.**
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-09-22: *«sigue, aunque los vendedores de ruta tienen su propia página»*. Se siguió,
 * y la medición dejó **dos**. Los demás no son un pendiente de reparto: son no-ops, errores de
 * ficha o decisiones humanas — todos declarados abajo con su nombre.
 *
 * ── Los dos, medidos en prod el 2026-09-22 (solo lectura) ───────────────────────────────────
 *
 *   · `full_stack_developer` → `sistemas.salud_datos`
 *     `david_cisneros` (rol `superadmin`, entró hoy), **reporta a `sistemas`**. `[SN.32]` le dio
 *     la clave al puesto `sistemas` y él quedó fuera por estar fichado en un puesto propio. Mismo
 *     departamento, mismo trabajo, y `USUARIOS_GESTIONAR` ya le abre `/admin/db-health`. La cola:
 *     **6 alertas abiertas, 5 críticas**, la más vieja del 12-sep.
 *
 *   · `aux_caja_general_zona` → `finanzas.caja`
 *     `mayra_gutierrez` (rol `finanzas_operativo`, `FINANCE_CAJA_VER = true`). El puesto se llama
 *     «Auxiliar de Caja General de Zona» y la cola se llama «Caja: movimientos por confirmar»:
 *     no hay mucho que interpretar.
 *     ⚠️ **Hoy no le va a aparecer nada, y se dice**: `finance.v_caja_movimientos_pendientes`
 *     devuelve **0 filas** y una cola en cero no se pinta. Mismo criterio que con `tesoreria` en
 *     `[SN.37]`: la responsabilidad declara de quién ES el trabajo, no cuánto hay hoy.
 *
 * ── ⛔ Todo lo demás que se midió, y por qué NO es una fila ──────────────────────────────────
 *
 *   ⛔ **`vendedor_ruta`** (20 personas, 6 activas — el grupo grande que quedaba). Decisión de
 *      Edgar: *«tienen su propia página»*. Trabajan en el app de vendedor, no en esta portada.
 *      ⚠️ Y aunque se quisiera, `comercial.venta_rutas` ancla en la **zona**: le publicaría a cada
 *      vendedor la venta de TODA su zona en vez de la suya.
 *
 *   ⛔ **`comercial.venta_vecinal` ya tiene dueño.** Mi recomendación previa decía «existe desde
 *      la Fase JZ y no la tiene nadie». **Falso, medido:** `jefe_zona` responde de los TRES
 *      canales (tiendas, rutas y vecinal). Y `supervisor_rv` —el candidato obvio— tiene **0
 *      personas**. No hay hueco.
 *
 *   ⛔ **`almacenista` → `almacen.conteo` sería un NO-OP**, por la misma razón que
 *      `vendedor_piso` en `[SN.37]`: esa clave vive en `me-tasks.ts`, y **las tareas asignadas
 *      están exentas** del filtro de `[SN.30]`. Ya ve lo que le asignan sin la clave. (Además
 *      `encargado_sucursal` ya responde de ella.)
 *
 *   ⛔ **`auxiliar_mkt` (4 personas, 3 activas) — ficha rota, no hueco de reparto.** Medido: su
 *      rol abre `RECONCILIATION_VER`, `FINANCE_BANK_VER`, `FINANCE_CAJA_VER`,
 *      `FINANCE_RECEIVABLES_VER` y `COMPRAS_HALLAZGOS_VER`. Una «Auxiliar de Mercadotecnia de
 *      Zona» que abre conciliación bancaria y cartera de clientes es un **error de rol**.
 *      Repartirle una clave encima sería construir sobre eso.
 *
 *   ⛔ **`facturador` (2 personas, 2 activas) — mismo caso**: las dos traen rol `telemarketing`.
 *      Es la familia de `anaquelista` con rol `repartidor`: el nombre del puesto y el rol no se
 *      hablan. Se corrige desde `/admin/personas`, no desde acá.
 *
 *   ⛔ **Mercadotecnia y Telemarketing no tienen clave que darles.** `jefe_marketing` (1),
 *      `auxiliar_mkt` (4), `coordinador_tlmk` (1) y `vendedor_promociones` (3): sus roles no abren
 *      **ninguna** de las colas que existen. No falta una fila — falta decidir **de qué responden**,
 *      y eso es de Dirección.
 *
 *   ⛔ **`presupuestos_compras_corp` (1)**: Presupuestos (Fase PU) tiene backend y **no tiene
 *      bandeja**. No hay cola que repartir hasta que exista.
 *
 *   ⛔ **`encargado_operaciones`**: sigue esperando la decisión de `[SN.37]` — su ficha dice
 *      almacén `08`, que tiene cero hallazgos de reabasto. Zona o almacén, lo decide negocio.
 *
 * ⛔ **Esto NO otorga permisos ni crea claves.** Las dos ya están en el catálogo y los dos roles
 * ya abren su pantalla.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [puesto, clave] — claves EXISTENTES del catálogo. Esta migración no inserta ninguna. */
const REPARTO = [
  ['full_stack_developer', 'sistemas.salud_datos'],
  ['aux_caja_general_zona', 'finanzas.caja'],
];

exports.up = async function up(knex) {
  for (const [puesto, key] of REPARTO) {
    // Se verifica que la clave EXISTA en vez de insertarla: crearla desde una migración de reparto
    // escondería que el catálogo y el código se desincronizaron (mismo criterio que `[SN.37]`).
    const cat = await knex('identity.responsibilities').where({ key }).first();
    if (!cat) {
      console.log(`  [SN.38] ⚠️ la clave "${key}" NO está en el catálogo — ${puesto} no la recibe`);
      continue;
    }
    const puestos = await knex('identity.positions')
      .where({ code: puesto })
      .whereNull('deleted_at')
      .select('tenant_id');
    if (puestos.length === 0) {
      console.log(`  [SN.38] ⚠️ el puesto "${puesto}" no existe — "${key}" no se reparte`);
      continue;
    }
    for (const { tenant_id } of puestos) {
      const ya = await knex('identity.position_responsibilities')
        .where({ tenant_id, position_code: puesto, responsibility_key: key })
        .whereNull('deleted_at')
        .first();
      if (ya) {
        console.log(`  [SN.38] ${puesto} ya responde de "${key}" — sin cambios`);
        continue;
      }
      await knex('identity.position_responsibilities').insert({
        tenant_id,
        position_code: puesto,
        responsibility_key: key,
        es_principal: true,
      });
      const gente = await knex('identity.users')
        .where({ tenant_id, position_code: puesto })
        .whereNull('deleted_at')
        .pluck('username');
      console.log(
        `  [SN.38] ${puesto} → ${key}  (la reciben ${gente.length}: ${gente.join(', ') || '—'})`,
      );
    }
  }
};

exports.down = async function down(knex) {
  for (const [puesto, key] of REPARTO) {
    await knex('identity.position_responsibilities')
      .where({ position_code: puesto, responsibility_key: key })
      .del();
  }
};
