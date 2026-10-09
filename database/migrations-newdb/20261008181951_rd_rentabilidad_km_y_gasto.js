'use strict';
/**
 * `[RD.57]` — **Capa 1 de «Rentabilidad por ruta»: los kilometros y el gasto dejan de teclearse.**
 *
 * El libro `INDICADORES RD 2026` tiene dos hojas que nadie cruza con las comisiones:
 * `OPERACION DE LAS RUTAS` (odometro, rendimiento) y `CONTROL DE GASTOS RD` (2,066 renglones).
 * Las dos se capturan a mano. Esta migracion mide que parte de eso **ya existe derivable** y
 * declara, con nombre, la parte que no.
 *
 * ── Lo medido contra prod el 2026-10-08 (db railway, system_identifier 7688376744939610156) ──
 *
 *   ✅ **Kilometros: SI, por ruta y por dia.** `logistics.trackers` trae `route_number` y son
 *      exactamente las rutas de Ruta Directa: 21, 22, 23, 26, 27, 28, 321, 322. Los 57 trackers
 *      traen odometro y hay 297,868 posiciones en 30 dias. La ruta 21 marca 60-192 km en dia
 *      habil. **Es el mismo numero que la hoja teclea.**
 *   ✅ **Gasto: SI, pero por PLAZA.** Tres departamentos contables, y son los tres del libro:
 *      `1-01-10-20` RD PADRE HIDALGO ($4,021,510 en 2026) · `1-03-50-51` CANINDO RD
 *      ($2,183,061) · `1-02-32-98` MORELIA MADERO RD ($133,052). Combustible RD 2026 =
 *      **$821,775** contra los $523,166 que acumula el libro: **la contabilidad tiene MAS que
 *      el Excel**, no menos.
 *   ⛔ **La ruta del gasto: NO.** El `comentario` de las lineas de combustible dice
 *      "combustible rd" (y "combuistible rd", con el typo), y `beneficiario` repite el nombre
 *      del concepto. La contabilidad llega al departamento, no al camion. **No se dibuja un
 *      reparto por ruta que nadie capturo** (ADR-056).
 *   ⛔ **Los litros: NO.** El `raw` de `fiscal.cfdis` guarda solo el encabezado — sin conceptos —
 *      y el XML completo existe en **105 de 6,241** facturas del proveedor de combustible
 *      (SUPER SERVICIO GARBRI, SSG981118LR6, 1,615 CFDIs en 2026). Las lineas de gasto de ese
 *      proveedor son **cero**, y el catalogo de presentaciones (PAQ/PZA/KG/SER/CJA/CUB/BTO) **no
 *      tiene litros**. Sin litros no hay `$/litro` ni `km/l`: se declaran, no se estiman.
 *
 * ── ⭐ El umbral de «dia medido» NO son los pings, y el dato lo refuto ───────────────────────
 * La regla obvia —"pocos pings = no medido"— es falsa aqui. Histograma de 736 ruta-dia en 90 d:
 *
 *     1-4 pings   15 filas   2.1 h cubiertas   km prom   1.7    <- cobertura de verdad insuficiente
 *     5-19 pings  88 filas  20.2 h cubiertas   km prom   0.1    <- el camion REPORTO QUIETO 20 h
 *     100+ pings 593 filas  17.5 h cubiertas   km prom 134.6
 *
 * El proveedor manda posicion cuando algo cambia: **quieto = pocos pings**. Un dia de 5-19 pings
 * con 20 horas de cobertura es un dia **medido con cero kilometros**, no un dia sin medir.
 * El separador es **las horas cubiertas** (hay un hueco limpio entre 2.1 y 10.1), y por eso el
 * corte va en 4 h — un numero que sale del histograma, no del pulgar.
 *
 * ── Las tres trampas que el dato ya traia ───────────────────────────────────────────────────
 * 1. **Dos trackers por ruta.** 21, 22, 26, 321 y 322 tienen la unidad **y** su dashcam, cada
 *    una con su propio odometro (la 321: 26,810 contra 61,349). Sumarlos duplica el kilometraje.
 *    Se elige **uno por ruta y dia**: primero el que no es camara, y entre iguales el de mas
 *    pings. Y el `(CAM)` de la 321 **no reporta desde el 2026-06-15**, asi que elegir por
 *    "el ultimo visto" tambien habria fallado.
 * 2. **El odometro se reinicia.** La ruta 22 el 2026-08-20 va de 25,275 a 46,477 con 386 pings:
 *    21,202 km en un dia. Es un cambio de equipo. Es **1 de 736** filas; el resto cae bajo 600.
 *    Fuera de [0, 600] el kilometraje sale NULL con veredicto, nunca un numero inventado.
 * 3. **La misma clave de departamento trae dos grafias** (`CANINDO RD.` y `CANINDO RD`,
 *    `NOMINA BANCOS.` / `NOMINA BANCOS ` / `NOMINA BANCOS` bajo el concepto 001). Agrupar por
 *    NOMBRE parte el total en dos sin avisar. Se agrupa por **clave** y el nombre se normaliza.
 *
 * ── Prueba negativa del universo ────────────────────────────────────────────────────────────
 * Se busco un cuarto departamento de Ruta Directa fuera de los tres (`dpto_nombre ~* 'RD|DIRECT'`
 * sobre el complemento): **0 filas**. Aun asi la vista NO clava las tres claves: las deriva del
 * nombre, para que un departamento nuevo entre solo.
 *
 * ── Y un desajuste que hay que declarar, no tapar ───────────────────────────────────────────
 * Las rutas con GPS son las de **Padre Hidalgo** (21-28) mas 321/322. Las de **Canindo
 * (501-505) no tienen tracker**: su kilometraje no existe y sale como ausencia con nombre,
 * no como cero. Y `MORELIA MADERO RD` gasta sin tener ninguna ruta en el resolvedor de
 * identidad, asi que su plaza queda NULL con veredicto `plaza_sin_rutas`.
 *
 * Vistas, no tablas: derive-no-copy. `security_invoker` para que respeten el RLS de quien lee.
 *
 * @param { import("knex").Knex } knex
 */

