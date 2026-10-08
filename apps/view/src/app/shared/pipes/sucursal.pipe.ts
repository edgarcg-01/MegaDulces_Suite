import { Pipe, PipeTransform } from '@angular/core';
import { warehouseName, warehouseCodeAndName } from '@megadulces/contracts';

/**
 * `[SUC.1]` El código de una sucursal o almacén, rotulado con su NOMBRE.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────
 * Pedido de negocio: *"sale como sucursal como número y es universal que debe salir como
 * nombre"*. Medido el 2026-10-07: **121 renderizados de un código crudo en 64 componentes**,
 * en dos vocabularios — `sucursal` (71, el código Kepler de 2 dígitos) y `warehouse_code`
 * (50, que además trae `MD-*` y `RUTA-*`). Nadie podía leer «07» y saber que es Morelia Madero.
 *
 * ── Por qué es PURO y sin HTTP ───────────────────────────────────────────────────────────
 * ⛔ La ruta obvia era pedirle la lista al backend, y está medida como peor: `GET
 * /commercial/warehouses` exige `COMMERCIAL_WAREHOUSES_VER`, y **39 roles / 80 personas no lo
 * tienen** —`finanzas`, `contabilidad`, `cajero`, `almacenista`, `tesoreria`, `facturacion`—,
 * que son justo quienes miran los códigos crudos en Finanzas, Caja, Cobranza y Almacén. Un
 * rotulador montado ahí dejaría a más de la mitad viendo números, sólo que ahora detrás de un
 * respaldo mudo. **Un nombre de sucursal no es un secreto: es un rótulo.**
 *
 * Resuelve contra `WAREHOUSE_DISPLAY_ORDER` de `libs/contracts`, que ya era el orden canónico
 * de pantalla compartido por backend y frontend, y que ya agrupa los alias de cada plaza (`07`
 * y `MD-32` son FILAS distintas en `commercial.warehouses`, pero la misma tienda). Al ser puro
 * no re-evalúa en cada ciclo de cambio: con `OnPush` y zoneless eso importa en tablas de cientos
 * de filas.
 *
 * ── Qué hace cuando NO conoce el código ──────────────────────────────────────────────────
 * Lo devuelve tal cual. Nunca vacío, nunca el nombre de la plaza vecina. Ver un `MD-99` dice
 * «hay un almacén que la lista no conoce» y se arregla; un hueco no se detecta, y un nombre
 * equivocado se cree. Por eso este pipe **no puede empeorar nada**: lo peor que llega a pasar
 * es que siga saliendo el código, que es exactamente lo que salía antes.
 *
 * ── Uso ──────────────────────────────────────────────────────────────────────────────────
 *     {{ r.warehouse_code | sucursal }}            → «Morelia Madero»
 *     {{ r.sucursal | sucursal:'con-codigo' }}     → «07 · Morelia Madero»
 *
 * `con-codigo` es para las tablas donde el código ES dato operativo (lo dictan por teléfono,
 * lo tipean en Kepler); en el resto va el nombre solo.
 */
@Pipe({ name: 'sucursal', standalone: true, pure: true })
export class SucursalPipe implements PipeTransform {
  transform(code: string | null | undefined, modo?: 'con-codigo' | 'nombre'): string {
    return modo === 'con-codigo' ? warehouseCodeAndName(code) : warehouseName(code);
  }
}
