import { ChangeDetectorRef, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError, type Observable } from 'rxjs';
import type {
  CalendarioCompras, GuardarReglaRespuesta, PropuestaSinRegla, PropuestasCalendario, ReglaCalendario, ResponsablesCalendario,
} from '@megadulces/contracts';
import { ComprasCalendarioComponent } from './compras-calendario.component';
import { CalendarioComprasService } from '../calendario-compras.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';

/**
 * Las mejoras que pidieron los usuarios al día siguiente de salir a prod (anexo C §10.12):
 * - `[PQ.3.21]` «Por zona» / «Por sucursal» con casillas: una regla por lugar (DC28); corregir no cambia el lugar;
 * - `[PQ.3.15]` la cadencia de «días de la semana» (DC29);
 * - `[PQ.3.22]` el responsable y «Mis revisiones» (DC30).
 * Hoy es sábado 21-nov-2026: el siguiente martes es el 24.
 */
const HOY = '2026-11-21';
const SUC = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];

const regla = (o: Partial<ReglaCalendario>): ReglaCalendario => ({
  id: 'R1', supplier_code: 'PT1', supplier_name: 'TOSTADAS DE PRUEBA', scope: 'zone', zone_code: 'LP', branch_code: null,
  pattern: 'weekdays', weekdays: [2], month_days: null, month_last_day: false, every_n_days: null, weekend_shift: 'friday',
  week_interval: null, week_anchor: null, month_week: null, reviewer_user_id: null, out_of_cycle_until: null, out_of_cycle_reason: null,
  alcance_nombre: 'Zona La Piedad', revisa: 'Gerencia de zona (La Piedad)',
  estado: { estado: 'al_dia', pendiente_desde: null, dias_atraso: 0, proxima: { fecha: '2026-11-24', corrida_de: null } },
  ultima_actividad: null, ultima_marca: null, definida_por: 'Gerencia', definida_el: '2026-11-20', note: null,
  pedido_supplier_id: null, pedido_warehouse_ids: [], ...o,
} as unknown as ReglaCalendario);

const cal = (reglas: ReglaCalendario[] = []): CalendarioCompras => ({
  hoy: HOY, reglas, resumen: { rezagada: 0, toca_hoy: 0, sin_ancla: 0, al_dia: reglas.length, fuera_de_ciclo: 0 },
  zonas: [{ code: 'LP', nombre: 'La Piedad', sucursales: ['01', '02', '03', '04'] }, { code: 'MOR', nombre: 'Morelia', sucursales: ['07', '08'] }],
  sucursales: SUC, actividad_desde: '2026-09-20', fuente: 'prueba', tu_alcance: { todas: true, sucursales: SUC },
} as unknown as CalendarioCompras);

const PROV: PropuestaSinRegla = {
  supplier_code: 'PT1', supplier_name: 'TOSTADAS DE PRUEBA', supplier_record: 'ficha_viva', proposal_status: 'propuesto',
  cycle_days_proposed: 14, next_date_proposed: '2026-11-27', rounds_12m: 20, last_order_date: '2026-11-13', branches_12m: ['02', '04'],
  reglas_vivas: 0, dias_fijos: [], peso: { escalon: 2, compra_pct: 1, ocs_12m: 10 },
} as PropuestaSinRegla;
const PROP: PropuestasCalendario = {
  hoy: HOY, con_regla: 0, dia_fijo: { measured: true, note: null }, sin_regla: [PROV], dia_fijo_pendiente: [],
  embudo: { measured: false, note: 'sin medir', total: { escalon: null, proveedores: 1, con_regla: 0, compra_pct: null, compra_con_regla_pct: null, ocs_pct: null, ocs_con_regla_pct: null }, escalones: [] },
} as unknown as PropuestasCalendario;

const RESP: ResponsablesCalendario = {
  personas: [
    { user_id: 'U-GER', nombre: 'Gerencia Prueba', puesto: 'gerente_compras', sucursales: null },
    { user_id: 'U-YUR', nombre: 'Encargado Yurécuaro', puesto: 'encargado_tienda', sucursales: ['04'] },
    { user_id: 'U-LP', nombre: 'Compras La Piedad', puesto: 'compras', sucursales: ['01', '02', '03', '04'] },
  ],
};

