'use strict';
/**
 * `[CDRP.3]` — **Ocupar las sillas de Dirección, por PERSONA, porque los PUESTOS están vacíos.**
 *
 * ── El problema, medido en prod el 2026-09-21 ───────────────────────────────────────────────
 * `[CDRP.0]` repartió `comercial.venta_zonas` y `comercial.thot` a los puestos que responden de
 * ellas, y `[CDRP.1]` + `[JZ.7]` construyeron el bloque de zonas que esas claves encienden. Todo
 * está en prod desde el 17 y 18 de septiembre (batches 455 y 456). Y **no lo ve nadie**:
 *
 *     identity.positions  code = 'direccion'            → 0 personas
 *     identity.positions  code = 'direccion_comercial'  → 0 personas
 *
 * `medirZona` corta en seco cuando la persona no tiene ninguna de esas claves
 * (`grupos.length === 0` → `{ zonas: [], consolidado: null }`), así que cuatro commits ya pagados
 * entregan **valor cero visible**. No falta código: falta que alguien ocupe la silla.
 *
 * ── Por qué va por PERSONA y no moviendo a nadie de puesto ──────────────────────────────────
 * Las dos personas están hoy registradas en el puesto `sistemas`:
 *
 *     superuser        Luis Francisco López Gutierrez   position_code = 'sistemas'
 *     guillermo_lopez  Guillermo Lopez Gutierrez        position_code = 'sistemas'
 *
 * Cambiarles el puesto es una decisión de **organigrama** — arrastra departamento, jerarquía,
 * historial y la frase de propósito — y ⭐ **el dato operativo (puesto, departamento, sucursal,
 * alcance) se administra desde la UI, no por migración** (regla de Edgar, 2026-08-27). Para esto
 * existe `identity.user_responsibilities`: la **excepción por persona**, que `[OR.1b]` creó con
 * `nota` NOT NULL justamente para que cueste y quede explicada. Es exactamente el caso canónico,
 * y el precedente vivo es `[SN.17]` (2026-09-12, ingresos a Ivonne / egresos a Mayra).
 *
 * Autorizado explícitamente por el usuario el 2026-09-21: «autorizo que tú asignes esas sillas».
 *
 * ── ⛔ Lo que esto NO resuelve, y hay que decirlo ────────────────────────────────────────────
 * Es un **puente, no el estado final**. Mientras el puesto siga siendo `sistemas`:
 *
 *   · La frase «mi trabajo se llama» (`identity.positions.proposito`, `[CDRP.1]`) que les toca es
 *     la de **§10 Sistemas**, no la de §2 Dirección General ni la de §3 Dirección Comercial. El
 *     dato queda mal aunque hoy ese bloque no se pinte (se retiró de la pantalla a pedido).
 *   · El organigrama, el departamento y cualquier reporte por puesto los siguen contando en
 *     Sistemas.
 *   · Y si mañana alguien SÍ ocupa `direccion`, va a heredar la clave por su puesto y estas filas
 *     quedan redundantes — hay que retirarlas entonces (para eso está el `down`).
 *
 * El arreglo de fondo sigue siendo mover a las personas a su puesto **desde `/admin/personas`**.
 *
 * ── ⚠️ Dos trampas que la medición destapó ──────────────────────────────────────────────────
 * 1. **Hay DOS Guillermos en prod** y no son la misma persona:
 *
 *        guillermo_lopez      Guillermo Lopez Gutierrez      → Dirección Comercial  ✅ es éste
 *        guillermo_hernandez  GUILLERMO HERNANDEZ ALMANZA    → vendedor_vecinal     ⛔ NO
 *
 *    Por eso se resuelve por `username` exacto y se aborta si no aparece, en vez de buscar por
 *    nombre. Asignarle la venta de todas las zonas a un vendedor vecinal sería un incidente.
 *
 * 2. **Dirección Comercial responde de DOS claves, no de una.** Medido en
 *    `identity.position_responsibilities`: `direccion_comercial` tiene `comercial.thot` **y**
 *    `comercial.venta_zonas`. Sembrarle sólo Thot le daría la bandeja de decisiones sin la venta
 *    que esas decisiones mueven. Por eso son 3 filas y no 2.
 *
 * ── Qué NO hace ─────────────────────────────────────────────────────────────────────────────
 * ⛔ **No gatea nada.** La responsabilidad ORDENA, no autoriza (`[OR.1b]`): *el PERMISO decide si
 * podés ABRIRLO; la RESPONSABILIDAD decide si es TUYO*. Las dos personas ya son `superadmin` y ya
 * podían entrar a todo; lo que cambia es que la venta consolidada les aparece **como suya**.
 * ⛔ No toca `identity.positions` ni `position_responsibilities`: el reparto por puesto de
 * `[CDRP.0]` queda intacto y sigue siendo el camino correcto.
 * ⛔ No crea claves: `comercial.venta_zonas` y `comercial.thot` ya están en el catálogo (medido).
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * [username, responsibility_key, rol]. Se resuelve por `username` EXACTO — ver trampa 1.
 * El reparto calca lo que `identity.position_responsibilities` ya declara para cada puesto.
 */
