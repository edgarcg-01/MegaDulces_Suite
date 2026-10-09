import { clasificarAcreedor } from './creditor-statements.engine';

/**
 * `[TES.2]` **Deuda prevista por semana — el espejo exacto de `cobranzaPrevista`.**
 *
 * El flujo de efectivo tenía el lado del cobro resuelto y declarado, y el lado del pago
 * sumando tres tablas vacías. Medido en prod el 2026-10-08: `expense_obligations` tiene 312
 * filas, las 312 en `status='propuesta'` y venciendo en 2027 (el motor las excluye a
 * propósito); `financial_commitments` y `supplier_payment_obligations` tienen **0 filas**. La
 * proyección publicaba **$0 de pago en 8 semanas** y se leía como liquidez excelente.
 *
 * Este resolvedor lee la deuda **derivada del ERP** (`analytics.v_supplier_payables`) y
 * devuelve la misma forma que el del cobro, por la misma razón: **la ventana hacia adelante
 * ve una fracción, y esa fracción se DECLARA**. Medido el mismo día: $30.6M vencen dentro de
 * la ventana contra **$114.4M ya vencidos** que la curva NO dibuja — meterlos en la semana 1
 * afirmaría que se pagan el lunes, que es inventar una fecha.
 *
 * ⛔ **No re-implementa la clasificación.** `clasificarAcreedor()` del motor de ECA es su
 * dueño (validado contra el reporte de Kepler para Mondelez). El SQL agrupa por
 * `(proveedor, grupo)` y **TypeScript clasifica**: así la regla vive en un solo lugar y el
 * universo que se excluye —los traspasos internos, $38.6M que NO son deuda— queda sujeto a
 * esa única definición.
 *
 * ⚠️ **`as_of` viaja en `null` a propósito.** El ODS no publica una marca de frescura en
 * `kdxe`, así que la procedencia se declara DESCONOCIDA (ADR-056) en vez de fabricar un
 * `now()` que diría "recién medido" sobre un dato de antigüedad no verificada.
 */

export interface DeudaCobertura {
  /** Vence dentro de `[from, to]`. Es lo único que la curva dibuja. */
  en_ventana: number;
  /** ⭐ Deuda ya vencida: exigible, sin fecha comprometida. La curva NO la dibuja. */
  vencido_fuera: number;
  /** Vence después de `to`. */
  posterior: number;
  /** Sin fecha de vencimiento en el ERP. Ausencia declarada, no cero. */
  sin_vencimiento: number;
  total: number;
  /** Qué porción de la deuda representa la curva. `null` si no hay deuda. */
  pct_en_ventana: number | null;
  /**
   * Excluido del total: traspasos entre sucursales, que no son deuda con terceros.
   * ⚠️ El literal canónico de `clasificarAcreedor()` es **`'interno'`**, no `'traspaso_interno'`.
   * Escribí el segundo y la comparación nunca habría disparado: $38.6M de traspasos se habrían
   * sumado a la deuda en silencio. No lo detecta el compilador —`AcreedorTipo` no incluye el
   * literal errado, pero un `===` contra una unión siempre tipa— sino leer el clasificador.
   */
  interno_excluido: number;
}

export interface DeudaPrevista {
  porSemana: { bucket: string; monto: number }[];
  cobertura: DeudaCobertura;
  /** `[TES.11]` De cuántos proveedores depende lo que la curva dibuja. Ver `Concentracion`. */
  concentracion: { n: number; top1_pct: number | null; top5_pct: number | null };
  /** Desglose por el tipo que decide `clasificarAcreedor()`. */
  porTipo: Record<string, number>;
  as_of: string | null;
  as_of_reason: string;
  base: 'pendiente';
}

const SQL = `
  SELECT proveedor,
         grupo,
         CASE WHEN vencimiento IS NULL                        THEN 'sin_vencimiento'
              WHEN vencimiento <  ?::date                     THEN 'vencido_fuera'
              WHEN vencimiento BETWEEN ?::date AND ?::date    THEN 'en_ventana'
              ELSE 'posterior' END                            AS categoria,
         CASE WHEN vencimiento BETWEEN ?::date AND ?::date
              THEN date_trunc('week', vencimiento)::date END  AS bucket,
         round(sum(pendiente), 2)                             AS monto
    FROM analytics.v_supplier_payables
   WHERE tenant_id = ?
     AND pendiente > 0
   GROUP BY 1, 2, 3, 4`;

