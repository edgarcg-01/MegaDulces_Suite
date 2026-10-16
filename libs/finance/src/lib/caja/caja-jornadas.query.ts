import type { Knex } from 'knex';
import { SUCURSAL_CAJA_GENERAL } from '@megadulces/contracts';

export interface JornadaSinCorte { fecha: string; movimientos: number }

/**
 * ⛔⛔ `[CGP-L.12]` **LA JORNADA DE UN MOVIMIENTO DEL LIBRO ES EL DÍA EN QUE SE MOVIÓ EL EFECTIVO.**
 *
 * Decisión de Edgar, 2026-10-15: *«el día en que se movió el efectivo»*. **No** `cash_ledger.fecha`,
 * que es la fecha del DOCUMENTO de Kepler y llega con una mediana de **3 días** de rezago
 * (`[CG.82]`: 2 de 5 movimientos vivos en prod tenían el papel de otro día, uno fechado 10-dic y
 * registrado el 28-sep).
 *
 * ⭐ **Por qué importa, y no es una preferencia:** el esperado del cajón se arma con las dos piernas
 * del cajero, y **se cancelan contra su movimiento del libro**:
 *
 *     gasto con dispensación -> dispensación +2,000 · gasto −2,000 = 0
 *     nómina $32,237 con dispensaciones $32,220      = −$17 (la morralla la puso el cajón)
 *
 * Esa cancelación **exige que las dos piernas caigan en la MISMA jornada**. CAOS se agrupa por
 * `accounting_date` (el día físico); si el libro se agrupa por el día del papel, la dispensación cae
 * en un corte y su gasto en otro: el primero pide contar efectivo que ya se gastó (**faltante
 * inventado**) y el segundo sobra por el mismo monto. Es el mismo defecto que `[CG.160]` corrigió en
 * el eje PLAZA, acá en el eje TIEMPO.
 *
 * ⚠️ **`created_at` es cuándo se TECLEÓ**, que coincide con el día del efectivo cuando la captura es
 * del mismo día. El libro no tiene una columna para «el día del efectivo»; una captura tardía vuelve
 * a separar las piernas. Deuda declarada: una columna propia, por omisión la de captura.
 *
 * ⛔ Una sola definición, y la comparten los TRES lectores (el universo del corte, los sueltos de
 * otros días y las jornadas sin corte). Tres copias de esta regla divergen — que es exactamente cómo
 * nació este defecto: `arqueoDelDia` ya usaba `created_at` y el corte se quedó en `fecha`.
 */
export const JORNADA_LIBRO = `(created_at AT TIME ZONE 'America/Mexico_City')::date`;

/**
 * El mismo día, como **rango sobre la columna** — la forma que conserva el índice.
 *
 * ⚠️ Nunca `(created_at AT TIME ZONE …)::date = ?`: envolver la columna en una expresión la saca de
 * cualquier índice. Es el defecto que en `[LC.9]` convirtió un `to_char(fecha)` en un seq scan de
 * 167k filas. Acá el predicado se escribe al revés: se convierte el DÍA, no la columna.
 */
export function enJornadaLibro<Q extends Knex.QueryBuilder>(q: Q, dia: string): Q {
  return q
    .whereRaw(`created_at >= (?::date) AT TIME ZONE 'America/Mexico_City'`, [dia])
    .whereRaw(`created_at <  ((?::date) + 1) AT TIME ZONE 'America/Mexico_City'`, [dia]) as Q;
}

/**
 * `[CGP-L.4]` y `[CGP-L.10]` — Las jornadas del cajón con movimientos vivos y SIN corte.
 *
 * Una sola consulta para dos lectores, a propósito: el sensor (que avisa) y la pantalla (que ofrece
 * abrir el corte atrasado). Dos copias de esta regla divergen, y entonces la campana avisa de un día
 * que la pantalla no ofrece cerrar — o al revés.
 *
 *  · Desde el PRIMER corte: antes de eso los días son historia de Control, no jornadas del libro.
 *  · `terminadaHaceH`: cuántas horas tiene que llevar terminada la jornada para contar. El sensor
 *    pide 26 (para no avisar cada madrugada); la pantalla pide 0 (todo día que ya pasó).
 *  · Los movimientos de OTRAS plazas cuentan: el cajón de la 00 las paga (`aplicarAlcanceCaja`).
 *
 * ⚠️ RLS: quien llama tiene que haber fijado `app.tenant_id` en esta transacción.
 */
