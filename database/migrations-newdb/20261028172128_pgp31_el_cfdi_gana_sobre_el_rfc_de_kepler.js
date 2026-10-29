/**
 * [PGP.31] **Cuando Kepler y el CFDI se contradicen, gana el CFDI.**
 *
 * Decisión de Edgar, 2026-10-28: *«siempre prioridad el CFDI»*.
 *
 * ## Qué estaba mal
 *
 * `[PGP.27]` eligió el RFC así: *si el valor de Kepler tiene forma de RFC del SAT, gana Kepler*.
 * Esa política tiene un agujero que se midió contra prod el 2026-10-28: **la forma no prueba la
 * identidad**. Dos casos verificados contra `fiscal.cfdis`, que es el testigo independiente —
 * los comprobantes que el proveedor timbró ante el SAT y nosotros recibimos:
 *
 * | Acreedor | Kepler decía | El SAT dice | CFDI recibidos |
 * |---|---|---|---|
 * | CJ002 J&F ENTERPRISE SA DE CV | NAGJ670512EX8 | **JEN120831K17** | 368 |
 * | CM009 MONDELEZ MEXICO S de RL de CV | PENC620207982 | **KFM920615PS8** | 3,490 |
 *
 * ⭐ Los dos RFC de Kepler empiezan con **cuatro letras**, que en el SAT es **persona física**,
 * sobre una **sociedad mercantil**. Pasaban el patrón y por eso ganaban. Son **18 acreedores**,
 * **142 pagos**, **$48,605,288.35**.
 *
 * La vista ya los detectaba y los publicaba en `rfc_discrepa` — pero **nadie lee esa columna**, así
 * que el acierto se perdía y el error manejaba la evidencia. Un hallazgo que no cambia ninguna
 * decisión es un hallazgo que no existe.
 *
 * ## Qué cambia, exactamente
 *
 * Se **invierte la prioridad**: cuando el nombre normalizado resuelve a un RFC en los sistemas
 * fiscales, **ése gana**; el de Kepler pasa a `rfc_discrepa` para que la pantalla pueda decir
 * «Kepler dice X, sus comprobantes dicen Y». Nada más cambia: mismas columnas, mismo contrato.
 *
 * ⛔ **Y nada pierde evidencia.** `rfc_crudo` sigue llevando el valor literal de Kepler, y
 * `v_payable_evidence` lo usa como **segunda llave** (`x.rfc = p.rfc OR x.rfc = p.rfc_crudo`).
 * Ese mecanismo se construyó en `[PGP.27]` justo para que invertir la prioridad no rompiera el
 * emparejado del papel que Compras teclea desde la misma ficha equivocada de Kepler.
 *
 * ## Lo que este cambio NO arregla, medido antes de hacerlo
 *
 * ⛔ **No destraba la cuenta destino de los acreedores grandes.** Con el RFC bueno, los REP
 * hallables pasan de **13 a 81**, pero sólo **8 declaran cuenta** y **6 traen una CLABE de 18**,
 * de **un solo acreedor**. Mondelez, Hershey y Bimbo seguirán sin cuenta propuesta **porque sus
 * REP no la declaran**, no por el RFC. Queda escrito para que nadie espere eso de acá.
 *
 * Lo que sí toca: **101 documentos por pagar ($4,535,609)** cuyo RFC publicado hoy es falso, de
 * los cuales **38 ($445,543) no tienen evidencia** y pasan a poder alcanzarla — hay **6,290
 * facturas** recibidas bajo el RFC correcto que la señal de RFC hoy no ve.
 *
 * ⭐ Pero la razón para hacerlo **no es la cobertura: es que el número no mienta** (ADR-059).
 * Aunque recuperara cero documentos, publicar en pantalla un RFC que no es el del acreedor
 * seguiría estando mal.
 */

const pgp27 = require('./20261028085707_pgp27_rfc_del_acreedor_resuelto.js');

/** Igual que en PGP.27: la forma del SAT. Sigue usándose, pero ya no para DECIDIR quién gana. */
const FORMA = `'^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'`;

