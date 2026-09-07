/**
 * U.7 — el COMMENT de las vistas apuntaba al ADR equivocado.
 *
 * Las migraciones de esta fase se escribieron creyendo que el siguiente ADR libre era el 056, pero
 * ése ya lo tomó la Fase VP (verdad y procedencia, aceptado 2026-09-05). El de unidades es el
 * **057**. Los archivos ya se renumeraron; esto corrige el comentario que quedó grabado en prod,
 * porque un puntero a documentación equivocada es peor que ninguno: manda a leer otra decisión.
 *
 * Es el mismo tipo de defecto que esta fase vino a arreglar, en miniatura — un dato que afirma
 * algo con confianza y apunta a otra parte. Y ADR-052 ya está triple-ocupado en este repo por
 * exactamente esta razón.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`COMMENT ON VIEW analytics.v_unit_truth IS
    'U.4/U.7 (ADR-057) - El resolvedor de unidad con veredicto Y metodo, grano (tenant, almacen, producto). box_factor es el divisor NATIVO de ese almacen (ADR-055); base_per_box son unidades BASE por caja. El veredicto contrasta base_per_box contra DOS testigos independientes: lo PAGADO al proveedor (v_supplier_cost_ladder.units_per_box, derivado de kepler_ods.kdpv_prov_prod) y la escalera del ERP (kdii.c84); la etiquetera coincide con lo pagado en 5,569 de 5,578 SKUs (99.84%, razon mediana 1.00) - o sea SI tiene testigo, contra lo que afirmaba la doc. La fuente PEOR es el override manual: 62 de 277 contradicen ($6.17M). metodo_cajas ORDENA los testigos en vez de elegir uno: dinero (revenue/cja_price, inmune a la unidad del numerador, 87.8% de la venta) > peso (granel: ya viene en kilos) > divisor (solo con el factor verificado; donde medible=true coincide con el dinero, razon mediana 0.997 sobre $547M) > unidad_es_caja (no hay paquete ni caja en la escalera y ningun testigo dice que la haya: cajas = unidades, verificado contra el precio realizado en 240 de 278 SKUs) > sin_metodo (se declara NULL, NO se dibuja). REGLA DURA: leer metodo_cajas y medible antes de convertir; con sin_metodo el numero va NULL con motivo, NUNCA 0. Lo que esta vista no cubre se enumera en analytics.v_unit_truth_coverage. Ver ADR-057 y docs/UNIDADES_DE_MEDIDA.md seccion 8sexies.'`);

  await knex.raw(`COMMENT ON VIEW analytics.v_unit_truth_coverage IS
    'U.6b (ADR-057) - Declara que almacenes cubre analytics.v_unit_truth y cuales NO, con el motivo. Existe porque una fila AUSENTE se lee peor que una fila mala: en un LEFT JOIN llega NULL y un COALESCE(medible, true) la cuenta como medible (el candado de U.4 reportaba 98.2% de cobertura por eso, agrupando solo por producto y sin ver el eje almacen). motivo responde UNA pregunta -- que resuelve el divisor -- con la cobertura primero; el cambio de ERP viaja aparte en cambio_de_erp, porque mezclarlos marcaba 5 sucursales Kepler cubiertas ($300.6M) como ERP mixto. motivo = erp_mixto_por_fecha son las 6 rutas de La Piedad: Wincaja hasta 2026-06-26 y Kepler desde 2026-06-29, sin solape, asi que ninguna columna estatica puede darles un divisor. Se detecta por dato, no por lista escrita a mano.'`);
};

exports.down = async function down() {
  // No-op: revertir seria volver a apuntar al ADR equivocado.
};
