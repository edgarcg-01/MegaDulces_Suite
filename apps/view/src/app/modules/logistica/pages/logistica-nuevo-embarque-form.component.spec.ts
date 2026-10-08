import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import {
  CapturaEmbarque, cuerpoDeToma, erroresDeCaptura, LogisticaNuevoEmbarqueFormComponent,
} from './logistica-nuevo-embarque-form.component';
import { conTarifaCompleta, hojaGuia0001419, hojaSinChofer } from '../../../../testing/nuevo-embarque.fixture';
import { Driver, NuevoEmbarqueHoja } from '../logistica.service';

/**
 * EMB.12 — «Nuevo embarque», paso 2: la hoja de embarque. Lo que se prueba es lo que decide algo:
 *   · lo de Kepler va lleno y bloqueado; lo demás, en blanco para teclear — sin leyendas ni avisos;
 *   · la COMISIÓN también va bloqueada: se calcula de la tarifa del viaje (fórmula de la beta de
 *     Logística) y si una ruta no tiene tarifa la hoja no deja crear;
 *   · el chofer es campo SÓLO si Kepler no lo trae (unidad 00008 de Padre Hidalgo);
 *   · los VIÁTICOS también: salen del horario (regla de la beta, EMB.19) y no se teclean;
 *   · el cuerpo que se manda lleva sólo lo capturado, y al crear se va al embarque.
 *
 * La guía 0001419 real trae SANTAGIO TANGAMNADAPIO sin tarifa, así que la hoja la FRENA. Las pruebas
 * de lo que pasa cuando sí se puede crear usan `conTarifaCompleta` (todas sus rutas tarifadas).
 */

const tarifada = () => conTarifaCompleta(hojaGuia0001419());

// Un día que no da comidas (sale 8:00, llega 14:00): no hace falta tarifa de viático.
const vacia = (over: Partial<CapturaEmbarque> = {}): CapturaEmbarque => ({
  delivery_type: 'route', driver_id: null, helper1_id: null, helper2_id: null,
  departure_time: '08:00', arrival_time: '14:00', overnight: false, freight_revenue: null, actual_km: null,
  total_weight_kg: null, notes: '', ...over,
});
/** Las tarifas de viático de la beta (logistics_baseline.js). */
const TARIFAS = { cafe: 50, desayuno: 100, comida: 100, cena: 100 };
const CONFIG_VIATICO = [
  { key: 'viatico_cafe', value: 50 }, { key: 'viatico_desayuno', value: 100 },
  { key: 'viatico_comida', value: 100 }, { key: 'viatico_cena', value: 100 },
];

describe('erroresDeCaptura', () => {
  it('con el chofer de Kepler y la tarifa completa no pide nada más', () => {
    expect(erroresDeCaptura(vacia(), tarifada(), TARIFAS)).toEqual([]);
  });
  it('sin chofer en Kepler hay que elegirlo', () => {
    expect(erroresDeCaptura(vacia(), hojaSinChofer(), TARIFAS)).toContain('Elige al chofer.');
    expect(erroresDeCaptura(vacia({ driver_id: 'd9' }), conTarifaCompleta(hojaSinChofer()), TARIFAS)).toEqual([]);
  });
  it('el tipo de entrega no viene de Kepler: hay que elegirlo', () => {
    expect(erroresDeCaptura(vacia({ delivery_type: null }), tarifada(), TARIFAS)).toEqual(['Elige el tipo de entrega.']);
  });
  it('una ruta sin tarifa frena, y dice cuál y dónde se captura (la guía real)', () => {
    expect(erroresDeCaptura(vacia(), hojaGuia0001419(), TARIFAS))
      .toEqual(['Falta la tarifa de SANTAGIO TANGAMNADAPIO en Logística › Configuración › Comisiones.']);
  });
  it('un viaje ya tomado no se puede volver a tomar', () => {
    const h = hojaGuia0001419({ tomado: { id: 'e1', folio: 'EMB-2026-00012', status: 'programado' } });
    expect(erroresDeCaptura(vacia(), h, TARIFAS)[0]).toContain('EMB-2026-00012');
  });
  it('el chofer no va de ayudante; montos negativos y km con decimales no pasan', () => {
    const h = tarifada();
    const e = erroresDeCaptura(vacia({ helper1_id: h.chofer.driver_id, freight_revenue: -5, actual_km: 1.5 }), h, TARIFAS);
    expect(e).toContain('El chofer no puede ir también como ayudante.');
    expect(e).toContain('El flete cobrado no puede ser negativo.');
    expect(e).toContain('Los kilómetros deben ser un número entero.');
  });
});