function montar(o: { reglas?: ReglaCalendario[]; vista?: string; respuesta?: GuardarReglaRespuesta; responsables?: Observable<ResponsablesCalendario>; historial?: CalendarioCompras['historial'] } = {}) {
  const api = {
    calendario: vi.fn(() => of({ ...cal(o.reglas), ...(o.historial ? { historial: o.historial } : {}) })), propuestas: vi.fn(() => of(PROP)),
    guardarRegla: vi.fn(() => of(o.respuesta ?? ({ id: 'R-NUEVA', accion: 'creada', reglas: [] } as GuardarReglaRespuesta))),
    responsables: vi.fn(() => o.responsables ?? of(RESP)),
  };
  TestBed.configureTestingModule({
    imports: [ComprasCalendarioComponent],
    providers: [
      provideRouter([]), { provide: CalendarioComprasService, useValue: api },
      { provide: PermissionsService, useValue: { has$: () => signal(true), has: () => true, isAdmin: () => false } },
      { provide: AuthService, useValue: { user: signal({ sub: 'U-YO' }) } },
      ...(o.vista ? [{ provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({ vista: o.vista })) } }] : []),
    ],
  });
  const f = TestBed.createComponent(ComprasCalendarioComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, el: f.nativeElement as HTMLElement, api };
}
/**
 * OnPush: la pantalla real se repinta con el clic (un evento de la plantilla); aquí se llama al método directo, así que
 * se marca a mano para que la plantilla vuelva a leer los campos del formulario.
 */
const repintar = (f: ComponentFixture<ComprasCalendarioComponent>) => {
  f.debugElement.injector.get(ChangeDetectorRef).markForCheck();
  f.detectChanges();
};
/** El martes marcado, como lo haría quien captura. */
const martes = (c: ComprasCalendarioComponent) => { c.rSemana[1] = true; };

