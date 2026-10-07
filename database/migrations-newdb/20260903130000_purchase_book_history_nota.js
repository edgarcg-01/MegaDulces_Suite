/**
 * LC.14 — `nota` en `finance.purchase_book_history`: por qué esta fila no es literal.
 *
 * Nace de un hallazgo del sembrado. En **abril de 2023** el workbook tiene el UUID corrido
 * un carácter en ~155 de sus 263 renglones: 7 quedaron con 37 caracteres (rotos a la vista)
 * y 148 con 36 — estructuralmente válidos, pero apuntando a un CFDI que no existe.
 *
 * Medido: de esos 148, **136 casan con un CFDI real quitando el último carácter**, y el
 * prefijo identifica a UNO solo. O sea el dato se puede recuperar de forma determinista y
 * verificable contra la fuente; no se está inventando nada.
 *
 * Pero una fila reparada NO es lo que dice el workbook, y eso tiene que verse. Sin esta
 * columna la reparación sería exactamente lo que GOTCHAS §32 prohíbe: materializar un valor
 * sin dejar rastro de su origen. Con ella, `nota` dice qué se hizo y `cfdi_uuid` guarda el
 * valor bueno.
 *
 * Lo que NO se repara —12 renglones cuyo prefijo no casa con nada— se queda fuera y se
 * declara en la cobertura, porque un hoyo invisible se lee igual que "no hay riesgo".
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('purchase_book_history'))) return;
  if (!(await knex.schema.withSchema('finance').hasColumn('purchase_book_history', 'nota'))) {
    await knex.raw(`ALTER TABLE finance.purchase_book_history ADD COLUMN nota text`);
    await knex.raw(`
      COMMENT ON COLUMN finance.purchase_book_history.nota IS
        'Por qué esta fila no es literal de su fuente. NULL = tal cual venía. Hoy sólo la usa la reparación de los UUID corridos de abr-2023.'`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('finance').hasColumn('purchase_book_history', 'nota')) {
    await knex.raw(`ALTER TABLE finance.purchase_book_history DROP COLUMN nota`);
  }
};
