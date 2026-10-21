'use strict';
/**
 * ⭐⭐ `[CGA-A.17]` — **El CONCEPTO se deriva del historial, igual que la cuenta.**
 *
 * ── Qué pasaba, medido en prod el 2026-10-19 ───────────────────────────────────────────────
 *
 *     analytics.mv_caja_autofill_entidad
 *       285 filas · 285 con cuenta (100%) · 44 con concepto (15%)
 *
 * `porEntidad()` exige las DOS mitades —*"media cuenta no contabiliza"*— así que **241 entidades
 * con la cuenta resuelta se publicaban como «sin propuesta»** y alguien las tecleaba. No es
 * teoría: de las **133 capturas manuales** del libro (\$1,488,051.25), **45 por \$463,801.52**
 * son exactamente este caso. Entre ellas `GN001` (NOMINA) con **967 antecedentes**, tecleada a
 * mano 13 veces; y `CP036` (PIÑATAS ANITA), que el 19-oct dejó un pago de \$14,421.00 sin poder
 * capturarse hasta que se declaró a mano (`[CGA-A.16]`).
 *
 * ── La causa ───────────────────────────────────────────────────────────────────────────────
 *
 * El *fallback* del concepto sólo resolvía cuando la cuenta tiene **exactamente uno** en el
 * catálogo:
 *
 *     HAVING count(DISTINCT v.concepto) = 1
 *
 * La cuenta `511` (COMPRA MERCANCIA A PROVEEDORS) tiene varios, así que caía a NULL — y `511`
 * es la cuenta de la mayoría de los proveedores.
 *
 * ── Qué se agrega ──────────────────────────────────────────────────────────────────────────
 *
 * Un tercer peldaño, `hist_cta`: **el concepto que la gente ya eligió para esa cuenta**, leído
 * de `finance.cash_ledger`. Es la misma clase de evidencia con la que la vista ya deriva la
 * cuenta desde las pólizas; sólo que para el concepto la fuente no es el GL (ahí no vive) sino
 * lo capturado.
 *
 * ⛔ **Con umbral, no a la primera.** Exige `total >= 3` y `>= 80%` de dominancia. Sin eso, una
 * sola captura equivocada se volvería la regla de toda la cuenta — y una propuesta inventada es
 * peor que ninguna, porque la gente la acepta.
 *
 * ⭐ **Y se declara de dónde salió** (ADR-056): `concepto_origen` dice `catalogo`,
 * `cuenta_unica` o `historial_cuenta`, con `concepto_support` / `concepto_total` para que la
 * pantalla pueda decir «27 de 28» en vez de afirmar sin respaldo.
 *
 * ── Un defecto latente que se arregla de paso ───────────────────────────────────────────────
 *
 * ⚠️ El *fallback* buscaba el concepto con `WHERE v.cuenta = r.cuenta`, pero la cuenta que la
 * vista PUBLICA es `COALESCE(pn.cuenta, r.cuenta)`. Cuando el catálogo por nombre mandaba
 * (`veredicto = 'catalogo'`, 10 filas), el concepto se buscaba contra la **otra** cuenta. Ahora
 * las dos miran la misma.
 *
 * ── Medición (ensayo contra prod, en transacción revertida) ─────────────────────────────────
 *
 *     con concepto      44  ->  171
 *     utilizables*      ??  ->  153        (*concepto no nulo y veredicto <> 'disperso')
 *     por origen:  historial_cuenta 127 · cuenta_unica 34 · catalogo 10 · sin concepto 114
 *
 *     CP036  PIÑATAS ANITA      511/059      historial_cuenta  28/29   unanime
 *     GN001  NOMINA         601-001/002      historial_cuenta  13/13   dominante
 *     CB013  BOTANAS PAU        511/059      historial_cuenta  28/29   unanime
 *     GNFC003 CAPITAN DE MARCA 606-014/074   historial_cuenta   5/6    unanime
 *
 * ⚠️ `[CGA-A.16]` declaró `CP036` a mano y **sigue ganando**: lo declarado es el primer peldaño
 * de `porEntidad()`. No se retira acá — una declaración explícita vale más que un cálculo, y
 * quitarla sería cambiar dos cosas en el mismo commit.
 *
 * ⛔ **Una matvista no admite `CREATE OR REPLACE`**: hay que soltar y recrear, así que el índice
 * único se vuelve a crear acá (lo necesita `REFRESH ... CONCURRENTLY`).
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_caja_autofill_entidad';
const IDX = 'mv_caja_autofill_entidad_uq';

/** La definición NUEVA, con `hist_cta` y la procedencia del concepto. */
const DEF_NUEVA = `WITH p AS (
         SELECT v_caja_movimientos_pendientes.sucursal,
            v_caja_movimientos_pendientes.doc_tipo,
            v_caja_movimientos_pendientes.folio,
            v_caja_movimientos_pendientes.entidad_code,
            v_caja_movimientos_pendientes.tipo,
            split_part(v_caja_movimientos_pendientes.doc_tipo, '-'::text, 3) AS tnum
           FROM finance.v_caja_movimientos_pendientes
          WHERE v_caja_movimientos_pendientes.entidad_code IS NOT NULL
        ), d AS (
         SELECT p.entidad_code,
            p.sucursal,
            p.doc_tipo,
            p.folio,
            p.tipo,
            min(f.c7::text) AS dt_dest,
            min(btrim(f.c9)) AS folio_dest,
            count(DISTINCT (f.c7::text || '-'::text) || btrim(f.c9))::integer AS n_dest
           FROM p
             LEFT JOIN kepler_ods.kdxf f ON btrim(f.c1) = p.sucursal AND f.c4::text = p.tnum AND f.c5 = 1::numeric AND btrim(f.c6) = p.folio
          GROUP BY p.entidad_code, p.sucursal, p.doc_tipo, p.folio, p.tipo
        ), gl AS (
         SELECT btrim(kdc22408.c14) AS suc,
            kdc22408.c17::text AS dt,
            btrim(kdc22408.c19) AS folio,
            btrim(kdc22408.c3) AS cuenta
           FROM kepler_ods.kdc22408
          WHERE btrim(COALESCE(kdc22408.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22501.c14) AS suc,
            kdc22501.c17::text AS dt,
            btrim(kdc22501.c19) AS folio,
            btrim(kdc22501.c3) AS cuenta
           FROM kepler_ods.kdc22501
          WHERE btrim(COALESCE(kdc22501.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22502.c14) AS suc,
            kdc22502.c17::text AS dt,
            btrim(kdc22502.c19) AS folio,
            btrim(kdc22502.c3) AS cuenta
           FROM kepler_ods.kdc22502
          WHERE btrim(COALESCE(kdc22502.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22503.c14) AS suc,
            kdc22503.c17::text AS dt,
            btrim(kdc22503.c19) AS folio,
            btrim(kdc22503.c3) AS cuenta
           FROM kepler_ods.kdc22503
          WHERE btrim(COALESCE(kdc22503.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22504.c14) AS suc,
            kdc22504.c17::text AS dt,
            btrim(kdc22504.c19) AS folio,
            btrim(kdc22504.c3) AS cuenta
           FROM kepler_ods.kdc22504
          WHERE btrim(COALESCE(kdc22504.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22505.c14) AS suc,
            kdc22505.c17::text AS dt,
            btrim(kdc22505.c19) AS folio,
            btrim(kdc22505.c3) AS cuenta
           FROM kepler_ods.kdc22505
          WHERE btrim(COALESCE(kdc22505.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22506.c14) AS suc,
            kdc22506.c17::text AS dt,
            btrim(kdc22506.c19) AS folio,
            btrim(kdc22506.c3) AS cuenta
           FROM kepler_ods.kdc22506
          WHERE btrim(COALESCE(kdc22506.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22507.c14) AS suc,
            kdc22507.c17::text AS dt,
            btrim(kdc22507.c19) AS folio,
            btrim(kdc22507.c3) AS cuenta
           FROM kepler_ods.kdc22507
          WHERE btrim(COALESCE(kdc22507.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22508.c14) AS suc,
            kdc22508.c17::text AS dt,
            btrim(kdc22508.c19) AS folio,
            btrim(kdc22508.c3) AS cuenta
           FROM kepler_ods.kdc22508
          WHERE btrim(COALESCE(kdc22508.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22509.c14) AS suc,
            kdc22509.c17::text AS dt,
            btrim(kdc22509.c19) AS folio,
            btrim(kdc22509.c3) AS cuenta
           FROM kepler_ods.kdc22509
          WHERE btrim(COALESCE(kdc22509.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22510.c14) AS suc,
            kdc22510.c17::text AS dt,
            btrim(kdc22510.c19) AS folio,
            btrim(kdc22510.c3) AS cuenta
           FROM kepler_ods.kdc22510
          WHERE btrim(COALESCE(kdc22510.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22511.c14) AS suc,
            kdc22511.c17::text AS dt,
            btrim(kdc22511.c19) AS folio,
            btrim(kdc22511.c3) AS cuenta
           FROM kepler_ods.kdc22511
          WHERE btrim(COALESCE(kdc22511.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22512.c14) AS suc,
            kdc22512.c17::text AS dt,
            btrim(kdc22512.c19) AS folio,
            btrim(kdc22512.c3) AS cuenta
           FROM kepler_ods.kdc22512
          WHERE btrim(COALESCE(kdc22512.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22601.c14) AS suc,
            kdc22601.c17::text AS dt,
            btrim(kdc22601.c19) AS folio,
            btrim(kdc22601.c3) AS cuenta
           FROM kepler_ods.kdc22601
          WHERE btrim(COALESCE(kdc22601.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22602.c14) AS suc,
            kdc22602.c17::text AS dt,
            btrim(kdc22602.c19) AS folio,
            btrim(kdc22602.c3) AS cuenta
           FROM kepler_ods.kdc22602
          WHERE btrim(COALESCE(kdc22602.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22603.c14) AS suc,
            kdc22603.c17::text AS dt,
            btrim(kdc22603.c19) AS folio,
            btrim(kdc22603.c3) AS cuenta
           FROM kepler_ods.kdc22603
          WHERE btrim(COALESCE(kdc22603.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22604.c14) AS suc,
            kdc22604.c17::text AS dt,
            btrim(kdc22604.c19) AS folio,
            btrim(kdc22604.c3) AS cuenta
           FROM kepler_ods.kdc22604
          WHERE btrim(COALESCE(kdc22604.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22605.c14) AS suc,
            kdc22605.c17::text AS dt,
            btrim(kdc22605.c19) AS folio,
            btrim(kdc22605.c3) AS cuenta
           FROM kepler_ods.kdc22605
          WHERE btrim(COALESCE(kdc22605.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22606.c14) AS suc,
            kdc22606.c17::text AS dt,
            btrim(kdc22606.c19) AS folio,
            btrim(kdc22606.c3) AS cuenta
           FROM kepler_ods.kdc22606
          WHERE btrim(COALESCE(kdc22606.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22607.c14) AS suc,
            kdc22607.c17::text AS dt,
            btrim(kdc22607.c19) AS folio,
            btrim(kdc22607.c3) AS cuenta
           FROM kepler_ods.kdc22607
          WHERE btrim(COALESCE(kdc22607.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22608.c14) AS suc,
            kdc22608.c17::text AS dt,
            btrim(kdc22608.c19) AS folio,
            btrim(kdc22608.c3) AS cuenta
           FROM kepler_ods.kdc22608
          WHERE btrim(COALESCE(kdc22608.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22609.c14) AS suc,
            kdc22609.c17::text AS dt,
            btrim(kdc22609.c19) AS folio,
            btrim(kdc22609.c3) AS cuenta
           FROM kepler_ods.kdc22609
          WHERE btrim(COALESCE(kdc22609.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22610.c14) AS suc,
            kdc22610.c17::text AS dt,
            btrim(kdc22610.c19) AS folio,
            btrim(kdc22610.c3) AS cuenta
           FROM kepler_ods.kdc22610
          WHERE btrim(COALESCE(kdc22610.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22612.c14) AS suc,
            kdc22612.c17::text AS dt,
            btrim(kdc22612.c19) AS folio,
            btrim(kdc22612.c3) AS cuenta
           FROM kepler_ods.kdc22612
          WHERE btrim(COALESCE(kdc22612.c19, ''::text)) <> ''::text
        ), res AS (
         SELECT d.entidad_code,
            d.tipo,
            count(DISTINCT g.cuenta)::integer AS n_cta,
            min(g.cuenta) AS cuenta
           FROM d
             LEFT JOIN gl g ON g.suc = d.sucursal AND g.dt = d.dt_dest AND g.folio = d.folio_dest AND g.cuenta !~~ '102%'::text AND g.cuenta !~~ '122%'::text AND (g.cuenta <> ALL (ARRAY['201'::text, '203'::text, '210-001'::text]))
          WHERE d.n_dest = 1
          GROUP BY d.entidad_code, d.tipo, d.sucursal, d.doc_tipo, d.folio
         HAVING count(DISTINCT g.cuenta) = 1
        ), conteo AS (
         SELECT res.entidad_code,
            min(res.tipo) AS tipo,
            res.cuenta,
            count(*)::integer AS n
           FROM res
          WHERE res.cuenta IS NOT NULL
          GROUP BY res.entidad_code, res.cuenta
        ), rank AS (
         SELECT conteo.entidad_code,
            conteo.tipo,
            conteo.cuenta,
            conteo.n,
            sum(conteo.n) OVER (PARTITION BY conteo.entidad_code)::integer AS total,
            count(*) OVER (PARTITION BY conteo.entidad_code)::integer AS cuentas_vistas,
            row_number() OVER (PARTITION BY conteo.entidad_code ORDER BY conteo.n DESC, conteo.cuenta) AS rk
           FROM conteo
        ), norm AS (
         SELECT DISTINCT v_caja_movimientos_pendientes.entidad_code,
            btrim(regexp_replace(upper(translate(v_caja_movimientos_pendientes.beneficiario, 'ÁÉÍÓÚÜÑ'::text, 'AEIOUUN'::text)), '[^A-Z0-9]+'::text, ' '::text, 'g'::text)) AS nb
           FROM finance.v_caja_movimientos_pendientes
          WHERE v_caja_movimientos_pendientes.entidad_code IS NOT NULL AND v_caja_movimientos_pendientes.beneficiario IS NOT NULL
        ), kname AS (
         SELECT DISTINCT v_kepler_conceptos.cuenta,
            v_kepler_conceptos.concepto,
            v_kepler_conceptos.concepto_nombre,
            btrim(regexp_replace(upper(translate(v_kepler_conceptos.concepto_nombre, 'ÁÉÍÓÚÜÑ'::text, 'AEIOUUN'::text)), '[^A-Z0-9]+'::text, ' '::text, 'g'::text)) AS nk
           FROM analytics.v_kepler_conceptos
          WHERE length(btrim(v_kepler_conceptos.concepto_nombre)) >= 12
        ), por_nombre AS (
         SELECT n.entidad_code,
            min(k.cuenta) AS cuenta,
            min(k.concepto) AS concepto
           FROM norm n
             JOIN kname k ON n.nb ~~ (('%'::text || k.nk) || '%'::text)
          GROUP BY n.entidad_code
         HAVING count(*) = 1
        ), hist_cta AS (
         SELECT z.cuenta, z.concepto, z.n, z.total
           FROM ( SELECT l.kepler_cuenta AS cuenta,
                         l.kepler_concepto AS concepto,
                         count(*)::integer AS n,
                         sum(count(*)) OVER (PARTITION BY l.kepler_cuenta)::integer AS total,
                         row_number() OVER (PARTITION BY l.kepler_cuenta ORDER BY count(*) DESC, l.kepler_concepto) AS rk
                    FROM finance.cash_ledger l
                   WHERE l.deleted_at IS NULL AND l.estado <> 'cancelado'::text
                     AND l.kepler_cuenta IS NOT NULL AND l.kepler_concepto IS NOT NULL
                   GROUP BY l.kepler_cuenta, l.kepler_concepto) z
          WHERE z.rk = 1 AND z.total >= 3 AND z.n::numeric / NULLIF(z.total, 0)::numeric >= 0.8
        )
 SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    r.entidad_code,
    r.tipo,
    COALESCE(pn.cuenta, r.cuenta) AS kepler_cuenta,
    r.n AS support,
    r.total,
    r.cuentas_vistas,
    round(r.n::numeric / NULLIF(r.total, 0)::numeric, 4) AS support_ratio,
    COALESCE(pn.concepto, ( SELECT min(v.concepto) AS min
           FROM analytics.v_kepler_conceptos v
          WHERE v.cuenta = COALESCE(pn.cuenta, r.cuenta)
         HAVING count(DISTINCT v.concepto) = 1), hc.concepto) AS kepler_concepto,
        CASE
            WHEN pn.concepto IS NOT NULL THEN 'catalogo'::text
            WHEN ( SELECT min(v.concepto) AS min
                     FROM analytics.v_kepler_conceptos v
                    WHERE v.cuenta = COALESCE(pn.cuenta, r.cuenta)
                   HAVING count(DISTINCT v.concepto) = 1) IS NOT NULL THEN 'cuenta_unica'::text
            WHEN hc.concepto IS NOT NULL THEN 'historial_cuenta'::text
            ELSE NULL::text
        END AS concepto_origen,
    hc.n AS concepto_support,
    hc.total AS concepto_total,
        CASE
            WHEN pn.cuenta IS NOT NULL THEN 'catalogo'::text
            WHEN r.cuentas_vistas = 1 THEN 'unanime'::text
            WHEN (r.n::numeric / NULLIF(r.total, 0)::numeric) >= 0.8 THEN 'dominante'::text
            ELSE 'disperso'::text
        END AS veredicto
   FROM rank r
     LEFT JOIN por_nombre pn ON pn.entidad_code = r.entidad_code
     LEFT JOIN hist_cta hc ON hc.cuenta = COALESCE(pn.cuenta, r.cuenta)
  WHERE r.rk = 1`;

