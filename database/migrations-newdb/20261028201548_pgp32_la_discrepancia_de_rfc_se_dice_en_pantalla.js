'use strict';
/**
 * `[PGP.32]` — **La discrepancia de RFC deja de perderse: las dos pantallas la pueden decir.**
 *
 * ── Qué estaba mal, y lo causó `[PGP.31]` ───────────────────────────────────────────────────
 *
 * `[PGP.31]` (ADR-108) invirtió la prioridad: cuando Kepler y el comprobante timbrado se
 * contradicen sobre la identidad de un acreedor, **gana el CFDI**. La vista lo publica bien
 * —`rfc` el bueno, `rfc_discrepa` el de Kepler— pero **ninguna pantalla lee esa columna**, y
 * en el camino dejó MINTIENDO a dos rótulos que antes decían la verdad:
 *
 *  · `/finanzas/calendario-pagos`, al lado de «RFC deducido»:
 *    *«Kepler no tiene un RFC utilizable para este acreedor.»*
 *  · `/finanzas/cuentas-pago`, en el diálogo de alta de cuenta:
 *    *«Kepler no tiene un RFC utilizable para este proveedor.»*
 *
 * Con `[PGP.27]` eso era cierto: `fuente = 'nombre'` sólo ganaba cuando Kepler no tenía nada o
 * lo tenía mal escrito. ⛔ **Con `[PGP.31]` ya no**: `fuente = 'nombre'` también aparece cuando
 * Kepler SÍ tiene un RFC bien formado y nosotros elegimos el del CFDI. Para J&F ENTERPRISE la
 * pantalla afirmaría que Kepler no tiene RFC mientras Kepler tiene `NAGJ670512EX8` capturado.
 *
 * ⭐ Es exactamente la falla que ya cobró en esta misma fase —una etiqueta que sobrevive al
 * cambio de significado del dato que pinta— y por eso esta migración va junto con el arreglo
 * de los tres textos, no después.
 *
 * ── Lo medido contra prod antes de escribir esto (sid 7688376744939610156, 2026-10-28) ──────
 *
 *  · **18 acreedores · 160 filas** (la ficha `kdxd` está replicada ×9) están en disputa.
 *  · De los **56** que `/finanzas/cuentas-pago` lista hoy, **2** traen discrepancia.
 *  · **91 documentos por pagar** del Calendario pertenecen a un acreedor en disputa — ahí está
 *    el dinero, y ahí es donde el renglón ya avisa «RFC deducido» sin decir contra qué.
 *
 * ── El costo, medido en sólo lectura antes de escribir la compuerta ─────────────────────────
 *
 *   | vista                            | hoy (2ª pasada) | con las columnas nuevas |
 *   |----------------------------------|----------------:|------------------------:|
 *   | `v_supplier_account_proposal`    |          390 ms |              **359 ms** |
 *   | `v_payable_evidence`             |          680 ms |              **654 ms** |
 *
 * No cuesta nada, como tenía que ser: la columna ya viaja en la fila. ⚠️ Esos 680 ms son de un
 * `count(*)`; con el `FILTER` que obliga a producir la evidencia la misma vista cuesta **2.5 s**,
 * y **ésa es la cifra real de la pantalla** (por eso la pide diferida). La compuerta de abajo
 * mide con el `FILTER`, no con el `count(*)`: una sonda que el planificador puede saltear no
 * vigila nada.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *
 * Nada más que **dejar pasar columnas que ya existen un nivel más abajo**:
 *
 *  · `analytics.v_payable_evidence` gana `rfc_discrepa` al final.
 *  · `analytics.v_supplier_account_proposal` gana `rfc_discrepa` y `rfc_via` al final.
 *
 * ⛔ **No recalcula nada y no puede costar más**: las dos ya leen `analytics.v_supplier_rfc` y
 * la columna viaja en la misma fila. La compuerta de costo lo comprueba igual, comparando
 * contra lo que midió **antes** de reemplazar, no contra un número que escribí yo.
 *
 * ⛔ **No corrige a Kepler.** Sigue siendo captura, no derivación (ADR-108). Esto sólo hace que
 * la contradicción se vea donde alguien puede hacer algo con ella.
 *
 * ⛔⛔ **Depende de que `[PGP.31]` ya esté aplicada, y lo VERIFICA**, porque `rfc_discrepa`
 * significa lo contrario en cada versión: con `[PGP.27]` guarda el RFC del nombre (gana Kepler);
 * con `[PGP.31]` guarda el de Kepler (gana el CFDI). Aplicar esto sobre la vista vieja pondría
 * en pantalla la frase correcta con los dos valores **intercambiados**. La prueba es la propia
 * implicación lógica, no un acreedor escrito a mano:
 *
 *   | versión viva | `rfc_discrepa IS NOT NULL` implica |
 *   |--------------|------------------------------------|
 *   | `[PGP.27]`   | `fuente = 'kepler'`                |
 *   | `[PGP.31]`   | `fuente = 'nombre'`                |
 *
 * Prueba negativa de esa compuerta: contra la vista que corre en prod HOY devuelve 160 y lanza.
 *
 * Idempotente: sólo `CREATE OR REPLACE VIEW` y `COMMENT`. No toca ninguna fila, no crea índices.
 *
 * @param { import("knex").Knex } knex
 */