/**
 * ⛔⛔ **ESTA MIGRACIÓN SE AUTORREVIRTIÓ EN PROD EL 2026-10-28 POR UNA GUARDA MAL ESCRITA, Y
 * LA GUARDA ERA MÍA.** Lo que sigue es la corrección, con lo que midió producción.
 *
 * La versión anterior copiaba el `TOPE_MS = 1000` de `[PGP.27]` y se lo aplicaba a la sonda…
 * que **no mide lo mismo**. En `[PGP.27]` ese tope guardaba `analytics.v_supplier_rfc`, que
 * cuesta ~200 ms; acá la sonda cuenta `analytics.v_payable_evidence`, cuyo **piso documentado
 * en el propio encabezado de `[PGP.27]` es 2.0 s**. O sea: un tope **imposible de cumplir por
 * construcción**, que habría disparado con cero cambios. Disparó con 3,109 ms, la transacción
 * se revirtió entera (limpio: `knex_migrations` no registró nada) y dejó el despliegue frenado
 * con 19 commits de 9 sesiones detrás.
 *
 * ⭐ Lo que lo deja claro, medido contra prod en sólo lectura (sid 7688376744939610156):
 *
 *   | qué se midió                                   | universo | con evidencia |      ms |
 *   |------------------------------------------------|---------:|--------------:|--------:|
 *   | la vista VIVA hoy (cadena de `[PGP.27]`)        |    2,905 |         1,275 | **2,616** |
 *   | el mismo cuerpo por subconsulta (vía pareja)    |    2,905 |         1,275 | **2,489** |
 *   | con la `v_supplier_rfc` de `[PGP.31]`           |    2,905 |     **1,287** | **2,635** |
 *
 * Invertir la prioridad cuesta **+146 ms sobre 2,489 = 5.9 %**, que es ruido. El tope medía el
 * piso de la vista, no mi cambio.
 *
 * ⛔ **Y por qué no lo vi antes de empujar:** verifiqué el SQL dentro de una transacción que
 * revertí, **no la migración**. El SQL estaba bien; la guarda que lo envuelve, no. Ejercer el
 * cuerpo no es ejercer el `up()`.
 *
 * ── La guarda, ahora ────────────────────────────────────────────────────────────────────────
 *
 * El costo se compara contra lo que esta misma migración **mide un momento antes** de reemplazar
 * la vista, no contra una cifra escrita a mano: un umbral fijo sobre una vista cuyo piso no es
 * suyo frena lo sano y no detecta lo roto. Queda además un techo absoluto, alto a propósito,
 * para cazar un cambio de plan catastrófico sin volver a prohibir lo que ya costaba eso.
 */
const FACTOR = 1.5;
const MARGEN_MS = 500;
/** Techo absoluto: ~3x el piso medido de `v_payable_evidence`. No es el presupuesto de la
 *  pantalla (ésa la pide diferida); es el detector de que el plan se rompió. */
const TECHO_MS = 8000;

/**
 * El bloque SELECT final de `v_supplier_rfc`, con la prioridad invertida.
 *
 * Se reusa TODO el cuerpo de `[PGP.27]` y sólo se reemplaza su cola: así la normalización de
 * nombres, las fuentes y los controles siguen siendo **los mismos que ya se midieron**, y este
 * archivo no puede divergir de aquél por copiarlo mal.
 */
const COLA_VIEJA = `SELECT sucursal, proveedor_code, proveedor_nombre,`;

const COLA_NUEVA = `SELECT sucursal, proveedor_code, proveedor_nombre,
       -- [PGP.31] El RFC USABLE. Gana el que resuelve el NOMBRE contra los sistemas fiscales;
       -- Kepler sólo cuando el nombre no resuelve. La forma del SAT ya no decide: 18 acreedores
       -- traian un RFC de persona fisica, bien formado, sobre una sociedad mercantil.
       CASE WHEN rfc_nombre IS NOT NULL THEN rfc_nombre
            WHEN upper(rfc_kepler) ~ ${FORMA} THEN rfc_kepler END AS rfc,
       -- Lo que Kepler dice LITERAL. Sigue siendo la SEGUNDA llave del emparejado: el papel que
       -- Compras captura se teclea desde esta misma ficha y repite su error.
       rfc_kepler AS rfc_crudo,
       (rfc_kepler IS NOT NULL AND NOT (upper(rfc_kepler) ~ ${FORMA})) AS rfc_kepler_mal_formado,
       CASE WHEN rfc_nombre IS NOT NULL THEN 'nombre'
            WHEN upper(rfc_kepler) ~ ${FORMA} THEN 'kepler'
            ELSE 'ninguna' END::text AS fuente,
       CASE WHEN rfc_nombre IS NOT NULL THEN via END::text AS via,
       -- El que PERDIO, cuando habia pleito. Ahora es el de Kepler, y se publica para que la
       -- pantalla pueda decir "Kepler dice X, sus comprobantes dicen Y" en vez de callarlo.
       -- ⛔ Exige que el de Kepler SEA un RFC (forma del SAT). Sin esa condicion la columna
       --    mezcla dos cosas distintas y la pantalla llamaria "contradiccion" a un error de
       --    dedo: medido contra prod el 2026-10-28, 18 acreedores se contradicen de verdad
       --    (J&F, MONDELEZ) y OTROS 14 solo tienen el RFC mal escrito (PTE120913, DGR0531773A).
       --    Esos 14 ya los declara rfc_kepler_mal_formado y su valor literal vive en rfc_crudo.
       CASE WHEN rfc_nombre IS NOT NULL AND upper(rfc_kepler) ~ ${FORMA} AND rfc_nombre <> rfc_kepler
            THEN rfc_kepler END AS rfc_discrepa,
       CASE WHEN rfc_nombre IS NOT NULL OR upper(rfc_kepler) ~ ${FORMA} THEN NULL
            WHEN rfc_kepler IS NOT NULL
              THEN 'el RFC capturado en Kepler (' || rfc_kepler || ') no tiene forma de RFC, y el nombre no resuelve en ningun otro sistema'
            WHEN proveedor_nombre IS NULL THEN 'el acreedor no tiene ni RFC ni nombre en Kepler'
            ELSE 'sin RFC en Kepler, y su nombre tampoco aparece en ContPAQi'
            END::text AS motivo
  FROM res`;

