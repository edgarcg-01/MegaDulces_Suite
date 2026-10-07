import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioSolicitudesComponent } from './servicio-solicitudes.component';

/**
 * `[MS.3.2]` El alta. Lo que se defiende:
 *  · una categoría que EXIGE sucursal vuelve obligatoria la sucursal — sin ella no se puede enviar. Esto lo
 *    atrapó `check:signal-reactivity`: `requiereSucursal` era un computed() sobre un campo plano y quedaba
 *    congelado, o sea que la sucursal NUNCA se habría pedido;
 *  · el formulario no manda una prioridad: la sugiere el servidor;
 *  · `?nueva=1` (el botón del header) abre el formulario directo y `?id=` (la campana) abre esa ficha.
 */
const CATALOGO: SdCatalogResponse = {
  queues: [{ id: 'q1', code: 'ti', name: 'TI', priority_model: 'impacto', asks_zone: false }],
  zones: [],
  categories: [
    { id: 'c-libre', queue_id: 'q1', code: 'reportes', name: 'Reportes', default_priority: 'baja', requires_branch: false },
    { id: 'c-suc', queue_id: 'q1', code: 'caja', name: 'Sistema de caja', default_priority: 'alta', requires_branch: true },
  ],
  impacts: ['yo', 'varios', 'sucursal', 'red'],
};

