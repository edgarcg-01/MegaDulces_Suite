'use strict';
/**
 * `[PVI.10]` — Reparte `PRESUPUESTOS_APROBAR`: **preparar deja de ser lo mismo que autorizar**.
 *
 * `POST /finance/budget/budgets/:id/approve` exigía `PRESUPUESTOS_GESTIONAR` — la misma llave que
 * editar una partida o mandar el ejercicio a firma. Tanto, que la descripción de esa clave decía
 * textual *«crear **y aprobar** el ejercicio presupuestal»*. El único freno era no poder
 * auto-aprobar la propia captura, y eso separa PERSONAS, no FACULTADES: dos personas que preparan
 * se aprueban el ejercicio entre sí sin que nadie haya autorizado nada.
 *
 * ── Lo medido en prod ANTES de escribir esto (sólo lectura, 2026-10-09) ──────────────────────
 *
 *  [A] `PRESUPUESTOS_APROBAR` **no existe en ningún mapa de rol**. Importa porque la trampa de
 *      `[LC.6.2]` es justo la contraria: una clave que ya vive en `false` (residuo de guardar el
 *      mapa completo desde `/admin/roles`) hace que el patrón `-> 'KEY' IS NULL` sea un NO-OP
 *      silencioso. Acá no aplica, y se deja verificado para que nadie lo vuelva a suponer.
 *  [B] Quién puede aprobar HOY: `direccion` (2 personas) y `superadmin` (8). Los dos ya tienen
 *      `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`, el precedente "restringido" de TP.6.
 *  [C] El UPDATE toca **2 filas**.
 *
 * ⚠️ **Y la cifra que hay que decir en voz alta: esto NO separa a nadie el día uno.** Se reparte a
 *    exactamente los mismos roles que ya podían aprobar, así que nadie gana ni pierde una
 *    facultad. Peor: 8 de esas 10 personas son `superadmin`, que **saltea toda comprobación de
 *    permiso por NOMBRE DE ROL** (`RolesGuard:102`), o sea que ningún diseño de permisos las acota.
 *
 * ⭐ Entonces, ¿por qué se hace? Porque el hueco real es que **nadie PREPARA**: `finanzas` tiene
 *    sólo `VER` y no hay un rol con `GESTIONAR` que no sea Dirección. El día que Finanzas reciba
 *    `GESTIONAR` —que es lo que de verdad falta— la separación tiene que existir YA. Crearla
 *    después, con la llave vieja repartida, es la deuda que `[LC.6.2]` documentó: separarlos ahora
 *    es gratis, separarlos después no.
 *
 * ── Por qué se DERIVA del estado vivo y no se escriben los roles a mano ──────────────────────
 *
 * El criterio es **cero pérdida de facultad**: recibe la clave quien hoy puede aprobar, que es
 * quien tiene `PRESUPUESTOS_GESTIONAR = true`. Calcar una lista de nombres se desincroniza del
 * estado real (es el defecto de `[LC.6.2]`: el permiso declarado y nunca repartido).
 *
 * ⛔ **ORDEN DE ENTREGA:** esta migración va **ANTES** del código que exige la clave. Al revés,
 *    `direccion` pierde la aprobación en el instante del deploy y sólo `superadmin` seguiría
 *    pasando, por god-mode — fail-closed sobre gente real.
 *
 * ⚠️ Quien ya tenga sesión abierta necesita **re-login**: el permiso viaja en el JWT.
 *
 * Idempotente: no toca una fila que ya tenga la clave, y `||` conserva el resto del mapa.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'PRESUPUESTOS_APROBAR';
const ORIGEN = 'PRESUPUESTOS_GESTIONAR';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ⛔ `permissions -> ? IS NULL` y NO el operador `?` de JSONB (`permissions ? 'CLAVE'`): knex
  // usa `?` como su propio placeholder de binding y no lo escapa, así que `permissions ? ?` se
  // rompe o liga mal. Está escrito en CLAUDE.md y lo escribí mal igual en el primer intento.
  //
  // ⛔ **Y el `::text` del primer `?` no es decorativo.** Sin él, contra prod (2026-10-09):
  //     could not determine data type of parameter $1
  // `jsonb_build_object` es **variádica `"any"`**: Postgres no tiene de dónde deducir el tipo de un
  // parámetro suelto en esa posición, y el error llega recién al ejecutar — el archivo "se ve bien".
  // Los otros dos `?` no lo necesitan porque `->>` y `->` sí declaran `text` en su firma.
  // ⭐ Es la TERCERA vez hoy del mismo defecto de familia: un parámetro ligado donde Postgres no
  // puede inferir — `COMMENT ON` ([PVI.4]), `SET LOCAL` ([TES.12]) y ésta. Las tres fallaron en su
  // primera corrida real contra prod, no en el editor.
  const { rows } = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE (permissions ->> ?) = 'true'
        AND permissions -> ? IS NULL
      RETURNING role_name`,
    [CLAVE, ORIGEN, CLAVE],
  );

  // No se dibuja un éxito que no ocurrió: si no tocó ninguna fila hay que saberlo, porque el
  // código que viene detrás exige la clave y una repartición vacía deja la pantalla fail-closed.
  // eslint-disable-next-line no-console
  console.log(`[PVI.10] ${CLAVE} repartido a ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ') || '(ninguno — revisar antes de desplegar el código)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita la clave, sin tocar el resto del mapa. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - ? WHERE permissions -> ? IS NOT NULL`, [CLAVE, CLAVE]);
};
