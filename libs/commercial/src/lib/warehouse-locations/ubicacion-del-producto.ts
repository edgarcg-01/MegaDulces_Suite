/**
 * `[ICR.0.2][ICR.0.3][ICR.0.4]` — **Dónde está un producto, y cuál de sus ubicaciones gana.**
 *
 * El catálogo de ubicaciones es de la fase UB y vive acá (`commercial.warehouse_bins` +
 * `bin_assignments`); por eso el primitivo que lo interpreta vive acá también, y no dentro de quien
 * lo consume. Hoy lo consumen dos oficios distintos:
 *
 *  · **Surtido** (`[GP.RF.33]`, decisión de Edgar del 2026-11-17): a qué lugar camina el surtidor.
 *  · **Inventario físico** (fase ICR): en qué tramo del recorrido cae cada renglón del folio, que es
 *    lo que permite decir «este pedazo es tuyo» y repartir el conteo entre personas.
 *
 * ⛔ Y vive acá porque **ya se había duplicado**. `apoyo-surtido.ts` tenía la regla desde el 17 de
 * noviembre; el conteo escribió la suya el 27, con una diferencia real: **no excluía las ubicaciones
 * dadas de baja**. Hoy eso no cambia ningún número (476 de 476 están `activa`), pero era una copia
 * separándose de la otra. ADR-056: el primitivo va a un solo lugar, o queda como deuda con nombre.
 *
 * ⭐ **El reparto de trabajo**: la regla de cuál gana vive acá, en TypeScript. La vista
 * `commercial.v_product_bin_location` sólo **junta y filtra** (asignación viva × ubicación no dada
 * de baja) y deriva el `tramo` de cada ubicación. Poner además el orden en un `CASE` de la vista
 * sería volver a tener dos copias.
 */

/** La vista derivada que junta asignación viva y ubicación. `derive-no-copy` (regla 1). */
export const VISTA_UBICACION_DEL_PRODUCTO = 'commercial.v_product_bin_location';

/**
 * Una fila de la vista: **una** ubicación de **un** producto en **un** almacén. Un producto puede
 * tener varias (medido en prod el 2026-11-27: de 40 asignados, 5 en dos ubicaciones y 3 en tres).
 */
export interface UbicacionDelProducto {
  product_id: string;
  bin_id?: string;
  /** El código que la gente lee y dice en voz alta: `TA011`. */
  bin_code?: string;
  code?: string;
  /** `T` = tienda · `B` = bodega (`ck_wh_bins_zona`). */
  zona?: string | null;
  pasillo?: string | null;
  /** `zona-pasillo` (`T-A`) o `sin-recorrido` para lo que no tiene ninguno (carretas, legado). */
  tramo?: string | null;
  /** El orden en que se camina el almacén. Corrido por almacén, ya ordena los pasillos entre sí. */
  pick_sequence?: number | string | null;
  papel: string;
  presentacion_rotulo?: string | null;
}

/**
 * Dónde se busca primero: el lugar fijo; si no hay, la exhibición de tienda; al final, la reserva.
 * Hoy son los tres únicos valores posibles (`ck_bin_assignments_papel`).
 */
export const ORDEN_PAPEL: Readonly<Record<string, number>> = {
  surtido_fijo: 0,
  exhibicion_tienda: 1,
  reserva_preferida: 2,
};

/** El lugar de un `papel` que todavía no existe: el último de la fila. */
export const ORDEN_DESCONOCIDO = 9;

/**
 * ⭐ **Qué hacer con un `papel` que este código no conoce, y por qué NO es la misma respuesta para
 * todos.** Es lo único que separa a los dos oficios que usan este módulo, y por eso se dice en cada
 * llamada en vez de decidirse acá:
 *
 *  · **Surtido** descarta (`descartarPapelDesconocido: true`). Un papel nuevo bien podría ser
 *    cuarentena o merma, y mandar al surtidor ahí sería **sacar mercancía que no debe salir**. Entre
 *    equivocarse y no ir, no ir. Su prueba negativa lo fija desde el 2026-11-17.
 *  · **Inventario físico** lo conserva. Lo que está en cuarentena **existe y hay que contarlo**;
 *    descartarlo convertiría «está en un lugar que no sé ordenar» en «no tiene ubicación», o sea
 *    dibujaría un vacío donde hay un dato (regla 11).
 *
 * ⛔ Que hoy ningún `papel` desconocido pueda existir no vuelve la diferencia teórica: el día que
 * UB agregue uno, los dos módulos tienen que reaccionar distinto, y acá está escrito cómo.
 */