describe('[MS.3.2] ServicioSolicitudesComponent', () => {
  let fix: ComponentFixture<ServicioSolicitudesComponent>;
  let c: ServicioSolicitudesComponent;
  let params$: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let api: { mine: ReturnType<typeof vi.fn>; catalog: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> };

  async function render(query: Record<string, string> = {}) {
    params$ = new BehaviorSubject(convertToParamMap(query));
    api = {
      mine: vi.fn(() => of({ rows: [], total: 0 })),
      catalog: vi.fn(() => of(CATALOGO)),
      create: vi.fn(() => of({ id: 'nuevo' })),
      detail: vi.fn(() => NEVER), // la ficha embebida pide su ticket; aquí no importa qué responda
    };
    await TestBed.configureTestingModule({
      imports: [ServicioSolicitudesComponent],
      providers: [
        { provide: ServiceDeskService, useValue: api },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) }, queryParamMap: params$.asObservable() } },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ServicioSolicitudesComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('al abrir carga «mis solicitudes abiertas», sólo las propias', async () => {
    await render();
    expect(api.mine).toHaveBeenCalledWith(expect.objectContaining({ scope: 'open' }));
    expect(api.catalog).not.toHaveBeenCalled(); // el catálogo se pide hasta que alguien abre el formulario
  });

  it('⭐ una categoría que exige sucursal vuelve obligatoria la sucursal: sin ella NO se puede enviar', async () => {
    await render();
    c.nueva();
    fix.detectChanges();
    c.form.title = 'No abre la caja';

    c.elegirCategoria('c-libre');
    expect(c.requiereSucursal()).toBe(false);
    expect(c.puedeEnviar()).toBe(true);

    c.elegirCategoria('c-suc');
    expect(c.requiereSucursal()).toBe(true); // era false para siempre mientras fue un computed sobre campo plano
    expect(c.puedeEnviar()).toBe(false);

    c.form.warehouse_code = '02';
    expect(c.puedeEnviar()).toBe(true);
  });

  it('sin título o sin categoría no se envía', async () => {
    await render();
    c.nueva();
    expect(c.puedeEnviar()).toBe(false);
    c.elegirCategoria('c-libre');
    expect(c.puedeEnviar()).toBe(false);
    c.form.title = '   ';
    expect(c.puedeEnviar()).toBe(false);
    c.form.title = 'Algo';
    expect(c.puedeEnviar()).toBe(true);
  });

  it('⭐ nunca manda una prioridad: la sugiere el servidor', async () => {
    await render();
    c.nueva();
    c.elegirCategoria('c-libre');
    c.form.title = 'Reporte lento';
    c.form.impact = 'sucursal';
    c.form.blocks_work = true;
    c.enviar();
    await new Promise((r) => setTimeout(r)); // la lectura de archivos es una promesa: se espera su turno
    expect(api.create).toHaveBeenCalledTimes(1);
    const dto = api.create.mock.calls[0][0] as Record<string, unknown>;
    expect(dto).not.toHaveProperty('priority');
    expect(dto).toMatchObject({ category_id: 'c-libre', title: 'Reporte lento', impact: 'sucursal', blocks_work: true });
  });

  it('abrir un formulario nuevo olvida la categoría del anterior', async () => {
    await render();
    c.nueva();
    c.elegirCategoria('c-suc');
    expect(c.requiereSucursal()).toBe(true);
    c.nueva();
    expect(c.requiereSucursal()).toBe(false);
  });

  it('?nueva=1 (el botón «Reportar un problema» del header) abre el formulario directo', async () => {
    await render({ nueva: '1' });
    expect(c.creando()).toBe(true);
    expect(api.catalog).toHaveBeenCalled();
  });

  it('⭐ con la página YA abierta, un parámetro nuevo también reacciona (Angular reutiliza el componente)', async () => {
    // Medido en vivo: estando en la bandeja, pulsar un aviso de la campana cambiaba la URL y la pantalla no; y
    // «Reportar un problema» del header no hacía nada desde «Mis solicitudes». Antes se leía una sola vez al iniciar.
    await render();
    expect(c.creando()).toBe(false);
    params$.next(convertToParamMap({ nueva: '1' }));
    expect(c.creando()).toBe(true);
    params$.next(convertToParamMap({ id: 'otra-solicitud' }));
    expect(c.selId()).toBe('otra-solicitud');
    expect(c.creando()).toBe(false);
  });

  it('?id= (el deep-link de la campana) abre la ficha de esa solicitud', async () => {
    await render({ id: 'abc-123' });
    expect(c.selId()).toBe('abc-123');
    expect(c.creando()).toBe(false);
  });
  describe('[MS.3.14] el campo se llama «Ubicación», no «Sucursal»', () => {
    it('⭐ con una categoría que exige ubicación el campo dice «Ubicación *» y su selector también', async () => {
      await render();
      c.nueva();
      c.elegirCategoria('c-suc');
      fix.detectChanges();
      const texto = (fix.nativeElement as HTMLElement).textContent ?? '';
      expect(texto).toContain('Ubicación *');
      expect(texto).not.toMatch(/Sucursal \*/);
      expect((fix.nativeElement as HTMLElement).querySelector('p-select[arialabel="Ubicación"], p-select[ariaLabel="Ubicación"]')).toBeTruthy();
    });
    it('⭐ `[MS.3.17]` la ubicación OPCIONAL se ve siempre, sin tener que pulsar un enlace', async () => {
      await render();
      c.nueva();
      c.elegirCategoria('c-libre');
      fix.detectChanges();
      const el = fix.nativeElement as HTMLElement;
      const texto = el.textContent ?? '';
      expect(texto).toContain('Ubicación (opcional)');
      expect(el.querySelector('p-select[arialabel="Ubicación"], p-select[ariaLabel="Ubicación"]')).toBeTruthy();
      expect(texto).not.toContain('Indicar ubicación');
      expect(texto).not.toContain('Indicar sucursal');
    });
    it('⛔ NEGATIVA — antes de elegir categoría el formulario también la muestra, y no la marca obligatoria', async () => {
      await render();
      c.nueva();
      fix.detectChanges();
      const texto = (fix.nativeElement as HTMLElement).textContent ?? '';
      expect(texto).toContain('Ubicación (opcional)');
      expect(texto).not.toContain('Ubicación *');
    });
  });

  describe('[MS.3.14] la lista de sucursales', () => {
    it('⭐ ofrece «Oficinas Corporativas» y «Estacionamiento CEDIS» (que no son sucursales Kepler) AL FINAL de la red', async () => {
      await render();
      const nombres = c.sucursales.map((x) => x.name);
      expect(nombres.slice(-2)).toEqual(['Oficinas Corporativas', 'Estacionamiento CEDIS']);
      expect(c.sucursales.slice(-2).map((x) => x.code)).toEqual(['OF', 'EC']);
    });
    it('⛔ NEGATIVA — NO quita ni cambia ninguna de las sucursales de la red (siguen las 9, en su orden)', async () => {
      await render();
      expect(c.sucursales.slice(0, 9).map((x) => x.code)).toEqual(['00', '01', '02', '03', '04', '05', '06', '07', '08']);
      expect(c.sucursales).toHaveLength(11);
    });
    it('el código de las oficinas no choca con ningún código de sucursal', async () => {
      await render();
      const codigos = c.sucursales.map((x) => x.code);
      expect(new Set(codigos).size).toBe(codigos.length);
    });
  });
});