const pgp27 = require('./20261028085707_pgp27_rfc_del_acreedor_resuelto.js');
const pgp29 = require('./20261028093850_pgp29_cuenta_propuesta_desde_el_rep.js');

/**
 * ⛔⛔ **`pgp27.SQL.EVIDENCIA` y `pgp29.SQL.CUERPO` son `SELECT` PELADOS**: el
 * `CREATE OR REPLACE VIEW` vive en el `up()` de cada una. Ejecutarlos tal cual corre un
 * `SELECT`, **no reemplaza nada, y las compuertas pasan en verde** porque una vista intacta
 * devuelve los mismos números. Ya pasó en `[PGP.31]` y lo cazó la sonda contra prod, no yo.
 * Por eso acá el envoltorio es explícito y hay un control de que el reemplazo OCURRIÓ.
 */
function splice(base, ancla, reemplazo, quien) {
  const partes = base.split(ancla);
  if (partes.length !== 2) {
    throw new Error(
      '[PGP.32] el ancla de ' + quien + ' aparece ' + (partes.length - 1) + ' veces y tiene que ' +
        'aparecer 1: el texto de la migracion de origen cambio y este empalme ya no sabe donde ' +
        'pegar. Se corrige el ancla a mano contra el archivo de origen; no se adivina.',
    );
  }
  return partes.join(reemplazo);
}

/** `v_payable_evidence`: la columna entra al CTE `pay` y sale al final de la proyección. */
const A_PAY = "         r.rfc, r.rfc_crudo, coalesce(r.fuente, 'ninguna') AS rfc_fuente, r.motivo AS rfc_motivo";
const A_SEL = '       p.rfc,\n       p.rfc_fuente\n  FROM pay p';

/** `v_supplier_account_proposal`: las dos columnas salen al final, con el alias `r` que ya usa. */
const A_PROP = '            END::text AS motivo\n  FROM analytics.v_supplier_rfc r';

function evidencia() {
  let s = splice(pgp27.SQL.EVIDENCIA, A_PAY, A_PAY + ',\n         r.rfc_discrepa', 'pay (PGP.27)');
  s = splice(
    s,
    A_SEL,
    '       p.rfc,\n       p.rfc_fuente,\n       p.rfc_discrepa\n  FROM pay p',
    'la proyeccion (PGP.27)',
  );
  return s;
}

function propuesta() {
  return splice(
    pgp29.SQL.CUERPO,
    A_PROP,
    '            END::text AS motivo,\n       r.rfc_discrepa,\n       r.via AS rfc_via' +
      '\n  FROM analytics.v_supplier_rfc r',
    'la proyeccion (PGP.29)',
  );
}

exports.SQL = { evidencia, propuesta };

/** Cuánto puede empeorar el costo y seguir siendo creíble que no recalculé nada. */
const FACTOR = 1.5;
const MARGEN_MS = 500;

