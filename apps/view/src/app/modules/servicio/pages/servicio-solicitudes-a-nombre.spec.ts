import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse, SdRequesterDto } from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioSolicitudesComponent } from './servicio-solicitudes.component';

/**
 * `[MS.3.11]` Quien atiende levanta una solicitud A NOMBRE DE otra persona. Lo que se defiende:
 *  · la opción sólo existe para quien atiende (el servidor igual la vuelve a exigir);
 *  · con la opción encendida hay que ELEGIR a la persona: sin ella no se envía (si no, se levantaría a nombre de quien
 *    llama sin que se note);
 *  · elegir a la persona precarga su área y su sucursal, sin pisar una sucursal que ya se había elegido;
 *  · sin persona elegida NO viajan `requester_id` ni `department_code` (la solicitud sigue siendo de quien la escribe);
 *  · lo levantado a nombre de otra persona no es «mío»: se abre en la bandeja, no en «Mis solicitudes».
 */
const CATALOGO: SdCatalogResponse = {
  queues: [{ id: 'q1', code: 'ti', name: 'TI' }],
  categories: [{ id: 'c-libre', queue_id: 'q1', code: 'reportes', name: 'Reportes', default_priority: 'baja', requires_branch: false }],
  impacts: ['yo', 'varios', 'sucursal', 'red'],
};
const ANA: SdRequesterDto = { user_id: 'u-ana', username: 'ana', name: 'Ana Pérez', department_code: 'cajas', department_name: 'Cajas', position_code: 'cajera', warehouse_code: '02', warehouse_name: 'Piedad' };

