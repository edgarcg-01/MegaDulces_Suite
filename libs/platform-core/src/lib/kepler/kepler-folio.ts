/**
 * `[PGP.122.4]` **El folio de un documento nuevo sale del CONTADOR de Kepler, no de `MAX+1` a secas.**
 *
 * Plan: [`FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md) §5.3.
 *
 * ── Lo medido (ODS, 2026-11-14/15) ────────────────────────────────────────────────────────────
 * `md.sqliov` es el contador de folios de Kepler. Llave `(c1, c2, c3)`; los contadores de documento
 * son `c1 = 'KF' + grupo + naturaleza + tipo(2) + serie(2) + '.' + sucursal` con `c2 = c3 = 0`, y
 * `c4` (texto) es el SIGUIENTE folio que Kepler va a dar:
 *   · `KFXA1501` (solicitud de gasto), `KFXA1001` (gasto) y `KFXD2601` (pago): `c4 = MAX(c6)+1` en
 *     9 de 9 servidores, y los 12,910 folios X-A-15 no tienen un solo hueco.
 *   · `KFXA3001` (requisición, la escribe la Suite con `MAX+1` sin tocar el contador, ADR-092 regla 2):
 *     el contador quedó ATRÁS del último folio en 00 (`'0003161'` contra 3,185), 01 (190 / 203),
 *     06 (4 / 22) y 08 (21 / 89). La próxima requisición que una persona capture ahí pide un folio
 *     que ya existe. Es el defecto que este primitivo existe para no repetir.
 *   · `KFXA3001.04` = 122 = su MAX sin ningún folio de la Suite: «c4 = siguiente» no está cerrado del
 *     todo. Por eso el folio es `greatest(c4, MAX+1)` y no `c4` solo.
 *
 * ── La regla ────────────────────────────────────────────────────────────────────────────────
 * En UNA transacción del escritor: candado de la fila del contador (`FOR UPDATE`, con el
 * `lock_timeout` corto que fije quien llama) → folio = `greatest(c4, MAX(c6)+1)` → el contador queda
 * en `folio + 1`, sin ceros a la izquierda (como los nueve `KFXA1501`). El candado serializa con la
 * pantalla de Kepler si ella también lo toma; si no lo toma, la llave primaria de `kdm1` rebota el
 * choque y se deshace todo.
 *
 * ⛔ Fail-closed: sin fila de contador, o con un `c4` que no es un número, NO se escribe. No se
 * inventa un contador.
 *
 * Sin `pg`: la consulta entra por una interfaz mínima, para que el ensayo empaquetado (esbuild) y la
 * prueba de `database/tests` lo carguen sin arrastrar la librería entera.
 */
import type { Resolucion } from './kepler-servidor';

/** El universo del documento en `kdm1` (`c2`): X = proveedores/acreedores, U = clientes, N = bancos. */
export type GrupoKepler = 'X' | 'U' | 'N';
/** La naturaleza (`kdm1.c3`): A = abono, D = cargo. */
export type NaturalezaKepler = 'A' | 'D';

export interface DocumentoKepler {
  sucursal: string;
  grupo: GrupoKepler;
  naturaleza: NaturalezaKepler;
  /** `kdm1.c4` (p. ej. 15 = solicitud de gasto). */
  tipo: number;
  /** `kdm1.c5` (p. ej. 1). */
  serie: number;
}

const SUCURSAL = /^\d{2}$/;
/** Un folio de Kepler: `kdm1.c6`, siete dígitos. */
export const FOLIO_MAXIMO = 9_999_999;

/** `KFXA1501.08` para la solicitud de gasto (X-A-15-1) del servidor 08. */
export function llaveDelContador(d: DocumentoKepler): Resolucion<string> {
  if (!SUCURSAL.test(String(d.sucursal ?? ''))) return { ok: false, motivo: `Sucursal Kepler inválida «${d.sucursal}»` };
  if (!['X', 'U', 'N'].includes(d.grupo)) return { ok: false, motivo: `Grupo de documento inválido «${d.grupo}»` };
  if (!['A', 'D'].includes(d.naturaleza)) return { ok: false, motivo: `Naturaleza de documento inválida «${d.naturaleza}»` };
  if (!Number.isInteger(d.tipo) || d.tipo < 1 || d.tipo > 99) return { ok: false, motivo: `Tipo de documento inválido «${d.tipo}»` };
  if (!Number.isInteger(d.serie) || d.serie < 0 || d.serie > 99) return { ok: false, motivo: `Serie de documento inválida «${d.serie}»` };
  const dos = (n: number) => String(n).padStart(2, '0');
  return { ok: true, valor: `KF${d.grupo}${d.naturaleza}${dos(d.tipo)}${dos(d.serie)}.${d.sucursal}` };
}

