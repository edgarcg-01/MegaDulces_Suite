/**
 * Orden CANÓNICO de presentación de las tiendas/almacenes (pedido de negocio 2026-09-10 para
 * `/compras/pedido`): PH · MA · MM · 8ESQ · LPA · YUR · CAN · Zamora Centro · CEDIS (Irapuato).
 *
 * ⚠️ Decía «CEDIS (BPIRAPUATO)». `BPIRAPUATO` nombraba el `.mdb` de Wincaja, no la plaza, y esa
 * fuente se retiró con el corte a Kepler del 2026-09-30. El nombre vive en la TABLA
 * (`commercial.warehouses.name` = «CEDIS» desde la mig 20261001120000); acá sólo va el rótulo del
 * grupo, que ya decía «CEDIS» y por eso no cambió.
 *
 * Es orden de PANTALLA, no de datos: no cambia ningún cálculo, sólo en qué secuencia aparecen
 * columnas, filas agrupadas y opciones de filtro. Vive acá (contrato compartido) para que el
 * backend (columnas/filtros que arma el server) y el frontend (sorts locales) lean la MISMA lista;
 * antes cada uno ordenaba por `code` alfabético y salía 00,01,02,…,MD-30, que no es como el
 * negocio piensa la red.
 *
 * Una tienda tiene más de un código según el sistema que la nombra (Kepler '01'/'07', Wincaja
 * 'MD-30'/'MD-32', finanzas 'MD-10'…): todos los alias de la misma plaza comparten rango.
 * Código desconocido → va DESPUÉS de los conocidos, alfabético, para que nada se pierda.
 * Dato chico (una decena de strings): puede vivir en el barrel sin pegarle al bundle inicial.
 */
/**
 * `[SUC.1]` — **`name` es el rótulo que ve la gente; `label` es la abreviatura de columna.**
 *
 * Nació de un pedido de negocio: *"sale como sucursal como número y es universal que debe salir
 * como nombre"*. Medido el 2026-10-07 en `apps/view`: **121 renderizados de un código crudo en 64
 * componentes**, en dos vocabularios — `sucursal` (71, el código Kepler de 2 dígitos) y
 * `warehouse_code` (50, que además trae `MD-*` y `RUTA-*`).
 *
 * ⭐ El nombre vive ACÁ y no en una consulta por tres razones medidas, no por comodidad:
 *
 *  1. **Alias.** Una plaza tiene varios códigos según quién la nombre, y `commercial.warehouses`
 *     los guarda en FILAS DISTINTAS (`07` y `MD-32` son dos registros). Esta lista ya los agrupa,
 *     que es exactamente lo que un rotulador necesita y la tabla no da sin lógica extra.
 *  2. **Permiso.** `GET /commercial/warehouses` exige `COMMERCIAL_WAREHOUSES_VER`, y medido en
 *     prod **39 roles / 80 personas no lo tienen** — entre ellos `finanzas`, `contabilidad`,
 *     `cajero`, `almacenista`, `tesoreria`, `facturacion`. Son justo quienes miran los códigos
 *     crudos en Finanzas, Caja, Cobranza y Almacén. Un rotulador montado ahí dejaría a más de la
 *     mitad viendo números, pero ahora escondido tras un respaldo mudo. **Un nombre de sucursal no
 *     es un secreto: es un rótulo.**
 *  3. **Ya era el lugar declarado.** Este archivo ya existía como el orden canónico de pantalla,
 *     compartido por los tres targets. Agregarle el nombre no suma una copia: **colapsa las que
 *     había** — `apps/view/.../store-branches.ts`, el mapa del prompt de Thot y los rótulos
 *     sueltos de cada servicio. `purchase-adjustments.service.ts` ya lo había denunciado textual:
 *     *"y ya divergía: «8 Esquinas» / «8ESQ» / «Ocho Esquinas»"*.
 *
 * ⚠️ **Que viva acá no lo exime de cuadrar.** `test-newdb-warehouse-names.js` comprueba contra
 * prod que cada `name` de esta lista coincide con `commercial.warehouses.name` de sus códigos. Si
 * alguien renombra una plaza en la base y no acá, el candado se pone rojo — que es la diferencia
 * entre una copia declarada y una copia que miente.
 *
 * ⛔ `03` decía **`8ESQ`** en `commercial.warehouses.name`, que es un código, no un nombre. Se
 * corrige en la base (mig `[SUC.1]`) por decisión de Edgar el 2026-10-07; `05` queda `Zamora
 * Centro` con su apodo de piso `DAMASO` en `short_label`, que no se toca.
 */