const FN = 'analytics.fn_expense_family';
const V_KM = 'analytics.v_rd_route_km_daily';
const V_GASTO = 'analytics.v_rd_expense_period';

// Clasificador de familia de gasto. Vive en UNA funcion y no inline, porque el mismo CASE ya
// esta copiado dentro de `analytics.v_logistics_expense_channel` (Fase J) y una constante
// duplicada a mano es justo lo que ADR-056 cuenta como primitivo sin casa.
// ⚠️ DEUDA DECLARADA `[RD.57.1]`: `v_logistics_expense_channel` sigue con su copia inline. No se
// reescribe aqui a proposito — recrear una vista viva arrastra la trampa del plan cacheado
// (GOTCHAS, 0A000) y ese objeto es de otra fase. La paridad se conserva al pie de la letra,
// imprecisiones incluidas (MANTENIM cae en 'vehiculo' aunque sea de un local).
const SQL_FN = `
CREATE OR REPLACE FUNCTION ${FN}(p_concepto text, p_cuenta text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN upper(coalesce(p_concepto,'')) ~ 'COMBUST|GASOLIN|DIESEL' THEN 'combustible'
    WHEN upper(coalesce(p_concepto,'')) ~ 'NOMINA|SUELDO|FINIQUITO|AGUINALDO|VACACION|SUA|IMSS|INFONAVIT'
      OR upper(coalesce(p_concepto,'')) ~ 'COMISION|BONO|CAJA DE AHORRO|PRESTAMO|PTU|INDEMNIZ'
      OR left(coalesce(p_cuenta,''),3) IN ('601','762') THEN 'personal'
    WHEN upper(coalesce(p_concepto,'')) ~ 'ARRENDAM|MANTENIM|REPARACION|LLANTA|REFACCION|ACEITE|LUBRICANTE'
      OR upper(coalesce(p_concepto,'')) ~ 'SUSPENSION|LAMINACION|VERIFICACION|TENENCIA|SEGURO' THEN 'vehiculo'
    WHEN upper(coalesce(p_concepto,'')) ~ 'CASETA|PEAJE|VIATICO|HOTEL|TAXI|CARRETA|ACARREO|ESTACIONAM' THEN 'viaje'
    WHEN upper(coalesce(p_concepto,'')) ~ 'TRASLADO DE VALORES|CUSTODIA' THEN 'valores'
    WHEN upper(coalesce(p_concepto,'')) ~ 'LOCAL|RENTA|LUZ|AGUA|PREDIAL|VIGILANCIA|LIMPIEZA' THEN 'local'
    WHEN upper(coalesce(p_concepto,'')) ~ 'GPS|TELEFON|SISTEMA|SOFTWARE|RECARGA|INTERNET|COMPUT' THEN 'tecnologia'
    ELSE 'otros'
  END
$fn$`;