/** El `c4` de `sqliov` como número, o `null` si no es un número (`'0003161'` → 3161; `'149z'` → null). */
export function leerContador(c4: unknown): number | null {
  const s = String(c4 ?? '').trim();
  if (!/^\d{1,7}$/.test(s)) return null;
  return Number(s);
}

export interface FolioDecidido {
  /** `kdm1.c6`, siete dígitos. */
  folio: string;
  /** Lo que queda en `sqliov.c4`: el siguiente, sin ceros a la izquierda. */
  contadorNuevo: string;
  /** `true` si el contador venía atrás de `MAX+1` (se registra: es el síntoma del KR). */
  contadorAtrasado: boolean;
}

/** `greatest(contador, MAX+1)`. `maximo` es el `MAX(c6)` del tipo y serie en ese servidor (0 si no hay). */
export function decidirFolio(p: { contador: number | null; maximo: number }): Resolucion<FolioDecidido> {
  if (p.contador == null) return { ok: false, motivo: 'El contador de folios de Kepler (sqliov.c4) no es un número: no se inventa un folio' };
  if (!Number.isInteger(p.maximo) || p.maximo < 0) return { ok: false, motivo: `El último folio leído no es válido («${p.maximo}»)` };
  const n = Math.max(p.contador, p.maximo + 1);
  if (n > FOLIO_MAXIMO) return { ok: false, motivo: `El siguiente folio (${n}) ya no cabe en siete dígitos` };
  return { ok: true, valor: { folio: String(n).padStart(7, '0'), contadorNuevo: String(n + 1), contadorAtrasado: p.contador < p.maximo + 1 } };
}

/** `true` si el contador de Kepler ya no apunta al siguiente folio libre (la compuerta del contador, §5.6). */
export function contadorAtrasado(contador: number | null, maximo: number): boolean {
  return contador == null || contador <= maximo;
}

/** Lo mínimo de un cliente de Postgres que hace falta aquí (lo cumple `pg.PoolClient`). */
export interface ConsultaKepler {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface FolioReservado extends FolioDecidido {
  llave: string;
  /** El `c4` como estaba antes, tal cual (para la bitácora). */
  contadorAntes: string;
  maximo: number;
}

/**
 * Toma el candado del contador, decide el folio y avanza el contador. **Corre dentro de la
 * transacción de quien llama** (`BEGIN` ya hecho) y no la confirma: si después el `INSERT` falla, el
 * `ROLLBACK` de quien llama deshace también el contador.
 *
 * Permisos que pide en Kepler: `SELECT, UPDATE (c4) ON md.sqliov` y `SELECT ON md.kdm1`.
 */
export async function reservarFolioKepler(c: ConsultaKepler, d: DocumentoKepler): Promise<Resolucion<FolioReservado>> {
  const llave = llaveDelContador(d);
  if (!llave.ok) return llave;
  const fila = await c.query(`SELECT c4 FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0 FOR UPDATE`, [llave.valor]);
  if (fila.rowCount !== 1) {
    return { ok: false, motivo: `Kepler (${d.sucursal}) no tiene el contador ${llave.valor} en sqliov (${fila.rowCount ?? 0} filas): no se inventa un folio` };
  }
  const antes = String(fila.rows[0].c4 ?? '');
  const max = await c.query(
    `SELECT coalesce(max(c6::int), 0)::int AS m FROM md.kdm1
      WHERE c1 = $1 AND c2 = $2 AND c3 = $3 AND c4 = $4::numeric AND c5 = $5::numeric AND c6 ~ '^[0-9]+$'`,
    [d.sucursal, d.grupo, d.naturaleza, d.tipo, d.serie]);
  const maximo = Number(max.rows[0]?.m ?? 0);
  const decidido = decidirFolio({ contador: leerContador(antes), maximo });
  if (!decidido.ok) return decidido;
  const upd = await c.query(`UPDATE md.sqliov SET c4 = $2 WHERE c1 = $1 AND c2 = 0 AND c3 = 0`, [llave.valor, decidido.valor.contadorNuevo]);
  if (upd.rowCount !== 1) return { ok: false, motivo: `Avanzar el contador ${llave.valor} tocó ${upd.rowCount ?? 0} filas: se esperaba una` };
  return { ok: true, valor: { ...decidido.valor, llave: llave.valor, contadorAntes: antes, maximo } };
}
