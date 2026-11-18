import 'reflect-metadata';
import { Permission, PERMISSIONS_KEY, ANY_PERMISSIONS_KEY } from '@megadulces/platform-core';
import { PERMISOS_PEDIR_ANTICIPO } from '@megadulces/contracts';
import { SupplierPaymentObligationsController } from './supplier-payment-obligations.controller';

/**
 * `[PGP.138]` + `[PGP.142]` — **quién entra a cada ruta de obligaciones.** Pedir (o programar) un anticipo lo
 * abre UNA lista, `PERMISOS_PEDIR_ANTICIPO`, la misma que los botones:
 *  - Compras (`COMPRAS_OBLIGACIONES_GESTIONAR`), como desde `[PGP.119]`;
 *  - Dirección (`FINANCE_PAYMENT_CALENDAR_AUTORIZAR`) — ADR-120, Edgar, 2026-11-17;
 *  - ⛔ quien sólo programa pagos (`FINANCE_PAYMENTS_GESTIONAR`: Tesorería, Finanzas, Contabilidad) NO — ADR-120;
 *    Francisco se alineó el 2026-11-18 (D14, que los incluía, quedó sustituida).
 * Lo demás de obligaciones sigue siendo de Compras: abrir el anticipo NO abre capturar ni cancelar cualquier
 * obligación.
 *
 * Lo que se prueba es la metadata que lee `RolesGuard` (`@RequirePermissions` = todas, `@RequireAnyPermission`
 * = basta una), recorriendo TODOS los métodos: una ruta nueva sin llave rompe esta prueba.
 */
type Metodo = keyof SupplierPaymentObligationsController;
const proto = SupplierPaymentObligationsController.prototype as unknown as Record<string, object>;
const metodos = Object.getOwnPropertyNames(SupplierPaymentObligationsController.prototype)
  .filter((m) => m !== 'constructor' && typeof proto[m] === 'function') as Metodo[];
const todas = (m: Metodo): string[] | undefined => Reflect.getMetadata(PERMISSIONS_KEY, proto[m]);
const alguna = (m: Metodo): string[] | undefined => Reflect.getMetadata(ANY_PERMISSIONS_KEY, proto[m]);

/** La misma regla que `RolesGuard`: todas las de AND y al menos una de OR. */
function entra(m: Metodo, llaves: Permission[]): boolean {
  const and = todas(m) ?? [];
  const any = alguna(m) ?? [];
  return and.every((k) => llaves.includes(k as Permission)) && (!any.length || any.some((k) => llaves.includes(k as Permission)));
}
const alcanza = (llaves: Permission[]) => metodos.filter((m) => entra(m, llaves)).sort();

/** Pedir un anticipo y lo que el formulario lee para pedirlo, más deshacerlo. */
const PEDIR = ['anticipoOcs', 'anticipoProveedores', 'cancelarAnticipo', 'crearAnticipo', 'subirCotizacion'];

describe('[PGP.138][PGP.142] obligaciones a proveedor: cada ruta pide su llave', () => {
  it('el recorrido mide algo: ninguna ruta sin llave', () => {
    expect(metodos.length).toBeGreaterThanOrEqual(PEDIR.length + 5);
    for (const m of metodos) {
      expect((todas(m)?.length ?? 0) + (alguna(m)?.length ?? 0), `${m} no declara llave: quedaría abierta a cualquiera con sesión`).toBeGreaterThan(0);
    }
    for (const m of PEDIR) expect(metodos, `falta la ruta ${m}`).toContain(m);
  });

  it('pedir un anticipo acepta EXACTAMENTE la lista compartida con la pantalla', () => {
    for (const m of PEDIR) {
      expect(todas(m), `${m} no debe exigir llaves AND`).toBeUndefined();
      expect([...(alguna(m) ?? [])].sort(), m).toEqual([...PERMISOS_PEDIR_ANTICIPO].sort());
    }
  });

  it('Compras entra a todo lo suyo, como antes', () => {
    const compras = alcanza([Permission.COMPRAS_OBLIGACIONES_VER, Permission.COMPRAS_OBLIGACIONES_GESTIONAR]);
    for (const m of [...PEDIR, 'cancel', 'create', 'listAnticipos']) expect(compras, m).toContain(m);
  });

  it('[ADR-120] Dirección pide con la llave de autorizar el Calendario, sola', () => {
    const direccion = alcanza([Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR]);
    for (const m of PEDIR) expect(direccion, m).toContain(m);
  });

  it('⛔ NEGATIVA [ADR-120] — quien sólo programa pagos (Tesorería, Finanzas, Contabilidad) NO pide ni cancela anticipos; sí ve el seguimiento y la cotización', () => {
    const finanzas = alcanza([Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR]);
    for (const m of PEDIR) expect(finanzas, m).not.toContain(m);
    for (const m of ['listAnticipos', 'cotizacion']) expect(finanzas, m).toContain(m);
  });

  it('⛔ NEGATIVA — quien programa pagos o autoriza NO captura ni cancela obligaciones de Compras por la puerta genérica', () => {
    const finanzas = alcanza([Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR, Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR]);
    expect(finanzas).not.toContain('cancel');
    expect(finanzas).not.toContain('create');
  });

  it('⛔ NEGATIVA — quien sólo VE pagos u obligaciones no pide ni cancela anticipos; sin llave, nadie', () => {
    const ver = alcanza([Permission.FINANCE_PAYMENTS_VER, Permission.COMPRAS_OBLIGACIONES_VER]);
    for (const m of PEDIR) expect(ver, m).not.toContain(m);
    for (const m of PEDIR) expect(entra(m as Metodo, []), m).toBe(false);
  });
});
