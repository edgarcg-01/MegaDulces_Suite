import type { Knex } from 'knex';

/**
 * ⛔⛔ `[CGP-VEC.1]` **EL COBRO DE RUTA VECINAL TIENE FUENTE, Y NADIE LA ESTABA USANDO.**
 *
 * **Lo que lo motivó, el 2026-10-15.** Edgar subió a mano el arqueo de la ruta **2V005** (Morelia
 * Abastos) del 7-oct, folio 25, $6,244.50, porque *«tengo que hacer la mayoría de mis movimientos
 * manuales»*. Midiendo por qué, la primera respuesta fue equivocada —busqué en el feed de **caja**
 * (`analytics.mv_caja_movimientos`, cuenta `0011`) y ahí no hay un solo cobro de Morelia Abastos, así
 * que concluí «no existe la fuente»—. **Otra sesión lo corrigió:** la venta vive en
 * `kepler_ods.kdm1` (doctype `U-D-10`, `c12` = código de ruta) y **ya está derivada**.
 *
 * ⭐ Y hay más que la venta: **`analytics.v_vecinal_conciliacion` ya la arbitra contra el arqueo**.
 * Para el 7-oct de la 2V005: vecinal $6,244.48 · arqueo $6,244.48 · contado $6,244.48 ·
 * diferencia **$0.00** · `cuadra`. *El dinero que se estaba tecleando a mano ya tenía fuente, testigo
 * y veredicto.* Lo único que faltaba era el puente al libro de caja — esto es el puente.
 *
 * ── Qué se propone, y por qué ese monto ───────────────────────────────────────────────────────
 * Se propone **`efectivo_contado`**: el efectivo que alguien contó y que por lo tanto existe. No la
 * venta (`vecinal`), que puede incluir tarjeta y transferencia, ni el arqueo teórico.
 *
 * ⚠️ **Los días que NO cuadran también se proponen, con su veredicto a la vista.** Un `faltante` o un
 * `vecinal_excede_arqueo` no es motivo para esconder el dinero: el efectivo se contó igual. Lo que no
 * se hace es dibujarlo como si cuadrara (ADR-056).
 *
 * ⛔ **El día en curso NO se propone.** Mientras la jornada está abierta el conteo sigue cambiando —
 * es el mismo criterio que `[CGP-L.13]` usa para la bandeja: lo de hoy es trabajo, no un olvido.
 */

/**
 * ⛔⛔ **HIPÓTESIS REFUTADA — no la reconstruyas: parear venta ↔ depósito POR IMPORTE no sirve.**
 *
 * **2026-10-15.** Buscando cómo evitar que el mismo dinero entre dos veces (una por este puente y
 * otra por el `U-A-5` «DEPOSITO EFECTIVO CAJA GENERAL» que Kepler captura días después), encontré
 * **tres coincidencias al centavo** y parecían concluyentes:
 *
 *     $30,883.14 = 2V003 del 3-oct · $8,351.72 = 2V001 del 5-oct · $5,224.23 = 2V001 del 3-oct
 *
 * Medido con **control de placebo** sobre 270 ruta-día desde el 1-sep, ventana `día..día+10`:
 *
 *     real    (el importe de ESE día)            8 de 270 = 3.0 %
 *     placebo (el importe del día SIGUIENTE)     8 de 256 = 3.1 %
 *
 * ⭐ **Idénticos.** El cruce no reconoce *esa* venta: reconoce que el depósito es **alguna** venta
 * vecinal — y lo es, porque los depósitos del período *son* importes de ventas de días cercanos.
 * Las tres coincidencias al centavo estaban dentro de lo que produce ese pozo. *Un importe que
 * calza al centavo convence; por eso el placebo no es opcional.*
 *
 * ⚠️ Y de paso quedó medido que **sólo 8 de 270 ruta-día tienen siquiera un depósito que calce**:
 * la mayoría de las ventas vecinales no tienen documento de depósito en Kepler en los 10 días
 * siguientes, así que el doble conteo es raro — pero sigue sin resolverse, y por eso este puente
 * **todavía no se conecta a la pantalla**.
 */

/** Un día de ruta vecinal, ya conciliado contra su arqueo, listo para entrar al libro. */
export interface CobroVecinalPendiente {
  sucursal: string;
  /** La jornada, `YYYY-MM-DD`. */
  fecha: string;
  caja: number;
  /** Las rutas que cerraron en esa caja ese día, separadas por coma. */
  rutas: string;
  /** El efectivo CONTADO. Es lo que entra al libro. */
  monto: number;
  /** La venta vecinal del día, para que la pantalla pueda mostrar contra qué cuadra. */
  venta: number;
  /** `cuadra` · `faltante` · `vecinal_excede_arqueo` … tal como lo publica el árbitro. */
  veredicto: string;
  /** `contado − arqueo`, con su signo. `0` cuando cuadra. */
  diferencia: number;
  origen_ref: string;
  glosa: string;
}

