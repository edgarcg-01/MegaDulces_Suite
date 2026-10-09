import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import {
  CapturaEmbarque, cuerpoDeToma, erroresDeCaptura, LogisticaNuevoEmbarqueFormComponent, SE_CALCULA_EN_GUIAS, SE_CAPTURA_EN_GUIAS,
} from './logistica-nuevo-embarque-form.component';
import { hojaGuia0001419, hojaSinChofer } from '../../../../testing/nuevo-embarque.fixture';
import { NuevoEmbarqueHoja } from '../logistica.service';

/**
 * EMB.12 / EMB.22 — «Nuevo embarque», paso 2: la hoja de embarque. Lo que se prueba es lo que
 * decide algo:
 *   · lo de Kepler va lleno y bloqueado; lo del EMBARQUE que Kepler no tiene (tipo de entrega,
 *     peso, km, flete, notas) en blanco para teclear;
 *   · lo de la GUÍA que Kepler no tiene (ayudantes, horario, el chofer si falta) va BLOQUEADO con
 *     «Se captura en Guías»: se llena una sola vez, en la pestaña Guías del embarque;
 *   · el cuerpo que se manda lleva sólo lo del embarque, y al crear se va al embarque.
 */

const vacia = (over: Partial<CapturaEmbarque> = {}): CapturaEmbarque => ({
  delivery_type: 'route', freight_revenue: null, actual_km: null, total_weight_kg: null, notes: '', ...over,
});

describe('erroresDeCaptura', () => {
  it('con el tipo de entrega no pide nada más: ni chofer, ni tarifa, ni horario', () => {
    expect(erroresDeCaptura(vacia(), hojaGuia0001419())).toEqual([]);
    expect(erroresDeCaptura(vacia(), hojaSinChofer())).toEqual([]);
  });
  it('el tipo de entrega no viene de Kepler: hay que elegirlo', () => {
    expect(erroresDeCaptura(vacia({ delivery_type: null }), hojaGuia0001419())).toEqual(['Elige el tipo de entrega.']);
  });
  it('un viaje ya tomado no se puede volver a tomar', () => {
    const h = { ...hojaGuia0001419(), tomado: { id: 'x', folio: 'EMB-2026-00012', status: 'programado' } };
    expect(erroresDeCaptura(vacia(), h)[0]).toContain('EMB-2026-00012');
  });
  it('montos negativos y km con decimales no pasan', () => {
    const e = erroresDeCaptura(vacia({ freight_revenue: -5, actual_km: 1.5 }), hojaGuia0001419());
    expect(e).toEqual(['El flete cobrado no puede ser negativo.', 'Los kilómetros deben ser un número entero.']);
  });
});

describe('cuerpoDeToma', () => {
  it('lleva sólo lo del embarque: la tripulación, el horario y los montos de la guía NO viajan', () => {
    const b = cuerpoDeToma(vacia({ notes: '  ojo  ', actual_km: 180 }));
    expect(b).toEqual({ delivery_type: 'route', freight_revenue: null, actual_km: 180, total_weight_kg: null, notes: 'ojo' });
  });
});

function montar(hoja: NuevoEmbarqueHoja) {
  TestBed.configureTestingModule({
    imports: [LogisticaNuevoEmbarqueFormComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ sucursal: '06', guia: '0001419' }) } } },
    ],
  });
  const router = TestBed.inject(Router);
  const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const f = TestBed.createComponent(LogisticaNuevoEmbarqueFormComponent);
  const http = TestBed.inject(HttpTestingController);
  f.detectChanges();
  http.expectOne((r) => r.url.endsWith('/erp-shipments/trips/06/0001419/nuevo-embarque')).flush(hoja);
  f.detectChanges();
  return { f, http, nav, el: f.nativeElement as HTMLElement, comp: f.componentInstance };
}

/** Los campos bloqueados de la hoja como { etiqueta: valor }. */
const bloqueadosDe = (el: HTMLElement) => Object.fromEntries([...el.querySelectorAll('dl.hj-f')].map((x) => [
  x.querySelector('dt')!.textContent!.trim(), x.querySelector('dd')!.textContent!.trim(),
]));

