'use strict';
/**
 * [PR.M5.1] -- H4 repetia la afirmacion que [PR.M5] vino a corregir.
 *
 * La migracion anterior corrigio el motivo de H3 buscando el texto "el numerador viene INFLADO".
 * H4 no lo decia asi: decia "Hereda las dos advertencias de H3: numerador inflado por traspasos,
 * y el share depende del universo que se elija". O sea que la frase incorrecta seguia publicada,
 * con otras palabras, en la senal de al lado -- y el UPDATE reporto "1 senal corregida" cuando
 * habia que corregir dos.
 *
 * ⚠️ Un reemplazo por texto literal corrige lo que encuentra y calla lo que no. Por eso esta
 *    migracion no busca una frase: AFIRMA el resultado y falla si no se cumple.
 */

const R = 'analytics.price_signal_registry';

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '5s'");

  const hay = (await knex.raw(`SELECT to_regclass('${R}') IS NOT NULL AS hay`)).rows[0].hay;
  if (!hay) {
    // eslint-disable-next-line no-console
    console.log('[PR.M5.1] no existe el registro de senales en esta base: nada que corregir.');
    return;
  }

  await knex.raw(`
    UPDATE ${R} SET motivo_ausencia = replace(motivo_ausencia,
      'Hereda las dos advertencias de H3: numerador inflado por traspasos, y el share depende del universo que se elija.',
      'Hereda las dos advertencias de H3, ya corregidas: (1) el numerador tiene un residuo MEDIDO de ~10% sin explicar -- lo que se publicaba antes, que venia inflado por traspasos con una brecha de $19.5M a $21.6M por mes, lo refuto la medicion por sucursal: la brecha grande era cobertura de nuestro propio fact (analytics.sales_daily arranca 2025-01 para 01/02/06, 2026-01 para 03/04/05 y 2026-09 para 07 y 08), no inflacion; y (2) el share depende del universo que se elija.'),
      updated_at = now()
    WHERE clave = 'H4'`);

  // ⭐ Se comprueba el RESULTADO, no el reemplazo: ninguna senal puede seguir afirmando que el
  //   numerador viene inflado por traspasos sin decir que esa causa quedo refutada.
  const { rows } = await knex.raw(`
    SELECT clave FROM ${R}
    WHERE motivo_ausencia ILIKE '%inflado por traspasos%'
      AND motivo_ausencia NOT ILIKE '%refut%'`);
  if (rows.length) {
    throw new Error('[PR.M5.1] siguen publicando la causa refutada: ' + rows.map((r) => r.clave).join(', '));
  }

  // eslint-disable-next-line no-console
  console.log('[PR.M5.1] H4 corregida · ninguna senal sigue atribuyendo la brecha a los traspasos.');
};

exports.down = async function down() {
  // No se revierte un texto que quedo demostrado falso.
};