const SQL_KM = `
CREATE OR REPLACE VIEW ${V_KM} WITH (security_invoker = true) AS
WITH tr AS (
  SELECT t.tenant_id, t.id AS tracker_id, t.route_number, t.external_name,
         -- La camara es un SEGUNDO aparato sobre el MISMO camion, con su propio odometro.
         (t.external_name ~* 'DASHCAM|[(]CAM[)]') AS es_camara
    FROM logistics.trackers t
   WHERE t.route_number IS NOT NULL AND t.deleted_at IS NULL
), dia AS (
  SELECT p.tenant_id, tr.route_number, tr.tracker_id, tr.external_name, tr.es_camara,
         (p.captured_at AT TIME ZONE 'America/Mexico_City')::date AS dia,
         count(*)::integer AS pings,
         round((extract(epoch FROM (max(p.captured_at) - min(p.captured_at))) / 3600.0)::numeric, 2) AS horas_cubiertas,
         min(p.odometer) AS odometro_min,
         max(p.odometer) AS odometro_max
    FROM logistics.vehicle_positions p
    JOIN tr ON tr.tracker_id = p.tracker_id AND tr.tenant_id = p.tenant_id
   WHERE p.odometer IS NOT NULL
   GROUP BY 1,2,3,4,5,6
), elegido AS (
  SELECT d.*,
         (d.odometro_max - d.odometro_min)::bigint AS km_crudo,
         row_number() OVER (PARTITION BY d.tenant_id, d.route_number, d.dia
                            ORDER BY d.es_camara, d.pings DESC, d.tracker_id) AS rn,
         count(*) OVER (PARTITION BY d.tenant_id, d.route_number, d.dia)::integer AS trackers_del_dia
    FROM dia d
)
SELECT e.tenant_id,
       e.route_number::text AS route_code,
       e.dia,
       e.tracker_id,
       e.external_name AS tracker_nombre,
       e.trackers_del_dia,
       e.pings,
       e.horas_cubiertas,
       e.odometro_min,
       e.odometro_max,
       CASE
         WHEN e.horas_cubiertas < 4 THEN 'cobertura_insuficiente'
         WHEN e.km_crudo < 0 OR e.km_crudo > 600 THEN 'odometro_reiniciado'
         WHEN e.km_crudo = 0 THEN 'sin_movimiento'
         ELSE 'medido'
       END AS veredicto,
       -- ⛔ NULL, nunca 0, cuando no se pudo medir: un cero se lee como "no se movio".
       CASE
         WHEN e.horas_cubiertas < 4 THEN NULL
         WHEN e.km_crudo < 0 OR e.km_crudo > 600 THEN NULL
         ELSE e.km_crudo
       END AS km,
       e.km_crudo
  FROM elegido e
 WHERE e.rn = 1`;

