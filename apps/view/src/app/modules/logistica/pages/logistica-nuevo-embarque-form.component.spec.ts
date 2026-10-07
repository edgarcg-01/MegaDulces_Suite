import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import {
  CapturaEmbarque, cuerpoDeToma, erroresDeCaptura, LogisticaNuevoEmbarqueFormComponent, totalViaticos,
} from './logistica-nuevo-embarque-form.component';
import { hojaGuia0001419, hojaSinChofer } from '../../../../testing/nuevo-embarque.fixture';
import { Driver, NuevoEmbarqueHoja } from '../logistica.service';

/**
 * EMB.12 — «Nuevo embarque», paso 2: la hoja de embarque. Lo que se prueba es lo que decide algo:
 *   · lo de Kepler va lleno y bloqueado; lo demás, en blanco para teclear — sin leyendas ni avisos;
 *   · el chofer es campo SÓLO si Kepler no lo trae (unidad 00008 de Padre Hidalgo);
 *   · el cuerpo que se manda lleva sólo lo capturado, y al crear se va al embarque.
 */

const vacia = (over: Partial<CapturaEmbarque> = {}): CapturaEmbarque => ({
  delivery_type: 'route', driver_id: null, helper1_id: null, helper2_id: null,
  driver_commission: null, helper1_commission: null, helper2_commission: null,
  per_diem_total: null, overnight: false, freight_revenue: null, actual_km: null,
  total_weight_kg: null, notes: '', ...over,
});

describe('erroresDeCaptura', () => {
  it('con el chofer de Kepler no pide nada más', () => {
    expect(erroresDeCaptura(vacia(), hojaGuia0001419())).toEqual([]);
  });
  it('sin chofer en Kepler hay que elegirlo', () => {
    expect(erroresDeCaptura(vacia(), hojaSinChofer())).toContain('Elige al chofer.');
    expect(erroresDeCaptura(vacia({ driver_id: 'd9' }), hojaSinChofer())).toEqual([]);
  });
  it('el tipo de entrega no viene de Kepler: hay que elegirlo', () => {
    expect(erroresDeCaptura(vacia({ delivery_type: null }), hojaGuia0001419())).toEqual(['Elige el tipo de entrega.']);
  });
  it('un viaje ya tomado no se puede volver a tomar', () => {
    const h = hojaGuia0001419({ tomado: { id: 'e1', folio: 'EMB-2026-00012', status: 'programado' } });
    expect(erroresDeCaptura(vacia(), h)[0]).toContain('EMB-2026-00012');
  });
  it('el chofer no va de ayudante; montos negativos y km con decimales no pasan', () => {
    const h = hojaGuia0001419();
    const e = erroresDeCaptura(vacia({ helper1_id: h.chofer.driver_id, driver_commission: -5, actual_km: 1.5 }), h);
    expect(e).toContain('El chofer no puede ir también como ayudante.');
    expect(e).toContain('La comisión del chofer no puede ser negativo.');
    expect(e).toContain('Los kilómetros deben ser un número entero.');
  });
});

describe('totalViaticos / cuerpoDeToma', () => {
  const marcas = {
    driver: { cafe: false, desayuno: true, comida: true, cena: false },
    helper1: { cafe: true, desayuno: false, comida: false, cena: false },
    helper2: { cafe: true, desayuno: true, comida: true, cena: true },
  };
  it('suma sólo las personas que van en el viaje', () => {
    const t = { cafe: 25, desayuno: 80, comida: 120, cena: 90 };
    expect(totalViaticos(marcas, t, ['driver'])).toBe(200);
    expect(totalViaticos(marcas, t, ['driver', 'helper1'])).toBe(225);
  });
  it('no manda comisión de un ayudante que no va', () => {
    const b = cuerpoDeToma(vacia({ driver_commission: 98.04, helper1_commission: 57.76, notes: '  ojo  ' }));
    expect(b).toMatchObject({ delivery_type: 'route', driver_commission: 98.04, helper1_commission: null, notes: 'ojo' });
  });
});

function montar(hoja: NuevoEmbarqueHoja, personas: Driver[] = []) {
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
  http.expectOne((r) => r.url.includes('/logistics/fleet/drivers')).flush(personas);
  http.expectOne((r) => r.url.includes('/logistics/config')).flush([]);
  f.detectChanges();
  return { f, http, nav, el: f.nativeElement as HTMLElement, comp: f.componentInstance };
}

const PERSONAS = [
  { id: 'd-otro', full_name: 'Otro chofer', roles: ['chofer'], active: true },
  { id: 'd-ay', full_name: 'Manuel M.', roles: ['ayudante'], active: true },
] as Driver[];

