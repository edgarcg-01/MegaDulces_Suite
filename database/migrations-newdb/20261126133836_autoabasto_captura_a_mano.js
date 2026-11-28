'use strict';
/**
 * `[AB.PM.1]` **El renglón a mano en el borrador de Autoabasto.** Cada renglón del borrador dice
 * CÓMO NACIÓ:
 *  · `motor` — el ajuste de una persona sobre lo que sugirió el motor (todo lo que existe hoy);
 *  · `mano`  — lo que la persona pidió con el buscador, lo sugiriera el motor o no.
 *
 * Pedido de Francisco (2026-11-26): la sucursal le pide un traspaso a su matriz u otra sucursal,
 * capturado a mano «como en Cotizaciones», y con el alcance en días como en Pedido de Compras.
 * Plan y reglas: `docs/IMPLEMENTACION/FASES/FASE_AB_ANEXO_PEDIDO_A_MANO_2026-11-26.md`.
 *
 * ── Por qué una columna y no otra tabla ─────────────────────────────────────────────────────
 * La tabla ya guarda «lo que la persona decidió» por producto, con `UNIQUE (tenant_id, pedido_id,
 * product_id)`. Esa UNIQUE ES la regla R1 del anexo: **un producto vive una sola vez en el
 * borrador**. Una tabla aparte para lo de a mano dejaría pedir el mismo producto dos veces (del
 * sugerido y a mano) y sería la segunda copia que la regla 2 del proyecto prohíbe.
 *
 * ── Lo que dicen las columnas de siempre en un renglón a mano ───────────────────────────────
 *  · `origen_tipo` / `origen_clave`: `matriz` + el código del almacén al que se le pide (traspaso),
 *    o `sin_ruta` + NULL cuando se le pide a Compras: Compras confirma la ruta (`[AB.NI.11]`). El
 *    CHECK de `origen_tipo` no cambia.
 *  · `sugerido` / `sugerido_base`: lo que el motor sugería de ese producto al capturarlo; 0 si no lo
 *    sugería. Siguen NOT NULL: es la foto de lo que la persona tenía enfrente.
 *
 * ── La huella ───────────────────────────────────────────────────────────────────────────────
 * Dos eventos nuevos: `capturar` (guardar un renglón a mano) y `quitar` (sacarlo del borrador). No
 * se reusa `ajustar`: el aprendizaje lee `ajustar` como «cuánto se desvió la persona del sugerido»,
 * y un renglón a mano no se desvía de nada.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-26) ───────────────────────────────────────
 *  · `autoabasto_pedido_lineas`: 3 renglones, los 3 `matriz`. `autoabasto_huella`: 105 (104 kB).
 *    Los dos CHECK recorren eso en milisegundos.
 *  · Un solo camino inserta en la tabla (`ajustar()`, `autoabasto-pedido.service.ts`). No manda
 *    `captura`, así que con el DEFAULT sigue escribiendo exactamente lo mismo (regla 14).
 *
 * ⚠️ Altera una tabla que el código lee: la compuerta del despliegue la cruza y frena hasta que
 *    esté aplicada. Va ANTES de soltar el código que escribe `captura`.
 *
 * Idempotente. Una columna con DEFAULT constante no reescribe la tabla (PG 11+; prod corre 18.6).
 *
 * @param { import("knex").Knex } knex
 */

