-- =============================================================================
-- [OPS-AUD.13] Normaliza UNA VEZ la hora de las pólizas viejas del ODS (kdc2YYMM).
--
-- POR QUÉ. Hasta el 2026-09-23 el ODS guardaba la fecha de la póliza (c2, parte de la PK)
-- corrida 6 h: 06:00 en vez de 00:00 ([NORM.3c]). Cuando Contabilidad edita hoy una póliza
-- vieja, la versión nueva llega a las 00:00, no empata con la de las 06:00 y queda un
-- DUPLICADO que suma dos veces. Con esto, una edición vuelve a pisar su renglón.
--
-- MEDIDO en prod el 2026-10-27 (sólo lectura):
--   · 290,595 filas a las 06:00 en kdc22408 → kdc22612, NINGUNA a otra hora (sólo 00:00/06:00);
--   · 36 de ellas con gemela a las 00:00, buscadas por las columnas de la PK:
--       kdc22601 6 · 2602 2 · 2604 3 · 2605 4 · 2606 6 · 2607 8 · 2608 7
--   · el origen (réplica) guarda c2 SIEMPRE a medianoche ([OBS.12], re-medido cada noche).
--
-- ⛔ Acá decía «~297 mil» y «27 … (kdc22601 6 · 2602 2 · 2606 6 · 2607 6 · 2608 7)», y las DOS
-- cifras estaban mal porque se midieron con el predicado viejo, el que comparaba `c4`/`c5`
-- (ver `[OPS-AUD.13.1]` abajo). Faltaban 2604, 2605 y dos de 2607: **nueve gemelas**, las
-- únicas que de verdad importaban, porque son las que CAMBIARON. Una cifra medida con el
-- instrumento roto describe el instrumento, no la base.
--
-- QUÉ HACE, por tabla kdc2YYMM de kepler_ods:
--   1. borra la copia de las 06:00 que TIENE gemela a las 00:00 (la de las 00:00 es la versión
--      que el ODS recibió después del 23-sep: la vigente);
--   2. a las demás de las 06:00 les resta 6 h (pasan a 00:00, como en el origen).
--
-- FRENOS (si alguno falla, NO se toca NADA):
--   · si aparece una fila a una hora que no sea 00:00 ni 06:00 → aborta (el supuesto no vale);
--   · si el total a mover pasa de :tope (default 320000) → aborta (no es lo que se midió).
--
-- USO (fuera de horario; toma candado de escritura sobre las kdc2):
--   en seco  (default, termina en ROLLBACK):
--     k3s kubectl -n prod exec -i deploy/pg-prod -- psql -U postgres -d railway -v ON_ERROR_STOP=1 < OPS-AUD13-polizas-hora-6h.sql
--   aplicar:
--     ... psql ... -v ON_ERROR_STOP=1 -v aplicar=1 < OPS-AUD13-polizas-hora-6h.sql
-- =============================================================================
\if :{?aplicar}
\else
  \set aplicar 0
\endif
\if :{?tope}
\else
  \set tope 320000
\endif
\set ON_ERROR_STOP 1

SELECT system_identifier::text = '7688376744939610156' AS es_prod FROM pg_control_system() \gset
\if :es_prod
\else
  \echo '⛔ esta base NO es prod (system_identifier distinto). No se toca.'
  \quit
\endif

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30min';
SET LOCAL TIME ZONE 'America/Mexico_City';
SET LOCAL ods.tope = :'tope';

