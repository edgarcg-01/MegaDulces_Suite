'use strict';
/**
 * `[RD.21]` — **La pantalla deja de calcular: abre, lee una tabla y verifica.**
 *
 * ── La medicion que define el diseño ────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-07, con el liston en 500 ms:
 *
 *     tablero del año (27 quincenas + su corrida) .....     2.2 ms   OK
 *     universo de rutas (vista derivada) ..............     3.3 ms   OK
 *     venta de UNA quincena (lo que hacia el boton) ... 6,491.0 ms   LENTO
 *
 * ⭐ **El unico camino lento del modulo eran los botones.** `Vista previa` y `Crear corrida`
 * tocan `v_rd_route_daily`, que se materializa entera en cada consulta; leer una corrida ya
 * persistida es leer una tabla de 26 filas. Quitar las acciones de la pantalla no es una
 * concesion: es lo que la vuelve rapida, y de paso la vuelve honesta — lo que se ve es lo que
 * el motor realmente calculo, no un numero que aparecio porque alguien apreto algo.
 *
 * Quien calcula es el cron (`CommissionRunnerService`). La pantalla **no tiene camino lento**.
 *
 * ── ⛔ El hueco que habia que cerrar para que eso fuera posible ──────────────────────────────
 * `commission_run_lines` **no guardaba el nombre de la persona**. El payload del servicio lo
 * cargaba desde la config y `persist()` nunca lo escribia (medido: la tabla tiene `route_code`
 * y `beneficiario`, y ninguna columna de nombre).
 *
 * Con botones eso se disimulaba, porque la vista previa traia el nombre en el mismo viaje. Sin
 * botones la pantalla lee SOLO la tabla, asi que tendria que ir a buscarlo a
 * `commission_route_config` — que **cambia**. Y entonces un recibo de hace seis meses mostraria
 * a quien maneja la ruta HOY, no a quien se le pago. Para un artefacto de nomina eso no es un
 * detalle: es el renglon que alguien firma.
 *
 * ⭐ El nombre se **congela en la linea**, igual que ya se congelan el subtotal, el porcentaje
 * aplicado y la deduccion. Una corrida se tiene que poder volver a explicar sin preguntarle nada
 * al presente.
 *
 * ── Estado nuevo `en_curso` ─────────────────────────────────────────────────────────────────
 * Para que la pantalla este **actualizada** el cron tambien calcula la quincena que todavia
 * corre. Esa corrida no se puede aprobar — pero llamarla `bloqueada` seria mentir: no le falla
 * ninguna compuerta, le falta terminar. Son dos cosas distintas y se arreglan distinto, asi que
 * llevan nombres distintos (ADR-056):
 *
 *     en_curso   -- el periodo no cerro. Se refresca solo. No se aprueba.
 *     bloqueada  -- cerro y una compuerta dura no paso. Hay algo que arreglar.
 *
 * ⚠️ `traslape_subtotal` queda **retirada, no borrada**: la premisa que la justificaba se midio
 * y quedo refutada (ver `20261007200000`). Se comenta en vez de eliminarse porque borrar una
 * columna pide confirmacion, y una columna en NULL no le miente a nadie mientras diga por que.
 *
 * @param { import("knex").Knex } knex
 */

const LINES = 'commercial.commission_run_lines';
const RUNS = 'commercial.commission_runs';

