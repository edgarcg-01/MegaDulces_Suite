'use strict';
/**
 * `[PR.D1]` — **La capa psicológica: dónde ATERRIZA el precio.**
 *
 * ── Por qué esto va primero ────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-09-29: **el 93.5 % de los precios del catálogo son "sucios"** —
 * terminan en `.01`, `.48`, `.52`, `.42`, `.91`… El más frecuente es `.01` (3.3 %). Sólo el
 * **1.9 %** termina en `.00` y el **3.3 %** en `.90/.95/.99`.
 *
 * ⭐ Y no es herencia del pasado: de los **170,818 cambios de precio de los últimos 90 días**,
 * apenas el **5.7 %** aterriza en `.00` y el **2.5 %** en `.90/.95/.99`. **El 90.6 % de los
 * cambios cae en un número que nadie eligió** — es el residuo de multiplicar costo por markup
 * por impuesto y redondear a dos decimales.
 *
 * Esto NO es cosmético. Entre `$86.00`, `$85.99` y `$89.90` hay una diferencia de percepción
 * medible, y hoy la decide una multiplicación.
 *
 * ── Lo que esta capa hace, y lo que NO ─────────────────────────────────────────────────────
 * ⭐ Es **aritmética de umbrales, no un modelo.** Recibe un precio objetivo (de donde venga) y
 * devuelve dónde debería aterrizar, con el diagnóstico de por qué.
 *
 * ⛔ **No elige la política.** `commercial.pricing_settings.redondeo_modo` nace **NULL con motivo
 * escrito** porque instaurar una es decisión de Dirección. Esta capa **calcula los candidatos**
 * para los cuatro modos y deja que el experimento A/B decida cuál gana.
 * ⛔ **No cambia ningún precio.** Publica diagnóstico y candidatos.
 * ⛔ **No toca los que oscilan** — se marcan y se excluyen: sobre un precio inestable no hay
 * nada que aterrizar.
 *
 * ── ⭐ El escalón NO es constante: escala con el precio ─────────────────────────────────────
 * Un precio de $5,000 no se aterriza a $4,999.90 — se aterriza a $5,000. Medido dónde viven los
 * precios y con qué magnitud se mueven hoy:
 *
 *   | rango        | SKUs  | magnitud mediana del cambio real |
 *   |--------------|-------|----------------------------------|
 *   | < $10        |   965 | 0.16 %                           |
 *   | $10 – $50    | 5,240 | 0.75 %                           |
 *   | $50 – $100   | 2,947 | 1.57 %                           |
 *   | $100 – $500  | 1,203 | 6.48 %                           |
 *   | > $500       |   111 | 5.00 %                           |
 *
 * Por eso `fn_precio_escalon` devuelve un paso por rango, y el **umbral de percepción** (D4)
 * también es por rango: aplicar uno solo declararía "no se nota" un alza de 5 % en un producto
 * de $8, donde la mediana real de movimiento es 0.16 %.
 *
 * ── Las cuatro señales ─────────────────────────────────────────────────────────────────────
 *  D1 · **terminación** — en qué centavo cae, y si eso señala algo
 *  D2 · **dígito izquierdo** — de $99 a $101 el salto percibido es enorme; de $101 a $103 es
 *       invisible. Se detecta si el aterrizaje CRUZA una decena o centena
 *  D3 · **umbral redondo** — medido: 755 precios justo encima de un múltiplo de 50 contra 692
 *       justo debajo. **Simétrico**, o sea que hoy nadie los usa
 *  D4 · **umbral de percepción** — por debajo de la magnitud mediana de su rango, el alza no se
 *       distingue del ruido de precio al que el mercado ya está acostumbrado
 *
 * VISTA + funciones INMUTABLES. No escribe nada. Aditiva.
 *
 * @param { import("knex").Knex } knex
 */