describe('[PQ.3.21] «Por zona» y «Por sucursal» con casillas: una regla por lugar (DC28)', () => {
  it('los rótulos son «Por zona» y «Por sucursal»', () => {
    const { c } = montar();
    expect(c.opcionesAlcance.map((o) => o.label)).toEqual(['Todas las sucursales', 'Por zona', 'Por sucursal']);
  });

  it('La Piedad y Morelia, martes: UNA llamada con las dos zonas, y el aviso dice las dos', () => {
    const { c, api } = montar({ respuesta: { id: 'A', accion: 'creada', reglas: [{ lugar: 'LP', id: 'A', accion: 'creada' }, { lugar: 'MOR', id: 'B', accion: 'actualizada' }] } });
    c.abrirReglaDePropuesta(PROV);
    c.cambiarPatron('weekdays');
    c.cambiarAlcance('zone');
    c.rZonas = ['LP', 'MOR'];
    martes(c);
    expect(c.problemaRegla()).toBeNull();
    c.guardarRegla();
    expect(api.guardarRegla).toHaveBeenCalledTimes(1);
    const dto = api.guardarRegla.mock.calls[0][0] as Record<string, unknown>;
    expect([dto['scope'], dto['zone_codes'], dto['zone_code'], dto['branch_codes']]).toEqual(['zone', ['LP', 'MOR'], undefined, null]);
    expect(c.aviso()).toBe('2 reglas de TOSTADAS DE PRUEBA, cada martes: zona La Piedad (nueva) y zona Morelia (reemplazada).');
  });

  it('las casillas se ven en el formulario: una por zona, una por sucursal', () => {
    const { c, f } = montar();
    c.abrirReglaDePropuesta(PROV);
    c.cambiarAlcance('zone');
    repintar(f);
    expect(document.body.querySelectorAll('.cc-lugares .cc-casilla').length).toBe(2);
    c.cambiarAlcance('branch');
    repintar(f);
    expect(document.body.querySelectorAll('.cc-lugares .cc-casilla').length).toBe(SUC.length);
  });

  it('NEGATIVA: sin ninguna zona o sucursal marcada, no deja guardar y dice qué falta', () => {
    const { c } = montar();
    c.abrirReglaDePropuesta(PROV);
    c.cambiarPatron('weekdays');
    martes(c);
    c.cambiarAlcance('zone');
    expect(c.problemaRegla()).toBe('Elige al menos una zona.');
    c.cambiarAlcance('branch');
    expect(c.problemaRegla()).toBe('Elige al menos una sucursal.');
  });

  it('avisa ANTES de guardar si en alguno de los lugares ya hay regla', () => {
    const { c } = montar({ reglas: [regla({ id: 'R-MOR', zone_code: 'MOR', alcance_nombre: 'Zona Morelia' })] });
    c.abrirReglaDePropuesta(PROV);
    c.cambiarAlcance('zone');
    c.rZonas = ['LP', 'MOR'];
    expect(c.avisoReemplazo()).toBe('Ya hay una regla de este proveedor para Zona Morelia (Cada martes): guardar la reemplaza y conserva sus marcas.');
  });

  it('«Corregir la regla» no cambia el lugar: lo muestra fijo, guarda ese mismo, y no se avisa a sí misma', () => {
    const r = regla({});
    const { c, f } = montar({ reglas: [r] });
    c.abrirReglaDe(r, true);
    f.detectChanges();
    expect(c.corrigiendo()).toBe(true);
    expect(c.lugarFijo()).toBe('Zona La Piedad');
    expect(document.body.querySelector('.cc-lugares')).toBeNull();
    expect(document.body.textContent).toContain('usa «Otra regla para este proveedor»');
    expect(c.avisoReemplazo()).toBeNull();
    c.guardarRegla();
    expect((f.componentInstance as unknown as { api: { guardarRegla: { mock: { calls: unknown[][] } } } }).api.guardarRegla.mock.calls[0][0]).toMatchObject({ scope: 'zone', zone_codes: ['LP'] });
  });
});

describe('[PQ.3.15] la cadencia de «días de la semana» (DC29)', () => {
  it('las opciones, en el orden en que las pidieron los usuarios', () => {
    const { c } = montar();
    expect(c.opcionesCadencia.map((o) => o.label)).toEqual(['Cada semana', 'Cada 2 semanas', 'Cada 3 semanas', 'Una vez al mes', 'Cada 6 semanas']);
  });

  it('cada 2 semanas: propone «a partir del» el siguiente martes, y la vista previa salta una semana', () => {
    const { c, api } = montar();
    c.abrirReglaDePropuesta(PROV);
    c.cambiarPatron('weekdays');
    martes(c);
    c.cambiarCadencia('2');
    expect(c.rAncla?.getDate()).toBe(24);
    expect(c.vistaPrevia()).toBe('mar 24 nov · mar 8 dic · mar 22 dic · mar 5 ene');
    expect(c.semanasQueNo()).toBe('otra');
    c.guardarRegla();
    expect(api.guardarRegla.mock.calls[0][0]).toMatchObject({ pattern: 'weekdays', weekdays: [2], week_interval: 2, week_anchor: '2026-11-24', month_week: null });
  });

  it('una vez al mes: el primer martes; el último', () => {
    const { c } = montar();
    c.abrirReglaDePropuesta(PROV);
    c.cambiarPatron('weekdays');
    martes(c);
    c.cambiarCadencia('mes');
    expect(c.vistaPrevia()).toBe('mar 1 dic · mar 5 ene · mar 2 feb · mar 2 mar');
    c.rMesSemana = 5;
    expect(c.vistaPrevia()).toBe('mar 24 nov · mar 29 dic · mar 26 ene · mar 23 feb');
  });

  it('NEGATIVA: cada semana manda la regla sin cadencia (como antes)', () => {
    const { c, api } = montar();
    c.abrirReglaDePropuesta(PROV);
    c.cambiarPatron('weekdays');
    martes(c);
    c.guardarRegla();
    expect(api.guardarRegla.mock.calls[0][0]).toMatchObject({ week_interval: null, week_anchor: null, month_week: null });
  });
});

