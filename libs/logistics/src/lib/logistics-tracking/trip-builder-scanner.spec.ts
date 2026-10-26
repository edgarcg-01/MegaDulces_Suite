import { TripBuilderScannerService } from './trip-builder-scanner.service';
import type { TripBuilderService } from './trip-builder.service';

/**
 * `[EMB.55]` Al ligar tarde un rastreador, sus días anteriores ya tienen posiciones pero no resumen.
 * El ciclo nocturno los arma después de ayer. La consulta de huecos (`diasSinResumen`) se ejerció
 * contra prod en sólo lectura; aquí se prueba el ciclo.
 */
describe('TripBuilderScannerService.rellenarHuecos', () => {
  const armar = (huecos: Array<{ vehicle_id: string; day: string }>, falla?: string) => {
    const hechos: string[] = [];
    const trips = {
      diasSinResumen: async () => huecos,
      buildForVehicleDay: async (v: string, d: string) => {
        if (v === falla) throw new Error('sin posiciones');
        hechos.push(`${v}|${d}`);
        return { vehicle_id: v, day: d, fixes: 1, stops: 0, customer_stops: 0, km_driven: 0 };
      },
    } as unknown as TripBuilderService;
    return { svc: new TripBuilderScannerService(trips), hechos };
  };

  it('arma cada vehículo × día que falta', async () => {
    const { svc, hechos } = armar([{ vehicle_id: 'hino', day: '2026-09-17' }, { vehicle_id: 'hino', day: '2026-09-18' }]);
    expect(await svc.rellenarHuecos()).toEqual({ armados: 2, fallidos: 0 });
    expect(hechos).toEqual(['hino|2026-09-17', 'hino|2026-09-18']);
  });

  it('PRUEBA NEGATIVA: un día que falla se cuenta y no frena a los demás', async () => {
    const { svc, hechos } = armar([{ vehicle_id: 'roto', day: '2026-09-17' }, { vehicle_id: 'hino', day: '2026-09-17' }], 'roto');
    expect(await svc.rellenarHuecos()).toEqual({ armados: 1, fallidos: 1 });
    expect(hechos).toEqual(['hino|2026-09-17']);
  });

  it('sin huecos no arma nada', async () => {
    const { svc, hechos } = armar([]);
    expect(await svc.rellenarHuecos()).toEqual({ armados: 0, fallidos: 0 });
    expect(hechos).toEqual([]);
  });
});
