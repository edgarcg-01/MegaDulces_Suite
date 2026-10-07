import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { SdQueueCandidateDto, SdQueueMemberDto, SdQueueMembersResponse } from '@megadulces/contracts';
import { ServiceDeskService } from './service-desk.service';
import { SdQueueMembersComponent } from './sd-queue-members.component';

/**
 * `[MS.7.17]` La pantalla de quién atiende una cola. Lo que se defiende:
 *  · no se pide nada hasta que se abre (una pantalla con N colas no hace N llamadas al cargar);
 *  · SIN `can_manage` (el servidor dice que no coordinas esa cola) es de sólo lectura: no hay formulario ni se piden candidatos;
 *  · para nombrar coordinación hace falta la clave de coordinar, y la pantalla lo dice antes del error del servidor;
 *  · lo que el servidor rechaza (409: última coordinación, tickets abiertos) se muestra con SU mensaje, y un cambio de rol
 *    rechazado recarga para que el selector no quede mintiendo.
 */
const COORD: SdQueueMemberDto = { user_id: 'u-coord', username: 'ubaldo', name: 'Ubaldo Barajas', role: 'coordinador', can_attend: true, can_coordinate: true };
const TEC: SdQueueMemberDto = { user_id: 'u-tec', username: 'tec1', name: 'Técnico Uno', role: 'tecnico', can_attend: true, can_coordinate: false };
const SIN_PERMISO: SdQueueMemberDto = { user_id: 'u-off', username: 'exagente', name: null, role: 'tecnico', can_attend: false, can_coordinate: false };
const CAND_OK: SdQueueCandidateDto = { user_id: 'c-1', username: 'jefa', name: 'Jefa Con Permiso', can_coordinate: true };
const CAND_TEC: SdQueueCandidateDto = { user_id: 'c-2', username: 'auxi', name: 'Auxiliar', can_coordinate: false };

const resp = (members: SdQueueMemberDto[], can_manage = true): SdQueueMembersResponse => ({ queue_id: 'q-1', members, can_manage });
const conflicto = (message: string) => throwError(() => new HttpErrorResponse({ status: 409, error: { message } }));

