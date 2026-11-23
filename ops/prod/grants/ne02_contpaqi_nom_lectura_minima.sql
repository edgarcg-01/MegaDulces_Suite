-- [NE.0.2] Lectura mínima de ContPAQi Nóminas, sin abrir el schema
--
-- Contexto. `contpaqi_nom` tiene ACL `{postgres=UC/postgres}`: ni la API (`app_runtime`), ni
-- `dev_ro`, ni las cuentas personales pueden leerlo. Fue deliberado — ahí viven CURP, RFC, NSS,
-- sueldos y cuentas bancarias. Este script NO levanta esa decisión: deja el schema cerrado y
-- publica, en el schema abierto `contpaqi_ods`, **dos vistas con el mínimo** que el frente NE
-- necesita para medir.
--
-- ⛔ Lo que estas vistas NO exponen: RFC, CURP, NSS, cuenta bancaria, banco, domicilio, sueldo
--    diario ni percepciones/deducciones desglosadas.
--
-- ⭐ La llave de empate con el padrón del Access NO es el RFC: es un **hash** del RFC. Permite
--    unir a la misma persona en los dos sistemas sin que el RFC salga nunca de `contpaqi_nom`.
--    Del otro lado se calcula el mismo `md5(upper(trim(rfc)))` y se comparan los hashes.
--
-- Quién lo corre: alguien con `postgres` en pg-prod (David), **fuera de horario hábil**.
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

-- 2) Lo pagado por periodo. Es lo que cierra NE.0.3: de dónde sale el importe que dispersa el banco.
CREATE OR REPLACE VIEW contpaqi_ods.v_nomina_pago_periodo AS
SELECT
    n.numempleadorec                              AS employee_code,
    n.fechainicialpago                            AS period_from,
    n.fechafinalpago                              AS period_to,
    n.periodicidadpago                            AS periodicity,
    n.totalpagado                                 AS net_paid,
    n.departamentorec                             AS department,
    n.puestorec                                   AS position
FROM contpaqi_nom.add_nomina n;

COMMENT ON VIEW contpaqi_ods.v_nomina_pago_periodo IS
  '[NE.0.3] Neto pagado por persona y periodo según el CFDI timbrado. Sin desglose de percepciones ni deducciones, sin banco ni cuenta.';

-- 3) Sólo lectura, y sólo para quien ya tiene `contpaqi_ods`.
GRANT SELECT ON contpaqi_ods.v_nomina_empleado     TO dev_ro, app_runtime;
GRANT SELECT ON contpaqi_ods.v_nomina_pago_periodo TO dev_ro, app_runtime;

COMMIT;

-- Comprobación (debe devolver 2 filas, ambas con rowsecurity = f y ACL que incluya dev_ro):
--   SELECT viewname FROM pg_views WHERE schemaname='contpaqi_ods' AND viewname LIKE 'v_nomina_%';
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