const ASIGNACIONES = [
  ['superuser', 'comercial.venta_zonas', 'Direccion General (puesto `direccion`, 0 personas)'],
  [
    'guillermo_lopez',
    'comercial.venta_zonas',
    'Direccion Comercial (puesto `direccion_comercial`, 0 personas)',
  ],
  [
    'guillermo_lopez',
    'comercial.thot',
    'Direccion Comercial (puesto `direccion_comercial`, 0 personas)',
  ],
];

const NOTA_BASE =
  'CDRP.3 - Puente autorizado por el usuario el 2026-09-21 ("autorizo que tu asignes esas sillas"). ' +
  'Los puestos `direccion` y `direccion_comercial` tienen 0 personas, asi que el reparto por puesto ' +
  'de CDRP.0 no le llega a nadie y el bloque de zonas de CDRP.1/JZ.7 sale vacio. Se asigna por ' +
  'PERSONA porque cambiar el puesto es decision de organigrama y se administra desde /admin/personas ' +
  '(regla de Edgar 2026-08-27), no por migracion. ES UN PUENTE: cuando alguien ocupe el puesto de ' +
  'verdad, estas filas sobran y hay que retirarlas. Puesto real al momento: ';

/** Las claves que esta migración usa. Si alguna no existe, NO se inventa: se aborta ruidoso. */
const CLAVES = [...new Set(ASIGNACIONES.map(([, k]) => k))];

exports.up = async function up(knex) {
  /*
   * ⛔ Prueba de existencia ANTES de escribir: una FK rota a mitad deja el reparto incompleto y en
   * silencio. Si el catálogo cambió, esto tiene que fallar acá y no dejar medias filas.
   */
  const enCatalogo = await knex('identity.responsibilities').whereIn('key', CLAVES).pluck('key');
  const faltan = CLAVES.filter((k) => !enCatalogo.includes(k));
  if (faltan.length) {
    throw new Error(
      `[CDRP.3] estas responsabilidades no existen en identity.responsibilities: ${faltan.join(', ')}. ` +
        'No se inventan: revisar el catalogo antes de repartir.',
    );
  }

  let puestas = 0;
  let yaEstaban = 0;
  for (const [username, key, rol] of ASIGNACIONES) {
    const u = await knex('identity.users')
      .whereRaw('lower(username) = ?', [username])
      .whereNull('deleted_at')
      .select('id', 'tenant_id', 'nombre', 'position_code')
      .first();
    if (!u) {
      // No se adivina a quién se refería: hay dos Guillermos y uno es vendedor vecinal.
      console.log(`  [CDRP.3] ⚠️ ${username} no existe o está borrado — NO se asignó "${key}"`);
      continue;
    }

    const ya = await knex('identity.user_responsibilities')
      .where({ tenant_id: u.tenant_id, user_id: u.id, responsibility_key: key })
      .whereNull('deleted_at')
      .first();
    if (ya) {
      yaEstaban++;
      console.log(`  [CDRP.3] ${username} ya responde de "${key}" — sin cambios`);
      continue;
    }

    await knex('identity.user_responsibilities').insert({
      tenant_id: u.tenant_id,
      user_id: u.id,
      responsibility_key: key,
      accion: 'suma',
      nota: `${NOTA_BASE}${u.position_code}. Rol: ${rol}.`,
    });
    puestas++;
    console.log(`  [CDRP.3] ${u.nombre} (${username}, puesto ${u.position_code}) → ${key}`);
  }

  const n = await knex('identity.user_responsibilities')
    .whereNull('deleted_at')
    .count({ n: '*' })
    .first();
  console.log(
    `  [CDRP.3] ${puestas} asignada(s), ${yaEstaban} ya existía(n) — ` +
      `identity.user_responsibilities: ${n.n} fila(s) vigentes`,
  );
  console.log(
    '  [CDRP.3] ⚠️ ACEPTACIÓN VISUAL, no de base: si la clave no llega, medirZona devuelve vacío ' +
      'con motivo NULL (pantalla muda, sin error). Verificar entrando a /projects.',
  );
};

exports.down = async function down(knex) {
  // Se retiran SOLO las filas de esta migración, por (persona, clave) — no se vacía la tabla, que
  // tiene el reparto de `[SN.17]` adentro.
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
};
