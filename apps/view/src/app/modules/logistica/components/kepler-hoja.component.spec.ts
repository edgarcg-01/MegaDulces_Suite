import { TestBed } from '@angular/core/testing';
import { datosDeKepler, KeplerHojaComponent } from './kepler-hoja.component';
import { hojaGuia0001419, hojaSinChofer } from '../../../../testing/nuevo-embarque.fixture';
import { GuideRecipient, NuevoEmbarqueHoja } from '../logistica.service';

/**
 * EMB.12 — El viaje de Kepler escrito en la hoja de embarque. Lo que se prueba es lo que el
 * coordinador LEE: los datos llenos con las palabras de la hoja, sin andamio (ni marcas de origen,
 * ni columnas de Kepler, ni avisos de qué falta).
 */

describe('datosDeKepler — la guía 0001419 de Canindo', () => {
  it('trae lo que Kepler ya escribió, listo para la hoja', () => {
    const d = datosDeKepler(hojaGuia0001419());
    expect(d).toMatchObject({
      fecha: '2026-10-03', guia: '0001419', origen: 'Sucursal Canindo', tipo: 'Entrega a cliente',
      unidad: '00017 · FORD 450 GASOLINA SUPER DUTY', placas: 'NC-1134-D', chofer: '00017 · CESAR C.',
      rutas: 'JIQUILPAN · SAHUAYO · SANTAGIO TANGAMNADAPIO · VENUSTIANO CARRANZA',
      surtio: 'JORGE, JOSE RAMON', checo: 'ANA GABRIELA C.', embarco: 'JUAN MANUEL E.',
      paradas: '13', cajas: '190', sueltos: '85', valor: '$159,596.20', traspaso: null,
    });
  });

  it('si Kepler no trae chofer, el dato queda vacío (es el campo que se captura)', () => {
    expect(datosDeKepler(hojaSinChofer()).chofer).toBeNull();
  });

  it('el traspaso va aparte de la venta: a costo, sin sumarse', () => {
    const h = hojaGuia0001419();
    h.resumen.valor_traspaso = 175340.51;
    expect(datosDeKepler(h)).toMatchObject({ valor: '$159,596.20', traspaso: '$175,340.51' });
  });
});

function montar(hoja: NuevoEmbarqueHoja, entregas: GuideRecipient[] = []) {
  TestBed.configureTestingModule({ imports: [KeplerHojaComponent] });
  const f = TestBed.createComponent(KeplerHojaComponent);
  f.componentRef.setInput('hoja', hoja);
  f.componentRef.setInput('entregas', entregas);
  f.detectChanges();
  return f.nativeElement as HTMLElement;
}

describe('KeplerHojaComponent — el viaje dentro del embarque ya creado', () => {
  it('pinta los datos de Kepler como hoja de sólo lectura, con sus paradas', () => {
    const el = montar(hojaGuia0001419());
    const campos = Object.fromEntries([...el.querySelectorAll('.kh-f')].map((x) => [
      x.querySelector('dt')!.textContent!.trim(), x.querySelector('dd')!.textContent!.trim(),
    ]));
    expect(campos).toMatchObject({ Unidad: '00017 · FORD 450 GASOLINA SUPER DUTY', Chofer: '00017 · CESAR C.', Cajas: '190' });
    expect(el.querySelectorAll('app-kepler-paradas tbody tr').length).toBe(13);
    expect(el.querySelector('input, select, textarea')).toBeNull();
  });

  it('sin andamio: ni marcas de origen ni columnas de Kepler ni avisos', () => {
    const texto = montar(hojaGuia0001419()).textContent!;
    for (const ruido of ['kdm1', 'kdudent', 'solo lectura', 'Sin medir', 'No viene en Kepler', 'La nota dice']) {
      expect(texto).not.toContain(ruido);
    }
  });

  it('las paradas llevan lo que registró el chofer en cada entrega', () => {
    const entregas = [
      { id: 'r1', guide_id: 'g', customer_name: 'x', boxes_count: 67, weight_kg: 0, value: 0, status: 'entregado', kepler_folio: '0001052', kepler_serie: '1' },
    ] as GuideRecipient[];
    const el = montar(hojaGuia0001419(), entregas);
    expect(el.querySelector('thead')!.textContent).toContain('Entrega');
    expect(el.querySelector('tbody tr')!.textContent).toContain('Entregado');
  });
});