/** La definición EXACTA que había antes, tal como `pg_get_viewdef` la devolvió el 2026-10-19. */
const DEF_VIEJA = `WITH p AS (
         SELECT v_caja_movimientos_pendientes.sucursal,
            v_caja_movimientos_pendientes.doc_tipo,
            v_caja_movimientos_pendientes.folio,
            v_caja_movimientos_pendientes.entidad_code,
            v_caja_movimientos_pendientes.tipo,
            split_part(v_caja_movimientos_pendientes.doc_tipo, '-'::text, 3) AS tnum
           FROM finance.v_caja_movimientos_pendientes
          WHERE v_caja_movimientos_pendientes.entidad_code IS NOT NULL
        ), d AS (
         SELECT p.entidad_code,
            p.sucursal,
            p.doc_tipo,
            p.folio,
            p.tipo,
            min(f.c7::text) AS dt_dest,
            min(btrim(f.c9)) AS folio_dest,
            count(DISTINCT (f.c7::text || '-'::text) || btrim(f.c9))::integer AS n_dest
           FROM p
             LEFT JOIN kepler_ods.kdxf f ON btrim(f.c1) = p.sucursal AND f.c4::text = p.tnum AND f.c5 = 1::numeric AND btrim(f.c6) = p.folio
          GROUP BY p.entidad_code, p.sucursal, p.doc_tipo, p.folio, p.tipo
        ), gl AS (
         SELECT btrim(kdc22408.c14) AS suc,
            kdc22408.c17::text AS dt,
            btrim(kdc22408.c19) AS folio,
            btrim(kdc22408.c3) AS cuenta
           FROM kepler_ods.kdc22408
          WHERE btrim(COALESCE(kdc22408.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22501.c14) AS suc,
            kdc22501.c17::text AS dt,
            btrim(kdc22501.c19) AS folio,
            btrim(kdc22501.c3) AS cuenta
           FROM kepler_ods.kdc22501
          WHERE btrim(COALESCE(kdc22501.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22502.c14) AS suc,
            kdc22502.c17::text AS dt,
            btrim(kdc22502.c19) AS folio,
            btrim(kdc22502.c3) AS cuenta
           FROM kepler_ods.kdc22502
          WHERE btrim(COALESCE(kdc22502.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22503.c14) AS suc,
            kdc22503.c17::text AS dt,
            btrim(kdc22503.c19) AS folio,
            btrim(kdc22503.c3) AS cuenta
           FROM kepler_ods.kdc22503
          WHERE btrim(COALESCE(kdc22503.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22504.c14) AS suc,
            kdc22504.c17::text AS dt,
            btrim(kdc22504.c19) AS folio,
            btrim(kdc22504.c3) AS cuenta
           FROM kepler_ods.kdc22504
          WHERE btrim(COALESCE(kdc22504.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22505.c14) AS suc,
            kdc22505.c17::text AS dt,
            btrim(kdc22505.c19) AS folio,
            btrim(kdc22505.c3) AS cuenta
           FROM kepler_ods.kdc22505
          WHERE btrim(COALESCE(kdc22505.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22506.c14) AS suc,
            kdc22506.c17::text AS dt,
            btrim(kdc22506.c19) AS folio,
            btrim(kdc22506.c3) AS cuenta
           FROM kepler_ods.kdc22506
          WHERE btrim(COALESCE(kdc22506.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22507.c14) AS suc,
            kdc22507.c17::text AS dt,
            btrim(kdc22507.c19) AS folio,
            btrim(kdc22507.c3) AS cuenta
           FROM kepler_ods.kdc22507
          WHERE btrim(COALESCE(kdc22507.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22508.c14) AS suc,
            kdc22508.c17::text AS dt,
            btrim(kdc22508.c19) AS folio,
            btrim(kdc22508.c3) AS cuenta
           FROM kepler_ods.kdc22508
          WHERE btrim(COALESCE(kdc22508.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22509.c14) AS suc,
            kdc22509.c17::text AS dt,
            btrim(kdc22509.c19) AS folio,
            btrim(kdc22509.c3) AS cuenta
           FROM kepler_ods.kdc22509
          WHERE btrim(COALESCE(kdc22509.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22510.c14) AS suc,
            kdc22510.c17::text AS dt,
            btrim(kdc22510.c19) AS folio,
            btrim(kdc22510.c3) AS cuenta
           FROM kepler_ods.kdc22510
          WHERE btrim(COALESCE(kdc22510.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22511.c14) AS suc,
            kdc22511.c17::text AS dt,
            btrim(kdc22511.c19) AS folio,
            btrim(kdc22511.c3) AS cuenta
           FROM kepler_ods.kdc22511
          WHERE btrim(COALESCE(kdc22511.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22512.c14) AS suc,
            kdc22512.c17::text AS dt,
            btrim(kdc22512.c19) AS folio,
            btrim(kdc22512.c3) AS cuenta
           FROM kepler_ods.kdc22512
          WHERE btrim(COALESCE(kdc22512.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22601.c14) AS suc,
            kdc22601.c17::text AS dt,
            btrim(kdc22601.c19) AS folio,
            btrim(kdc22601.c3) AS cuenta
           FROM kepler_ods.kdc22601
          WHERE btrim(COALESCE(kdc22601.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22602.c14) AS suc,
            kdc22602.c17::text AS dt,
            btrim(kdc22602.c19) AS folio,
            btrim(kdc22602.c3) AS cuenta
           FROM kepler_ods.kdc22602
          WHERE btrim(COALESCE(kdc22602.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22603.c14) AS suc,
            kdc22603.c17::text AS dt,
            btrim(kdc22603.c19) AS folio,
            btrim(kdc22603.c3) AS cuenta
           FROM kepler_ods.kdc22603
          WHERE btrim(COALESCE(kdc22603.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22604.c14) AS suc,
            kdc22604.c17::text AS dt,
            btrim(kdc22604.c19) AS folio,
            btrim(kdc22604.c3) AS cuenta
           FROM kepler_ods.kdc22604
          WHERE btrim(COALESCE(kdc22604.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22605.c14) AS suc,
            kdc22605.c17::text AS dt,
            btrim(kdc22605.c19) AS folio,
            btrim(kdc22605.c3) AS cuenta
           FROM kepler_ods.kdc22605
          WHERE btrim(COALESCE(kdc22605.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22606.c14) AS suc,
            kdc22606.c17::text AS dt,
            btrim(kdc22606.c19) AS folio,
            btrim(kdc22606.c3) AS cuenta
           FROM kepler_ods.kdc22606
          WHERE btrim(COALESCE(kdc22606.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22607.c14) AS suc,
            kdc22607.c17::text AS dt,
            btrim(kdc22607.c19) AS folio,
            btrim(kdc22607.c3) AS cuenta
           FROM kepler_ods.kdc22607
          WHERE btrim(COALESCE(kdc22607.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22608.c14) AS suc,
            kdc22608.c17::text AS dt,
            btrim(kdc22608.c19) AS folio,
            btrim(kdc22608.c3) AS cuenta
           FROM kepler_ods.kdc22608
          WHERE btrim(COALESCE(kdc22608.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22609.c14) AS suc,
            kdc22609.c17::text AS dt,
            btrim(kdc22609.c19) AS folio,
            btrim(kdc22609.c3) AS cuenta
           FROM kepler_ods.kdc22609
          WHERE btrim(COALESCE(kdc22609.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22610.c14) AS suc,
            kdc22610.c17::text AS dt,
            btrim(kdc22610.c19) AS folio,
            btrim(kdc22610.c3) AS cuenta
           FROM kepler_ods.kdc22610
          WHERE btrim(COALESCE(kdc22610.c19, ''::text)) <> ''::text
        UNION ALL
         SELECT btrim(kdc22612.c14) AS suc,
            kdc22612.c17::text AS dt,
            btrim(kdc22612.c19) AS folio,
            btrim(kdc22612.c3) AS cuenta
           FROM kepler_ods.kdc22612
          WHERE btrim(COALESCE(kdc22612.c19, ''::text)) <> ''::text
        ), res AS (
         SELECT d.entidad_code,
            d.tipo,
            count(DISTINCT g.cuenta)::integer AS n_cta,
            min(g.cuenta) AS cuenta
           FROM d
             LEFT JOIN gl g ON g.suc = d.sucursal AND g.dt = d.dt_dest AND g.folio = d.folio_dest AND g.cuenta !~~ '102%'::text AND g.cuenta !~~ '122%'::text AND (g.cuenta <> ALL (ARRAY['201'::text, '203'::text, '210-001'::text]))
          WHERE d.n_dest = 1
          GROUP BY d.entidad_code, d.tipo, d.sucursal, d.doc_tipo, d.folio
         HAVING count(DISTINCT g.cuenta) = 1
        ), conteo AS (
         SELECT res.entidad_code,
            min(res.tipo) AS tipo,
            res.cuenta,
            count(*)::integer AS n
           FROM res
          WHERE res.cuenta IS NOT NULL
          GROUP BY res.entidad_code, res.cuenta
        ), rank AS (
         SELECT conteo.entidad_code,
            conteo.tipo,
            conteo.cuenta,
            conteo.n,
            sum(conteo.n) OVER (PARTITION BY conteo.entidad_code)::integer AS total,
            count(*) OVER (PARTITION BY conteo.entidad_code)::integer AS cuentas_vistas,
            row_number() OVER (PARTITION BY conteo.entidad_code ORDER BY conteo.n DESC, conteo.cuenta) AS rk
           FROM conteo
        ), norm AS (
         SELECT DISTINCT v_caja_movimientos_pendientes.entidad_code,
            btrim(regexp_replace(upper(translate(v_caja_movimientos_pendientes.beneficiario, 'ÁÉÍÓÚÜÑ'::text, 'AEIOUUN'::text)), '[^A-Z0-9]+'::text, ' '::text, 'g'::text)) AS nb
           FROM finance.v_caja_movimientos_pendientes
          WHERE v_caja_movimientos_pendientes.entidad_code IS NOT NULL AND v_caja_movimientos_pendientes.beneficiario IS NOT NULL
        ), kname AS (
         SELECT DISTINCT v_kepler_conceptos.cuenta,
            v_kepler_conceptos.concepto,
            v_kepler_conceptos.concepto_nombre,
            btrim(regexp_replace(upper(translate(v_kepler_conceptos.concepto_nombre, 'ÁÉÍÓÚÜÑ'::text, 'AEIOUUN'::text)), '[^A-Z0-9]+'::text, ' '::text, 'g'::text)) AS nk
           FROM analytics.v_kepler_conceptos
          WHERE length(btrim(v_kepler_conceptos.concepto_nombre)) >= 12
        ), por_nombre AS (
         SELECT n.entidad_code,
            min(k.cuenta) AS cuenta,
            min(k.concepto) AS concepto
           FROM norm n
             JOIN kname k ON n.nb ~~ (('%'::text || k.nk) || '%'::text)
          GROUP BY n.entidad_code
         HAVING count(*) = 1
        )
 SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    r.entidad_code,
    r.tipo,
    COALESCE(pn.cuenta, r.cuenta) AS kepler_cuenta,
    r.n AS support,
    r.total,
    r.cuentas_vistas,
    round(r.n::numeric / NULLIF(r.total, 0)::numeric, 4) AS support_ratio,
    COALESCE(pn.concepto, ( SELECT min(v.concepto) AS min
           FROM analytics.v_kepler_conceptos v
          WHERE v.cuenta = r.cuenta
         HAVING count(DISTINCT v.concepto) = 1)) AS kepler_concepto,
        CASE
            WHEN pn.cuenta IS NOT NULL THEN 'catalogo'::text
            WHEN r.cuentas_vistas = 1 THEN 'unanime'::text
            WHEN (r.n::numeric / NULLIF(r.total, 0)::numeric) >= 0.8 THEN 'dominante'::text
            ELSE 'disperso'::text
        END AS veredicto
   FROM rank r
     LEFT JOIN por_nombre pn ON pn.entidad_code = r.entidad_code
  WHERE r.rk = 1`;