/**
 * El cuerpo de PGP.27 con la cola nueva, **ya envuelto en su `CREATE OR REPLACE`**.
 *
 * ⛔⛔ Lo de envolverlo acá no es cosmético. `pgp27.SQL.RFC_VIEW` es un **SELECT pelado**: el
 * `CREATE OR REPLACE VIEW` lo pone su `up()`. La primera versión de esta migración ejecutaba el
 * texto tal cual, o sea **corría un SELECT y no reemplazaba nada** — y las guardas de abajo
 * pasaban en verde, porque con la vista intacta el universo y la evidencia siguen donde estaban.
 * Una migración que no hace nada y reporta éxito. Lo cazó la sonda contra prod: J&F seguía con
 * `fuente = kepler` después del cambio.
 */
function construir() {
  const base = pgp27.SQL.RFC_VIEW;
  const i = base.lastIndexOf(COLA_VIEJA);
  if (i < 0) {
    throw new Error('[PGP.31] no encontre la cola de la vista de PGP.27: su texto cambio. Revisar a mano antes de aplicar.');
  }
  return `CREATE OR REPLACE VIEW analytics.v_supplier_rfc AS ${base.slice(0, i)}${COLA_NUEVA}`;
}

/** Universo y evidencia, para comparar el ANTES con el DESPUÉS sin cifras clavadas a mano. */
const SONDA = `SELECT count(*)::int AS n,
                      count(*) FILTER (WHERE evidencia <> 'ninguna')::int AS con,
                      coalesce(sum(pendiente) FILTER (WHERE evidencia <> 'ninguna'), 0)::numeric AS dinero
                 FROM analytics.v_payable_evidence`;