describe('LogisticaNuevoEmbarqueFormComponent', () => {
  it('es UNA hoja: lo de Kepler va lleno y bloqueado, lo demás en blanco para teclear', () => {
    const { el } = montar(hojaGuia0001419(), PERSONAS);
    const bloqueados = Object.fromEntries([...el.querySelectorAll('dl.hj-f')].map((x) => [
      x.querySelector('dt')!.textContent!.trim(), x.querySelector('dd')!.textContent!.trim(),
    ]));
    expect(bloqueados).toMatchObject({
      Fecha: '2026-10-03', Guía: '0001419', Origen: 'Sucursal Canindo', Unidad: '00017 · FORD 450 GASOLINA SUPER DUTY',
      Placas: 'NC-1134-D', Chofer: '00017 · CESAR C.', Cajas: '190', Sueltos: '85', 'Valor de la mercancía': '$159,596.20',
      Surtió: 'JORGE, JOSE RAMON', Checó: 'ANA GABRIELA C.', Embarcó: 'JUAN MANUEL E.',
    });
    // Lo bloqueado no es un campo: no se edita ni se le pasa con Tab.
    expect(el.querySelector('dl.hj-f input, dl.hj-f select, dl.hj-f textarea')).toBeNull();
    // Lo que se teclea: tipo de entrega, ayudantes, comisiones, viáticos, peso, km, flete, notas.
    for (const id of ['hj-ay1', 'hj-ay2', 'hj-com1', 'hj-com2', 'hj-com3', 'hj-pd', 'hj-pern', 'hj-peso', 'hj-km', 'hj-flete', 'hj-notas']) {
      expect(el.querySelector('#' + id)).not.toBeNull();
    }
    expect(el.querySelectorAll('input[name="tipo"]').length).toBe(2);
    expect(el.querySelectorAll('app-kepler-paradas tbody tr').length).toBe(13);
  });

  it('no le muestra qué está y qué no: sin leyendas, marcas de origen ni avisos', () => {
    const texto = montar(hojaGuia0001419(), PERSONAS).el.textContent!;
    for (const ruido of ['Viene de Kepler', 'Captura', 'Sugerido', 'No existe en Kepler', 'Sin medir', '¿Qué tan completo',
      'Del catálogo de rutas', 'Sin tarifa', 'kdm1', 'kdudent', 'La nota dice', 'Kepler sólo registra']) {
      expect(texto).not.toContain(ruido);
    }
  });

  it('la comisión del chofer arranca con la del catálogo de rutas y se puede cambiar', () => {
    const { el, comp } = montar(hojaGuia0001419(), PERSONAS);
    expect(comp.c.driver_commission).toBe(98.04);
    expect((el.querySelector('#hj-com1') as HTMLInputElement).readOnly).toBe(false);
  });

  it('el tipo de entrega arranca en blanco: lo elige quien arma el embarque', () => {
    const { el, comp } = montar(hojaGuia0001419(), PERSONAS);
    expect(comp.c.delivery_type).toBeNull();
    expect([...el.querySelectorAll<HTMLInputElement>('input[name="tipo"]')].some((r) => r.checked)).toBe(false);
    expect(comp.puedeCrear()).toBe(false);
    comp.c.delivery_type = 'route';
    comp.tocar();
    expect(comp.puedeCrear()).toBe(true);
  });

  it('con chofer de Kepler va bloqueado, sin selector para cambiarlo', () => {
    const { el } = montar(hojaGuia0001419(), PERSONAS);
    expect(el.querySelector('#hj-chofer')).toBeNull();
    expect(el.textContent).not.toContain('Cambiar');
  });

  it('sin chofer en Kepler el chofer es un campo más, y el botón no avanza hasta elegirlo', () => {
    const { f, el, comp } = montar(hojaSinChofer(), PERSONAS);
    expect(el.querySelector('#hj-chofer')).not.toBeNull();
    comp.c.delivery_type = 'route';
    comp.tocar();
    expect(comp.puedeCrear()).toBe(false);
    comp.c.driver_id = 'd-otro';
    comp.tocar();
    f.detectChanges();
    expect(comp.puedeCrear()).toBe(true);
  });

  // Hallado en la simulación de usuario: la lista de "qué falta" sólo se pintaba DESPUÉS de intentar
  // crear, pero el botón se apaga justo cuando falta algo — o sea, el motivo nunca se podía ver.
  it('con el botón apagado, el motivo se ve sin tener que hacer clic', () => {
    const { f, el, comp } = montar(hojaSinChofer(), PERSONAS);
    const botones = [...el.querySelectorAll('button')].filter((b) => b.textContent?.includes('Crear embarque'));
    expect(botones.length).toBe(2);
    botones.forEach((b) => {
      expect(b.disabled).toBe(true);
      expect(b.getAttribute('aria-describedby')).toBe('hj-faltan');
    });
    const faltan = el.querySelector('#hj-faltan')!.textContent!;
    expect(faltan).toContain('Elige el tipo de entrega.');
    expect(faltan).toContain('Elige al chofer.');

    comp.c.delivery_type = 'route';
    comp.c.driver_id = 'd-otro';
    comp.tocar();
    f.detectChanges();
    expect(el.querySelector('#hj-faltan')).toBeNull();
    botones.forEach((b) => expect(b.getAttribute('aria-describedby')).toBeNull());
  });

  it('al elegir ayudante le pone la comisión de ayudante del catálogo', () => {
    const { comp } = montar(hojaGuia0001419(), PERSONAS);
    comp.c.helper1_id = 'd-ay';
    comp.alElegirAyudante('helper1');
    expect(comp.c.helper1_commission).toBe(57.76);
  });

  it('crear manda sólo lo capturado y lleva al embarque nuevo', () => {
    const { http, comp, nav } = montar(hojaGuia0001419(), PERSONAS);
    comp.c.delivery_type = 'long_trip';
    comp.c.helper1_id = 'd-ay';
    comp.alElegirAyudante('helper1');
    comp.c.actual_km = 180;
    comp.crear();
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/logistics/shipments/from-kepler/06/0001419'));
    expect(req.request.body).toMatchObject({
      delivery_type: 'long_trip', driver_id: null, helper1_id: 'd-ay',
      driver_commission: 98.04, helper1_commission: 57.76, actual_km: 180, total_weight_kg: null,
    });
    req.flush({ shipment: { id: 'nuevo-id' }, guide: {}, destinatarios: 13 });
    expect(nav).toHaveBeenCalledWith(['/logistica/shipments', 'nuevo-id']);
  });

  it('si el servidor rechaza (otra persona lo tomó), lo dice y no navega', () => {
    const { f, http, el, comp, nav } = montar(hojaGuia0001419(), PERSONAS);
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
    http.match(() => true).forEach((r) => { if (!r.cancelled) r.flush([]); });
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('Kepler no tiene ese viaje');
  });
});
