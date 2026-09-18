'use strict';
/**
 * `[CDRP.1]` — **«MI TRABAJO SE LLAMA…»**: la frase que traduce el puesto a un resultado.
 *
 * ── Qué es ──────────────────────────────────────────────────────────────────────────────────
 * §1.1 del documento CDRP pide que la portada abra con *«una frase de una línea que traduzca la
 * descripción del puesto a un resultado empresarial»*. Es lo ÚNICO del encabezado de la
 * especificación que hoy no tiene dónde vivir: `identity.positions` tiene `name`, `nivel`,
 * `department_code`, `reports_to_position_code` y `org_labels`, y ninguna columna dice para qué
 * existe el puesto.
 *
 * ── Por qué una columna y no una constante en el front ──────────────────────────────────────
 * Es **dato de catálogo organizacional**, igual que el nombre del puesto: lo edita RH desde
 * `/admin/puestos`, no un dev desde un `.ts`. La regla de Edgar (2026-08-27) es explícita — el
 * dato operativo se administra desde la UI; el script sólo sirve para el backfill inicial. Una
 * constante en el frontend envejece y nadie la corrige (§13 del documento ya diagnostica eso mismo
 * con las descripciones de las tarjetas).
 *
 * ── ⚠️ Es texto DECLARADO, no derivado ──────────────────────────────────────────────────────
 * Estas 9 frases las escribió Dirección en el documento. No se calculan ni se validan contra nada:
 * son la definición del puesto. Lo que SÍ vale la pena decir es que **el puesto se muestra, no
 * gatea** (decisión `[SN]` §3.4): esta frase es contexto, y ninguna puerta depende de ella.
 *
 * ⛔ Los puestos que el documento NO cubre quedan en `NULL`, y `NULL` se muestra como ausencia, no
 * como cadena vacía ni como el nombre del puesto repetido. Hoy son 11 de los 20 puestos de mando.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [código del puesto, sección del documento, la frase tal como la escribió Dirección]. */
const PROPOSITOS = [
  [
    'direccion',
    '§2',
    'Asegurar la operación y la rentabilidad de Mega Dulces, desarrollar al equipo directivo y ' +
      'construir relaciones sostenibles con clientes y proveedores, convirtiendo la estrategia de ' +
      'largo plazo en resultados medibles.',
  ],
  [
    'direccion_comercial',
    '§3',
    'Convertir la estrategia comercial en crecimiento rentable, asignando objetivos, recursos y ' +
      'prioridades a zonas, canales y categorías, y asegurando su ejecución.',
  ],
  [
    'jefe_finanzas',
    '§4',
    'Garantizar liquidez, rentabilidad, disciplina presupuestal e información financiera confiable ' +
      'para que Mega Dulces pueda operar y decidir sin comprometer su capital de trabajo.',
  ],
  [
    'gerente_compras',
    '§5',
    'Mantener el inventario correcto, en el lugar correcto y al menor costo total posible, ' +
      'negociando cada compra para sostener abasto, rotación y rentabilidad.',
  ],
  [
    'jefe_marketing',
    '§6',
    'Convertir la inversión de proveedores y de Mega Dulces en demanda medible, ejecución comercial ' +
      'y crecimiento rentable de marcas, categorías y clientes.',
  ],
  [
    'jefe_zona',
    '§7',
    'Gerenciar integralmente la zona para cumplir ventas y rentabilidad, controlar gastos y ' +
      'operación, desarrollar los canales comerciales y asegurar una experiencia consistente al cliente.',
  ],
  [
    'jefatura_capital_humano',
    '§8',
    'Asegurar que Mega Dulces tenga la gente correcta, en los puestos correctos, desarrollando ' +
      'capacidades, liderazgo, cultura y sucesión para sostener el crecimiento del negocio.',
  ],
  [
    'prevencion',
    '§9',
    'Proteger los activos de Mega Dulces asegurando que la operación física coincida con el sistema, ' +
      'investigando diferencias hasta su causa y evitando que los errores o pérdidas se repitan.',
  ],
  [
    'sistemas',
    '§10',
    'Transformar necesidades del negocio en software confiable y medible, priorizando el desarrollo ' +
      'por impacto empresarial, cercanía al ingreso/cliente y esfuerzo requerido.',
  ],
];

exports.up = async function up(knex) {
  const hay = await knex.schema.withSchema('identity').hasColumn('positions', 'proposito');
  if (!hay) {
    await knex.schema.withSchema('identity').alterTable('positions', (t) => {
      t.text('proposito').nullable();
    });
    console.log('  [CDRP.1] identity.positions +proposito');
  } else {
    console.log('  [CDRP.1] identity.positions.proposito ya existe');
  }

  /*
   * El COMMENT va FUERA del `if`, y a proposito: la primera corrida de esta migracion agrego la
   * columna y despues murio en esta sentencia (llevaba `||`, que COMMENT ON no acepta -- concatena
   * pegando literales, sin operador). Al reintentar, `hasColumn` daba true y el comentario no se
   * escribia NUNCA. Una sentencia de documentacion dentro de un `if` de existencia se pierde en
   * silencio en cuanto el primer intento falla a la mitad.
   */
  await knex.raw(`
    COMMENT ON COLUMN identity.positions.proposito IS
    '[CDRP.1] Para que existe el puesto, en una linea, en terminos de resultado de negocio. '
    'Es la frase que abre la portada de esa persona (CDRP 1.1). Texto DECLARADO por Direccion, '
    'no derivado: no se calcula ni se valida contra nada. NULL = el puesto todavia no la tiene, '
    'y se muestra como ausencia, nunca repitiendo el nombre del puesto.'
  `);

  let n = 0;
  for (const [code, seccion, frase] of PROPOSITOS) {
    /*
     * ⛔ Sólo se escribe donde está en NULL. Si alguien ya la editó desde `/admin/puestos`, su
     * versión gana: un backfill que pisa lo que un humano corrigió convierte la UI en decorado.
     */
    const filas = await knex('identity.positions')
      .where({ code: code })
      .whereNull('deleted_at')
      .whereNull('proposito')
      .update({ proposito: frase });
    if (filas > 0) {
      n += filas;
      console.log(`  [CDRP.1] ${code} ← ${seccion}`);
    } else {
      const existe = await knex('identity.positions').where({ code: code }).whereNull('deleted_at').first();
      console.log(
        existe
          ? `  [CDRP.1] ${code} ya tenía frase — sin cambios`
          : `  [CDRP.1] ⚠️ el puesto "${code}" no existe — ${seccion} sin sembrar`,
      );
    }
  }

  const sin = await knex('identity.positions')
    .whereNull('deleted_at')
    .whereNull('proposito')
    .whereIn('nivel', ['direccion', 'gerencia', 'jefatura', 'coordinacion'])
    .count({ n: '*' })
    .first();
  console.log(
    `  [CDRP.1] ${n} puesto(s) sembrado(s); ${(sin && sin.n) || 0} puesto(s) de mando siguen SIN frase ` +
      '(el documento cubre 9 de los 9 que nombra; el resto es de fases posteriores)',
  );
};

exports.down = async function down(knex) {
  // La columna NO se borra: borrar columnas exige confirmación explícita (regla dura del proyecto).
  // Revertir es dejar en NULL sólo lo que esta migración escribió.
  for (const [code, , frase] of PROPOSITOS) {
    await knex('identity.positions').where({ code: code, proposito: frase }).update({ proposito: null });
  }
};
