import 'reflect-metadata';
import { ObjectStorageService } from '@megadulces/platform-core';
import { CommercialSupplierPaymentObligationsModule } from './commercial-supplier-payment-obligations.module';
import { SupplierPaymentObligationsService } from './supplier-payment-obligations.service';

/**
 * `[PGP.127]` **El grafo de Nest cierra con el almacenamiento de la cotización.**
 *
 * `SupplierPaymentObligationsService` recibe ahora `ObjectStorageService` (la cotización del anticipo). Si
 * el módulo no lo tiene al alcance, la API no arranca — la familia de #414, que tiró prod con el CI en
 * verde: que compile no es que arranque.
 *
 * ⛔ No se lee `design:paramtypes`: vitest transpila sin `emitDecoratorMetadata` y esa clave llega vacía
 * (la trampa de `[CB.53.1]`). Lo comprobable sin levantar la app es que el proveedor esté al ALCANCE del
 * módulo: lo que provee + lo que exportan sus imports.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];

function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) {
    for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  }
  return out;
}

describe('[PGP.127] el módulo de obligaciones tiene el almacenamiento de la cotización', () => {
  it('el servicio de obligaciones lo provee el módulo', () => {
    expect(meta<unknown>('providers', CommercialSupplierPaymentObligationsModule)).toContain(SupplierPaymentObligationsService);
  });

  it('ObjectStorageService está al alcance: lo exporta uno de sus imports (CloudinaryModule)', () => {
    expect(alcanceDe(CommercialSupplierPaymentObligationsModule).has(ObjectStorageService)).toBe(true);
  });

  it('NO lo provee por su cuenta: sería una segunda instancia sin su configuración', () => {
    expect(meta<unknown>('providers', CommercialSupplierPaymentObligationsModule)).not.toContain(ObjectStorageService);
  });

  it('PRUEBA NEGATIVA: sin ese import, la comprobación se pone roja', () => {
    // Sin decorador: un decorador DENTRO del spec no se transforma. Es la misma metadata que pondría.
    class ModuloSinElImport {}
    Reflect.defineMetadata('providers', [SupplierPaymentObligationsService], ModuloSinElImport);
    Reflect.defineMetadata('imports', [], ModuloSinElImport);
    expect(alcanceDe(ModuloSinElImport).has(ObjectStorageService)).toBe(false);
  });
});