/**
 * La llave del movimiento en el libro. **Estable y derivada**, no un consecutivo: si el mismo día se
 * vuelve a proponer, el `NOT EXISTS` lo reconoce y no aparece dos veces.
 *
 * ⚠️ Lleva la **caja** además del día: una sucursal puede cerrar dos cajas el mismo día (medido: la
 * `07` cierra la 4 y hoy está timbrando en la 3), y sin la caja los dos cierres colapsarían en uno.
 */
export function refVecinal(sucursal: string, fecha: string, caja: number | string): string {
  return `${sucursal}|VEC|${fecha}|${caja}`;
}

/** El veredicto del árbitro que significa «la jornada todavía no terminó». */
export const VEREDICTO_EN_CURSO = 'dia_en_curso';

/**
 * ¿Este día se propone? Puro, para poder probar la regla sin base.
 *
 * ⛔ **`cerrado` no alcanza**: el árbitro marca `cerrado = true` también en el día en curso (medido
 * el 2026-10-15: las tres filas de hoy vienen cerradas y con veredicto `dia_en_curso`). Si la regla
 * mirara sólo `cerrado`, la bandeja ofrecería capturar un conteo que todavía se está moviendo.
 */
export function esProponible(f: { cerrado: boolean | null; veredicto: string | null; monto: number }): boolean {
  if (!f.cerrado) return false;
  if (f.veredicto === VEREDICTO_EN_CURSO) return false;
  return Number(f.monto) > 0;
}

/** Lo que se ve en la bandeja. Nombra la ruta y el día, que es lo único que permite parearlo después. */
export function glosaVecinal(rutas: string, fecha: string, veredicto: string): string {
  const base = `Ruta vecinal ${rutas} · cierre del ${fecha}`;
  return veredicto === 'cuadra' ? base : `${base} · ${veredicto}`;
}

/**
 * Los cierres de ruta vecinal que todavía no están en el libro.
 *
 * ⚠️ `null` = **NO SE PUDO MEDIR** (el árbitro no está en esta base), nunca una lista vacía: una
 * lista vacía dice «no hay nada pendiente», que es exactamente lo contrario (ADR-056).
 */
export async function cobrosVecinalesPendientes(
  trx: Knex | Knex.Transaction, tenantId: string, desde: string,
): Promise<CobroVecinalPendiente[] | null> {
  const existe = await trx.raw(`SELECT to_regclass('analytics.v_vecinal_conciliacion') AS t`);
  if (!existe.rows?.[0]?.t) return null;

  const r = await trx.raw(`
    SELECT v.warehouse_code AS sucursal,
           to_char(v.business_date, 'YYYY-MM-DD') AS fecha,
           v.caja,
           coalesce(v.rutas, '') AS rutas,
           coalesce(v.efectivo_contado, 0)::float AS monto,
           coalesce(v.vecinal, 0)::float AS venta,
           coalesce(v.veredicto, '') AS veredicto,
           coalesce(v.efectivo_diff, 0)::float AS diferencia,
           v.cerrado
      FROM analytics.v_vecinal_conciliacion v
     WHERE v.tenant_id = ?
       AND v.business_date >= ?::date
       AND NOT EXISTS (
         SELECT 1 FROM finance.cash_ledger l
          WHERE l.tenant_id = v.tenant_id
            AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
            AND l.origen_ref = v.warehouse_code || '|VEC|'
                               || to_char(v.business_date, 'YYYY-MM-DD') || '|' || v.caja)
     ORDER BY v.business_date, v.warehouse_code, v.caja`, [tenantId, desde]);

  return r.rows
    .filter((x: { cerrado: boolean; veredicto: string; monto: number }) => esProponible(x))
    .map((x: CobroVecinalPendiente & { cerrado: boolean }) => ({
      sucursal: x.sucursal,
      fecha: x.fecha,
      caja: Number(x.caja),
      rutas: x.rutas,
      monto: Number(x.monto),
      venta: Number(x.venta),
      veredicto: x.veredicto,
      diferencia: Number(x.diferencia),
      origen_ref: refVecinal(x.sucursal, x.fecha, x.caja),
      glosa: glosaVecinal(x.rutas, x.fecha, x.veredicto),
    }));
}
