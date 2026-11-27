import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { AcuerdosDeReunion, AgendaCitas, DetalleReunion, OpcionesCitas, ReunionVista } from '@megadulces/contracts';
import { ComprasCitasComponent } from './compras-citas.component';
import { CitasProveedoresService } from '../citas-proveedores.service';
import { AcuerdosProveedoresService } from '../acuerdos-proveedores.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[PQ.3.8]` Citas · C3 — la pantalla montada: la respuesta primero, la semana por día, los botones que dice la API y
 * sólo con la llave de agendar. (Los tipos de la plantilla los compila `check:templates-types`, no este TestBed.)
 */
const HOY = '2026-11-26';

const reunion = (o: Partial<ReunionVista> = {}): ReunionVista => ({
  id: 'r1', supplier_code: 'PRV01', supplier_name: 'Dulcería de Prueba', kind: 'executive', status: 'scheduled', situacion: 'agendada',
  acciones: ['editar', 'cancelar'], date: '2026-11-27', start_time: '10:00', end_time: '11:00', starts_at: '2026-11-27T16:00:00Z',
  ends_at: '2026-11-27T17:00:00Z', mode: 'in_person', location: 'Sala de juntas', topics: ['Precios 2027'], work_plan_year: null,
  organizer: { user_id: 'U-YO', nombre: 'Compras Prueba' },
  participants: [
    { id: 'p1', side: 'internal', user_id: 'U-YO', nombre: 'Compras Prueba', area: 'compras', job_title: null },
    { id: 'p2', side: 'supplier', user_id: null, nombre: 'Ejecutivo', area: null, job_title: 'Gerente' },
  ],
  minutes: null, minutes_by: null, minutes_at: null, cancelled_reason: null, cancelled_by: null, cancelled_at: null, choques: [], ...o,
});

const agenda = (o: Partial<AgendaCitas> = {}): AgendaCitas => ({
  hoy: HOY, semana: { desde: '2026-11-23', hasta: '2026-11-29' }, por_confirmar: 0,
  reuniones: [
    reunion(),
    reunion({ id: 'r2', start_time: '12:00', end_time: '13:00', starts_at: '2026-11-27T18:00:00Z', ends_at: '2026-11-27T19:00:00Z', supplier_name: 'Botanas de Prueba' }),
    reunion({ id: 'r3', date: '2026-11-25', situacion: 'sin_minuta', acciones: ['minuta', 'editar', 'cancelar'], supplier_name: 'Chocolates de Prueba' }),
  ],
  sin_minuta: { total: 1, tope: 50, reuniones: [reunion({ id: 'r3', date: '2026-11-25', situacion: 'sin_minuta', acciones: ['minuta', 'editar', 'cancelar'], supplier_name: 'Chocolates de Prueba' })] },
  ...o,
});