async function recrear(knex, def) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);

  // ⛔ `GOTCHAS §87.1` — `CREATE MATERIALIZED VIEW` **POBLA en el acto**, y `def` lee
  // `finance.v_caja_movimientos_pendientes`, cuyo `WHERE` incluye `tenant_id = current_tenant_id()`.
  // Esa función sale de `current_setting('app.tenant_id')`, que en una sesión de migración **no está
  // puesta**: devuelve NULL, el `WHERE` no casa con nada y la matvista nace con CERO filas **sin un
  // solo error**. Medido el 2026-10-19: esta migración abortó con «pasó de 285 a 0 filas» — su propia
  // guarda la atrapó, que es justo para lo que estaba.
  //
  // El tenant NO se escribe a mano: se lee de lo que la matvista YA tiene, así que la migración no
  // puede quedar clavada a un tenant que mañana no sea el único.
  const tenants = (await knex.raw(`SELECT DISTINCT tenant_id::text AS t FROM ${MV}`)).rows;
  if (tenants.length !== 1) {
    throw new Error(
      `[A.17] la matvista tiene ${tenants.length} tenant(s); un solo SET no los puebla a todos. ABORTA.`,
    );
  }
  // ⚠️ `set_config(...)` y NO `SET LOCAL app.tenant_id = ?`: una sentencia `SET` **no admite
  // parámetros ligados** — Postgres la rechaza con `42601`. `set_config` es una función, así que
  // sí los acepta, y su tercer argumento `true` significa LOCAL (se revierte al cerrar la tx).
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenants[0].t]);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS ${def}`);
  // Sin este índice, `REFRESH ... CONCURRENTLY` falla y el refrescador queda bloqueando lectores.
  await knex.raw(`CREATE UNIQUE INDEX ${IDX} ON ${MV} USING btree (tenant_id, entidad_code)`);
}

exports.up = async function up(knex) {
  const [antes] = (await knex.raw(
    `SELECT count(*)::int total, count(kepler_concepto)::int con FROM ${MV}`)).rows;

  await recrear(knex, DEF_NUEVA);

  const [despues] = (await knex.raw(
    `SELECT count(*)::int total, count(kepler_concepto)::int con,
            count(*) FILTER (WHERE kepler_concepto IS NOT NULL AND veredicto <> 'disperso')::int usables
       FROM ${MV}`)).rows;

  // ⛔ Un commit que cambia un número no cierra sin el antes/después. Y si el universo se
  // ENCOGIÓ, algo se rompió: se aborta en vez de publicar menos filas en silencio.
  if (despues.total < antes.total) {
    throw new Error(`[A.17] la matvista pasó de ${antes.total} a ${despues.total} filas. ABORTA.`);
  }
  if (despues.con < antes.con) {
    throw new Error(`[A.17] los conceptos bajaron de ${antes.con} a ${despues.con}. ABORTA.`);
  }
  console.log(`[A.17] filas ${antes.total} -> ${despues.total} · con concepto ${antes.con} -> ${despues.con}`
    + ` · utilizables ${despues.usables}`);
};

/** Vuelve a la definición anterior, textual. */
exports.down = async function down(knex) {
  await recrear(knex, DEF_VIEJA);
};
