/**
 * `[PQ.132]` **Las temporada-año que entraron a la cola «por confirmar»**, como tabla derivada para la bandeja
 * «Temporadas por confirmar» de «Mi trabajo». Vive aparte para que el texto que corre en producción sea el
 * MISMO que se mide contra prod (mismo patrón que `anticipos-sin-factura.sql.ts`).
 *
 * Una `catalog.season_dates` viva de una temporada activa ENTRA a la cola cuando su venta empieza en 45 días o
 * menos (o ya empezó), y está ABIERTA mientras sus fechas sigan `propuesta` y su venta **no haya terminado**
 * (`vigente`). Lo propuesto no frena nada (PQ.94, ADR-056): sólo lo confirmado llega al pedido, y por eso una
 * temporada en venta con fechas propuestas es trabajo de alguien.
 *
 * ⛔ **La base NO se corta por fin de venta; `vigente` pesa sólo del lado abierto** (`abiertaExtra` en la
 *    bandeja, regla `[SN.36]` de `EjesCola`). Con el corte en la base, una temporada confirmada el 1-dic
 *    salía de la tabla el 25-dic y `cerradas_30d` caía a 0 con otra todavía abierta: la bandeja se habría
 *    declarado `congelada` trabajándose (lo encontró la revisión independiente del PR).
 * ⛔ Y sólo cuenta lo que de verdad estuvo en la cola:
 *    · se registró ANTES de que terminara su venta (las de 2025 que se cargaron el 10-nov-2026 nunca fueron
 *      trabajo: sin esto inflarían `entradas_30d`);
 *    · si está confirmada, se confirmó DESPUÉS de entrar (una confirmada antes de abrir su ventana nunca
 *      estuvo en la cola, y contarla como salida inventaría trabajo hecho).
 *
 * ⭐ **45 días** es POLÍTICA, no medición (tracker `[PQ.132]`): el margen para que la confirmación llegue
 *    antes del pedido de temporada. Se cambia en `TEMPORADAS_VENTANA_DIAS` y en nada más. Medido en prod el
 *    2026-11-20: Navidad 2026 está en venta desde el 20-oct con las fechas propuestas, y San Valentín 2027
 *    (que empezaría el 5-ene) todavía no tiene fila.
 * ⛔ Una temporada-año **sin fila** no aparece aquí: no hay nada que confirmar, falta proponerla. Es otra
 *    deuda (las de 2027, plan PQ §19), y contarla aquí inventaría una cola que la pantalla no puede vaciar.
 *
 * `entro` = el momento en que la fila entró a la cola: 45 días antes de que empiece la venta o cuando se
 * registró, lo que haya pasado DESPUÉS (las 14 de hoy se registraron el 10-nov, con Navidad ya en venta).
 *
 * ⚠️ Las fechas de venta salen como TEXTO (`to_char`): un `date` de node-pg llega como medianoche LOCAL y
 *    se corre un día en un proceso con otra zona (mismo aviso que `temporadas.repo.ts`).
 *
 * No usa `catalog.v_season_candidates` (0.4–1.6 s por temporada-año): esta cola corre en cada carga de la
 * portada.
 *
 * Parámetros: `[tenant_id, tenant_id]`.
 */
/** `[PQ.132]` Cuántos días antes de empezar la venta entra una temporada a la cola. Política, no medición. */
export const TEMPORADAS_VENTANA_DIAS = 45;

export const SQL_TEMPORADAS_EN_VENTANA = `(
  SELECT d.id, d.status, d.confirmed_at, d.year, s.name AS temporada,
         to_char(d.sale_from, 'YYYY-MM-DD') AS venta_desde,
         to_char(d.sale_to, 'YYYY-MM-DD') AS venta_hasta,
         d.sale_from <= (now() AT TIME ZONE 'America/Mexico_City')::date AS en_venta,
         d.sale_to >= (now() AT TIME ZONE 'America/Mexico_City')::date AS vigente,
         e.entro,
         (SELECT count(*) FROM catalog.season_products sp
           WHERE sp.tenant_id = ?::uuid AND sp.season_id = d.season_id AND sp.deleted_at IS NULL
             AND sp.decision = 'confirmada' AND (sp.only_year IS NULL OR sp.only_year = d.year))::int AS productos_confirmados
    FROM catalog.season_dates d
    JOIN catalog.seasons s
      ON s.tenant_id = d.tenant_id AND s.id = d.season_id AND s.deleted_at IS NULL AND s.active
    CROSS JOIN LATERAL (
      SELECT greatest(d.created_at, ((d.sale_from - ${TEMPORADAS_VENTANA_DIAS})::timestamp AT TIME ZONE 'America/Mexico_City')) AS entro
    ) e
   WHERE d.tenant_id = ?::uuid AND d.deleted_at IS NULL
     AND d.sale_from <= (now() AT TIME ZONE 'America/Mexico_City')::date + ${TEMPORADAS_VENTANA_DIAS}
     AND e.entro < ((d.sale_to + 1)::timestamp AT TIME ZONE 'America/Mexico_City')
     AND (d.status = 'propuesta' OR d.confirmed_at >= e.entro)
) AS temporadas`;