function montar(o: { agenda?: AgendaCitas; agendar?: boolean; error?: boolean; reunion?: string } = {}) {
  const api = {
    agenda: vi.fn(() => (o.error ? throwError(() => ({ status: 500 })) : of(o.agenda ?? agenda()))),
    detalle: vi.fn((): ReturnType<CitasProveedoresService['detalle']> => of({ reunion: reunion(), anterior: null } as DetalleReunion)),
    opciones: vi.fn(() => of({ personas: [{ user_id: 'U-YO', nombre: 'Compras Prueba', puesto: 'gerente_compras', area: 'compras' }] } as OpcionesCitas)),
    proveedores: vi.fn(() => of({ proveedores: [], tope: 20 })),
    agendar: vi.fn(() => of({ id: 'nueva', choques: [] })),
    editar: vi.fn(), confirmar: vi.fn(() => of({ id: 'r1' })), minuta: vi.fn(() => of({ id: 'r3' })), cancelar: vi.fn(() => of({ id: 'r1' })),
  };
  // `[PQ.3.10]` Los acuerdos de la reunión que se abre (el detalle los pide a su propio servicio).
  const deReunion: AcuerdosDeReunion = {
    hoy: HOY, meeting_id: 'r1', meeting_date: '2026-11-27', no_recibe: 'Los acuerdos salen de una reunión realizada: escribe primero su minuta.',
    organizer: { user_id: 'U-YO', nombre: 'Compras Prueba' }, acuerdos: [],
    del_proveedor: { total: 1, tope: 50, acuerdos: [{
      id: 'a1', meeting_id: 'r0', supplier_code: 'PRV01', supplier_name: 'Dulcería de Prueba', meeting_date: '2026-11-20', area: 'supplier',
      description: 'Mandar la lista de precios 2027', supplier_contact: 'Ejecutivo', assigned_to: { user_id: 'U-YO', nombre: 'Compras Prueba' },
      due_date: '2026-11-25', status: 'pending', situacion: 'vencido', acciones: ['iniciar', 'cumplir', 'cancelar', 'editar'],
      closed_by: null, closed_at: null, closing_note: null, assigned_by: 'Compras Prueba', assigned_at: '2026-11-20T18:00:00Z',
    }] },
  };
  const acuerdos = { deReunion: vi.fn(() => of(deReunion)), capturar: vi.fn() };
  const agendar = o.agendar ?? true;
  const perms = { has$: (p: string) => signal(p === Permission.COMPRAS_CITAS_AGENDAR ? agendar : true), has: () => true, isAdmin: () => false };
  TestBed.configureTestingModule({
    imports: [ComprasCitasComponent],
    providers: [
      provideRouter([]), { provide: CitasProveedoresService, useValue: api }, { provide: PermissionsService, useValue: perms },
      { provide: AuthService, useValue: { user: signal({ sub: 'U-YO' }) } },
      { provide: AcuerdosProveedoresService, useValue: acuerdos },
      ...(o.reunion ? [{ provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ reunion: o.reunion }) } } }] : []),
    ],
  });
  const f = TestBed.createComponent(ComprasCitasComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, el: f.nativeElement as HTMLElement, api, acuerdos };
}

const texto = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ');
const botones = (el: HTMLElement, etiqueta: string) => [...el.querySelectorAll('button')].filter((b) => texto(b).trim() === etiqueta);