describe('erroresDeCaptura — viáticos por horario (EMB.19)', () => {
  it('sin horario no se crea: los viáticos salen de él', () => {
    expect(erroresDeCaptura(vacia({ departure_time: '', arrival_time: '' }), tarifada(), TARIFAS))
      .toEqual(['Indica la hora de salida.', 'Indica la hora de llegada.']);
  });
  it('si el horario da una comida sin tarifa, frena y dice dónde se captura', () => {
    expect(erroresDeCaptura(vacia({ departure_time: '05:30' }), tarifada(), { ...TARIFAS, cafe: 0 }))
      .toEqual(['Falta la tarifa de café en Logística › Configuración › Viáticos.']);
  });
  it('si no se pudieron leer las tarifas, lo dice (no lo toma por «sin tarifa»)', () => {
    expect(erroresDeCaptura(vacia(), tarifada(), null)).toEqual(['No se pudieron leer las tarifas de viáticos. Recarga la página.']);
  });
});

describe('cuerpoDeToma', () => {
  it('lleva el horario; comisión y viáticos NO viajan: los calcula el servidor', () => {
    const b = cuerpoDeToma(vacia({ helper1_id: 'd-ay', notes: '  ojo  ', overnight: true }));
    expect(b).toMatchObject({ delivery_type: 'route', helper1_id: 'd-ay', notes: 'ojo', departure_time: '08:00', arrival_time: '14:00', overnight: true });
    for (const k of ['driver_commission', 'helper1_commission', 'helper2_commission', 'per_diem_total', 'per_diem_breakdown']) {
      expect(b).not.toHaveProperty(k);
    }
  });
});

function montar(hoja: NuevoEmbarqueHoja, personas: Driver[] = [], viatico: unknown[] = []) {
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
  http.expectOne((r) => r.url.includes('/logistics/config')).flush(viatico);
  f.detectChanges();
  return { f, http, nav, el: f.nativeElement as HTMLElement, comp: f.componentInstance };
}

/** Comisión y viáticos calculados, por renglón: { Chofer: [comisión, viáticos], … }. */
const calculadoDe = (el: HTMLElement) => Object.fromEntries([...el.querySelectorAll('app-guia-calculada tbody tr')].map((tr) => {
  const celdas = [...tr.querySelectorAll('td')].map((td) => td.textContent!.trim());
  const rol = tr.querySelector('th')!.childNodes[0].textContent!.trim();
  return [rol, [celdas[0], celdas[celdas.length - 1]]];
}));

/** Pone el horario y vuelve a pintar. */
const horario = (f: { detectChanges(): void }, comp: LogisticaNuevoEmbarqueFormComponent, salida = '08:00', llegada = '14:00', duerme = false) => {
  comp.c.departure_time = salida;
  comp.c.arrival_time = llegada;
  comp.c.overnight = duerme;
  comp.tocar();
  f.detectChanges();
};

const PERSONAS = [
  { id: 'd-otro', full_name: 'Otro chofer', roles: ['chofer'], active: true },
  { id: 'd-ay', full_name: 'Manuel M.', roles: ['ayudante'], active: true },
] as Driver[];

/** Los campos bloqueados de la hoja como { etiqueta: valor }. */
const bloqueadosDe = (el: HTMLElement) => Object.fromEntries([...el.querySelectorAll('dl.hj-f')].map((x) => [
  x.querySelector('dt')!.textContent!.trim(), x.querySelector('dd')!.textContent!.trim(),
]));