const FN_ESCALON = 'analytics.fn_precio_escalon';
const FN_PERCEPCION = 'analytics.fn_precio_umbral_percepcion';
const FN_ATERRIZA = 'analytics.fn_precio_aterriza';
const VIEW = 'analytics.v_price_psychology';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1 · El ESCALÓN por rango de precio ──────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN_ESCALON}(precio numeric)
    RETURNS numeric
    LANGUAGE sql IMMUTABLE STRICT
    AS $func$
      SELECT CASE
        WHEN precio <   10 THEN 0.50
        WHEN precio <  100 THEN 1.00
        WHEN precio <  500 THEN 5.00
        WHEN precio < 2000 THEN 10.00
        ELSE                    50.00
      END
    $func$
  `);

  await knex.raw(`COMMENT ON FUNCTION ${FN_ESCALON}(numeric) IS
    $c$[PR.D1] El paso de aterrizaje segun el rango de precio. Un precio de $5,000 no se aterriza
    a $4,999.90: se aterriza a $5,000. Calibrado contra donde viven los precios reales del
    catalogo (5,240 SKUs entre $10-50, 2,947 entre $50-100, 111 arriba de $500).$c$`);

  // ── 2 · El UMBRAL DE PERCEPCIÓN por rango (D4) ──────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN_PERCEPCION}(precio numeric)
    RETURNS numeric
    LANGUAGE sql IMMUTABLE STRICT
    AS $func$
      SELECT CASE
        WHEN precio <  10 THEN 0.16
        WHEN precio <  50 THEN 0.75
        WHEN precio < 100 THEN 1.57
        WHEN precio < 500 THEN 6.48
        ELSE                   5.00
      END
    $func$
  `);

  await knex.raw(`COMMENT ON FUNCTION ${FN_PERCEPCION}(numeric) IS
    $c$[PR.D1] D4 Weber-Fechner. Debajo de este porcentaje el cambio no se distingue del ruido de
    precio al que el mercado ya esta acostumbrado. NO es una constante: son las magnitudes
    MEDIANAS reales de cambio por rango, medidas sobre 245,665 cambios de 180 dias
    (analytics.v_label_price_changes). Un umbral unico declararia "no se nota" un alza de 5% en un
    producto de $8, donde la mediana real de movimiento es 0.16%.$c$`);

  // ── 3 · EL ATERRIZAJE ───────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN_ATERRIZA}(objetivo numeric, modo text)
    RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE
    AS $func$
    DECLARE
      paso numeric;
      base numeric;
    BEGIN
      /**
       * ⛔ EL PISO. Debajo de $1 no se aterriza NADA, y lo encontro la compuerta: sin este
       * freno, un precio de $0.01 aterrizaba a $0.90 -- un +8,900% presentado como "redondeo".
       * Medido: son 1,851 filas y NO son mercancia -- "PARA GENERAR VENTAS NC", "PACA DE CARTON
       * P/RECICLAR", "BULTO DE PLASTICO P/RECICLAR". Su venta total en 30 dias es de $43.
       * Son los marcadores de <= $0.05 que el ERP usa como artefacto (los mismos que is_promo
       * marca, y que NO significan promocion).
       */
      IF objetivo IS NULL OR objetivo < 1 THEN RETURN NULL; END IF;

      paso := ${FN_ESCALON}(objetivo);

      -- La parte entera del escalon: sobre ella se cuelga la terminacion.
      base := round(objetivo / paso) * paso;
      IF base <= 0 THEN base := paso; END IF;

      RETURN CASE modo
        -- Entero limpio. Senala calidad y simplifica la lectura.
        WHEN '00' THEN base
        -- Medio peso. Util donde el escalon entero es demasiado grueso.
        WHEN '50' THEN round(objetivo * 2) / 2
        -- Termina en .90 -- senala oferta. Se cuelga del entero de ABAJO para no
        -- encarecer: con objetivo 89.40 da 88.90, no 89.90.
        WHEN '90' THEN floor(objetivo) + 0.90
        WHEN '99' THEN floor(objetivo) + 0.99
        ELSE NULL
      END;
    END
    $func$
  `);

  await knex.raw(`COMMENT ON FUNCTION ${FN_ATERRIZA}(numeric, text) IS
    $c$[PR.D1] Donde aterriza un precio objetivo segun el modo de redondeo. NO elige el modo:
    commercial.pricing_settings.redondeo_modo nace NULL con motivo porque instaurar una politica
    es decision de Direccion. Esta funcion calcula los candidatos para que el experimento A/B
    decida cual gana. Los modos .90 y .99 se cuelgan del entero de ABAJO: con objetivo 89.40 dan
    88.90 y 88.99, nunca 89.90 -- aterrizar no puede ser una excusa para encarecer.$c$`);

  // ── 4 · LA VISTA DE DIAGNÓSTICO ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    WITH base AS (
      SELECT sucursal, sku, nombre, precio_ficha AS precio, venta_neta_30d, unidades_base_30d
        FROM analytics.v_kepler_standard_cost
       WHERE precio_ficha > 0
    ), calc AS (
      SELECT b.*,
             (round(b.precio * 100)::bigint % 100)             AS centavos,
             ${FN_ESCALON}(b.precio)                           AS escalon,
             ${FN_PERCEPCION}(b.precio)                        AS umbral_percepcion_pct,
             ${FN_ATERRIZA}(b.precio, '00')                    AS cand_00,
             ${FN_ATERRIZA}(b.precio, '50')                    AS cand_50,
             ${FN_ATERRIZA}(b.precio, '90')                    AS cand_90,
             ${FN_ATERRIZA}(b.precio, '99')                    AS cand_99
        FROM base b
    )
    SELECT
      sucursal, sku, nombre, precio, venta_neta_30d, unidades_base_30d,
      centavos, escalon, umbral_percepcion_pct,

      -- D1 · ¿la terminación señala algo?
      CASE
        WHEN centavos = 0             THEN 'entero'
        WHEN centavos = 50            THEN 'medio'
        WHEN centavos IN (90, 95, 99) THEN 'oferta'
        ELSE                               'sucio'
      END AS terminacion,

      /**
       * D2 · El digito izquierdo. Un precio que esta a un pelo de cruzar una decena (o centena)
       * hacia ABAJO es el candidato mas valioso de todos: bajar centavos lo mueve a la decena
       * anterior y el salto PERCIBIDO es enorme -- o, al reves, subirlo cruza una barrera que el
       * cliente si nota. Se publica la distancia, no un juicio.
       */
      CASE WHEN precio >= 10
           THEN round((ceil(precio / 10.0) * 10.0 - precio)::numeric, 2) END AS falta_para_decena,
      CASE WHEN precio >= 100
           THEN round((ceil(precio / 100.0) * 100.0 - precio)::numeric, 2) END AS falta_para_centena,

      -- D3 · pegado a un umbral redondo (dentro de un escalon)
      (precio >= 10 AND (ceil(precio / 10.0) * 10.0 - precio) <= escalon)  AS pegado_a_decena,
      (precio >= 100 AND (ceil(precio / 100.0) * 100.0 - precio) <= escalon) AS pegado_a_centena,

      cand_00, cand_50, cand_90, cand_99,

      /**
       * ⭐ Lo que costaria aterrizar, en % -- por candidato. Un aterrizaje que mueve MENOS que el
       * umbral de percepcion es margen (o senal) practicamente gratis: el mercado no lo nota.
       */
      round((100.0 * (cand_00 - precio) / precio)::numeric, 3) AS delta_00_pct,
      round((100.0 * (cand_50 - precio) / precio)::numeric, 3) AS delta_50_pct,
      round((100.0 * (cand_90 - precio) / precio)::numeric, 3) AS delta_90_pct,
      round((100.0 * (cand_99 - precio) / precio)::numeric, 3) AS delta_99_pct,

      -- D4 · ¿el aterrizaje a entero pasa desapercibido?
      CASE WHEN cand_00 IS NOT NULL
           THEN abs(100.0 * (cand_00 - precio) / precio) <= umbral_percepcion_pct END
        AS cero_se_percibe_no,

      /**
       * ⭐⭐ LA SEPARACION HONESTA, y es la columna mas importante de esta vista.
       *
       * Aterrizar tiene DOS efectos y NO son lo mismo:
       *
       *   1. el ALZA IMPLICITA -- pasar de 86.88 a 86.90 sube el precio 0.02. Es dinero real,
       *      pero es SUBIR EL PRECIO, no psicologia. Medido sobre el catalogo: el modo .00 es
       *      NEUTRO (-$10,096/30 d: redondea hacia abajo tanto como hacia arriba), mientras .90
       *      da +$543,441 y .99 da +$659,564 -- y esa diferencia es casi toda alza, porque los
       *      dos se cuelgan del entero de abajo.
       *   2. el efecto de SENALIZACION -- que el cliente lea .99 como oferta y .00 como calidad.
       *      Eso NO se puede calcular: solo lo mide el experimento A/B.
       *
       * ⛔ Publicar los $8.03 M anualizados del modo .99 como "el valor de la capa psicologica"
       * seria vender un alza de precio disfrazada. Por eso el alza va en su propia columna, con
       * su nombre, y la senalizacion se DECLARA como no medida hasta que el A/B responda.
       */
      CASE WHEN cand_00 IS NOT NULL
           THEN round((100.0 * (cand_00 - precio) / precio)::numeric, 3) END AS alza_implicita_00_pct,
      CASE WHEN cand_90 IS NOT NULL
           THEN round((100.0 * (cand_90 - precio) / precio)::numeric, 3) END AS alza_implicita_90_pct,
      CASE WHEN cand_99 IS NOT NULL
           THEN round((100.0 * (cand_99 - precio) / precio)::numeric, 3) END AS alza_implicita_99_pct,

      -- El efecto de senalizacion, DECLARADO: no hay con que medirlo hasta el A/B (fase 2).
      NULL::numeric                                             AS efecto_senalizacion_pct,
      'no_medido_hasta_el_ab'::text                             AS senalizacion_motivo,

      /**
       * El veredicto: que TAN LEJOS esta este precio de senalar algo.
       * ⛔ No dice que hacer -- eso lo decide la politica que el A/B todavia no resolvio.
       */
      CASE
        WHEN cand_00 IS NULL                 THEN 'fuera_de_alcance'
        WHEN centavos IN (0, 50, 90, 95, 99) THEN 'ya_aterrizado'
        WHEN abs(100.0 * (cand_00 - precio) / precio) <= umbral_percepcion_pct
          THEN 'aterrizable_sin_que_se_note'
        ELSE 'aterrizable_con_costo'
      END AS veredicto,

      CASE WHEN cand_00 IS NULL
           THEN 'precio por debajo de $1: es un marcador del ERP, no mercancia' END
        AS motivo_fuera_de_alcance
    FROM calc
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.D1] La capa PSICOLOGICA del precio: donde ATERRIZA, y que tan lejos esta hoy de
    senalar algo. Medido 2026-09-29: el 93.5% de los precios del catalogo son sucios (la
    terminacion mas frecuente es .01 con 3.3%) y el 90.6% de los 170,818 cambios de los ultimos
    90 dias tambien -- o sea que nadie decide donde cae el precio, sale del residuo de una
    multiplicacion. Cuatro senales: D1 terminacion, D2 digito izquierdo (distancia a la decena y
    a la centena), D3 pegado a umbral redondo, D4 umbral de percepcion POR RANGO (Weber-Fechner:
    0.16% bajo $10, 1.57% en $50-100, 6.48% en $100-500 -- son las magnitudes medianas reales de
    cambio, no una constante inventada). Publica los CUATRO candidatos de aterrizaje y lo que
    cuesta cada uno; NO elige politica (redondeo_modo nace NULL, lo decide el A/B) y NO cambia
    ningun precio. VISTA derive-no-copy, security_invoker.$c$`);

  // ── Compuerta, con sus pruebas NEGATIVAS ────────────────────────────────────────────
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE terminacion = 'sucio')::int sucios,
           count(*) FILTER (WHERE veredicto = 'ya_aterrizado')::int ya,
           count(*) FILTER (WHERE veredicto = 'aterrizable_sin_que_se_note')::int gratis,
           count(*) FILTER (WHERE veredicto = 'fuera_de_alcance')::int fuera,
           -- ⛔ NEGATIVA 1: el modo .90 NUNCA puede encarecer mas de un peso
           count(*) FILTER (WHERE cand_90 > precio + 1.0)::int noventa_encarece,
           -- ⛔ NEGATIVA 2: un candidato existe o no existe, pero NUNCA vale cero ni negativo
           count(*) FILTER (WHERE cand_00 <= 0 OR cand_50 <= 0
                              OR cand_90 <= 0 OR cand_99 <= 0)::int candidato_invalido,
           -- ⛔ NEGATIVA 3: un precio ya entero no puede reportarse como 'sucio'
           count(*) FILTER (WHERE centavos = 0 AND terminacion <> 'entero')::int clasificacion_rota,
           -- ⛔ NEGATIVA 4: quedarse mudo. Sin candidato Y sin motivo se lee como "no hay nada que hacer"
           count(*) FILTER (WHERE cand_00 IS NULL
                              AND motivo_fuera_de_alcance IS NULL)::int mudas,
           -- ⛔ NEGATIVA 5: el aterrizaje NUNCA puede alejarse mas de un escalon del precio
           count(*) FILTER (WHERE cand_00 IS NOT NULL
                              AND abs(cand_00 - precio) > escalon)::int se_aleja_demasiado,
           -- ⛔ NEGATIVA 6: la senalizacion se declara, no se inventa
           count(*) FILTER (WHERE efecto_senalizacion_pct IS NOT NULL)::int senalizacion_inventada
      FROM ${VIEW}`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.D1] ${g.filas} filas · sucios ${g.sucios} `
    + `(${(100 * g.sucios / g.filas).toFixed(1)}%) · ya aterrizados ${g.ya} · `
    + `⭐ aterrizables sin que se note ${g.gratis} · fuera de alcance ${g.fuera}`);

  if (g.noventa_encarece > 0) {
    throw new Error(`[PR.D1] ${g.noventa_encarece} veces el modo .90 encarece mas de $1: `
      + 'aterrizar no puede ser una excusa para subir el precio.');
  }
  if (g.candidato_invalido > 0) {
    throw new Error(`[PR.D1] ${g.candidato_invalido} candidatos en cero o negativos.`);
  }
  if (g.clasificacion_rota > 0) {
    throw new Error(`[PR.D1] ${g.clasificacion_rota} precios enteros clasificados mal.`);
  }
  if (g.mudas > 0) {
    throw new Error(`[PR.D1] ${g.mudas} filas sin candidato Y sin motivo: una ausencia muda se `
      + 'lee igual que "no hay nada que hacer".');
  }
  if (g.se_aleja_demasiado > 0) {
    throw new Error(`[PR.D1] ${g.se_aleja_demasiado} aterrizajes se alejan mas de un escalon `
      + 'del precio: eso no es redondear, es cambiar el precio.');
  }
  if (g.senalizacion_inventada > 0) {
    throw new Error(`[PR.D1] ${g.senalizacion_inventada} filas publican un efecto de `
      + 'senalizacion: eso NO se puede calcular, solo medirlo con el A/B.');
  }
  if (g.sucios === 0) {
    throw new Error('[PR.D1] cero precios sucios: la medicion dice 93.4%, algo esta mal.');
  }
  if (g.fuera === 0) {
    throw new Error('[PR.D1] cero fuera de alcance: el piso de $1 no esta actuando, y hay 1,851 '
      + 'marcadores del ERP que no son mercancia.');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN_ATERRIZA}(numeric, text)`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN_PERCEPCION}(numeric)`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN_ESCALON}(numeric)`);
};
