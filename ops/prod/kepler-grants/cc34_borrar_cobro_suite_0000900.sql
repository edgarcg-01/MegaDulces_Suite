-- [CC.34] Borrar en Canindo el cobro U-A-7 0000900 que escribio la Suite y que NO se pudo timbrar.
--
-- Hermano de `cc29_borrar_cobro_suite_0000886.sql`, mismo caso y mismas guardas. Por que se borra:
--   · Quedo SIN complemento de pago. Medido horas despues de escribirlo: cero filas en kdfe33m1 -- y
--     nada lo barre (los 6 cobros de septiembre llevan dos meses igual, CC.32).
--   · Kepler NO lo puede abrir: «El CFDI asignado a este documento KEPLER, no puede ser procesado por
--     esta pagina. Version CFDI: (vacio). Permitidas en esta version: 4.0». La razon, medida: Kepler
--     escribe PRIMERO la ficha del CFDI (version 4.0, sin folio fiscal) y la timbra despues -- hay 124
--     fichas asi en la 06 ahora mismo. Nuestro cobro no tiene ninguna, y por eso esa pagina lo rechaza.
--   · El carril kepler_push no tiene DELETE ni UPDATE sobre estas tablas, que es como debe ser.
--   · No es un hecho de negocio: el deposito es real, pero este DOCUMENTO nunca debio nacer asi.
--     Lo va a capturar una persona por el camino de Kepler, que timbra 1,489 de 1,489 veces.
--
-- ⛔ El folio 0000900 se consumio del contador y NO se retrocede: queda un hueco. Se declara.
-- ⛔ Y despues de esto hay DOS pasos mas, fuera de Kepler (CC.30): el espejo `kepler_ods` no ve los
--    DELETE, asi que la fila fantasma de kdue se limpia aparte y la cartera se recalcula. Si no, el
--    cliente aparece debiendo $15,539.63 de menos.
--
-- verificar: (SELECT count(*) FROM md.kdm1 WHERE c1='06' AND c2='U' AND c3='A' AND c4=7 AND btrim(c6)='0000900') = 0 AND (SELECT count(*) FROM md.kdm5 WHERE c1='06' AND c2='U' AND c3='A' AND c4=7 AND btrim(c6)='0000900') = 0 AND (SELECT count(*) FROM md.kdue WHERE c1='06' AND c3='A' AND c4=7 AND btrim(c6)='0000900') = 0 AND (SELECT count(*) FROM md.kdc22611 WHERE btrim(c15)='U' AND btrim(c16)='A' AND btrim(c17::text)='7' AND btrim(c19)='0000900') = 0 AND (SELECT round(k.c16::numeric - coalesce((SELECT sum(m.c12::numeric) FROM md.kdm5 m WHERE m.c1=k.c1 AND m.c8='D' AND m.c9=k.c4 AND m.c10=k.c5 AND btrim(m.c11)=btrim(k.c6)),0),2) FROM md.kdm1 k WHERE k.c1='06' AND k.c2='U' AND k.c3='D' AND k.c4=8 AND k.c5=1 AND btrim(k.c6)='0001446') = 15539.63

DO $$
DECLARE
  n_doc int; n_suite int; n_cfdi int; saldo_antes numeric;
BEGIN
  -- 1. Tiene que existir, y ser EXACTAMENTE el de la Suite (capturista y referencia).
  SELECT count(*) INTO n_doc FROM md.kdm1
   WHERE c1='06' AND c2='U' AND c3='A' AND c4=7 AND btrim(c6)='0000900';
  IF n_doc <> 1 THEN RAISE EXCEPTION 'el cobro 0000900 aparece % veces: no se toca', n_doc; END IF;

  SELECT count(*) INTO n_suite FROM md.kdm1
   WHERE c1='06' AND c2='U' AND c3='A' AND c4=7 AND btrim(c6)='0000900'
     AND btrim(coalesce(c67,'')) = 'SUITE' AND btrim(coalesce(c11,'')) = 'SUITE-CC-mwz3xwju';
  IF n_suite <> 1 THEN RAISE EXCEPTION 'el cobro 0000900 NO es el de la Suite (capturista o referencia distintos): no se toca'; END IF;

  -- 2. ⛔ Si llegara a tener su complemento timbrado, NO se borra: seria destruir un CFDI vivo.
  SELECT count(*) INTO n_cfdi FROM md.kdfe33m1
   WHERE c1='06' AND btrim(c3)='0000900' AND btrim(coalesce(c25,'')) = 'P';
  IF n_cfdi <> 0 THEN RAISE EXCEPTION 'el cobro 0000900 SI tiene complemento timbrado (% fila(s)): no se borra, se cancela por Kepler', n_cfdi; END IF;

  -- 3. La factura que quedaria libre, antes.
  SELECT round(k.c16::numeric - coalesce((SELECT sum(m.c12::numeric) FROM md.kdm5 m
            WHERE m.c1=k.c1 AND m.c8='D' AND m.c9=k.c4 AND m.c10=k.c5 AND btrim(m.c11)=btrim(k.c6)),0),2)
    INTO saldo_antes
    FROM md.kdm1 k WHERE k.c1='06' AND k.c2='U' AND k.c3='D' AND k.c4=8 AND k.c5=1 AND btrim(k.c6)='0001446';
  IF saldo_antes IS NULL THEN RAISE EXCEPTION 'no encuentro la factura 8-1-0001446'; END IF;
  RAISE NOTICE 'antes: la factura 8-1-0001446 debe %', saldo_antes;
END $$;

-- 4. El borrado, en el orden de lo que cuelga hacia el encabezado.
DELETE FROM md.kdc22611
 WHERE btrim(c15)='U' AND btrim(c16)='A' AND btrim(c17::text)='7' AND btrim(c19)='0000900';
DELETE FROM md.kdm5
 WHERE c1='06' AND c2='U' AND c3='A' AND c4=7 AND btrim(c6)='0000900';
DELETE FROM md.kdue
 WHERE c1='06' AND c3='A' AND c4=7 AND btrim(c6)='0000900';
DELETE FROM md.kdm1
 WHERE c1='06' AND c2='U' AND c3='A' AND c4=7 AND btrim(c6)='0000900'
   AND btrim(coalesce(c67,'')) = 'SUITE' AND btrim(coalesce(c11,'')) = 'SUITE-CC-mwz3xwju';

-- 5. Y que la factura haya vuelto a deber lo suyo.
DO $$
DECLARE saldo numeric;
BEGIN
  SELECT round(k.c16::numeric - coalesce((SELECT sum(m.c12::numeric) FROM md.kdm5 m
            WHERE m.c1=k.c1 AND m.c8='D' AND m.c9=k.c4 AND m.c10=k.c5 AND btrim(m.c11)=btrim(k.c6)),0),2)
    INTO saldo
    FROM md.kdm1 k WHERE k.c1='06' AND k.c2='U' AND k.c3='D' AND k.c4=8 AND k.c5=1 AND btrim(k.c6)='0001446';
  IF saldo <> 15539.63 THEN RAISE EXCEPTION 'la factura 8-1-0001446 quedo debiendo % y debia volver a 15539.63', saldo; END IF;
  RAISE NOTICE 'despues: la factura 8-1-0001446 vuelve a deber %', saldo;
END $$;