describe('[PQ.3.22] el responsable y «Mis revisiones» (DC30)', () => {
  const nombres = (c: ComprasCalendarioComponent) => c.opcionesResponsable().map((o) => o.value);

  it('sólo se ofrece a quien escribe en TODAS las sucursales de la regla', () => {
    const { c } = montar();
    c.abrirReglaDePropuesta(PROV);
    expect(nombres(c)).toEqual(['U-GER']);                       // todas las sucursales
    c.cambiarAlcance('branch');
    c.rSucursales = ['04'];
    expect(nombres(c)).toEqual(['U-GER', 'U-YUR', 'U-LP']);      // Yurécuaro
    c.cambiarAlcance('zone');
    c.rZonas = ['LP'];
    expect(nombres(c)).toEqual(['U-GER', 'U-LP']);               // zona La Piedad (01–04)
    expect(c.opcionesResponsable()[1].label).toBe('Compras La Piedad · Compras');
  });

  it('se guarda con la regla, y «Revisa» pasa a decir quién es el responsable', () => {
    const { c, api } = montar();
    c.abrirReglaDePropuesta(PROV);
    c.cambiarPatron('weekdays');
    martes(c);
    c.cambiarAlcance('zone');
    c.rZonas = ['LP'];
    expect(c.revisaDelFormulario()).toBe('Revisa: Gerencia de zona (La Piedad)');
    c.rResponsable = 'U-LP';
    expect(c.revisaDelFormulario()).toBe('Responsable: Compras La Piedad');
    c.guardarRegla();
    expect(api.guardarRegla.mock.calls[0][0]).toMatchObject({ reviewer_user_id: 'U-LP' });
  });

  it('NEGATIVA: si después se agrega un lugar que el responsable no ve, no deja guardar y lo dice', () => {
    const { c } = montar();
    c.abrirReglaDePropuesta(PROV);
    c.cambiarPatron('weekdays');
    martes(c);
    c.cambiarAlcance('branch');
    c.rSucursales = ['04'];
    c.rResponsable = 'U-YUR';
    expect(c.problemaRegla()).toBeNull();
    c.rSucursales = ['04', '05'];
    expect(c.problemaRegla()).toBe('Encargado Yurécuaro no ve todas las sucursales de esta regla: elige a otra persona o quítala.');
    expect(nombres(c)).toContain('U-YUR');   // la elegida sigue a la vista para poder quitarla
  });

  it('NEGATIVA: si no se pudo leer quién puede ser responsable, lo dice y se guarda sin responsable', () => {
    const { c, f } = montar({ responsables: throwError(() => ({ status: 500 })) });
    c.abrirReglaDePropuesta(PROV);
    c.cambiarPatron('weekdays');
    martes(c);
    f.detectChanges();
    expect(c.errorResponsables()).toContain('La regla se puede guardar sin responsable.');
    expect(document.body.querySelector('#cc-resp')).toBeNull();
    expect(c.problemaRegla()).toBeNull();
  });

  it('«Mis revisiones» aparece si eres responsable de alguna regla, y filtra a ésas', () => {
    const mia = regla({ id: 'MIA', reviewer_user_id: 'U-YO', revisa: 'Yo Prueba' });
    const otra = regla({ id: 'OTRA', supplier_code: 'PX2', supplier_name: 'OTRO', zone_code: 'MOR', alcance_nombre: 'Zona Morelia' });
    const { c, el, f } = montar({ reglas: [mia, otra], vista: 'reglas' });
    f.detectChanges();
    expect(c.mias()).toBe(1);
    const b = el.querySelector<HTMLButtonElement>('button.cc-mias');
    expect(b?.textContent?.trim()).toBe('Mis revisiones (1)');
    expect(el.textContent).toContain('Responsable: Yo Prueba');
    b?.click();
    f.detectChanges();
    expect(b?.getAttribute('aria-pressed')).toBe('true');
    expect(c.reglas().map((r) => r.id)).toEqual(['MIA']);
    expect(el.textContent).toContain('Viendo sólo las reglas de las que eres responsable.');
  });

  it('NEGATIVA: sin ninguna regla tuya, «Mis revisiones» no se ofrece', () => {
    const { el, c } = montar({ reglas: [regla({})] });
    expect(c.mias()).toBe(0);
    expect(el.querySelector('button.cc-mias')).toBeNull();
  });
});

