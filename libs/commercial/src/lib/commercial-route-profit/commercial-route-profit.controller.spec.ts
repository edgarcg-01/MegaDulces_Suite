import 'reflect-metadata';
import { CommercialRouteProfitController } from './commercial-route-profit.controller';
import { CommercialRouteProfitModule } from './commercial-route-profit.module';
import { TlmkTripsService } from './tlmk-trips.service';

/**
 * `[FCT.2.1]` — Al agregar `TlmkTripsService` al constructor y la ruta `tlmk`, lo que se puede romper
 * es el ARRANQUE (ONBOARDING §30, #414).
 *
 * ⛔ Acá NO se lee `design:paramtypes`: vitest transpila sin `emitDecoratorMetadata` y la clave llega
 * vacía (medido: la prueba que la leía falló con «sin design:paramtypes»). Se verificó aparte con
 * `ts.transpileModule` y metadata encendida (2026-11-04): el constructor emite
 * `[RouteProfitService, TlmkTripsService]` y `viajesTlmk` emite `[String, String, String]`.
 */
describe('[FCT.2.1] CommercialRouteProfitController · arranque', () => {
  it('el constructor toma sus dos dependencias', () => {
    expect(CommercialRouteProfitController.length).toBe(2);
  });

  it('el módulo provee el servicio de viajes TM', () => {
    const meta = (k: string) =>
      (Reflect as unknown as { getMetadata(k: string, o: object): unknown[] }).getMetadata(k, CommercialRouteProfitModule) ?? [];
    expect(meta('providers')).toContain(TlmkTripsService);
    expect(meta('controllers')).toContain(CommercialRouteProfitController);
  });
});
