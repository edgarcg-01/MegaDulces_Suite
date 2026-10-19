-- =============================================================================
-- [CGA-A.24] Tres movimientos conciliados uno a uno. Equivalente de la migracion
--            20261019164259. Idempotente. Todo dentro de un DO: o entra entero o
--            no entra.
--
-- LA REGLA:   lo que conto la MAQUINA + lo que quedo en el CAJON = lo que dice KEPLER
--
--   #1561 -> CI-2026-00002   21,770.00 +     20.00 = 21,790.00
--   #1586 -> CI-2026-00021   17,680.00 +     12.00 = 17,692.00
--   sin dep -> CI-2026-00042      0.00 + 21,507.00 = 21,507.00   ("NO FUNCINA CAOS")
--   sin dep -> CI-2026-00043      0.00 + 17,408.00 = 17,408.00   ("NO FUNCIONA CAOS")
--   sin dep -> CI-2026-00044      0.00 + 13,896.00 = 13,896.00   ("NO APARECE EN SWITE")
--                                 el documento dice 13,895.87: $0.13 de redondeo de teclado,
--                                 dentro de la tolerancia de $1.00 que autorizo Edgar.
--
-- ⛔ NO toca `morralla`: los $20, $12 y la morralla del tercero son hechos FISICOS.
--    Los declara quien conto el efectivo, no esta migracion.
-- ⛔ NO toca importe ni estado: los tres estan en corte o registrados tal cual.
-- =============================================================================
DO $mig$
DECLARE
  T uuid := '00000000-0000-0000-0000-00000000d01c';
  DEV text := 'AST700-19758';
  r record; l record; m record; d record; otro text; ref text; n int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('CI-2026-00002', 1561, 21790.00, 21770.00,    20.00, NULL),
      ('CI-2026-00021', 1586, 17692.00, 17680.00,    12.00, '01-005|U-A-5|0000011|0011'),
      ('CI-2026-00042', NULL, 21507.00,     0.00, 21507.00, '01-001|U-A-5|0000012|0011'),
      ('CI-2026-00043', NULL, 17408.00,     0.00, 17408.00, '01-006|U-A-5|0000012|0011'),
      ('CI-2026-00044', NULL, 13896.00,     0.00, 13896.00, '01-004|U-A-5|0000012|0011')
    ) AS t(folio, dep, libro, maquina, cajon, doc_ref)
  LOOP
    -- G1: existe, vive, y vale lo medido
    SELECT id, monto, origen_ref, declared_doc_ref, estado, sin_documento_motivo
      INTO l FROM finance.cash_ledger
     WHERE tenant_id = T AND folio = r.folio AND deleted_at IS NULL;
    IF l IS NULL THEN RAISE EXCEPTION '[A.24] % no existe o esta borrado. ABORTA.', r.folio; END IF;
    IF l.estado = 'cancelado' THEN RAISE EXCEPTION '[A.24] % esta cancelado. ABORTA.', r.folio; END IF;
    IF l.monto <> r.libro THEN
      RAISE EXCEPTION '[A.24] % vale % y se midio %. Cambio: ABORTA.', r.folio, l.monto, r.libro;
    END IF;

    IF r.dep IS NULL THEN
      -- G2-bis: sin deposito, pero con el motivo DECLARADO y sin apuntar a ninguno
      IF l.origen_ref IS NOT NULL THEN
        RAISE EXCEPTION '[A.24] % se declaro sin deposito pero apunta a "%". ABORTA.', r.folio, l.origen_ref;
      END IF;
      IF coalesce(btrim(l.sin_documento_motivo),'') = '' THEN
        RAISE EXCEPTION '[A.24] % no tiene deposito NI motivo declarado. ABORTA.', r.folio;
      END IF;
      RAISE NOTICE '[A.24] % sin deposito, motivo: "%"', r.folio, l.sin_documento_motivo;
    ELSE
      IF l.origen_ref IS DISTINCT FROM DEV || '|' || r.dep THEN
        RAISE EXCEPTION '[A.24] % apunta a "%", no al deposito %. ABORTA.', r.folio, l.origen_ref, r.dep;
      END IF;
      -- G2: el deposito existe, es Deposito, y conto lo medido
      SELECT total, type_id INTO m FROM analytics.caos_cash_movements
       WHERE tenant_id = T AND device = DEV AND external_id = r.dep;
      IF m IS NULL THEN RAISE EXCEPTION '[A.24] el deposito % no esta en CAOS. ABORTA.', r.dep; END IF;
      IF m.type_id <> 0 THEN RAISE EXCEPTION '[A.24] % no es un Deposito. ABORTA.', r.dep; END IF;
      IF m.total <> r.maquina THEN
        RAISE EXCEPTION '[A.24] la maquina dice % para %, se midio %. ABORTA.', m.total, r.dep, r.maquina;
      END IF;
    END IF;

    -- G3: LA ECUACION
    IF r.maquina + r.cajon <> r.libro THEN
      RAISE EXCEPTION '[A.24] %: % + % <> %. ABORTA.', r.folio, r.maquina, r.cajon, r.libro;
    END IF;

    -- G4: el documento de Kepler existe y vale lo mismo
    ref := coalesce(r.doc_ref, l.declared_doc_ref);
    IF ref IS NULL THEN RAISE EXCEPTION '[A.24] % sin documento declarado ni pasado. ABORTA.', r.folio; END IF;
    SELECT monto INTO d FROM (
      SELECT monto, origen_ref FROM finance.v_caja_movimientos_pendientes
      UNION ALL
      SELECT v.importe, v.sucursal||'|'||v.doc_tipo||'|'||v.folio||'|'||v.clave_banco
        FROM analytics.mv_caja_movimientos v WHERE v.tenant_id = T) z
     WHERE z.origen_ref = ref LIMIT 1;
    IF d IS NULL THEN RAISE EXCEPTION '[A.24] el documento % no existe en Kepler. ABORTA.', ref; END IF;
    -- Tolerancia de REDONDEO DE TECLADO, $1.00, autorizada por Edgar el 2026-10-19.
    -- ⚠️ NO aplica a la ecuacion maquina+cajon=libro, que sigue al centavo (G3).
    IF abs(r.libro - d.monto) > 1.00 THEN
      RAISE EXCEPTION '[A.24] % vale % y el libro % (desfase %). Pasa de $1.00: ABORTA.',
        ref, d.monto, r.libro, round(r.libro - d.monto, 2);
    END IF;
    IF r.libro <> d.monto THEN
      RAISE NOTICE '[A.24] % difiere del documento en $% -- redondeo de teclado, tolerado.',
        r.folio, round(r.libro - d.monto, 2);
    END IF;

    -- G5: nadie mas tomo ese documento
    SELECT folio INTO otro FROM finance.cash_ledger
     WHERE tenant_id = T AND deleted_at IS NULL AND estado <> 'cancelado'
       AND id <> l.id AND (origen_ref = ref OR declared_doc_ref = ref) LIMIT 1;
    IF otro IS NOT NULL THEN
      RAISE EXCEPTION '[A.24] % ya lo tiene %. Seria un duplicado: ABORTA.', ref, otro;
    END IF;

    -- El enlace formal, SOLO si hay deposito
    IF r.dep IS NOT NULL THEN
      INSERT INTO finance.caos_cash_links
        (tenant_id, cash_ledger_id, caos_device, caos_external_id, monto_enlazado, senales)
      VALUES (T, l.id, DEV, r.dep, r.maquina,
              jsonb_build_object('origen','CGA-A.24','por','conciliacion_uno_a_uno','cajon', r.cajon))
      ON CONFLICT (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL DO NOTHING;
    END IF;

    -- El documento, solo si falta
    IF r.doc_ref IS NOT NULL THEN
      UPDATE finance.cash_ledger SET declared_doc_ref = r.doc_ref, updated_at = now()
       WHERE tenant_id = T AND id = l.id AND declared_doc_ref IS NULL;
    END IF;

    n := n + 1;
    RAISE NOTICE '[A.24] % OK: maquina % + cajon % = % (doc %)', r.folio, r.maquina, r.cajon, r.libro, ref;
  END LOOP;
  RAISE NOTICE '[A.24] % movimiento(s) conciliados. La morralla la declara quien conto el efectivo.', n;
END
$mig$;

SELECT l.folio, l.monto, l.declared_doc_ref,
       (SELECT count(*) FROM finance.caos_cash_links k
         WHERE k.cash_ledger_id = l.id AND k.deleted_at IS NULL) AS enlaces,
       l.morralla
  FROM finance.cash_ledger l
 WHERE l.tenant_id = '00000000-0000-0000-0000-00000000d01c'
   AND l.folio IN ('CI-2026-00002','CI-2026-00021','CI-2026-00042','CI-2026-00043','CI-2026-00044')
 ORDER BY l.folio;