/**
 * ⛔ **No se mide con un `count(*)` pelado.** Medido contra prod: `count(*)` sobre
 * `v_payable_evidence` cuesta 680 ms y con el `FILTER` que obliga a producir la columna,
 * 2.5 s — o sea que el planificador se saltea el trabajo que la compuerta cree estar
 * vigilando. Cada vista se mide con un predicado suyo que fuerza la evaluación completa, y
 * que **existe en las dos versiones** para que el antes y el después sean comparables.
 */
const SONDA = {
  'analytics.v_payable_evidence':
    "SELECT count(*)::int AS n, count(*) FILTER (WHERE evidencia <> 'ninguna')::int AS util",
  'analytics.v_supplier_account_proposal':
    "SELECT count(*)::int AS n, count(*) FILTER (WHERE estado = 'propuesta')::int AS util",
};

async function medir(knex, vista) {
  const t0 = Date.now();
  const [r] = (await knex.raw(SONDA[vista] + ' FROM ' + vista)).rows;
  return { ms: Date.now() - t0, n: Number(r.n), util: Number(r.util) };
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── La dependencia, comprobada por su implicación lógica ──────────────────────────────────
  const [dep] = (await knex.raw(
    `SELECT count(*) FILTER (WHERE rfc_discrepa IS NOT NULL AND fuente = 'kepler')::int AS viejo,
            count(*) FILTER (WHERE rfc_discrepa IS NOT NULL AND fuente = 'nombre')::int AS nuevo
       FROM analytics.v_supplier_rfc`,
  )).rows;
  console.log(
    `[PGP.32] filas en disputa -- semantica PGP.27: ${dep.viejo} · semantica PGP.31: ${dep.nuevo}`,
  );
  if (Number(dep.viejo) > 0) {
    throw new Error(
      `[PGP.32] analytics.v_supplier_rfc todavia es la de [PGP.27]: ${dep.viejo} filas tienen ` +
        `rfc_discrepa con fuente='kepler'. En esa version rfc_discrepa guarda el RFC del NOMBRE, ` +
        `o sea lo contrario de lo que los rotulos van a decir, y la pantalla publicaria los dos ` +
        `valores intercambiados. Aplicar primero ` +
        `20261028172128_pgp31_el_cfdi_gana_sobre_el_rfc_de_kepler.js.`,
    );
  }
  if (Number(dep.nuevo) === 0) {
    throw new Error(
      `[PGP.32] cero filas en disputa: medido contra prod el 2026-10-28 eran 160 (18 acreedores). ` +
        `Cero puede ser que la vista perdio la columna o que la fuente del nombre dejo de resolver, ` +
        `y cero por defecto es indistinguible de cero porque ya no haya contradiccion. Se revierte ` +
        `y se mide antes de reintentar.`,
    );
  }

  const antesEv = await medir(knex, 'analytics.v_payable_evidence');
  const antesPr = await medir(knex, 'analytics.v_supplier_account_proposal');

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_payable_evidence AS ${evidencia()}`);
  await knex.raw(
    `COMMENT ON VIEW analytics.v_payable_evidence IS ` +
      `'[PGP.32] La mejor prueba documental de cada documento por pagar (ver [PGP.19] y [PGP.27]). ` +
      `rfc es el que se uso para buscarla, rfc_fuente de donde salio, y rfc_discrepa lo que Kepler ` +
      `tiene capturado cuando contradice al comprobante timbrado (ADR-108). Derivada: no materializa nada.'`,
  );

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_supplier_account_proposal AS ${propuesta()}`);
  await knex.raw(
    `COMMENT ON VIEW analytics.v_supplier_account_proposal IS ` +
      `'[PGP.32] La cuenta que el propio proveedor declaro en su REP timbrado (ver [PGP.29]). ` +
      `Suma rfc_discrepa (lo que Kepler dice cuando contradice al CFDI, ADR-108) y rfc_via (con que ` +
      `se resolvio el nombre). Solo PROPONE: el alta sigue pasando por una solicitud. Derivada.'`,
  );

  await knex.raw(`GRANT SELECT ON analytics.v_payable_evidence TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_payable_evidence TO dev_ro`);
  await knex.raw(`GRANT SELECT ON analytics.v_supplier_account_proposal TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_supplier_account_proposal TO dev_ro`);

  // ── El reemplazo OCURRIO: las columnas nuevas existen de verdad ────────────────────────────
  const { rows: cols } = await knex.raw(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'analytics'
        AND (table_name, column_name) IN
            (('v_payable_evidence','rfc_discrepa'),
             ('v_supplier_account_proposal','rfc_discrepa'),
             ('v_supplier_account_proposal','rfc_via'))`,
  );
  if (cols.length !== 3) {
    throw new Error(
      `[PGP.32] se esperaban 3 columnas nuevas y existen ${cols.length} ` +
        `(${cols.map((c) => `${c.table_name}.${c.column_name}`).join(', ') || 'ninguna'}): ` +
        `el CREATE OR REPLACE no reemplazo lo que creia. Se revierte.`,
    );
  }

  const despEv = await medir(knex, 'analytics.v_payable_evidence');
  const despPr = await medir(knex, 'analytics.v_supplier_account_proposal');

  // La columna nueva TRAE algo: existir y venir siempre en NULL son indistinguibles en el
  // catalogo, y una columna vacia pintaria "Kepler no dice nada" para los 18 que si dicen.
  const [{ ev, pr }] = (await knex.raw(
    `SELECT (SELECT count(rfc_discrepa) FROM analytics.v_payable_evidence)::int AS ev,
            (SELECT count(rfc_discrepa) FROM analytics.v_supplier_account_proposal)::int AS pr`,
  )).rows;
  console.log(
    `[PGP.32] v_payable_evidence ${antesEv.n} filas (${antesEv.util} con evidencia) / ${antesEv.ms} ms -> ` +
      `${despEv.n} (${despEv.util}) / ${despEv.ms} ms · ${ev} documentos con RFC en disputa · ` +
      `v_supplier_account_proposal ${antesPr.n} (${antesPr.util} proponibles) / ${antesPr.ms} ms -> ` +
      `${despPr.n} (${despPr.util}) / ${despPr.ms} ms · ${pr} filas con RFC en disputa`,
  );
  if (Number(ev) === 0 && Number(pr) === 0) {
    throw new Error(
      `[PGP.32] las dos columnas nuevas vienen enteras en NULL. Medido contra prod el 2026-10-28, ` +
        `v_supplier_account_proposal traia 160 filas con rfc_discrepa (18 acreedores) y ` +
        `v_payable_evidence 91 documentos. Una columna que existe y nunca trae nada es ` +
        `indistinguible de no haberla agregado, y la pantalla diria que nadie se contradice. Se revierte.`,
    );
  }

  const vistas = [
    ['analytics.v_payable_evidence', antesEv, despEv],
    ['analytics.v_supplier_account_proposal', antesPr, despPr],
  ];
  for (const [vista, a, d] of vistas) {
    if (d.n < a.n) {
      throw new Error(
        `[PGP.32] ${vista} perdio filas: ${a.n} -> ${d.n}. Dejar pasar una columna no puede quitar ` +
          `renglones; si los quita, el empalme pego donde no era. Se revierte.`,
      );
    }
    const tope = Math.round(a.ms * FACTOR + MARGEN_MS);
    if (d.ms > tope) {
      throw new Error(
        `[PGP.32] ${vista} paso de ${a.ms} ms a ${d.ms} ms (tope ${tope} ms = ${FACTOR}x + ${MARGEN_MS} ms). ` +
          `Una columna que ya viaja en la misma fila no puede costar eso: el empalme cambio el plan. ` +
          `Se revierte.`,
      );
    }
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: las dos vistas vuelven a su cuerpo de origen. */
exports.down = async function down(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_payable_evidence AS ${pgp27.SQL.EVIDENCIA}`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_supplier_account_proposal AS ${pgp29.SQL.CUERPO}`);
};