exports.up = async function up(knex) {
  // ⭐ El ANTES se mide con la vista VIEJA todavía puesta. Las guardas de abajo comparan contra
  //    esto y no contra un número escrito a mano: un umbral fijo se pudre con los datos y
  //    termina frenando una migración sana (o dejando pasar una rota).
  //    Y se mide TAMBIÉN su costo, con el mismo patrón que el después (una pasada de calentado
  //    y la que cuenta): sin eso no hay con qué comparar y el tope vuelve a ser inventado.
  await knex.raw(SONDA);
  const tAntes = process.hrtime.bigint();
  const antes = (await knex.raw(SONDA)).rows[0];
  const msAntes = Number(process.hrtime.bigint() - tAntes) / 1e6;

  const SQL = construir();
  await knex.raw(SQL);

  // ⛔ Prueba de que el reemplazo OCURRIO, antes de medir nada: si la vista siguiera siendo la
  //    de PGP.27, los dos acreedores verificados contra fiscal.cfdis seguirian con fuente kepler.
  const { rows: ctrl } = await knex.raw(
    `SELECT proveedor_code, rfc, fuente FROM analytics.v_supplier_rfc
      WHERE proveedor_code IN ('CJ002','CM009') AND fuente = 'kepler'`
  );
  if (ctrl.length) {
    throw new Error(`[PGP.31] la vista NO se reemplazo: ${ctrl.map((r) => r.proveedor_code + '=' + r.rfc).join(', ')} siguen con fuente kepler. Se revierte.`);
  }

  // ⛔ rfc_discrepa significa "Kepler tiene OTRO RFC", no "Kepler lo tiene mal escrito". Si entra
  //    un valor sin forma de RFC, la columna esta mezclando las dos cosas y la pantalla que la
  //    pinte va a llamar contradiccion a un error de dedo. Prueba negativa: sin la condicion de
  //    forma en la cola, esta consulta devuelve 14 acreedores contra prod (medido 2026-10-28).
  const { rows: mezcla } = await knex.raw(
    `SELECT DISTINCT proveedor_code, rfc_discrepa FROM analytics.v_supplier_rfc
      WHERE rfc_discrepa IS NOT NULL AND NOT (upper(rfc_discrepa) ~ ${FORMA}) LIMIT 5`
  );
  if (mezcla.length) {
    throw new Error(`[PGP.31] rfc_discrepa trae valores que no son RFC (${mezcla.map((r) => r.proveedor_code + '=' + r.rfc_discrepa).join(', ')}): la columna esta mezclando contradiccion con error de captura. Se revierte.`);
  }
  await knex.raw(
    `COMMENT ON VIEW analytics.v_supplier_rfc IS ` +
    `'[PGP.31] El RFC de cada acreedor con su PROCEDENCIA. Gana el que resuelve el NOMBRE normalizado contra los sistemas fiscales (unico en su fuente); Kepler (kdxd.c10) solo cuando el nombre no resuelve. La forma del SAT ya no decide quien gana: 18 acreedores traian un RFC de persona fisica, bien formado, sobre una sociedad mercantil. rfc_discrepa publica el que PERDIO. rfc_crudo conserva lo literal de Kepler y sigue siendo la segunda llave del emparejado, para que invertir la prioridad no haga perder evidencia. Derivada: no materializa nada.'`
  );
  await knex.raw('GRANT SELECT ON analytics.v_supplier_rfc TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.v_supplier_rfc TO dev_ro');

  // ── Lo que esta migracion CAMBIA es un numero, asi que se dice el antes Y el despues ──
  await knex.raw(SONDA);
  const t0 = process.hrtime.bigint();
  const r = (await knex.raw(SONDA)).rows[0];
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const { rows: flip } = await knex.raw(
    `SELECT count(DISTINCT proveedor_code)::int AS n FROM analytics.v_supplier_rfc WHERE rfc_discrepa IS NOT NULL`
  );
  const mx = (v) => '$' + Number(v).toLocaleString('es-MX', { maximumFractionDigits: 0 });
  console.log(`[PGP.31] universo ${antes.n} -> ${r.n} · con evidencia ${antes.con} -> ${r.con} (${r.con - antes.con >= 0 ? '+' : ''}${r.con - antes.con}) · ${mx(antes.dinero)} -> ${mx(r.dinero)} · ${flip[0].n} acreedores con RFC en disputa · la evidencia ${msAntes.toFixed(0)} ms -> ${ms.toFixed(0)} ms`);

  // ⛔ Relativo a lo que esta vista YA costaba, no a una cifra que yo elija: el piso de
  //    v_payable_evidence (2.5-2.9 s medidos) no es de esta migracion. Ver la nota de FACTOR.
  const tope = Math.round(msAntes * FACTOR + MARGEN_MS);
  if (ms > tope) {
    throw new Error(`[PGP.31] la evidencia paso de ${msAntes.toFixed(0)} ms a ${ms.toFixed(0)} ms (tope ${tope} ms = ${FACTOR}x + ${MARGEN_MS} ms). Invertir la prioridad no recalcula nada: si cuesta eso, cambio el plan. Se revierte.`);
  }
  if (ms > TECHO_MS) {
    throw new Error(`[PGP.31] la evidencia cuesta ${ms.toFixed(0)} ms, techo absoluto ${TECHO_MS} ms. Se revierte (la leccion de PGP.27).`);
  }
  // ⛔ Invertir la prioridad NO puede hacer PERDER nada: rfc_crudo sigue siendo la segunda llave
  //    del emparejado. Si el universo se encogio o la evidencia bajo, el mecanismo se rompio.
  //    Se compara contra la medicion de hace un momento, no contra una cifra escrita a mano.
  if (r.n < antes.n) {
    throw new Error(`[PGP.31] el universo bajo de ${antes.n} a ${r.n}. Se revierte.`);
  }
  if (r.con < antes.con) {
    throw new Error(`[PGP.31] la evidencia bajo de ${antes.con} a ${r.con}. Invertir la prioridad no debe perder documentos. Se revierte.`);
  }
};

exports.down = async function down(knex) {
  // Vuelve EXACTAMENTE a la vista de PGP.27, su dueña original — con su envoltorio, que ese
  // módulo exporta SIN él (ver la nota de construir()).
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_supplier_rfc AS ${pgp27.SQL.RFC_VIEW}`);
  await knex.raw('GRANT SELECT ON analytics.v_supplier_rfc TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.v_supplier_rfc TO dev_ro');
};

exports.SQL = { construir, COLA_NUEVA, FACTOR, MARGEN_MS, TECHO_MS };
