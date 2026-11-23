-- [NE.0.2] Lectura mínima de ContPAQi Nóminas, sin abrir el schema
--
-- ⭐⭐ ESTADO (reconciliado contra prod el 2026-11-23, `system_identifier` verificado):
--    **las dos vistas YA ESTÁN APLICADAS en pg-prod** y las lee `app_runtime` (la API),
--    `dev_ro` y las cuentas personales — comprobado con `has_table_privilege`, no con
--    `information_schema.role_table_grants`, que **no responde esa pregunta** (ahí sólo
--    aparecía `dev_ro`). `contpaqi_nom` sigue cerrado: nadie más que `postgres` tiene `USAGE`.
--
-- ⚠️ Lo aplicado NO era este archivo tal cual: `v_nomina_pago_periodo` se desplegó con 14
--    columnas y aquí había 7, y ninguno de los dos COMMENT llegó a prod. Este archivo quedó
--    reescrito para decir **exactamente lo que hay en producción**; la versión vieja ya no se
--    podía volver a correr (`CREATE OR REPLACE VIEW` no puede quitarle columnas a una vista).
--
-- Contexto. `contpaqi_nom` tiene ACL `{postgres=UC/postgres}`: ni la API, ni `dev_ro`, ni las
-- cuentas personales pueden leerlo. Fue deliberado — ahí viven CURP, RFC, NSS, sueldos y cuentas
-- bancarias. Este script NO levanta esa decisión: deja el schema cerrado y publica, en el schema
-- abierto `contpaqi_ods`, dos vistas con lo que el frente NE necesita.
--
-- ⛔ Lo que estas vistas NO exponen: RFC, CURP, NSS, cuenta bancaria, banco, domicilio ni sueldo
--    diario. ⚠️ **Sí exponen el desglose del CFDI** —percepciones, otros pagos y deducciones—:
--    lo aplicado fue más amplio que lo que decía la versión original de este archivo.
--
-- ⭐ La llave de empate con el padrón del Access es un **hash**, nunca el dato en claro:
--    `curp_hash` = `md5(upper(trim(CURP)))` en los pagos, `rfc_hash` en el padrón. Del otro lado
--    se calcula el mismo hash y se comparan. ⛔ El empate se hace **por CURP**: la columna `rfc`
--    de ContPAQi no es el RFC (0 de 229 empatan por ahí, 217 de 238 por CURP).
--
-- Quién lo corre: alguien con `postgres` en pg-prod, **fuera de horario hábil**.
-- Es idempotente y no escribe datos. Para revertir: los dos DROP VIEW del final, comentados.

BEGIN;

-- 1) Padrón: quién es, dónde trabaja y por qué vía cobra. Sin un solo dato fiscal en claro.
CREATE OR REPLACE VIEW contpaqi_ods.v_nomina_empleado AS
SELECT
    e.codigoempleado                              AS employee_code,
    e.nombrelargo                                 AS full_name,
    e.estadoempleado                              AS status,
    e.fechaalta                                   AS hired_at,
    e.fechabaja                                   AS terminated_at,
    e.formapago                                   AS payment_form,
    -- llave de empate, no reversible a RFC
    md5(upper(btrim(e.rfc)))                      AS rfc_hash,
    (btrim(coalesce(e.cuentapagoelectronico,'')) <> '') AS tiene_cuenta_bancaria
FROM contpaqi_nom.nom_nom10001 e;

COMMENT ON VIEW contpaqi_ods.v_nomina_empleado IS
  '[NE.0.2] Padrón de ContPAQi Nóminas sin datos fiscales en claro. rfc_hash es md5(upper(trim(rfc))): sirve para unir con otro padrón, no para recuperar el RFC.';

-- 2) Lo pagado por periodo, según el CFDI timbrado. Es lo que cierra NE.0.3: de dónde sale el
--    importe que dispersa el banco. ⛔ Esta es la forma REAL que corre en prod (14 columnas).
CREATE OR REPLACE VIEW contpaqi_ods.v_nomina_pago_periodo AS
SELECT
    n.numempleadorec                              AS employee_code,
    -- llave de empate: por CURP, no por RFC
    md5(upper(btrim(n.curpreceptor)))             AS curp_hash,
    n.fechainicialpago                            AS period_from,
    n.fechafinalpago                              AS period_to,
    n.fechapago                                   AS paid_on,
    n.numdiaspagados                              AS days_paid,
    n.tiponomina                                  AS payroll_type,
    n.periodicidadpago                            AS periodicity,
    n.totalpercepciones                           AS gross_pay,
    n.totalotrospagos                             AS other_pay,
    n.totaldeducciones                            AS deductions,
    COALESCE(
      n.totalpagado,
      COALESCE(n.totalpercepciones, 0::numeric)
        + COALESCE(n.totalotrospagos, 0::numeric)
        - COALESCE(n.totaldeducciones, 0::numeric)
    )                                             AS net_paid,
    n.departamentorec                             AS department,
    n.puestorec                                   AS "position"
FROM contpaqi_nom.add_nomina n;

COMMENT ON VIEW contpaqi_ods.v_nomina_pago_periodo IS
  '[NE.0.3] Pago por persona y periodo según el CFDI timbrado de nómina. curp_hash = md5(upper(trim(CURP))): une a la persona sin exponer la CURP. Semanal (periodicidad 05) desde 2016-12-31.';

-- 3) Sólo lectura, y sólo para quien ya tiene `contpaqi_ods`.
GRANT SELECT ON contpaqi_ods.v_nomina_empleado     TO dev_ro, app_runtime;
GRANT SELECT ON contpaqi_ods.v_nomina_pago_periodo TO dev_ro, app_runtime;

COMMIT;

-- Comprobación (debe devolver 2 filas):
--   SELECT viewname FROM pg_views WHERE schemaname='contpaqi_ods' AND viewname LIKE 'v_nomina_%';
-- ⛔ Y quién puede leerlas se pregunta así, NO con information_schema:
--   SELECT has_table_privilege('app_runtime','contpaqi_ods.v_nomina_pago_periodo','SELECT');
--
-- Prueba negativa obligatoria (un gate sin prueba negativa es una intención):
-- conectado como `dev_ro`, esto DEBE seguir fallando con «permission denied for schema contpaqi_nom»:
--   SELECT count(*) FROM contpaqi_nom.nom_nom10001;
-- y esto DEBE funcionar:
--   SELECT count(*) FROM contpaqi_ods.v_nomina_empleado;
--
-- Revertir:
--   DROP VIEW IF EXISTS contpaqi_ods.v_nomina_pago_periodo;
--   DROP VIEW IF EXISTS contpaqi_ods.v_nomina_empleado;