export async function jornadasSinCorte(
  trx: Knex | Knex.Transaction, tenantId: string, terminadaHaceH: number,
): Promise<{ inicio: string | null; jornadas: JornadaSinCorte[] }> {
  const inicio = await trx.raw(
    `SELECT to_char(min(fecha), 'YYYY-MM-DD') AS d FROM finance.cash_ledger_cuts WHERE tenant_id = ?`, [tenantId]);
  const r = await trx.raw(`
    WITH inicio AS (SELECT min(fecha) AS d FROM finance.cash_ledger_cuts WHERE tenant_id = ?)
    SELECT to_char(j.dia, 'YYYY-MM-DD') AS fecha, count(*)::int AS movimientos
      FROM (SELECT ${JORNADA_LIBRO} AS dia, tenant_id, deleted_at, estado
              FROM finance.cash_ledger) j, inicio
     WHERE j.tenant_id = ? AND j.deleted_at IS NULL AND j.estado <> 'cancelado'
       AND inicio.d IS NOT NULL AND j.dia >= inicio.d
       AND (j.dia + 1)::timestamp
           < (now() AT TIME ZONE 'America/Mexico_City') - make_interval(hours => ?)
       AND NOT EXISTS (
         SELECT 1 FROM finance.cash_ledger_cuts c
          WHERE c.tenant_id = j.tenant_id AND c.sucursal = ? AND c.fecha = j.dia)
     GROUP BY j.dia
     ORDER BY j.dia`, [tenantId, tenantId, terminadaHaceH, SUCURSAL_CAJA_GENERAL]);
  return {
    inicio: inicio.rows[0]?.d ?? null,
    jornadas: r.rows.map((x: { fecha: string; movimientos: number }) => ({ fecha: x.fecha, movimientos: Number(x.movimientos) })),
  };
}

/** `[CGP-L.13]` Lo que la bandeja propone y nadie confirmó. `null` = NO SE PUDO MEDIR. */
export interface BandejaSinConfirmar {
  movimientos: number;
  monto: number;
  /** El documento más viejo que sigue sin confirmar (`YYYY-MM-DD`). */
  masViejo: string;
  /** Días que lleva esperando el más viejo. */
  dias: number;
}

/**
 * ⛔⛔ `[CGP-L.13]` **LA BANDEJA PROPONE Y NADIE LA MIRA.**
 *
 * Medido en prod el 2026-10-15, desde que ADR-070 hizo a la Suite el libro (12-oct): de 111
 * movimientos de Caja General que el ERP registró, **51 se confirmaron y 60 no** ($389,038.99). Y el
 * **14-oct** se desplomó: **4 de 39**, con $159,929.71 colgando.
 *
 * ⭐ **No es rezago de la ingesta, y eso es lo que lo vuelve accionable:** los 35 gastos del 14 que
 * quedaron sin confirmar entraron al ERP **ese mismo día (29) o el anterior (6)**. Estaban en la
 * bandeja cuando ocurrieron. Es el mismo patrón que `[CGP-L.10]`: *tres jornadas trabadas y ningún
 * sistema avisó* — acá, un día entero sin confirmar y tampoco.
 *
 * ── Dos decisiones del alcance, y las dos tienen porqué ───────────────────────────────────────
 *
 * 1. **Desde el PRIMER corte**, igual que `jornadasSinCorte`. Sin eso el sensor nacería rojo para
 *    siempre: en la ventana de 45 días del código hay **1,965 movimientos por $17.8M**, casi todos
 *    de antes de que el módulo existiera. *Un denominador que incluye el pasado que nadie iba a
 *    capturar no mide trabajo pendiente, mide historia* — me pasó midiendo esto: la primera cifra
 *    dio 3% de confirmación y la correcta es 46%.
 * 2. **Sólo lo que ya cumplió un día** (`fecha_valor <= hoy − 1`). Lo de hoy todavía es trabajo del
 *    día, no un olvido.
 *
 * ⚠️ `null` cuando la vista no existe (la base de pruebas del corte no la trae): **no se declara
 * cero**, que sería indistinguible de «la bandeja está al día» (ADR-056).
 */
export async function bandejaSinConfirmar(
  trx: Knex | Knex.Transaction, tenantId: string, hoy: string,
): Promise<BandejaSinConfirmar | null> {
  const existe = await trx.raw(`SELECT to_regclass('finance.v_caja_movimientos_pendientes') AS t`);
  if (!existe.rows?.[0]?.t) return null;

  const r = await trx.raw(`
    WITH inicio AS (SELECT min(fecha) AS d FROM finance.cash_ledger_cuts WHERE tenant_id = ?)
    SELECT count(*)::int AS movimientos,
           coalesce(sum(p.monto), 0)::float AS monto,
           to_char(min(p.fecha_valor), 'YYYY-MM-DD') AS mas_viejo,
           coalesce((?::date - min(p.fecha_valor)::date), 0)::int AS dias
      FROM finance.v_caja_movimientos_pendientes p, inicio
     WHERE p.tenant_id = ?
       -- 0011 es la cuenta de CAJA GENERAL en Kepler; la vista ya la usa para la pierna de las
       -- rutas. Sin este filtro entrarían los bancos y la bandeja mediría otra caja.
       AND p.clave_banco = '0011'
       AND inicio.d IS NOT NULL AND p.fecha_valor >= inicio.d
       AND p.fecha_valor <= (?::date - 1)`, [tenantId, hoy, tenantId, hoy]);

  const f = r.rows[0];
  if (!f || Number(f.movimientos) === 0) return { movimientos: 0, monto: 0, masViejo: hoy, dias: 0 };
  return {
    movimientos: Number(f.movimientos),
    monto: Number(f.monto),
    masViejo: String(f.mas_viejo),
    dias: Number(f.dias),
  };
}

/** La fecha de hoy en México, la de la BASE: el reloj del servidor de la app puede estar en otra zona. */
export async function hoyMx(trx: Knex | Knex.Transaction): Promise<string> {
  const r = await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`);
  return r.rows[0].d as string;
}
