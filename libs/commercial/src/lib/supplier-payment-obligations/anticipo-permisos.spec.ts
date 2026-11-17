import 'reflect-metadata';
import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY, Permission } from '@megadulces/platform-core';
import { SupplierPaymentObligationsController } from './supplier-payment-obligations.controller';

/**
 * `[PGP.138]` Quién pide (o programa) un anticipo. Edgar, 2026-11-17: desde el Calendario de pagos, **sólo
 * Dirección** (la llave de autorizar el Calendario), además de Compras, que ya lo pedía en su submódulo.
 * Tesorería y Finanzas NO: «Tesorería paga, Compras registra la deuda» (`[TP.13]`, ADR-064).
 *
 * Se prueba la metadata que lee `RolesGuard` (`@RequirePermissions` = todas, `@RequireAnyPermission` = basta una).
 */
type Metodo = 'anticipoProveedores' | 'anticipoOcs' | 'crearAnticipo';
const proto = SupplierPaymentObligationsController.prototype as unknown as Record<Metodo, object>;
const todas = (m: Metodo): string[] => Reflect.getMetadata(PERMISSIONS_KEY, proto[m]) ?? [];
const alguna = (m: Metodo): string[] => Reflect.getMetadata(ANY_PERMISSIONS_KEY, proto[m]) ?? [];
const entra = (m: Metodo, llaves: string[]): boolean =>
  todas(m).every((k) => llaves.includes(k)) && (!alguna(m).length || alguna(m).some((k) => llaves.includes(k)));
const METODOS: Metodo[] = ['anticipoProveedores', 'anticipoOcs', 'crearAnticipo'];

describe('[PGP.138] quién pide o programa un anticipo', () => {
  it('los tres pasos del diálogo existen en el controlador (si cambian de nombre, esta prueba se entera)', () => {
    for (const m of METODOS) expect(typeof proto[m]).toBe('function');
  });
  it('Compras entra, como antes', () => {
    for (const m of METODOS) expect(entra(m, [Permission.COMPRAS_OBLIGACIONES_GESTIONAR])).toBe(true);
  });
  it('Dirección entra con la llave de autorizar el Calendario', () => {
    for (const m of METODOS) expect(entra(m, [Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR])).toBe(true);
  });
  it('⛔ quien sólo prepara o ve pagos (Tesorería, Finanzas, Contabilidad) NO entra', () => {
    const preparar = [Permission.FINANCE_PAYMENTS_GESTIONAR, Permission.FINANCE_PAYMENTS_VER, Permission.COMPRAS_OBLIGACIONES_VER];
    for (const m of METODOS) expect(entra(m, preparar)).toBe(false);
  });
  it('⛔ nadie entra sin llave', () => {
    for (const m of METODOS) expect(entra(m, [])).toBe(false);
  });
});