export const WAREHOUSE_DISPLAY_ORDER: ReadonlyArray<{ label: string; name: string; codes: ReadonlyArray<string> }> = Object.freeze([
  { label: 'PH',            name: 'Padre Hidalgo',     codes: ['01', 'MD-10'] },
  // '08' es el código VIVO desde la fusión del 2026-09-21 (antes `MD-30`); los otros dos son
  // alias de su historia Wincaja, que los feeds antiguos siguen emitiendo.
  { label: 'MA',            name: 'Morelia Abastos',   codes: ['08', 'MD-30', '30'] },
  { label: 'MM',            name: 'Morelia Madero',    codes: ['MD-32', '32', '07'] },
  { label: '8ESQ',          name: '8 Esquinas',        codes: ['03', 'MD-40'] },
  { label: 'LPA',           name: 'La Piedad Abastos', codes: ['02', 'MD-42'] },
  { label: 'YUR',           name: 'Yurécuaro',         codes: ['04', 'MD-44'] },
  { label: 'CAN',           name: 'Canindo',           codes: ['06', 'MD-50', '50'] },
  { label: 'ZAMORA CENTRO', name: 'Zamora Centro',     codes: ['05', 'MD-54'] },
  { label: 'CEDIS',         name: 'CEDIS',             codes: ['00', 'MD-00'] },
]);

// Bucles simples a propósito (sin flatMap/spread): este archivo lo compilan tres targets distintos.
const RANK = new Map<string, number>();
WAREHOUSE_DISPLAY_ORDER.forEach((g, i) => { g.codes.forEach((c) => RANK.set(c, i)); });

/** Rango de presentación del código (0 = primero). Desconocido → `WAREHOUSE_DISPLAY_ORDER.length`. */
export function warehouseDisplayRank(code: string | null | undefined): number {
  const c = String(code ?? '').trim().toUpperCase();
  return RANK.get(c) ?? WAREHOUSE_DISPLAY_ORDER.length;
}

const NOMBRE = new Map<string, string>();
WAREHOUSE_DISPLAY_ORDER.forEach((g) => { g.codes.forEach((c) => NOMBRE.set(c, g.name)); });

/** `RUTA-21`, `RUTA-505`, y también el `21`/`505` pelado que emiten algunos feeds. */
const RUTA_RX = /^(?:RUTA-)?(\d{2,3})$/;

/**
 * `[SUC.1]` El NOMBRE de una sucursal/almacén a partir de cualquiera de sus códigos.
 *
 * Resuelve los dos vocabularios con la misma llamada: el `sucursal` de 2 dígitos que emiten los
 * feeds de Kepler y el `warehouse_code` de `commercial.warehouses` (`07`, `MD-30`, `RUTA-21`).
 *
 * ⚠️ **Un código que no conoce se devuelve TAL CUAL, nunca en blanco ni adivinado.** Es la regla
 * de ADR-056 aplicada a un rótulo: ver `MD-99` dice «hay un almacén que esta lista no conoce» y se
 * puede arreglar; ver un hueco, o peor, el nombre de otra plaza, no se puede ni detectar. Por eso
 * el pipe de la UI no tiene rama de error: lo peor que pasa es que siga saliendo el código, que es
 * exactamente lo que salía antes.
 *
 * ⛔ Las RUTAS **no entran en `WAREHOUSE_DISPLAY_ORDER`** y es correcto: ese arreglo agrupa PLAZAS
 * para ordenar columnas, y las 13 rutas no son columnas de ese tablero. Pero sí se pintan en
 * pantalla (`RUTA-21` aparece en Almacén y en Comercial), así que su nombre se DERIVA de la forma
 * del código en vez de agregar 13 filas que habría que mantener a mano — `commercial.warehouses`
 * las llama «Ruta 21»…«Ruta 505», exactamente esto.
 */
export function warehouseName(code: string | null | undefined): string {
  const crudo = String(code ?? '').trim();
  if (!crudo) return '';
  const c = crudo.toUpperCase();
  const n = NOMBRE.get(c);
  if (n) return n;
  const r = RUTA_RX.exec(c);
  // Un código de 2 dígitos que NO está en la lista no es una ruta: es una plaza desconocida.
  // Devolverlo como «Ruta 09» sería inventar. Sólo se deriva con el prefijo explícito.
  if (r && c.startsWith('RUTA-')) return `Ruta ${r[1]}`;
  return crudo;
}

/** Código + nombre, para cuando la pantalla quiere mostrar los dos («07 · Morelia Madero»). */
export function warehouseCodeAndName(code: string | null | undefined): string {
  const crudo = String(code ?? '').trim();
  if (!crudo) return '';
  const n = warehouseName(crudo);
  return n === crudo ? crudo : `${crudo} · ${n}`;
}

/** Comparador para `Array.prototype.sort`: orden canónico; los desconocidos al final, alfabético. */
export function compareWarehouseCodes(a: string | null | undefined, b: string | null | undefined): number {
  const ra = warehouseDisplayRank(a), rb = warehouseDisplayRank(b);
  if (ra !== rb) return ra - rb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}