describe('LogisticaNuevoEmbarqueFormComponent', () => {
  it('es UNA hoja: lo de Kepler va lleno y bloqueado, lo demás en blanco para teclear', () => {
    const { el } = montar(tarifada(), PERSONAS);
    expect(bloqueadosDe(el)).toMatchObject({
      Fecha: '2026-10-03', Guía: '0001419', Origen: 'Sucursal Canindo', Unidad: '00017 · FORD 450 GASOLINA SUPER DUTY',
      Placas: 'NC-1134-D', Chofer: '00017 · CESAR C.', Cajas: '190', Sueltos: '85', 'Valor de la mercancía': '$159,596.20',
      Surtió: 'JORGE, JOSE RAMON', Checó: 'ANA GABRIELA C.', Embarcó: 'JUAN MANUEL E.',
    });
    // Lo bloqueado no es un campo: no se edita ni se le pasa con Tab.
    expect(el.querySelector('dl.hj-f input, dl.hj-f select, dl.hj-f textarea')).toBeNull();
    // Lo que se teclea: tipo de entrega, ayudantes, horario, peso, km, flete, notas. Comisión y viáticos NO.
    for (const id of ['hj-ay1', 'hj-ay2', 'hj-sal', 'hj-lleg', 'hj-pern', 'hj-peso', 'hj-km', 'hj-flete', 'hj-notas']) {
      expect(el.querySelector('#' + id)).not.toBeNull();
    }
    expect(el.querySelector('#hj-pd')).toBeNull();
    expect(el.querySelector('app-guia-calculada input')).toBeNull();
    expect(el.querySelectorAll('input[name="tipo"]').length).toBe(2);
    expect(el.querySelectorAll('app-kepler-paradas tbody tr').length).toBe(13);
  });

  it('no le muestra qué está y qué no: sin leyendas, marcas de origen ni avisos', () => {
    const texto = montar(tarifada(), PERSONAS).el.textContent!;
    for (const ruido of ['Viene de Kepler', 'Captura', 'Sugerido', 'No existe en Kepler', 'Sin medir', '¿Qué tan completo',
      'Del catálogo de rutas', 'Sin tarifa', 'kdm1', 'kdudent', 'La nota dice', 'Kepler sólo registra']) {
      expect(texto).not.toContain(ruido);
    }
  });

  // ── La comisión: bloqueada y calculada (fórmula de la beta de Logística, 2026-10-07) ─────────

  it('la comisión del chofer va BLOQUEADA con la tarifa del viaje; no hay campo para teclearla', () => {
    const { el } = montar(tarifada(), PERSONAS);
    expect(calculadoDe(el)['Chofer'][0]).toBe('$98.04');
    expect(Object.keys(calculadoDe(el))).toEqual(['Chofer']); // sin ayudantes, no hay renglón de ayudante
    expect(el.querySelector('#hj-com1, #hj-com2, #hj-com3')).toBeNull();
  });

  it('al elegir ayudante, su comisión bloqueada sale de la tarifa de ayudante', () => {
    const { f, el, comp } = montar(tarifada(), PERSONAS);
    comp.c.helper1_id = 'd-ay';
    comp.alElegirAyudante('helper1');
    f.detectChanges();
    expect(calculadoDe(el)['Ayudante 1'][0]).toBe('$57.76');
  });

  // ── Los viáticos: bloqueados y calculados del horario (EMB.19) ──────────────────────────

  it('los viáticos salen del horario, por persona, y no hay campo para teclearlos', () => {
    const { f, el, comp } = montar(tarifada(), PERSONAS, CONFIG_VIATICO);
    comp.c.helper1_id = 'd-ay';
    comp.alElegirAyudante('helper1');
    // Sale 5:30, llega 16:00: café + desayuno + comida = $250 por persona.
    horario(f, comp, '05:30', '16:00');
    expect(calculadoDe(el)).toEqual({ Chofer: ['$98.04', '$250.00'], 'Ayudante 1': ['$57.76', '$250.00'] });
    expect(el.querySelector('app-guia-calculada tfoot')!.textContent).toContain('$500.00');
    expect(comp.viaticos()!.driver).toMatchObject({ cafe: true, desayuno: true, comida: true, cena: false });
  });

  it('si se queda a dormir hay cena, aunque llegue temprano', () => {
    const { f, comp } = montar(tarifada(), PERSONAS, CONFIG_VIATICO);
    horario(f, comp, '08:00', '12:00', true);
    expect(comp.viaticos()!.driver).toMatchObject({ cafe: false, desayuno: false, comida: false, cena: true, subtotal: 100 });
  });

  it('sin horario los viáticos no se pintan en cero: «—» y el botón dice qué falta', () => {
    const { f, el, comp } = montar(tarifada(), PERSONAS, CONFIG_VIATICO);
    horario(f, comp, '', '');
    expect(comp.viaticos()).toBeNull();
    expect(calculadoDe(el)['Chofer'][1]).toBe('—');
    expect(el.querySelector('#hj-faltan')!.textContent).toContain('Indica la hora de salida.');
  });

  it('si una ruta no tiene tarifa: la comisión no se adivina, el botón no avanza y dice cuál falta', () => {
    const { f, el, comp } = montar(hojaGuia0001419(), PERSONAS);
    comp.c.delivery_type = 'route';
    comp.tocar();
    f.detectChanges();
    expect(comp.comisiones()).toBeNull();
    expect(calculadoDe(el)['Chofer'][0]).toBe('—'); // con una ruta sin tarifa, la mayor no se sabe
    expect(comp.puedeCrear()).toBe(false);
    expect(el.querySelector('#hj-faltan')!.textContent)
      .toContain('Falta la tarifa de SANTAGIO TANGAMNADAPIO en Logística › Configuración › Comisiones.');
  });

  it('el tipo de entrega arranca en blanco: lo elige quien arma el embarque', () => {
    const { f, el, comp } = montar(tarifada(), PERSONAS);
    horario(f, comp);
    expect(comp.c.delivery_type).toBeNull();
    expect([...el.querySelectorAll<HTMLInputElement>('input[name="tipo"]')].some((r) => r.checked)).toBe(false);
    expect(comp.puedeCrear()).toBe(false);
    comp.c.delivery_type = 'route';
    comp.tocar();
    expect(comp.puedeCrear()).toBe(true);
  });

  it('con chofer de Kepler va bloqueado, sin selector para cambiarlo', () => {
    const { el } = montar(tarifada(), PERSONAS);
    expect(el.querySelector('#hj-chofer')).toBeNull();
    expect(el.textContent).not.toContain('Cambiar');
  });

  it('sin chofer en Kepler el chofer es un campo más, y el botón no avanza hasta elegirlo', () => {
    const { f, el, comp } = montar(conTarifaCompleta(hojaSinChofer()), PERSONAS);
    expect(el.querySelector('#hj-chofer')).not.toBeNull();
    comp.c.delivery_type = 'route';
    horario(f, comp);
    expect(comp.puedeCrear()).toBe(false);
    comp.c.driver_id = 'd-otro';
    comp.tocar();
    f.detectChanges();
    expect(comp.puedeCrear()).toBe(true);
  });

  // Hallado en la simulación de usuario: la lista de "qué falta" sólo se pintaba DESPUÉS de intentar
  // crear, pero el botón se apaga justo cuando falta algo — o sea, el motivo nunca se podía ver.
  it('con el botón apagado, el motivo se ve sin tener que hacer clic', () => {
    const { f, el, comp } = montar(conTarifaCompleta(hojaSinChofer()), PERSONAS);
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
    horario(f, comp);
    expect(el.querySelector('#hj-faltan')).toBeNull();
    botones.forEach((b) => expect(b.getAttribute('aria-describedby')).toBeNull());
  });

  it('crear manda sólo lo capturado (sin comisión ni viáticos) y lleva al embarque nuevo', () => {
    const { f, http, comp, nav } = montar(tarifada(), PERSONAS, CONFIG_VIATICO);
    comp.c.delivery_type = 'long_trip';
    comp.c.helper1_id = 'd-ay';
    comp.alElegirAyudante('helper1');
    comp.c.actual_km = 180;
    horario(f, comp, '05:30', '21:00', true);
    comp.crear();
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/logistics/shipments/from-kepler/06/0001419'));
    expect(req.request.body).toMatchObject({
      delivery_type: 'long_trip', driver_id: null, helper1_id: 'd-ay', actual_km: 180, total_weight_kg: null,
      departure_time: '05:30', arrival_time: '21:00', overnight: true,
    });
    expect(req.request.body).not.toHaveProperty('driver_commission');
    expect(req.request.body).not.toHaveProperty('per_diem_total');
    req.flush({ shipment: { id: 'nuevo-id' }, guide: {}, destinatarios: 13 });
    expect(nav).toHaveBeenCalledWith(['/logistica/shipments', 'nuevo-id']);
  });

  it('si el servidor rechaza (otra persona lo tomó), lo dice y no navega', () => {
    const { f, http, el, comp, nav } = montar(tarifada(), PERSONAS);
    comp.c.delivery_type = 'route';
    horario(f, comp);
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
