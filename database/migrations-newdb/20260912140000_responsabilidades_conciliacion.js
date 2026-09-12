'use strict';
/**
 * `[SN.17]` — Conciliar INGRESOS y conciliar EGRESOS son dos trabajos distintos, y el puesto no
 * los distingue.
 *
 * ── El pedido y lo que la medición le corrigió ──────────────────────────────────────────────
 * Edgar (2026-09-12): *"ese es para un solo usuario, debemos personalizar según su puesto. ivonne
 * es de ingresos, ella se encarga de conciliar ingresos"*.
 *
 * **Por puesto no se puede.** Medido en prod el mismo día:
 *
 *     mayra_gutierrez  → position_code = 'auxiliar_finanzas'  role = 'finanzas_operativo'
 *     ivonne_cruz      → position_code = 'auxiliar_finanzas'  role = 'finanzas_operativo'
 *
 * Son **el mismo puesto**, y hay **6 personas** en él. Lo único que `auxiliar_finanzas` declara
 * hoy es `finanzas.hallazgos`. Partir el trabajo por puesto exigiría partir el puesto — decisión
 * de organigrama, de Dirección, no de esta migración.
 *
 * Para eso existe `identity.user_responsibilities`: la **excepción por persona**, que `[OR.1b]`
 * creó con `nota` NOT NULL y vigencia justamente para que cueste y quede explicada. Es el caso
 * canónico: dos personas del mismo puesto con trabajos distintos.
 *
 * ⚠️ **Si mañana hay que hacer esto con las otras 4 auxiliares, la excepción se volvió la norma**
 * y la respuesta correcta pasa a ser partir el puesto. Queda dicho acá para que se note.
 *
 * ── Qué NO hace esta migración ──────────────────────────────────────────────────────────────
 * ⛔ **No gatea nada.** La responsabilidad ORDENA, no autoriza — es la regla que `[OR.1b]` dejó
 * escrita: *"el PERMISO decide si podés ABRIRLO; la RESPONSABILIDAD decide si es TUYO… si también
 * gateara habría un cuarto sistema de autorización"*. Las 24 personas con `FINANCE_BANK_VER`
 * siguen viendo y pudiendo abrir las dos conciliaciones; lo que cambia es que a Ivonne la suya le
 * aparece **como suya y primero**, y a Mayra la otra.
 *
 * ⛔ No toca `position_responsibilities`: el puesto `auxiliar_finanzas` **no** responde de una de
 * las dos, responde de las dos o de ninguna. Sembrarlo ahí sería decir algo falso de las 6.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [key, label, descripcion, dimension, orden] — mismo formato que `20260911140000`. */
const NUEVAS = [
  [
    'finanzas.conciliacion_ingresos',
    'Conciliación de ingresos',
    'Cuadrar los depósitos del banco contra las pólizas de cobranza de Kepler, mes por mes.',
    null,
    12,
  ],
  [
    'finanzas.conciliacion_egresos',
    'Conciliación de egresos',
    'Cuadrar los retiros del banco contra las pólizas del 102 de Kepler, mes por mes.',
    null,
    14,
  ],
];

/**
 * Quién responde de qué, por PERSONA. La nota no es adorno: es el único lugar donde queda escrito
 * por qué esta persona tiene algo que su puesto no le da.
 */
const ASIGNACIONES = [
  ['ivonne_cruz', 'finanzas.conciliacion_ingresos'],
  ['mayra_gutierrez', 'finanzas.conciliacion_egresos'],
];

const NOTA =
  'Reparto declarado por Edgar (2026-09-12): ingresos a Ivonne, egresos a Mayra. Va por PERSONA ' +
  'y no por puesto porque las dos son `auxiliar_finanzas` — el puesto no distingue los dos ' +
  'trabajos y son 6 personas. Si esto se repite con las demas, hay que partir el puesto.';

exports.up = async function up(knex) {
  for (const [key, label, desc, dim, orden] of NUEVAS) {
    await knex.raw(
      `INSERT INTO identity.responsibilities (key, label, descripcion, dimension, orden)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, descripcion = EXCLUDED.descripcion,
                                       dimension = EXCLUDED.dimension, orden = EXCLUDED.orden`,
      [key, label, desc, dim, orden],
    );
  }
  console.log(`  [SN.17] catálogo: +${NUEVAS.length} responsabilidades de conciliación`);

  for (const [username, key] of ASIGNACIONES) {
    const u = await knex('identity.users')
      .whereRaw('lower(username) = ?', [username])
      .whereNull('deleted_at')
      .select('id', 'tenant_id', 'position_code')
      .first();
    if (!u) {
      // No se inventa la fila: si la persona no está, se dice y se sigue. Una asignación a un
      // usuario que no existe fallaría por FK, y peor sería adivinar a quién se refería.
      console.log(`  [SN.17] ⚠️ ${username} no existe o está borrado — NO se asignó "${key}"`);
      continue;
    }
    const ya = await knex('identity.user_responsibilities')
      .where({ tenant_id: u.tenant_id, user_id: u.id, responsibility_key: key })
      .whereNull('deleted_at')
      .first();
    if (ya) {
      console.log(`  [SN.17] ${username} ya responde de "${key}" — sin cambios`);
      continue;
    }
    await knex('identity.user_responsibilities').insert({
      tenant_id: u.tenant_id,
      user_id: u.id,
      responsibility_key: key,
      accion: 'suma',
      nota: NOTA,
    });
    console.log(`  [SN.17] ${username} (${u.position_code}) → ${key}`);
  }

  const n = await knex('identity.user_responsibilities').whereNull('deleted_at').count('* as n').first();
  console.log(`  [SN.17] identity.user_responsibilities: ${n.n} fila(s) vigentes`);
};

exports.down = async function down(knex) {
  // Se retiran SOLO las filas que esta migración creó, y por su nota — no se vacía la tabla.
  for (const [username, key] of ASIGNACIONES) {
    const u = await knex('identity.users')
      .whereRaw('lower(username) = ?', [username])
      .select('id', 'tenant_id')
      .first();
    if (!u) continue;
    await knex('identity.user_responsibilities')
      .where({ tenant_id: u.tenant_id, user_id: u.id, responsibility_key: key })
      .del();
  }
  await knex('identity.responsibilities')
    .whereIn('key', NUEVAS.map(([k]) => k))
    .del();
};