describe('[MS.3.11] ServicioSolicitudesComponent — levantar a nombre de otra persona', () => {
  let fix: ComponentFixture<ServicioSolicitudesComponent>;
  let c: ServicioSolicitudesComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let navigate: ReturnType<typeof vi.fn>;

  async function render(perms: string[]) {
    api = {
      mine: vi.fn(() => of({ rows: [], total: 0 })),
      catalog: vi.fn(() => of(CATALOGO)),
      create: vi.fn(() => of({ id: 'nuevo' })),
      detail: vi.fn(() => NEVER),
      requesters: vi.fn(() => of([ANA])),
      departments: vi.fn(() => of([{ code: 'cajas', name: 'Cajas' }, { code: 'tienda', name: 'Tienda' }])),
    };
    navigate = vi.fn(() => Promise.resolve(true));
    await TestBed.configureTestingModule({
      imports: [ServicioSolicitudesComponent],
      providers: [
        { provide: ServiceDeskService, useValue: api },
        { provide: PermissionsService, useValue: { has: (k: string) => perms.includes(k) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) }, queryParamMap: new BehaviorSubject(convertToParamMap({})).asObservable() } },
        { provide: Router, useValue: { navigate } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ServicioSolicitudesComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    c.nueva();
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  const html = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const llenar = () => { c.elegirCategoria('c-libre'); c.form.title = 'No abre la caja'; };

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ la opción aparece sólo para quien atiende', async () => {
    await render([Permission.SERVICIO_ATENDER]);
    expect(c.puedeAtender()).toBe(true);
    expect(html()).toContain('Levantar a nombre de otra persona');
  });

  it('⛔ NEGATIVA — quien sólo reporta no la ve ni la puede usar', async () => {
    await render([Permission.SERVICIO_REPORTAR]);
    expect(c.puedeAtender()).toBe(false);
    expect(html()).not.toContain('Levantar a nombre de otra persona');
    llenar();
    c.aNombreDe.set(true); // aunque alguien forzara el estado, sin persona elegida no se envía
    expect(c.puedeEnviar()).toBe(false);
  });

  it('la coordinación también (COORDINAR)', async () => {
    await render([Permission.SERVICIO_COORDINAR]);
    expect(c.puedeAtender()).toBe(true);
  });

  it('encender la opción trae el catálogo de áreas una sola vez', async () => {
    await render([Permission.SERVICIO_ATENDER]);
    c.alternarANombreDe(true);
    c.alternarANombreDe(false);
    c.alternarANombreDe(true);
    expect(api['departments']).toHaveBeenCalledTimes(1);
    expect(c.departamentos().length).toBe(2);
  });

  it('⛔ no busca con menos de 2 letras (no es un padrón navegable)', async () => {
    vi.useFakeTimers();
    try {
      await render([Permission.SERVICIO_ATENDER]);
      c.alternarANombreDe(true);
      c.buscarPersona('a');
      vi.advanceTimersByTime(500);
      expect(api['requesters']).not.toHaveBeenCalled();
      c.buscarPersona('an');
      vi.advanceTimersByTime(500);
      expect(api['requesters']).toHaveBeenCalledWith('an');
      expect(c.resultados()).toEqual([ANA]);
    } finally { vi.useRealTimers(); }
  });

  it('⭐ con la opción encendida y SIN persona elegida no se puede enviar', async () => {
    await render([Permission.SERVICIO_ATENDER]);
    llenar();
    expect(c.puedeEnviar()).toBe(true);
    c.alternarANombreDe(true);
    expect(c.puedeEnviar()).toBe(false);
    c.elegirPersona(ANA);
    expect(c.puedeEnviar()).toBe(true);
  });

  it('elegir a la persona precarga su ÁREA y su SUCURSAL', async () => {
    await render([Permission.SERVICIO_ATENDER]);
    c.alternarANombreDe(true);
    c.elegirPersona(ANA);
    expect(c.areaCode).toBe('cajas');
    expect(c.form.warehouse_code).toBe('02');
    expect(c.solicitante()).toEqual(ANA);
    expect(c.resultados()).toEqual([]);
  });

  it('⛔ NEGATIVA — precargar NO pisa una sucursal que quien atiende ya había elegido', async () => {
    await render([Permission.SERVICIO_ATENDER]);
    c.form.warehouse_code = '05';
    c.elegirPersona(ANA);
    expect(c.form.warehouse_code).toBe('05');
  });

  it('⭐ al enviar viajan requester_id y el área elegida (puede ser distinta a la de la ficha)', async () => {
    await render([Permission.SERVICIO_ATENDER]);
    llenar();
    c.alternarANombreDe(true);
    c.elegirPersona(ANA);
    c.areaCode = 'tienda';
    c.enviar();
    await vi.waitFor(() => expect(api['create']).toHaveBeenCalled());
    expect(api['create']).toHaveBeenCalledWith(expect.objectContaining({ requester_id: 'u-ana', department_code: 'tienda', warehouse_code: '02' }));
  });

  it('⭐ lo levantado a nombre de otra persona se abre en la BANDEJA (no es «mío»)', async () => {
    await render([Permission.SERVICIO_ATENDER]);
    llenar();
    c.alternarANombreDe(true);
    c.elegirPersona(ANA);
    c.enviar();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith(['/servicio/bandeja'], { queryParams: { id: 'nuevo' } });
    expect(c.selId()).toBeNull();
  });

  it('⛔ NEGATIVA — sin persona elegida NO viaja requester_id ni department_code, y la ficha se abre en «Mis solicitudes»', async () => {
    await render([Permission.SERVICIO_ATENDER]);
    llenar();
    c.enviar();
    await vi.waitFor(() => expect(api['create']).toHaveBeenCalled());
    const dto = api['create'].mock.calls[0][0] as Record<string, unknown>;
    expect(dto['requester_id']).toBeUndefined();
    expect(dto['department_code']).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
    expect(c.selId()).toBe('nuevo');
  });

  it('«Cambiar» quita a la persona y limpia su área; una solicitud nueva arranca limpia', async () => {
    await render([Permission.SERVICIO_ATENDER]);
    c.alternarANombreDe(true);
    c.elegirPersona(ANA);
    c.quitarPersona();
    expect(c.solicitante()).toBeNull();
    expect(c.areaCode).toBeNull();
    c.elegirPersona(ANA);
    c.nueva();
    expect(c.solicitante()).toBeNull();
    expect(c.aNombreDe()).toBe(false);
  });
});
