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

export interface CobranzaPrevista {
  porSemana: { bucket: string; monto: number }[];
  cobertura: CobranzaCobertura;
  as_of: string | null;
  /** La columna que se sumó. Viaja con el dato para que la pantalla no tenga que suponerlo. */
  base: 'saldo_ajustado';
}

const SQL = `
  WITH v AS MATERIALIZED (
    SELECT vencimiento, saldo_ajustado, computed_at
      FROM analytics.customer_receivables
     WHERE tenant_id = ?
  )
  SELECT
    (SELECT max(computed_at) FROM v) AS as_of,
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
  const r = await trx.raw(SQL, [tenantId, from, to, from, to, from, to]);
  const row = (r.rows || r)[0] || {};
  const cob = row.cobertura || {};
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
    as_of: row.as_of ? new Date(row.as_of).toISOString() : null,
    base: 'saldo_ajustado',
  };
}