describe('[PQ.3.17] quién la definió, quién la cambió y de qué a qué (DC25)', () => {
  const MEDIDO = { measured: true, note: null };
  const texto = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
  const cambiada = regla({
    every_n_days: null, weekdays: [2], reviewer_user_id: 'U-LP',
    ultimo_cambio: { por: 'Compras La Piedad', el: '2026-11-21T16:00:00Z', dia: '2026-11-21' }, cambios_total: 1,
    cambios: [{
      el: '2026-11-21T16:00:00Z', dia: '2026-11-21', por: 'Compras La Piedad', nombres: { 'U-LP': 'Compras La Piedad' },
      campos: {
        pattern: { antes: 'every_n_days', despues: 'weekdays' }, every_n_days: { antes: 7, despues: null }, weekdays: { antes: null, despues: [2] },
        reviewer_user_id: { antes: null, despues: 'U-LP' },
      },
    }],
  });

  it('una regla que cambió otra persona nombra a las dos: quién la definió y quién la cambió, y de qué a qué', () => {
    const { f, c } = montar({ reglas: [cambiada], historial: MEDIDO });
    c.abrir('R1'); f.detectChanges();
    expect(texto()).toContain('Definida por Gerencia el vie 20 nov.');
    expect(texto()).toContain('Último cambio: Compras La Piedad, el sáb 21 nov.');
    // Cada cambio, renglón por renglón (cada uno es su propio elemento: así se ve y así se lee).
    const li = [...document.querySelectorAll('.cc-cambios li')].map((x) => [...x.children].map((s) => (s.textContent ?? '').trim()));
    expect(li).toEqual([['sáb 21 nov · Compras La Piedad', 'Patrón: Cada 7 días → Cada martes', 'Responsable: nadie (revisa el puesto) → Compras La Piedad']]);
  });

  it('el último cambio anterior al historial se dice así (quién y cuándo, no de qué a qué)', () => {
    const { f, c } = montar({ reglas: [{ ...cambiada, cambios: [], cambios_total: 0 }], historial: MEDIDO });
    c.abrir('R1'); f.detectChanges();
    expect(texto()).toContain('Último cambio: Compras La Piedad, el sáb 21 nov.');
    expect(texto()).toContain('Ese último cambio es de antes de que se guardara el historial');
    expect(document.querySelector('.cc-cambios')).toBeNull();
  });

  it('sin historial medido, una regla cambiada lo DICE (no pinta «sin cambios»)', () => {
    const { f, c } = montar({ reglas: [{ ...cambiada, cambios: undefined }], historial: { measured: false, note: 'El historial de cambios de las reglas no está activo en esta base.' } });
    c.abrir('R1'); f.detectChanges();
    expect(texto()).toContain('El historial de cambios de las reglas no está activo en esta base.');
    expect(document.querySelector('.cc-cambios')).toBeNull();
  });

  it('NEGATIVA: una regla que nadie tocó sólo dice quién la definió', () => {
    const { f, c } = montar({ reglas: [regla({ ultimo_cambio: null, cambios: [], cambios_total: 0 })], historial: MEDIDO });
    c.abrir('R1'); f.detectChanges();
    expect(texto()).toContain('Definida por Gerencia el vie 20 nov.');
    expect(texto()).not.toContain('Último cambio');
    expect(texto()).not.toContain('antes de que se guardara el historial');
    expect(document.querySelector('.cc-cambios')).toBeNull();
  });
});
