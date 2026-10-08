'use strict';
/**
 * `[RD.23]` — **La linea de comision congela CUANTOS DIAS la alimentaron.**
 *
 * ── Por que ─────────────────────────────────────────────────────────────────────────────────
 * Medido el 2026-10-08 contra `INDICADORES RD 2026.xlsx`, que trae Q1-Q20 ya calculadas a mano:
 * sobre **125 ruta-periodo** (Q10-Q20, solo rutas que comisionan), el motor reproduce lo pagado
 * en **108 con desviacion mediana de 0.11%**. La regla esta bien -- se valido reproduciendo el
 * libro al centavo:
 *
 *     ruta 504, Q20:  179,189.91 x 4.25% x 80% = 6,092.46   (el libro dice 6,092.46)
 *
 * De las **17** que difieren mas de 5%, **14 es que le faltan DIAS a la fuente**. Y el error no
 * es proporcional: el tramo mas bajo arranca en **$189,999.99 de venta**, asi que perder dias no
 * baja el pago, lo tira al piso. La ruta 504 en Q20 tiene **5 de 12 dias** (su carril dejo de
 * subir el 1-oct), cae en `bajo_umbral` y se le pagaria **$0 en vez de $1,092.46**.
 *
 * ⭐ El motivo `bajo_umbral` es cierto sobre el mecanismo y **enganoso sobre la causa**: dice
 * "vendio poco" y la ruta vendio normal, lo que le faltan son siete dias. Estas dos columnas son
 * lo que vuelve ese motivo interpretable sin volver a abrir el Excel.
 *
 * ── Por que CONGELADAS en la linea y no derivadas al mirar ───────────────────────────────────
 * Es el mismo criterio de `beneficiario_nombre` y `zona` (RD.21): una corrida es el registro de
 * lo que se pago, y la cobertura es parte de POR QUE se pago eso. Derivarla despues la contaria
 * contra la fuente de hoy, que para entonces ya se reparo -- y un recibo de hace seis meses
 * diria que todo estaba completo.
 *
 * ── Lo que NO hace ──────────────────────────────────────────────────────────────────────────
 * ⛔ No corrige ni suprime nada. `dias_esperados` es la **mediana de las rutas hermanas de su
 * plaza en ese mismo periodo**, no un calendario inventado: los domingos y los puentes se caen
 * solos porque le pasan a todas. Y la compuerta que la lee **avisa, no bloquea**, porque medido
 * sobre Q10-Q20 marca 14 reales contra **8 falsas** (rutas que cuadran al 0.0% contra el libro
 * porque el camion de verdad no salio).
 *
 * Idempotente (`hasColumn`). Aditiva: nullable, sin default, sin backfill -- las corridas que ya
 * existan quedan en NULL, que es lo correcto: nadie midio su cobertura, y dibujar un numero
 * seria inventarlo.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commission_run_lines';

exports.up = async function up(knex) {
  const tiene = async (col) => knex.schema.withSchema('commercial').hasColumn(TABLA, col);

  if (!(await tiene('dias_con_venta'))) {
    await knex.schema.withSchema('commercial').alterTable(TABLA, (t) => {
      t.integer('dias_con_venta').nullable();
    });
  }
  if (!(await tiene('dias_esperados'))) {
    await knex.schema.withSchema('commercial').alterTable(TABLA, (t) => {
      t.integer('dias_esperados').nullable();
    });
  }

  await knex.raw(`
    COMMENT ON COLUMN commercial.${TABLA}.dias_con_venta IS
      'RD.23 - dias con venta de ESTA ruta en el periodo, congelados al calcular. NULL = la ruta no tuvo fuente (ver motivo_no_pago), no cero.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.${TABLA}.dias_esperados IS
      'RD.23 - mediana de dias de las rutas que comisionan en su MISMA plaza y ese MISMO periodo. No es un calendario: es lo que trabajaron sus hermanas. dias_con_venta < dias_esperados dispara la compuerta cobertura_dias, que AVISA (medido Q10-Q20: 14 reales contra 8 falsas).'`);

  const { rows: [chk] } = await knex.raw(`
    SELECT count(*) FILTER (WHERE column_name = 'dias_con_venta')::int a,
           count(*) FILTER (WHERE column_name = 'dias_esperados')::int b
      FROM information_schema.columns
     WHERE table_schema = 'commercial' AND table_name = ?`, [TABLA]);
  if (chk.a !== 1 || chk.b !== 1) {
    throw new Error(`las columnas no quedaron: dias_con_venta=${chk.a} dias_esperados=${chk.b}`);
  }
  console.log(`[rd_commission_dias] commercial.${TABLA}: dias_con_venta y dias_esperados listas`);
};

exports.down = async function down(knex) {
  const tiene = async (col) => knex.schema.withSchema('commercial').hasColumn(TABLA, col);
  if (await tiene('dias_esperados')) {
    await knex.schema.withSchema('commercial').alterTable(TABLA, (t) => t.dropColumn('dias_esperados'));
  }
  if (await tiene('dias_con_venta')) {
    await knex.schema.withSchema('commercial').alterTable(TABLA, (t) => t.dropColumn('dias_con_venta'));
  }
};