exports.up = async function up(knex) {
  const hasCol = (t, c) => knex.schema.withSchema('commercial').hasColumn(t.split('.')[1], c);

  // ── 1. El nombre, congelado en la linea ────────────────────────────────────────────────────
  if (!(await hasCol(LINES, 'beneficiario_nombre'))) {
    await knex.raw(`ALTER TABLE ${LINES} ADD COLUMN beneficiario_nombre varchar(160)`);
  }
  if (!(await hasCol(LINES, 'zona'))) {
    await knex.raw(`ALTER TABLE ${LINES} ADD COLUMN zona varchar(80)`);
  }
  if (!(await hasCol(LINES, 'dias_multifuente'))) {
    await knex.raw(`ALTER TABLE ${LINES} ADD COLUMN dias_multifuente integer`);
  }

  await knex.raw(`COMMENT ON COLUMN ${LINES}.beneficiario_nombre IS
    'RD.21 - a QUIEN se le paga esta linea, congelado. La tabla no lo guardaba: el servicio lo cargaba de commission_route_config y persist() no lo escribia. Con la pantalla leyendo solo esta tabla, buscarlo en la config haria que un recibo viejo mostrara a quien maneja la ruta HOY. Se congela como el subtotal y el porcentaje: una corrida se explica sin preguntarle nada al presente.'`);
  await knex.raw(`COMMENT ON COLUMN ${LINES}.zona IS
    'RD.21 - la plaza de la ruta al momento de la corrida (La Piedad y Padre Hidalgo / Zamora / Morelia). Congelada por la misma razon que el nombre; la usa el agrupado de la pantalla.'`);
  await knex.raw(`COMMENT ON COLUMN ${LINES}.dias_multifuente IS
    'RD.21 - cuantos dias del periodo trajeron mas de una captura de la venta. Es un CORTE DE SISTEMA, no un duplicado (medido: cero folios compartidos en 200 dias). Se publica para reconocer una quincena que cruza un cambio de sistema, no para restarle nada.'`);
  await knex.raw(`COMMENT ON COLUMN ${LINES}.traslape_subtotal IS
    'RD.21 - RETIRADA, siempre NULL. Nacio para medir un doble conteo de la venta que se midio el 2026-10-07 y NO EXISTE (3 dias con dos capturas en 120, cero folios compartidos en 200; son el corte de sistema). No se borra porque borrar una columna pide confirmacion; una columna en NULL no le miente a nadie mientras diga por que. Lo que si se publica es dias_multifuente.'`);

  // ── 2. `en_curso`: el periodo que todavia corre no esta "bloqueado" ────────────────────────
  await knex.raw(`ALTER TABLE ${RUNS} DROP CONSTRAINT IF EXISTS commission_runs_status_valid`);
  await knex.raw(`
    ALTER TABLE ${RUNS} ADD CONSTRAINT commission_runs_status_valid
      CHECK (status IN ('en_curso','borrador','bloqueada','aprobado','pagado','anulado'))`);
  await knex.raw(`COMMENT ON COLUMN ${RUNS}.status IS
    'RD.21 - en_curso (el periodo no cerro: se refresca solo, no se aprueba) | borrador (cerro y las compuertas pasaron) | bloqueada (cerro y una compuerta dura no paso: hay algo que arreglar) | aprobado | pagado | anulado. en_curso y bloqueada se separan a proposito: la primera le falta terminar, la segunda le falla algo, y se arreglan distinto.'`);

  // ── 3. El camino de la pantalla, cubierto por indice ───────────────────────────────────────
  // Medido: el tablero del año sale en 2.2 ms y el detalle lee por (tenant_id, run_id), que ya
  // tiene su indice de RD.6. Este es el unico que faltaba: la pantalla pide la corrida VIVA de
  // cada periodo, y sin el parcial el planner filtra despues de leer las anuladas.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_commission_runs_viva
      ON ${RUNS} (tenant_id, period_id)
      INCLUDE (status, total_neto, total_a_pagar, data_as_of)
      WHERE deleted_at IS NULL AND status <> 'anulado'`);
};

exports.down = async function down(knex) {
  const hasCol = (t, c) => knex.schema.withSchema('commercial').hasColumn(t.split('.')[1], c);
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_commission_runs_viva`);
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int n FROM ${RUNS} WHERE status = 'en_curso'`);
  if (n.n > 0) throw new Error(`hay ${n.n} corrida(s) en estado en_curso: resolverlas antes del down`);
  await knex.raw(`ALTER TABLE ${RUNS} DROP CONSTRAINT IF EXISTS commission_runs_status_valid`);
  await knex.raw(`
    ALTER TABLE ${RUNS} ADD CONSTRAINT commission_runs_status_valid
      CHECK (status IN ('borrador','bloqueada','aprobado','pagado','anulado'))`);
  for (const c of ['beneficiario_nombre', 'zona', 'dias_multifuente']) {
    if (await hasCol(LINES, c)) await knex.raw(`ALTER TABLE ${LINES} DROP COLUMN ${c}`);
  }
};
