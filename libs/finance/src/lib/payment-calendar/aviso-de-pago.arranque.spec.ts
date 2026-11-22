import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { JwtModule } from '@nestjs/jwt';
import { IS_PUBLIC_KEY, Permission, PERMISSIONS_KEY } from '@megadulces/platform-core';
import { FinancePaymentCalendarModule } from './finance-payment-calendar.module';
import { AvisoDePagoService } from './aviso-de-pago.service';
import { AvisoDePagoController, AvisoDePagoPublicoController } from './aviso-de-pago.controller';

/**
 * `[PGP.194]` Que compile no es que arranque (`#414`): vitest no emite `design:paramtypes`, así que el grafo se lee
 * del módulo y de la aridad, y cada ruta por su metadata (la llave que lee `RolesGuard`).
 */
const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
const ruta = (c: object, m: string) => {
  const f = (c as Record<string, object>)[m];
  return `${Reflect.getMetadata(METHOD_METADATA, f)} ${Reflect.getMetadata(PATH_METADATA, f)}`;
};
const llaves = (c: object, m: string): string[] | undefined => Reflect.getMetadata(PERMISSIONS_KEY, (c as Record<string, object>)[m]);

describe('[PGP.194] el aviso de pago entra al módulo del Calendario sin mover lo que ya está en prod', () => {
  it('servicio con 4 dependencias (tk, tenant, jwt, almacenamiento opcional) y cada controlador con 1', () => {
    expect(AvisoDePagoService.length).toBe(4);
    expect(AvisoDePagoController.length).toBe(1);
    expect(AvisoDePagoPublicoController.length).toBe(1);
  });

  it('los dos controladores y el servicio registrados; el JWT que firma la liga lo provee el MISMO módulo', () => {
    const ctrls = meta('controllers', FinancePaymentCalendarModule);
    expect(ctrls).toContain(AvisoDePagoController);
    expect(ctrls).toContain(AvisoDePagoPublicoController);
    expect(meta('providers', FinancePaymentCalendarModule)).toContain(AvisoDePagoService);
    const imports = meta<{ module?: unknown }>('imports', FinancePaymentCalendarModule);
    expect(imports.some((i) => i && (i as { module?: unknown }).module === JwtModule)).toBe(true);
  });

  it('prefijos propios: no cuelgan de `finance/payment-calendar`', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AvisoDePagoController)).toBe('finance/payment-notices');
    expect(Reflect.getMetadata(PATH_METADATA, AvisoDePagoPublicoController)).toBe('finance/payment-notice');
    const p = AvisoDePagoController.prototype as unknown as object;
    expect({ datos: ruta(p, 'datos'), crear: ruta(p, 'crear'), pdf: ruta(p, 'pdf') }).toEqual({
      datos: `${RequestMethod.GET} :allocationId`, crear: `${RequestMethod.POST} :allocationId`, pdf: `${RequestMethod.GET} :allocationId/pdf`,
    });
    expect(ruta(AvisoDePagoPublicoController.prototype as unknown as object, 'pdf')).toBe(`${RequestMethod.GET} :token/aviso.pdf`);
  });
});

describe('[PGP.194] cada ruta pide su llave', () => {
  const p = AvisoDePagoController.prototype as unknown as object;
  it('ver el aviso y su PDF: ver pagos; generar la liga (escribe): gestionarlos', () => {
    expect(llaves(p, 'datos')).toEqual([Permission.FINANCE_PAYMENTS_VER]);
    expect(llaves(p, 'pdf')).toEqual([Permission.FINANCE_PAYMENTS_VER]);
    expect(llaves(p, 'crear')).toEqual([Permission.FINANCE_PAYMENTS_GESTIONAR]);
  });
  it('⛔ NEGATIVA — ninguna ruta interna es pública; la única pública es la de la liga', () => {
    for (const m of ['datos', 'crear', 'pdf']) expect(Reflect.getMetadata(IS_PUBLIC_KEY, (p as Record<string, object>)[m]), m).toBeFalsy();
    const pub = AvisoDePagoPublicoController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, pub['pdf'])).toBe(true);
  });
});