describe('LogisticaNuevoEmbarqueFormComponent', () => {
  it('es UNA hoja: lo de Kepler lleno y bloqueado, lo del embarque en blanco para teclear', () => {
    const { el } = montar(hojaGuia0001419());
    expect(bloqueadosDe(el)).toMatchObject({
      Fecha: '2026-10-03', Guía: '0001419', Origen: 'Sucursal Canindo', Unidad: '00017 · FORD 450 GASOLINA SUPER DUTY',
      Placas: 'NC-1134-D', Cajas: '190', Sueltos: '85', 'Valor de la mercancía': '$159,596.20',
    });
    // Lo bloqueado no es un campo: no se edita ni se le pasa con Tab.
    expect(el.querySelector('dl.hj-f input, dl.hj-f select, dl.hj-f textarea')).toBeNull();
    // Lo que se teclea es del EMBARQUE: tipo de entrega, peso, km, flete, notas.
    for (const id of ['hj-peso', 'hj-km', 'hj-flete', 'hj-notas']) expect(el.querySelector('#' + id)).not.toBeNull();
    expect(el.querySelectorAll('input[name="tipo"]').length).toBe(2);
    expect(el.querySelectorAll('app-kepler-paradas tbody tr').length).toBe(13);
  });

  it('lo de la guía que Kepler no tiene va BLOQUEADO con «Se captura en Guías»: aquí no se teclea', () => {
    const { el } = montar(hojaGuia0001419());
    const b = bloqueadosDe(el);
    expect(b['Ayudantes']).toBe(SE_CAPTURA_EN_GUIAS);
    expect(b['Hora de salida']).toBe(SE_CAPTURA_EN_GUIAS);
    expect(b['Hora de llegada']).toBe(SE_CAPTURA_EN_GUIAS);
    expect(b['Comisión y viáticos']).toBe(SE_CALCULA_EN_GUIAS);
    // Con chofer en Kepler, el chofer es el de Kepler (bloqueado), no la leyenda.
    expect(b['Chofer']).toBeTruthy();
    expect(b['Chofer']).not.toBe(SE_CAPTURA_EN_GUIAS);
    for (const id of ['hj-chofer', 'hj-ay1', 'hj-ay2', 'hj-sal', 'hj-lleg', 'hj-pern', 'hj-pd']) {
      expect(el.querySelector('#' + id)).toBeNull();
    }
    expect(el.querySelector('app-guia-calculada')).toBeNull();
  });

  it('sin chofer en Kepler, el chofer también dice «Se captura en Guías» y la toma no se frena por eso', () => {
    const { el, comp } = montar(hojaSinChofer());
    expect(bloqueadosDe(el)['Chofer']).toBe(SE_CAPTURA_EN_GUIAS);
    comp.c.delivery_type = 'route';
    comp.tocar();
    expect(comp.puedeCrear()).toBe(true);
  });

  it('no le muestra marcas de origen ni avisos de tarifas', () => {
    const texto = montar(hojaGuia0001419()).el.textContent!;
    for (const ruido of ['Viene de Kepler', 'Sugerido', 'No existe en Kepler', 'Sin medir', '¿Qué tan completo',
      'Del catálogo de rutas', 'Sin tarifa', 'kdm1', 'kdudent', 'La nota dice', 'Kepler sólo registra']) {
      expect(texto).not.toContain(ruido);
    }
  });

  it('el tipo de entrega arranca en blanco: lo elige quien arma el embarque', () => {
    const { el, comp } = montar(hojaGuia0001419());
    expect(comp.c.delivery_type).toBeNull();
    expect([...el.querySelectorAll<HTMLInputElement>('input[name="tipo"]')].some((r) => r.checked)).toBe(false);
    expect(comp.puedeCrear()).toBe(false);
    comp.c.delivery_type = 'route';
    comp.tocar();
    expect(comp.puedeCrear()).toBe(true);
  });

  it('con el botón apagado, el motivo se ve sin tener que hacer clic', () => {
    const { f, el, comp } = montar(hojaGuia0001419());
    const botones = [...el.querySelectorAll('button')].filter((b) => b.textContent?.includes('Crear embarque'));
    expect(botones.length).toBe(2);
    botones.forEach((b) => {
      expect(b.disabled).toBe(true);
      expect(b.getAttribute('aria-describedby')).toBe('hj-faltan');
    });
    expect(el.querySelector('#hj-faltan')!.textContent).toContain('Elige el tipo de entrega.');
    comp.c.delivery_type = 'route';
    comp.tocar();
    f.detectChanges();
    expect(el.querySelector('#hj-faltan')).toBeNull();
    botones.forEach((b) => expect(b.getAttribute('aria-describedby')).toBeNull());
  });

  it('crear manda sólo lo del embarque y lleva al embarque nuevo (ahí se completa la guía)', () => {
    const { http, comp, nav } = montar(hojaGuia0001419());
    comp.c.delivery_type = 'long_trip';
    comp.c.actual_km = 180;
    comp.tocar();
    comp.crear();
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/logistics/shipments/from-kepler/06/0001419'));
    expect(req.request.body).toEqual({ delivery_type: 'long_trip', freight_revenue: null, actual_km: 180, total_weight_kg: null, notes: null });
    req.flush({ shipment: { id: 'nuevo-id' }, guide: {}, destinatarios: 13 });
    expect(nav).toHaveBeenCalledWith(['/logistica/shipments', 'nuevo-id']);
  });

  it('si el servidor rechaza (otra persona lo tomó), lo dice y no navega', () => {
    const { f, http, el, comp, nav } = montar(hojaGuia0001419());
    comp.c.delivery_type = 'route';
    comp.tocar();
    comp.crear();
    http.expectOne((r) => r.method === 'POST').flush(
      { message: 'Otra persona acaba de tomar este viaje. Recarga la lista.' }, { status: 409, statusText: 'Conflict' });
    f.detectChanges();
    expect(el.textContent).toContain('Otra persona acaba de tomar este viaje');
    expect(nav).not.toHaveBeenCalled();
  });

  it('una guía que Kepler ya no tiene muestra el motivo', () => {
    TestBed.configureTestingModule({
      imports: [LogisticaNuevoEmbarqueFormComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ sucursal: '06', guia: '9' }) } } },
      ],
    });
    const f = TestBed.createComponent(LogisticaNuevoEmbarqueFormComponent);
    const http = TestBed.inject(HttpTestingController);
    f.detectChanges();
    http.expectOne((r) => r.url.includes('nuevo-embarque')).flush({ message: 'no' }, { status: 404, statusText: 'NF' });
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('Kepler no tiene ese viaje');
  });
});