const CAPTURAS = ['motor', 'mano'];
/** Los eventos de `[AB.18]`, tal cual. */
const EVENTOS_AB18 = ['abrir', 'ajustar', 'restablecer', 'aceptar_grupo', 'posiciones', 'enviar', 'recalcular'];
const EVENTOS = [...EVENTOS_AB18, 'capturar', 'quitar'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(',');

/** La definición de un CHECK de `commercial.<tabla>`, o `null` si no existe. */
const checkDe = async (knex, tabla, nombre) => {
  const r = await knex.raw(
    `SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c
      WHERE c.conrelid = ('commercial.' || ?)::regclass AND c.conname = ?`, [tabla, nombre]);
  return r.rows?.[0]?.d ?? null;
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('commercial').hasTable('autoabasto_pedido_lineas'))) {
    throw new Error('[AB.PM.1] falta commercial.autoabasto_pedido_lineas (migración 20261012215125)');
  }

  if (!(await knex.schema.withSchema('commercial').hasColumn('autoabasto_pedido_lineas', 'captura'))) {
    await knex.raw(`ALTER TABLE commercial.autoabasto_pedido_lineas ADD COLUMN captura varchar(8) NOT NULL DEFAULT 'motor'`);
  }
  if (!(await checkDe(knex, 'autoabasto_pedido_lineas', 'commercial_autoabasto_lineas_captura_chk'))) {
    await knex.raw(`ALTER TABLE commercial.autoabasto_pedido_lineas
      ADD CONSTRAINT commercial_autoabasto_lineas_captura_chk CHECK (captura IN (${lista(CAPTURAS)}))`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.autoabasto_pedido_lineas.captura IS
    '[AB.PM.1] Como nacio el renglon: motor = ajuste sobre lo que sugirio el motor; mano = pedido a mano con el buscador. Un producto vive una sola vez en el borrador (UNIQUE pedido+producto).'`);

  // La huella: el CHECK de `evento` se rehace sólo si todavía no admite los dos eventos nuevos.
  const ev = await checkDe(knex, 'autoabasto_huella', 'commercial_autoabasto_huella_evento_chk');
  if (!ev || !ev.includes("'capturar'") || !ev.includes("'quitar'")) {
    await knex.raw(`ALTER TABLE commercial.autoabasto_huella DROP CONSTRAINT IF EXISTS commercial_autoabasto_huella_evento_chk`);
    await knex.raw(`ALTER TABLE commercial.autoabasto_huella
      ADD CONSTRAINT commercial_autoabasto_huella_evento_chk CHECK (evento IN (${lista(EVENTOS)}))`);
  }

  const n = (await knex.raw(
    `SELECT count(*) FILTER (WHERE captura = 'motor')::int AS motor, count(*) FILTER (WHERE captura = 'mano')::int AS mano
       FROM commercial.autoabasto_pedido_lineas`)).rows[0];
  // eslint-disable-next-line no-console
  console.log(`[AB.PM.1] autoabasto_pedido_lineas.captura lista: ${n.motor} motor, ${n.mano} a mano; huella admite capturar/quitar`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. Si ya hay renglones a mano o huellas
 * de los eventos nuevos, NO se deshace: quitar la columna borraría cómo nacieron, y el CHECK viejo
 * no podría volver sin borrar huella — que es la decisión de una persona, no de un `down`.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hayColumna = await knex.schema.withSchema('commercial').hasColumn('autoabasto_pedido_lineas', 'captura');
  const mano = hayColumna
    ? (await knex.raw(`SELECT count(*)::int AS n FROM commercial.autoabasto_pedido_lineas WHERE captura = 'mano'`)).rows[0].n
    : 0;
  const huellas = (await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.autoabasto_huella WHERE evento IN ('capturar','quitar')`)).rows[0].n;
  if (mano || huellas) {
    throw new Error(`[AB.PM.1] no se deshace: hay ${mano} renglón(es) a mano y ${huellas} huella(s) capturar/quitar`);
  }
  await knex.raw(`ALTER TABLE commercial.autoabasto_huella DROP CONSTRAINT IF EXISTS commercial_autoabasto_huella_evento_chk`);
  await knex.raw(`ALTER TABLE commercial.autoabasto_huella
    ADD CONSTRAINT commercial_autoabasto_huella_evento_chk CHECK (evento IN (${lista(EVENTOS_AB18)}))`);
  await knex.raw(`ALTER TABLE commercial.autoabasto_pedido_lineas DROP CONSTRAINT IF EXISTS commercial_autoabasto_lineas_captura_chk`);
  if (hayColumna) await knex.raw(`ALTER TABLE commercial.autoabasto_pedido_lineas DROP COLUMN captura`);
};