export interface OpcionesDeUbicacion {
  /** La presentación pedida: desempata entre ubicaciones del mismo papel. */
  unidad?: string | null;
  /** `true` = un papel desconocido se trata como si no hubiera ubicación. Por defecto, `false`. */
  descartarPapelDesconocido?: boolean;
}

/** El tramo de quien **no tiene ninguna ubicación**. Es trabajo real, no una ausencia. */
export const SIN_UBICAR = 'sin-ubicar';

const ordenDe = (papel: string): number =>
  papel in ORDEN_PAPEL ? ORDEN_PAPEL[papel] : ORDEN_DESCONOCIDO;

/** El código legible de una fila, venga de la vista (`bin_code`) o de una consulta cruda (`code`). */
const codigoDe = (u: UbicacionDelProducto): string => (u.bin_code ?? u.code ?? '').trim();

/** `pick_sequence` como número, o `null` si no lo tiene (las 4 ubicaciones sin recorrido). */
export function ordenDeRecorrido(u: UbicacionDelProducto): number | null {
  if (u.pick_sequence == null || u.pick_sequence === '') return null;
  const n = Number(u.pick_sequence);
  return Number.isFinite(n) ? n : null;
}

/**
 * **Todas** las ubicaciones de un producto, en el orden en que se caminan.
 *
 * Lo que no tiene recorrido va al final, no se pierde. Es lo que la ficha del conteo muestra: si el
 * producto está en tres lugares, quien cuenta tiene que saberlo o va a reportar de menos.
 */
export function ubicacionesDe<T extends UbicacionDelProducto>(
  filas: readonly T[],
  productId: string,
): T[] {
  return filas
    .filter((u) => u.product_id === productId)
    .sort((a, b) => {
      const oa = ordenDeRecorrido(a);
      const ob = ordenDeRecorrido(b);
      if (oa !== ob) {
        if (oa == null) return 1;
        if (ob == null) return -1;
        return oa - ob;
      }
      return codigoDe(a).localeCompare(codigoDe(b));
    });
}

/**
 * **La** ubicación del producto: la que gana por `papel` y, dentro del mismo papel, la de la
 * presentación que se pide. `null` = el producto no tiene ubicación en ese almacén — se dice así,
 * no se inventa una.
 */
export function ubicacionDe<T extends UbicacionDelProducto>(
  filas: readonly T[],
  productId: string,
  opciones: OpcionesDeUbicacion = {},
): T | null {
  const u = (opciones.unidad ?? '').trim().toUpperCase();
  const delProducto = filas
    .filter(
      (f) =>
        f.product_id === productId &&
        (!opciones.descartarPapelDesconocido || f.papel in ORDEN_PAPEL),
    )
    .sort(
      (a, b) =>
        ordenDe(a.papel) - ordenDe(b.papel) ||
        Number((b.presentacion_rotulo ?? '').trim().toUpperCase() === u) -
          Number((a.presentacion_rotulo ?? '').trim().toUpperCase() === u),
    );
  return delProducto[0] ?? null;
}

/**
 * **El tramo del producto**: el de su ubicación que gana, o `SIN_UBICAR`.
 *
 * ⭐ Es la unidad con la que se reparte el conteo entre personas. Un producto en dos tramos cuenta en
 * el de su ubicación principal: el otro lo ve quien abra su ficha, porque `ubicacionesDe()` las trae
 * todas. ⚠️ Medido el 2026-11-27 en Padre Hidalgo, **3,322 de 3,361** productos con existencia caen
 * hoy en `SIN_UBICAR`: ése es el tamaño del trabajo que falta, y tiene que **verse**.
 */
export function tramoDe(filas: readonly UbicacionDelProducto[], productId: string): string {
  const u = ubicacionDe(filas, productId);
  return (u?.tramo ?? '').trim() || SIN_UBICAR;
}

/** Los códigos del producto para mostrar en una línea: `TA011 · TA014`. `null` si no tiene. */
export function codigosDe(filas: readonly UbicacionDelProducto[], productId: string): string | null {
  const codigos = ubicacionesDe(filas, productId).map(codigoDe).filter(Boolean);
  return codigos.length ? codigos.join(' · ') : null;
}
