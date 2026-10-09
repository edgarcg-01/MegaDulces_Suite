/**
 * `[CXC.22]` **Cobranza prevista por semana — un solo resolvedor, y declara qué NO ve.**
 *
 * Esta consulta estaba **copiada a mano en dos servicios** (`budget-cashflow.service.ts` y
 * `budget-capacity.service.ts`), idéntica hasta el `date_trunc`. Es exactamente el primitivo
 * inventado dos veces que ADR-056 manda subir a `libs/` compartido: si una de las dos se
 * corrige y la otra no, dos pantallas de finanzas proyectan cobros distintos sin que nadie lo
 * note.
 *
 * ── DOS CORRECCIONES, LAS DOS MEDIDAS CONTRA PROD (2026-09-24) ────────────────────────────
 *
 * **1. Se usa `saldo_ajustado`, no `saldo_documento`.** La cartera publica TRES cifras del
 * mismo concepto y no son versiones rivales: son preguntas distintas, y el puente cierra al
 * centavo —
 *
 *     saldo_documento   62,370,011.28   ¿cuánto hay abierto en documentos?
 *      − remanente       3,061,125.61   abonos que YA entraron y ningún documento absorbió
 *      + sin documento     462,557.11   12 clientes que deben sin documento abierto
 *      = positivos      59,771,442.78
 *      − a favor         1,656,827.97   176 clientes con saldo a SU favor
 *      = saldo_cliente  58,114,614.81   ¿cuánto nos deben en neto?
 *
 *     saldo_ajustado    59,308,885.67 = positivos − sin documento   ¿cuánto hay que SALIR a cobrar?
 *
 * Proyectar con `saldo_documento` cuenta dos veces los $3.06M de remanente: ese dinero ya está
 * en el banco. ⚠️ El efecto en la ventana hacia adelante es **chico y hay que decirlo así**:
 * **$27,272.85 sobre $8.01M en 12 semanas (0.3%)**, porque el remanente cae sobre los
 * documentos MÁS VIEJOS, no sobre los que vencen mañana. Se corrige porque es lo correcto por
 * definición, no porque mueva la aguja.
 *
 * **2. ⭐ La ventana hacia adelante ve el 13.5% de la cartera, y eso se DECLARA.** Agendar por
 * `vencimiento BETWEEN from AND to` con `from = hoy` deja fuera **$51,295,140.89 en 6,109
 * documentos (86.5%)** que ya vencieron. En una cartera 89.7% vencida, una curva de flujo que
 * no dice eso se lee como *"esto es toda la cobranza que viene"* — y da por no-cobrable justo
 * lo que se cobra todos los días.
 *
 * ⛔ **No se mete lo vencido dentro de la primera semana.** Eso afirmaría que se cobra completo
 * el lunes, que es inventar una fecha. Se devuelve **aparte, con su monto**, para que la
 * pantalla lo muestre como lo que es: exigible hoy, sin fecha comprometida.
 */

export interface CobranzaCobertura {
  /** Lo que sí cae dentro de `[from, to]` por su vencimiento. Es lo que la curva dibuja. */
  en_ventana: number;
  /** ⭐ Cartera cobrable cuyo vencimiento ya pasó: exigible, sin fecha. La curva NO la dibuja. */
  vencido_fuera: number;
  /** Vence después de `to`. */
  posterior: number;
  /** Cobrable sin fecha de vencimiento en el ERP. Ausencia declarada, no cero. */
  sin_vencimiento: number;
  total: number;
  /** Qué porción del total cobrable representa la curva. `null` si no hay cartera. */
  pct_en_ventana: number | null;
}

/**
 * `[TES.11]` **De cuántos depende lo que la curva proyecta.**
 *
 * Una curva de cobranza con el mismo total puede ser dos negocios distintos: repartida entre
 * cientos de clientes, o colgada de cinco. Medido contra prod el 2026-10-09: **los 5 mayores
 * concentran el 42.4 % de la cartera y los 20 mayores el 53.8 %, sobre 1,163 clientes**.
 *
 * ⛔ Eso no es una cifra de color: es **el riesgo real del pronóstico**. Si uno de esos cinco
 * atrasa, la proyección se cae — y hasta hoy ningún número en pantalla lo decía. Se mide sobre
 * lo que **la curva dibuja** (lo que vence en la ventana), no sobre la cartera entera: el riesgo
 * es que lo proyectado dependa de pocos, y lo proyectado es la ventana.
 */
export interface Concentracion {
  /** Cuántos clientes sostienen la ventana. */
  n: number;
  /** % del mayor **dentro de la ventana**. `null` si no hay con qué medirlo — nunca 0. */
  top1_pct: number | null;
  top5_pct: number | null;
  /** Cuántos clientes componen la masa vencida. */
  n_vencido: number;
  /** ⭐ % de los 5 mayores **en lo VENCIDO**: ahí es donde el riesgo vive de verdad. */
  vencido_top5_pct: number | null;
}

export interface CobranzaPrevista {
  porSemana: { bucket: string; monto: number }[];
  cobertura: CobranzaCobertura;
  concentracion: Concentracion;
  as_of: string | null;
  /** La columna que se sumó. Viaja con el dato para que la pantalla no tenga que suponerlo. */
  base: 'saldo_ajustado';
}

