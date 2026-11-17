-- [PGP.122.4] H1 — Avanza a MAX(c6)+1 los contadores de folios de Kepler (md.sqliov) que los carriles de escritura de la
-- Suite dejaron ATRÁS al escribir con MAX+1 sin tocarlos. Plan: anexo S §12 H1 y §16 R8,
-- docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md; decisión: ADR-119 punto 4.
--
-- POR QUÉ (2026-11-17): en Zamora Centro, una persona abrió un pedido TELEMARK nuevo y Kepler le propuso UD4001-0001149.
-- Ese folio ya existe: lo escribió la Suite (c24 = COT-2026-00412) con MAX+1 y luego se canceló en Kepler, y el contador
-- KFUD4001.05 se quedó en 1149. Al grabar, choca. Medido en el ODS (sólo lectura), 16 contadores atrasados:
--   pedido TLMK U-D-40: 01 (3 atrás) · 05 (1) · 06 (6) · 08 (4)
--   requisición X-A-30: 00 (27) · 01 (18) · 02 (1) · 04 (1) · 05 (1) · 06 (22) · 08 (76)
--   OC X-A-35: 00 · 02 · 05 · 06 (1 cada uno) · pago X-D-26: 01 (1)
-- Este archivo NO depende de esa foto: en cada servidor recalcula contra SU Kepler vivo.
--
-- QUÉ HACE, en cada servidor (la base es md_NN: la sucursal sale de current_database()):
--   sólo los contadores PROPIOS (KF<tipo>01.NN, NN = la sucursal del servidor) de los 6 documentos que escribe o escribirá
--   la Suite (U-D-40, X-A-30, X-A-35, X-D-26, X-A-15, X-A-10), y sólo si c4 ≤ MAX(c6): los pone en MAX(c6)+1, sin ceros a
--   la izquierda (como kepler-folio.ts). NUNCA baja un contador. Correrlo dos veces no cambia nada la segunda.
--
-- ⚠️ Mientras la Suite siga escribiendo con MAX+1 (antes de soltar 216245d60), cada documento que escriba vuelve a dejar
--    su contador 1 atrás. Este arreglo destraba HOY a quien captura a mano; el que lo vuelve permanente es soltar
--    216245d60, después del GRANT de pgp1224_contador_sqliov.sql. Si se suelta después, correr éste otra vez.
-- ⚠️ Quien tenga abierta un ALTA con el folio viejo (la persona de Zamora Centro): cancelar esa alta y abrir una nueva
--    después de correr esto. NO MEDIDO: si Kepler vuelve a leer el contador al grabar o sólo al abrir el alta.
--
-- Correr (desde la PC con acceso a los 9; pide la contraseña de superusuario y no la guarda):
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-contadores/avanzar-contadores-atrasados.sql             (revisa: «ya aplicado: no» = hay atrasados)
--   node ops/prod/kepler-sql-todos.js ops/prod/kepler-contadores/avanzar-contadores-atrasados.sql --aplicar   (una transacción por servidor; si después queda alguno atrás, se revierte)
-- verificar: SELECT current_database() ~ '^md_[0-9]{2}$' AND NOT EXISTS (SELECT 1 FROM md.sqliov s JOIN (SELECT 'KF' || btrim(c2) || btrim(c3) || lpad(c4::int::text, 2, '0') || lpad(c5::int::text, 2, '0') || '.' || btrim(c1) AS llave, max(btrim(c6)::int) AS m FROM md.kdm1 WHERE btrim(c1) = right(current_database(), 2) AND btrim(c6) ~ '^[0-9]+$' AND (btrim(c2), btrim(c3), c4::int, c5::int) IN (('U','D',40,1), ('X','A',30,1), ('X','A',35,1), ('X','D',26,1), ('X','A',15,1), ('X','A',10,1)) GROUP BY 1) k ON btrim(s.c1) = k.llave AND s.c2 = 0 AND s.c3 = 0 WHERE btrim(s.c4) !~ '^[0-9]+$' OR btrim(s.c4)::int <= k.m)

DO $$
BEGIN
  IF current_database() !~ '^md_[0-9]{2}$' THEN
    RAISE EXCEPTION 'Esta base (%) no es md_NN: no se sabe de qué sucursal son los contadores', current_database();
  END IF;
END $$;

UPDATE md.sqliov s
   SET c4 = (k.m + 1)::text
  FROM (SELECT 'KF' || btrim(c2) || btrim(c3) || lpad(c4::int::text, 2, '0') || lpad(c5::int::text, 2, '0') || '.' || btrim(c1) AS llave,
               max(btrim(c6)::int) AS m
          FROM md.kdm1
         WHERE btrim(c1) = right(current_database(), 2)
           AND btrim(c6) ~ '^[0-9]+$'
           AND (btrim(c2), btrim(c3), c4::int, c5::int) IN (('U','D',40,1), ('X','A',30,1), ('X','A',35,1), ('X','D',26,1), ('X','A',15,1), ('X','A',10,1))
         GROUP BY 1) k
 WHERE btrim(s.c1) = k.llave AND s.c2 = 0 AND s.c3 = 0
   AND btrim(s.c4) ~ '^[0-9]+$' AND btrim(s.c4)::int <= k.m;