DO $mig$
DECLARE
  t text;
  borradas bigint; movidas bigint; rara bigint;
  tot_b bigint := 0; tot_m bigint := 0;
  tope bigint := current_setting('ods.tope')::bigint;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'kepler_ods' AND c.relname ~ '^kdc2[0-9]{4}$' ORDER BY 1 LOOP
    EXECUTE format($q$SELECT count(*) FROM kepler_ods.%I
                      WHERE (c2 AT TIME ZONE 'America/Mexico_City')::time NOT IN ('00:00','06:00')$q$, t) INTO rara;
    IF rara > 0 THEN
      RAISE EXCEPTION '% tiene % filas a una hora que no es 00:00 ni 06:00 — el supuesto no vale, no se toca nada', t, rara;
    END IF;

    -- ⛔ `[OPS-AUD.13.1]` (2026-10-27) La gemela se busca por las columnas de la PK —
    -- `(sucursal, c3, c2, c8, c1, c10)`, verificada igual en las 25 tablas— y NO por
    -- `c4`/`c5`, que es lo que hacía antes.
    --
    -- Por qué importaba: `c5` es el IMPORTE. Exigir que coincida sólo encontraba las gemelas
    -- que NO cambiaron, o sea justo las que no interesan; las que sí cambiaron se escapaban y
    -- después el `UPDATE` de abajo chocaba contra la PK. **Medido en seco el 2026-10-27**:
    -- abortó en `kdc22604` con `duplicate key … (00, 201, 2026-04-17 00:00:00, D, 10053, 1)`.
    --
    -- Lo que destapó: eran 36 gemelas, no las 27 que decía el encabezado. Las 27 son copias
    -- idénticas (`c4`,`c5`,`c6` iguales); las 9 que faltaban son BAJAS — la versión de las
    -- 00:00 trae `c5 = 0.00` y `c6 = 'BAJA - <folio>'`, y la de las 06:00 conserva el importe
    -- viejo. Entre las nueve suman **$394,664.02**. Dejarlas a las dos no es prudente: hace
    -- que el reporte sume la póliza anulada Y su propia baja.
    EXECUTE format($q$DELETE FROM kepler_ods.%1$I v
                      WHERE (v.c2 AT TIME ZONE 'America/Mexico_City')::time = '06:00'
                        AND EXISTS (SELECT 1 FROM kepler_ods.%1$I g
                                     WHERE g.sucursal = v.sucursal AND g.c3 = v.c3 AND g.c8 = v.c8
                                       AND g.c1 = v.c1 AND g.c10 = v.c10
                                       AND g.c2 = v.c2 - interval '6 hours')$q$, t);
    GET DIAGNOSTICS borradas = ROW_COUNT;

    EXECUTE format($q$UPDATE kepler_ods.%I SET c2 = c2 - interval '6 hours'
                      WHERE (c2 AT TIME ZONE 'America/Mexico_City')::time = '06:00'$q$, t);
    GET DIAGNOSTICS movidas = ROW_COUNT;

    tot_b := tot_b + borradas; tot_m := tot_m + movidas;
    IF borradas + movidas > 0 THEN
      RAISE NOTICE '% · duplicados borrados % · movidas a 00:00 %', t, borradas, movidas;
    END IF;
  END LOOP;

  IF tot_b + tot_m > tope THEN
    RAISE EXCEPTION 'se tocarían % filas, más que el tope % — no es lo que se midió, no se toca nada', tot_b + tot_m, tope;
  END IF;
  RAISE NOTICE 'TOTAL · duplicados borrados % · movidas a 00:00 %', tot_b, tot_m;
END $mig$;

-- Comprobación dentro de la misma transacción: no debe quedar NINGUNA a las 06:00.
DO $chk$
DECLARE t text; n bigint; total bigint := 0;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname = 'kepler_ods' AND c.relname ~ '^kdc2[0-9]{4}$' LOOP
    EXECUTE format($q$SELECT count(*) FROM kepler_ods.%I WHERE (c2 AT TIME ZONE 'America/Mexico_City')::time <> '00:00'$q$, t) INTO n;
    total := total + n;
  END LOOP;
  IF total > 0 THEN RAISE EXCEPTION 'quedaron % filas fuera de las 00:00 — se revierte', total; END IF;
  RAISE NOTICE 'comprobación: 0 filas fuera de las 00:00';
END $chk$;

\if :aplicar
  COMMIT;
  \echo '✔ APLICADO'
\else
  ROLLBACK;
  \echo 'EN SECO — nada cambió. Para aplicar: -v aplicar=1'
\endif