/**
 * Deuda prevista por semana **y su cobertura**. Una sola pasada: los baldes y los totales
 * salen de las mismas filas, así que no pueden discrepar entre sí.
 */
export async function deudaPrevista(
  trx: any, tenantId: string, from: string, to: string,
): Promise<DeudaPrevista> {
  const r = await trx.raw(SQL, [from, from, to, from, to, tenantId]);
  const rows: any[] = r.rows || r || [];

  const cob: DeudaCobertura = {
    en_ventana: 0, vencido_fuera: 0, posterior: 0, sin_vencimiento: 0,
    total: 0, pct_en_ventana: null, interno_excluido: 0,
  };
  const porTipo: Record<string, number> = {};
  const semanas = new Map<string, number>();
  // [TES.11] Espejo de la concentración del cobro. No hace falta tocar el SQL: ya viene agrupado
  // por proveedor. Medido contra prod el 2026-10-09: los 5 mayores concentran el **44.7 %** de la
  // deuda y los 20 el **68.3 %**, sobre 397 proveedores — MÁS concentrado que la cartera.
  const porProveedor = new Map<string, number>();

  for (const row of rows) {
    const monto = Number(row.monto) || 0;
    const tipo = clasificarAcreedor(String(row.proveedor ?? ''), row.grupo ?? null);

    // Los traspasos entre sucursales se mueven por el mismo ledger pero no son deuda con un
    // tercero: se EXCLUYEN del total y se declaran aparte, nunca se suman en silencio.
    if (tipo === 'interno') { cob.interno_excluido = r2(cob.interno_excluido + monto); continue; }

    porTipo[tipo] = r2((porTipo[tipo] ?? 0) + monto);
    cob.total = r2(cob.total + monto);
    const cat = String(row.categoria) as keyof DeudaCobertura;
    if (cat === 'en_ventana' || cat === 'vencido_fuera' || cat === 'posterior' || cat === 'sin_vencimiento') {
      cob[cat] = r2((cob[cat] as number) + monto);
    }
    if (row.bucket) {
      const b = String(row.bucket).slice(0, 10);
      semanas.set(b, r2((semanas.get(b) ?? 0) + monto));
      // Sólo lo que la curva DIBUJA: el riesgo es que lo proyectado dependa de pocos.
      const p = String(row.proveedor ?? '?');
      porProveedor.set(p, r2((porProveedor.get(p) ?? 0) + monto));
    }
  }

  // Sin deuda la cobertura es DESCONOCIDA, no 0%: un 0% se leería como "no hay nada que pagar"
  // cuando lo que pasa es que no hay con qué medirlo.
  cob.pct_en_ventana = cob.total > 0 ? Math.round((cob.en_ventana / cob.total) * 1000) / 10 : null;

  // [TES.11] Concentración de lo que la curva dibuja. Sin proveedores en la ventana queda
  // DESCONOCIDA, no 0%: un 0 se leería como «bien repartida» y lo que pasa es que no hay con qué.
  const montos = [...porProveedor.values()].sort((a, b) => b - a);
  const totalV = montos.reduce((s, m) => s + m, 0);
  const topN = (k: number) => (totalV > 0
    ? Math.round((montos.slice(0, k).reduce((s, m) => s + m, 0) / totalV) * 1000) / 10 : null);

  return {
    concentracion: { n: montos.length, top1_pct: topN(1), top5_pct: topN(5) },
    porSemana: [...semanas.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([bucket, monto]) => ({ bucket, monto })),
    cobertura: cob,
    porTipo,
    as_of: null,
    as_of_reason: 'El ODS no publica marca de frescura en kdxe: la procedencia se declara desconocida, no se fabrica.',
    base: 'pendiente',
  };
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
