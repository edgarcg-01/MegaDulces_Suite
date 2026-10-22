'use strict';
/**
 * `[RD.71.1]` — **Las rutas 321 y 322 pasaron de Ruta Directa a Ruta Vecinal. Salen del padrón de
 * comisión de RD.**
 *
 * ── Lo medido antes, contra prod (sólo lectura, 2026-10-20) ────────────────────────────────
 *
 *  · El testigo que manda es **el libro**, porque es el registro de lo que de verdad se
 *    depositó. Su último renglón para estas dos rutas es la **quincena 14 (02-jul → 15-jul)**:
 *
 *        321 -> ultimo pago $3,390 en la Q14. De la Q15 en adelante NO tiene renglon.
 *        322 -> nunca cobro en 2026: las 14 quincenas en 'bajo_umbral'. Tampoco tiene Q15+.
 *
 *    O sea que **el negocio hizo el cambio en julio** y lo único que quedó atrás fue el padrón
 *    del sistema.
 *  · Mientras tanto seguían `activo = true`, así que el universo las publicaba como
 *    `comisiona` con la fuente **muerta hace 139 y 110 días** y **$0 de venta en 30 días**
 *    (lo destapó `[RD.71]`).
 *  · Operan hoy en Kepler como **`2V001`** y **`2V003`** desde el **2026-09-08** (`[RD.61]`:
 *    `RVMM` = Ruta Vecinal Morelia Madero). Las dos venden **$751,354.38 en 30 días** y el
 *    universo las clasifica `fuera_no_es_camion` — que con esta decisión es **correcto**.
 *
 * ── La decisión, que NO es derivable ───────────────────────────────────────────────────────
 *
 * ⭐ **Edgar, 2026-10-20: «si son sus relevos, pasaron de RD a RV».** O sea que **la comisión de
 * Ruta Directa sigue al TIPO DE RUTA, no al chofer** — es la decisión D1 de la fase. Un chofer
 * que se mueve a vecinal deja de generar comisión de RD, aunque sea la misma persona.
 *
 * ⛔⛔ **ESTO YA SE HIZO UNA VEZ Y SE REVIRTIÓ EL MISMO DÍA.** `[RD.61]`: se apagó la 321 en
 * prod y hubo que deshacerlo al aparecer el renombre. La evidencia de entonces —la fuente murió,
 * el libro dejó de pagar, el GPS casi quieto— **era toda cierta y toda llevaba a la conclusión
 * equivocada** («están retiradas»), porque faltaba el hecho de negocio. *Se escribió en
 * producción antes de terminar de medir.*
 *
 * La diferencia ahora no es que haya más datos: es que **la decisión existe y tiene dueño**, y
 * el libro le pone fecha. Si alguien vuelve a leer sólo la ausencia de dato, va a llegar otra
 * vez a la conclusión equivocada — por eso el motivo queda ESCRITO en la fila, no en un commit.
 *
 * ── Lo que NO toca ─────────────────────────────────────────────────────────────────────────
 *
 * **Nada de lo pagado.** Las 14 quincenas viven en `commission_run_lines` con su corrida en
 * `pagado`, y el motor sólo calcula hacia adelante (`[RD.22]`). Esto cambia el padrón del
 * **futuro**; la historia queda igual, al centavo.
 *
 * ⚠️ **Y no se BORRAN las filas, se apagan.** Una fila borrada no deja rastro de que la ruta
 * existió, y el día que alguien pregunte «¿y la 321 quién la pagaba?» no hay respuesta. Apagada
 * = sigue en el padrón, sale como `config_inactiva`, y declara su motivo.
 *
 * ⚠️ **Deuda que esto deja con nombre:** `commission_route_config` **no tiene pantalla**. Esto
 * debería cambiarse desde la UI por quien decide la nómina, no por una migración. Mientras no
 * exista, cada alta/baja de ruta es un despliegue.
 *
 * Idempotente: sólo apaga lo que siga encendido, y el `down` lo devuelve exactamente.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[rd_321_322_pasaron_a_vecinal]';
const RUTAS = ['321', '322'];
const MOTIVO = 'Pasaron de Ruta Directa a Ruta Vecinal. El libro dejo de pagarles despues de la '
  + 'quincena 14 (cerro 2026-07-15); operan en Kepler como 2V001 y 2V003 desde el 2026-09-08. '
  + 'Decision de Edgar 2026-10-20: la comision de RD sigue al TIPO DE RUTA, no al chofer. '
  + 'Ver [RD.61] y [RD.71.1]. NO reactivar por "el chofer es el mismo": esa es justamente la '
  + 'lectura que ya se equivoco una vez.';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ⭐ `notes` NO existía, y por eso se agrega acá: el padrón no tenía dónde guardar POR QUÉ una
  // ruta está apagada. Sin eso, el motivo vive sólo en este archivo y en el tracker — o sea,
  // invisible para quien abra la tabla y vea `activo = false` sin explicación. Apagar sin decir
  // por qué es lo que hace que alguien la reactive "porque el chofer es el mismo".
  if (!(await knex.schema.withSchema('commercial').hasColumn('commission_route_config', 'notes'))) {
    await knex.schema.withSchema('commercial').alterTable('commission_route_config', (t) => {
      t.text('notes');
    });
    await knex.raw(`COMMENT ON COLUMN commercial.commission_route_config.notes IS
      'RD.71.1 - por que esta ruta esta como esta. Obligatorio al apagar una: una fila con
activo=false y sin motivo se reactiva sola la proxima vez que alguien mire la tabla.'`);
    console.log(`${TAG} columna notes agregada`);
  }

  // El `WHERE activo` es el guard idempotente: si ya se apagaron, no se vuelve a tocar
  // `updated_at` ni se pisa una nota que alguien haya ajustado a mano.
  const { rowCount } = await knex.raw(
    `UPDATE commercial.commission_route_config
        SET activo     = false,
            notes      = coalesce(nullif(notes,'') || ' | ', '') || ?,
            updated_at = now()
      WHERE route_code = ANY(?) AND activo AND deleted_at IS NULL`,
    [MOTIVO, RUTAS],
  );
  console.log(`${TAG} apagadas ${rowCount} de ${RUTAS.length} (${RUTAS.join(', ')})`);

  // Control: que queden las 13 de siempre menos estas dos, y que NO se haya tocado otra.
  const { rows: [t] } = await knex.raw(
    `SELECT count(*) FILTER (WHERE activo)::int AS activas,
            count(*)::int                       AS total
       FROM commercial.commission_route_config WHERE deleted_at IS NULL`);
  console.log(`${TAG} padron: ${t.activas} activas de ${t.total}`);
  if (t.activas !== t.total - RUTAS.length) {
    throw new Error(`${TAG} el padron no cuadra: ${t.activas} activas de ${t.total}, se esperaban ${t.total - RUTAS.length}`);
  }
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: las vuelve a encender y quita **su** nota.
 *
 * ⚠️ Quita la nota por COMPARACIÓN LITERAL (`replace`), no con una expresión regular. El motivo
 * trae `.`, `(`, `|` y `-`, que en un regex significan otra cosa — y un `regexp_replace` con el
 * texto sin escapar borraría de más. Es la misma trampa que `[RD.60.1]`, donde una placa se usó
 * como patrón y un paréntesis suelto rompió la consulta entera.
 *
 * ⛔ Y la columna `notes` **no se quita**: la agregó este `up`, pero otras filas pueden haberla
 * usado ya. Tirarla se llevaría notas que no son nuestras.
 */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE commercial.commission_route_config
        SET activo     = true,
            notes      = nullif(btrim(replace(replace(coalesce(notes,''), ?::text, ''), ' | ', '')), ''),
            updated_at = now()
      WHERE route_code = ANY(?::text[]) AND NOT activo AND deleted_at IS NULL`,
    [MOTIVO, RUTAS],
  );
};