const SQL_GASTO = `
CREATE OR REPLACE VIEW ${V_GASTO} WITH (security_invoker = true) AS
WITH rd AS (
  SELECT e.tenant_id, e.fecha, e.dpto, e.concepto, e.cuenta, e.sucursal,
         btrim(regexp_replace(e.dpto_nombre, '[. ]+$', '')) AS dpto_norm,
         btrim(regexp_replace(coalesce(e.concepto_nombre, ''), '[. ]+$', '')) AS concepto_norm,
         e.importe * CASE WHEN e.cargo_abono = 'A' THEN -1 ELSE 1 END AS importe
    FROM analytics.expense_entries e
   WHERE e.dpto IS NOT NULL
     AND e.dpto_nombre IS NOT NULL
     -- RD como palabra, no como subcadena. Derivado: un departamento nuevo entra solo.
     AND btrim(regexp_replace(e.dpto_nombre, '[. ]+$', '')) ~ '(^|[^A-Za-z])RD([^A-Za-z]|$)'
), con_plaza AS (
  SELECT r.*,
         btrim(regexp_replace(r.dpto_norm, '(^RD[ ]|[ ]RD$)', '')) AS plaza_norm
    FROM rd r
), plazas AS (
  SELECT DISTINCT tenant_id, plaza, upper(plaza) AS plaza_upper
    FROM analytics.mv_rd_route_identity
)
SELECT c.tenant_id,
       p.anio,
       p.period_no,
       p.date_from,
       p.date_to,
       c.dpto,
       c.dpto_norm,
       pl.plaza,
       CASE WHEN pl.plaza IS NULL THEN 'plaza_sin_rutas' ELSE 'ok' END AS veredicto_plaza,
       c.concepto,
       c.concepto_norm,
       ${FN}(c.concepto_norm, c.cuenta) AS familia,
       count(*)::integer AS lineas,
       round(sum(c.importe)::numeric, 2) AS importe,
       min(c.fecha) AS primer_movimiento,
       max(c.fecha) AS ultimo_movimiento
  FROM con_plaza c
  JOIN commercial.commission_periods p
    ON p.tenant_id = c.tenant_id AND c.fecha >= p.date_from AND c.fecha <= p.date_to
  LEFT JOIN plazas pl
    ON pl.tenant_id = c.tenant_id AND pl.plaza_upper = c.plaza_norm
 GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12`;

exports.up = async function up(knex) {
  await knex.raw(SQL_FN);
  await knex.raw(SQL_KM);
  await knex.raw(SQL_GASTO);

  // ⚠️ `security_invoker` y los GRANT no se heredan al recrear una vista (ADR-057). Explicitos.
  await knex.raw(`GRANT SELECT ON ${V_KM} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${V_GASTO} TO app_runtime`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION ${FN}(text, text) TO app_runtime`);

  await knex.raw(
    `COMMENT ON VIEW ${V_KM} IS 'RD.57 - kilometros por ruta y dia desde el odometro del GPS. Un tracker por ruta (la dashcam es un segundo aparato sobre el mismo camion). km NULL con veredicto cuando la cobertura es menor a 4 h o el odometro se reinicio; 0 solo cuando el camion REPORTO quieto. Solo Padre Hidalgo + 321/322 tienen tracker: Canindo 501-505 no aparece.'`,
  );
  await knex.raw(
    `COMMENT ON VIEW ${V_GASTO} IS 'RD.57 - gasto de Ruta Directa por quincena, departamento y concepto. Grano maximo = PLAZA: la contabilidad no atribuye el gasto a la camioneta. Se agrupa por CLAVE de dpto/concepto, nunca por nombre (la misma clave trae dos grafias). Sin litros: el CFDI no guarda conceptos.'`,
  );
  await knex.raw(
    `COMMENT ON FUNCTION ${FN}(text, text) IS 'RD.57 - familia de gasto (combustible/personal/vehiculo/viaje/valores/local/tecnologia/otros). Copia fiel del CASE que vive inline en analytics.v_logistics_expense_channel; deuda RD.57.1 = apuntar esa vista aqui.'`,
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V_GASTO}`);
  await knex.raw(`DROP VIEW IF EXISTS ${V_KM}`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN}(text, text)`);
};