describe('[PQ.3.8] Citas · la pantalla', () => {
  it('abre con la respuesta: la semana y lo pendiente de antes', () => {
    const { el } = montar();
    expect(texto(el.querySelector('.ct-respuesta') as HTMLElement)).toBe('Esta semana: 3 reuniones. 1 reunión ya pasó sin minuta.');
  });

  it('la semana por hora, con el día pintado sólo en el primer renglón de cada día', () => {
    const { el } = montar();
    const filas = [...el.querySelectorAll('tbody tr')];
    expect(filas).toHaveLength(3);
    // El orden lo da la API (por inicio); la pantalla no reordena.
    expect(filas.map((f) => texto(f.querySelector('.ct-link') as HTMLElement).trim())).toEqual(['Dulcería de Prueba', 'Botanas de Prueba', 'Chocolates de Prueba']);
    expect(filas.map((f) => !!f.querySelector('.ct-dia'))).toEqual([true, false, true]);
  });

  it('los botones son los que dice la API, y sólo con la llave de agendar', () => {
    const conLlave = montar();
    expect(botones(conLlave.el, 'Escribir minuta')).toHaveLength(1); // sólo la que ya pasó
    expect(botones(conLlave.el, 'Agendar reunión').length).toBeGreaterThanOrEqual(1);
    TestBed.resetTestingModule();
    const sinLlave = montar({ agendar: false });
    expect(botones(sinLlave.el, 'Escribir minuta')).toHaveLength(0);
    expect(botones(sinLlave.el, 'Agendar reunión')).toHaveLength(0);
  });

  it('«Sin minuta» muestra lo pendiente de cualquier semana, con cuánto hace', () => {
    const { c, f, el } = montar();
    c.irAVista('sin_minuta');
    f.detectChanges();
    const filas = [...el.querySelectorAll('tbody tr')];
    expect(filas).toHaveLength(1);
    expect(texto(filas[0])).toContain('ayer'); // del 25, vista el 26
  });

  it('con error, no dibuja la respuesta ni un cero: lo dice', () => {
    const { el } = montar({ error: true });
    expect(el.querySelector('.ct-respuesta')).toBeNull();
    expect(el.querySelector('app-metric-strip')).toBeNull();
  });

  it('semana vacía: lo dice y ofrece agendar (a quien puede)', () => {
    const { el } = montar({ agenda: agenda({ reuniones: [], sin_minuta: { total: 0, tope: 50, reuniones: [] } }) });
    expect(texto(el)).toContain('Sin reuniones en esta semana');
    expect(texto(el.querySelector('.ct-respuesta') as HTMLElement)).toBe('Esta semana: sin reuniones.');
  });

  it('agendar manda el payload que espera la API (hora de México en texto, gente con área)', () => {
    const { c, api } = montar();
    c.abrirNueva();
    c.fProveedor = { code: 'PRV01', name: 'Dulcería de Prueba', etiqueta: 'Dulcería de Prueba · PRV01' };
    c.fFecha = new Date(2026, 11, 2);
    c.fInicio = '10:00';
    c.fFin = '11:30';
    c.fTemas = ['Precios 2027', '  '];
    c.fProveedorGente = [{ id: null, name: 'Ejecutivo', job_title: '' }];
    expect(c.falta()).toBeNull();
    c.guardar();
    expect(api.agendar).toHaveBeenCalledWith({
      supplier_code: 'PRV01', kind: 'executive', status: 'scheduled', date: '2026-12-02', start_time: '10:00', end_time: '11:30',
      mode: 'in_person', location: null, topics: ['Precios 2027'], work_plan_year: null,
      participants: [
        { id: null, side: 'internal', user_id: 'U-YO', area: 'compras' },
        { id: null, side: 'supplier', name: 'Ejecutivo', job_title: null },
      ],
    });
  });

  it('un renglón nuevo que nadie llenó no cuenta: no frena ni se manda; uno a medias sí se revisa', () => {
    const { c, api } = montar();
    c.abrirNueva();
    c.fProveedor = { code: 'PRV01', name: 'Dulcería de Prueba', etiqueta: 'Dulcería de Prueba · PRV01' };
    c.fFecha = new Date(2026, 11, 2);
    c.fInternos.push({ id: null, user_id: null, area: null });
    expect(c.fProveedorGente).toEqual([{ id: null, name: '', job_title: '' }]);
    expect(c.falta()).toBeNull();
    c.guardar();
    expect(api.agendar.mock.calls[0][0].participants).toEqual([{ id: null, side: 'internal', user_id: 'U-YO', area: 'compras' }]);
    c.fProveedorGente = [{ id: null, name: '', job_title: 'Gerente' }];
    expect(c.falta()).toBe('Escribe el nombre de cada quien va por el proveedor (o quita el renglón).');
  });

  it('[PQ.3.10] ?reunion= abre esa reunión, con sus acuerdos: si no recibe, dice por qué; y lo abierto con el proveedor', () => {
    const { f, el, api, acuerdos } = montar({ reunion: 'r1' });
    f.detectChanges();
    expect(api.detalle).toHaveBeenCalledWith('r1');
    expect(acuerdos.deReunion).toHaveBeenCalledWith('r1');
    const t = texto(el);
    expect(t).toContain('Acuerdos de esta reunión');
    expect(t).toContain('Los acuerdos salen de una reunión realizada: escribe primero su minuta.');
    expect(t).toContain('Sigue abierto con este proveedor, de otras reuniones (1)');
    expect(t).toContain('Mandar la lista de precios 2027');
    // Agendada: no se ofrece capturar (la misma regla que frena la escritura).
    expect(botones(el, 'Capturar acuerdo')).toHaveLength(0);
  });

  it('sin proveedor no se puede guardar (y no llama a la API)', () => {
    const { c, api } = montar();
    c.abrirNueva();
    c.fFecha = new Date(2026, 11, 2);
    expect(c.falta()).toBe('Elige el proveedor.');
    c.guardar();
    expect(api.agendar).not.toHaveBeenCalled();
  });
});