const SQL = `
  WITH v AS MATERIALIZED (
    SELECT cliente_code, vencimiento, saldo_ajustado, computed_at
      FROM analytics.customer_receivables
     WHERE tenant_id = ?
  ),
  -- [TES.11] Concentración en UNA sola pasada y con DOS respuestas, porque la pregunta tiene
  -- dos: de cuántos depende lo que la curva dibuja, y de cuántos depende la masa que declara
  -- que NO puede fechar. Medido el 2026-10-09 y son universos distintos: en la ventana los 5
  -- mayores son el 15.7 % sobre 217 clientes; en lo vencido son el **48.2 %** sobre 1,095.
  -- ⇒ El riesgo de concentración NO vive en el pronóstico: vive en lo vencido.
  conc AS (
    SELECT cliente_code,
           sum(saldo_ajustado) FILTER (WHERE vencimiento BETWEEN ?::date AND ?::date) AS m_ven,
           sum(saldo_ajustado) FILTER (WHERE vencimiento < ?::date)                   AS m_vcd
      FROM v WHERE saldo_ajustado > 0
     GROUP BY 1
  )
  SELECT
    (SELECT max(computed_at) FROM v) AS as_of,
    (SELECT jsonb_build_object(
        'n',          count(*) FILTER (WHERE m_ven > 0),
        'top1_pct',   round(100.0 * COALESCE((SELECT sum(m_ven) FROM (SELECT m_ven FROM conc WHERE m_ven > 0 ORDER BY m_ven DESC LIMIT 1) a), 0) / NULLIF(sum(m_ven), 0), 1),
        'top5_pct',   round(100.0 * COALESCE((SELECT sum(m_ven) FROM (SELECT m_ven FROM conc WHERE m_ven > 0 ORDER BY m_ven DESC LIMIT 5) b), 0) / NULLIF(sum(m_ven), 0), 1),
        'n_vencido',  count(*) FILTER (WHERE m_vcd > 0),
        'vencido_top5_pct', round(100.0 * COALESCE((SELECT sum(m_vcd) FROM (SELECT m_vcd FROM conc WHERE m_vcd > 0 ORDER BY m_vcd DESC LIMIT 5) c), 0) / NULLIF(sum(m_vcd), 0), 1))
       FROM conc) AS concentracion,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', s.b, 'monto', s.m) ORDER BY s.b)
                FROM (SELECT date_trunc('week', vencimiento)::date AS b,
                             round(sum(saldo_ajustado), 2) AS m
                        FROM v
                       WHERE saldo_ajustado > 0
                         AND vencimiento BETWEEN ?::date AND ?::date
                       GROUP BY 1) s), '[]'::jsonb) AS por_semana,
    (SELECT jsonb_build_object(
        'en_ventana',      round(COALESCE(sum(saldo_ajustado) FILTER (
                             WHERE vencimiento BETWEEN ?::date AND ?::date), 0), 2),
        'vencido_fuera',   round(COALESCE(sum(saldo_ajustado) FILTER (
                             WHERE vencimiento < ?::date), 0), 2),
        'posterior',       round(COALESCE(sum(saldo_ajustado) FILTER (
                             WHERE vencimiento > ?::date), 0), 2),
        'sin_vencimiento', round(COALESCE(sum(saldo_ajustado) FILTER (
                             WHERE vencimiento IS NULL), 0), 2),
        'total',           round(COALESCE(sum(saldo_ajustado), 0), 2))
       FROM v WHERE saldo_ajustado > 0) AS cobertura`;

/**
 * Devuelve la cobranza prevista por semana **y su cobertura**. Una sola pasada por la vista:
 * los baldes y los totales salen del mismo `MATERIALIZED`, así que no pueden discrepar entre sí.
 */
export async function cobranzaPrevista(
  trx: any, tenantId: string, from: string, to: string,
): Promise<CobranzaPrevista> {
  // ⚠️ El orden importa y no es obvio: el CTE `conc` metió TRES `?` (from, to, from) ENTRE el
  // tenant y los que ya estaban. Un binding de más o de menos acá no revienta — devuelve otra
  // ventana EN SILENCIO, que es la peor forma de fallar.
  const r = await trx.raw(SQL, [tenantId, from, to, from, from, to, from, to, from, to]);
  const row = (r.rows || r)[0] || {};
  const cob = row.cobertura || {};
  const cn = row.concentracion || {};
  // Sin clientes en la ventana la concentración es DESCONOCIDA, no 0%: un 0 se leería como
  // «está bien repartida» cuando lo que pasa es que no hay con qué medirla.
  const pct = (v: unknown) => (v == null ? null : Number(v));
  const total = Number(cob.total) || 0;
  const en = Number(cob.en_ventana) || 0;
  return {
    porSemana: ((row.por_semana as any[]) || []).map((x) => ({
      bucket: String(x.bucket).slice(0, 10), monto: Number(x.monto) || 0,
    })),
    cobertura: {
      en_ventana: en,
      vencido_fuera: Number(cob.vencido_fuera) || 0,
      posterior: Number(cob.posterior) || 0,
      sin_vencimiento: Number(cob.sin_vencimiento) || 0,
      total,
      // Sin cartera la cobertura es DESCONOCIDA, no 0%: un 0% se leería como "no hay nada que
      // cobrar" cuando lo que pasa es que no hay con qué medirlo.
      pct_en_ventana: total > 0 ? Math.round((en / total) * 1000) / 10 : null,
    },
    concentracion: {
      n: Number(cn.n) || 0, top1_pct: pct(cn.top1_pct), top5_pct: pct(cn.top5_pct),
      n_vencido: Number(cn.n_vencido) || 0, vencido_top5_pct: pct(cn.vencido_top5_pct),
    },
    as_of: row.as_of ? new Date(row.as_of).toISOString() : null,
    base: 'saldo_ajustado',
  };
}