describe('[MS.7.17] SdQueueMembersComponent', () => {
  let fix: ComponentFixture<SdQueueMembersComponent>;
  let c: SdQueueMembersComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';

  async function render(over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
    api = {
      queueMembers: vi.fn(() => of(resp([COORD, TEC, SIN_PERMISO]))),
      queueCandidates: vi.fn(() => of([CAND_OK, CAND_TEC])),
      upsertQueueMember: vi.fn(() => of(resp([COORD, TEC, SIN_PERMISO]))),
      removeQueueMember: vi.fn(() => of(resp([COORD]))),
      ...over,
    };
    await TestBed.configureTestingModule({
      imports: [SdQueueMembersComponent],
      providers: [{ provide: ServiceDeskService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(SdQueueMembersComponent);
    fix.componentRef.setInput('queueId', 'q-1');
    c = fix.componentInstance;
    fix.detectChanges();
  }
  async function abrir() {
    c.alternar();
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ no pide nada hasta que se abre', async () => {
    await render();
    expect(api['queueMembers']).not.toHaveBeenCalled();
    expect(api['queueCandidates']).not.toHaveBeenCalled();
    await abrir();
    expect(api['queueMembers']).toHaveBeenCalledWith('q-1');
    expect(api['queueCandidates']).toHaveBeenCalledWith('q-1');
  });

  it('lista a los miembros con su rol y cuántos son', async () => {
    await render();
    await abrir();
    expect(texto()).toContain('Ubaldo Barajas');
    expect(texto()).toContain('Técnico Uno');
    expect(el().querySelector('.qm-n')?.textContent?.trim()).toBe('3');
  });

  it('⭐ un miembro que ya no tiene el permiso sale MARCADO «sin permiso» (y los demás no)', async () => {
    await render();
    await abrir();
    const filas = Array.from(el().querySelectorAll('tbody tr'));
    expect(filas[2].textContent).toContain('sin permiso');
    expect(filas[0].textContent).not.toContain('sin permiso');
  });

  it('⛔ NEGATIVA — sin can_manage es de sólo lectura: ni formulario de agregar, ni botón Quitar, ni se piden candidatos', async () => {
    await render({ queueMembers: vi.fn(() => of(resp([COORD, TEC], false))) });
    await abrir();
    expect(api['queueCandidates']).not.toHaveBeenCalled();
    expect(el().querySelector('.qm-add')).toBeNull();
    expect(texto()).not.toContain('Quitar');
    expect(texto()).toContain('Técnico Uno'); // pero SÍ ve con quién trabaja
  });

  it('⛔ nombrar coordinación a quien no tiene la clave de coordinar: la pantalla lo dice y no deja agregar; como técnico sí', async () => {
    await render();
    await abrir();
    c.elegido = 'c-2';
    c.rolNuevo = 'coordinador';
    expect(c.motivoNoAgrega()).toContain('SERVICIO_COORDINAR');
    expect(c.puedeAgregar()).toBe(false);
    c.rolNuevo = 'tecnico';
    expect(c.motivoNoAgrega()).toBeNull();
    expect(c.puedeAgregar()).toBe(true);
  });

  it('quien SÍ tiene la clave de coordinar se puede nombrar coordinación', async () => {
    await render();
    await abrir();
    c.elegido = 'c-1';
    c.rolNuevo = 'coordinador';
    expect(c.puedeAgregar()).toBe(true);
  });

  it('las opciones de agregar avisan quién no tiene el permiso de coordinar', async () => {
    await render();
    await abrir();
    expect(c.opcionesCandidatos().map((o) => o.label)).toEqual(['Jefa Con Permiso', 'Auxiliar (sin permiso de coordinar)']);
  });

  it('⭐ agregar manda el rol elegido y refresca a los candidatos (el recién agregado deja de ofrecerse)', async () => {
    await render({ upsertQueueMember: vi.fn(() => of(resp([COORD, TEC, SIN_PERMISO, { ...TEC, user_id: 'c-2', username: 'auxi', name: 'Auxiliar' }]))) });
    await abrir();
    c.elegido = 'c-2';
    c.rolNuevo = 'tecnico';
    c.agregar();
    expect(api['upsertQueueMember']).toHaveBeenCalledWith('q-1', 'c-2', 'tecnico');
    expect(c.miembros()?.length).toBe(4);
    expect(c.aviso()).toContain('agregada');
    expect(api['queueCandidates']).toHaveBeenCalledTimes(2); // la carga inicial y el refresco
  });

  it('⛔ lo que el servidor rechaza al quitar (tiene solicitudes abiertas) se muestra con SU mensaje y nadie sale de la lista', async () => {
    await render({ removeQueueMember: vi.fn(() => conflicto('Tiene 2 solicitudes abiertas asignadas: reasígnalas antes de quitarla de la cola')) });
    await abrir();
    c.quitar(TEC);
    fix.detectChanges();
    expect(texto()).toContain('Tiene 2 solicitudes abiertas asignadas');
    expect(c.miembros()?.length).toBe(3);
  });

  it('quitar a alguien actualiza la lista con lo que responde el servidor', async () => {
    await render();
    await abrir();
    c.quitar(TEC);
    expect(api['removeQueueMember']).toHaveBeenCalledWith('q-1', 'u-tec');
    expect(c.miembros()?.map((m) => m.user_id)).toEqual(['u-coord']);
  });

  it('⛔ un cambio de rol RECHAZADO muestra el motivo y recarga (el selector no debe quedar mintiendo)', async () => {
    await render({ upsertQueueMember: vi.fn(() => conflicto('La cola no puede quedarse sin coordinación: nombra a otra persona coordinadora primero')) });
    await abrir();
    const cargasAntes = api['queueMembers'].mock.calls.length;
    c.cambiarRol(COORD, 'tecnico');
    fix.detectChanges();
    expect(texto()).toContain('no puede quedarse sin coordinación');
    expect(api['queueMembers'].mock.calls.length).toBe(cargasAntes + 1);
  });

  it('cambiar al mismo rol no llama al servidor', async () => {
    await render();
    await abrir();
    c.cambiarRol(TEC, 'tecnico');
    expect(api['upsertQueueMember']).not.toHaveBeenCalled();
  });

  it('sin candidatos lo dice y explica a quién pedir el permiso', async () => {
    await render({ queueCandidates: vi.fn(() => of([])) });
    await abrir();
    expect(texto()).toContain('SERVICIO_ATENDER');
  });
});
