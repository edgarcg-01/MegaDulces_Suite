import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { Select } from 'primeng/select';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { HrCandidatoFilaDto, HrTiempoPorEtapaDto, HrVacanteDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { authCon, permisos } from '../../../../testing/rh.fixture';
import { ReclutamientoService } from '../reclutamiento.service';
import { RhCandidatosComponent } from './rh-candidatos.component';
import { RhVacantesComponent, cuerpoDe, formDe } from './rh-vacantes.component';
import { RhReclutamientoRevisionesComponent } from './rh-reclutamiento-revisiones.component';
import { pasosDe, tiemposDe } from './rh-reclutamiento-resumen.component';
import { contraMeta } from '../reclutamiento-formato';

/**
 * `[RH.2.3]` Las tres pantallas de Reclutamiento. Lo que se defiende: la lista pide al servidor el apartado y la etapa
 * elegidos y muestra sus conteos; una vacante vacía se manda como «sin dato», no como texto en blanco; y el tiempo
 * por etapa se compara contra la meta de Mega Talento sin inventar una meta donde no hay.
 */
const fila = (o: Partial<HrCandidatoFilaDto> = {}): HrCandidatoFilaDto => ({
  id: 'c1', full_name: 'Ana Prueba', phone: '3511234567', phone_key: '3511234567', city_branch: 'Zamora', ciudad: 'Zamora', position_interest: 'Cajera',
  stage: 'aptitudes', stage_raw: 'aptitudes', source: 'portal', traffic_light: null, has_cv: true, no_rehire: false, is_spam: false,
  created_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), deleted_at: null, deletion_reason: null, ...o,
});

function api(over: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  return {
    candidatos: vi.fn(() => of({ total: 2, filas: [fila(), fila({ id: 'c2', full_name: 'Beto Prueba', has_cv: false, no_rehire: true })], por_etapa: { aptitudes: 2, filtro_inicial: 5 } })),
    casilleros: vi.fn(() => of([])),
    ficha: vi.fn(() => of(null)),
    vacantes: vi.fn(() => of([])),
    crearVacante: vi.fn(() => of({})),
    reingresos: vi.fn(() => of([])),
    duplicados: vi.fn(() => of([])),
    tiempoPorEtapa: vi.fn(() => of({ fases: [], total: 0 })),
    ...over,
  } as Record<string, ReturnType<typeof vi.fn>>;
}

async function montar<T>(cmp: new (...a: never[]) => T, svc: Record<string, unknown>, claves: string[]): Promise<ComponentFixture<T>> {
  await TestBed.configureTestingModule({
    imports: [cmp],
    providers: [
      provideRouter([]),
      { provide: ReclutamientoService, useValue: svc },
      { provide: PermissionsService, useValue: permisos(...claves) },
      { provide: AuthService, useValue: authCon(...claves) },
    ],
  }).compileComponents();
  const fix = TestBed.createComponent(cmp);
  fix.detectChanges();
  await fix.whenStable();
  fix.detectChanges();
  return fix;
}

const texto = (f: ComponentFixture<unknown>) => (f.nativeElement as HTMLElement).textContent ?? '';
const boton = (f: ComponentFixture<unknown>, t: string) =>
  [...(f.nativeElement as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim().startsWith(t)) as HTMLButtonElement | undefined;

describe('[RH.2.3] Candidatos', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ pide los postulados por omisión y muestra la lista con sus marcas y los conteos por etapa', async () => {
    const svc = api();
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    expect(svc['candidatos']).toHaveBeenCalledWith(expect.objectContaining({ view: 'postulados', stage: null }));
    expect(texto(f)).toContain('Ana Prueba');
    expect(texto(f)).toContain('No recontratable');
    expect(texto(f)).toContain('Sin CV');
    expect(boton(f, 'Todas')?.textContent).toContain('7');
    expect(boton(f, 'Aptitudes')?.textContent).toContain('2');
  });

  it('[RH.13.6] cada fila se lee de corrido: quién, qué busca y dónde; cuánto espera; teléfono 3-3-4 que se copia entero', async () => {
    const hace3dias = new Date(Date.now() - 3 * 86400000).toISOString();
    const svc = api({ candidatos: vi.fn(() => of({ total: 2, por_etapa: { aptitudes: 1, contratado: 1 }, filas: [
      fila({ last_activity_at: hace3dias }),
      fila({ id: 'c2', full_name: 'Ceci Prueba', stage: 'contratado', stage_raw: 'contratado', city_branch: 'Zamora' }),
    ] })) });
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    const el = f.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('thead th')].map((t) => t.textContent?.trim())).toEqual(['Candidato', 'Etapa', 'Esperando', 'Teléfono', 'Se postuló']);
    const [ana, ceci] = [...el.querySelectorAll('tbody tr:not(.rc-zona)')];
    // La zona ya la dice su encabezado: debajo del nombre sólo el puesto.
    expect(ana.querySelector('.rc-meta')?.textContent?.trim()).toBe('Cajera');
    expect(ceci.querySelector('.rc-meta')?.textContent?.trim()).toBe('Cajera');
    // Aptitudes tiene meta de 48 h: con 3 días espera y está atrasada; el porqué va junto.
    expect(ana.querySelector('.rc-esp')?.textContent).toContain('3 días');
    expect(ana.querySelector('.rc-esp .pill')?.textContent?.trim()).toBe('Atrasado');
    // Contratada ya no espera: se dice desde cuándo, sin «Atrasado».
    expect(ceci.querySelector('.rc-esp')?.textContent?.trim()).toMatch(/^desde /);
    expect(ceci.querySelector('.rc-esp .pill')).toBeNull();
    // Se ve en grupos, pero el texto (lo que se copia) va entero.
    expect([...ana.querySelectorAll('.rc-tel span span')].map((s) => s.textContent)).toEqual(['351', '123', '4567']);
    expect(ana.querySelector('.rc-tel')?.textContent?.trim()).toBe('3511234567');
  });

  it('[RH.13.6] por zona: en el orden del catálogo, «sin ciudad reconocida» al final, con cuántos y cuántos atrasados', async () => {
    const viejo = new Date(Date.now() - 5 * 86400000).toISOString();
    const svc = api({ candidatos: vi.fn(() => of({ total: 5, por_etapa: { aptitudes: 5 }, filas: [
      fila({ id: 'a', full_name: 'Uno', city_branch: 'por ahí', ciudad: 'sin_ciudad' }),
      fila({ id: 'b', full_name: 'Dos', city_branch: 'Zamora', ciudad: 'Zamora', last_activity_at: viejo }),
      fila({ id: 'c', full_name: 'Tres', city_branch: 'Morelia Norte', ciudad: 'Morelia' }),
      fila({ id: 'd', full_name: 'Cuatro', city_branch: 'zamora ', ciudad: 'Zamora' }),
      fila({ id: 'e', full_name: 'Cinco', city_branch: 'Yurecuaro', ciudad: 'Yurécuaro' }),
    ] })) });
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    const el = f.nativeElement as HTMLElement;
    const zonas = [...el.querySelectorAll('tr.rc-zona th')].map((t) => t.querySelector('span')?.textContent?.trim() + ' ' + t.querySelector('small')?.textContent?.replace(/\s+/g, ' ').trim());
    expect(zonas).toEqual(['Morelia 1', 'Zamora 2 · 1 atrasado', 'Yurécuaro 1', 'Sin ciudad reconocida 1']);
    // Cada zona trae a los suyos, en el orden en que llegaron.
    const nombres = [...el.querySelectorAll('tbody')].map((tb) => [...tb.querySelectorAll('.rc-nom')].map((b) => b.textContent?.trim()));
    expect(nombres).toEqual([['Tres'], ['Dos', 'Cuatro'], ['Cinco'], ['Uno']]);
    // El lugar sale sólo si dice algo que el encabezado no dice.
    const meta = (n: string) => [...el.querySelectorAll('tbody tr:not(.rc-zona)')].find((tr) => tr.textContent?.includes(n))?.querySelector('.rc-meta')?.textContent?.trim();
    expect(meta('Tres')).toBe('Cajera · Morelia Norte');
    expect(meta('Cuatro')).toBe('Cajera');
    expect(meta('Cinco')).toBe('Cajera');
    expect(meta('Uno')).toBe('Cajera · por ahí');
  });

  it('[RH.13.6] si no están todos cargados, la cuenta de cada zona lo dice', async () => {
    const svc = api({ candidatos: vi.fn(() => of({ total: 250, por_etapa: { aptitudes: 250 }, filas: [fila()] })) });
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    expect((f.nativeElement as HTMLElement).querySelector('tr.rc-zona th')?.textContent).toContain('1 de los cargados');
  });

  it('⛔ NEGATIVA — si el servidor no manda la zona, la lista va plana: no se agrupa con una regla inventada aquí', async () => {
    const sinZona = { ...fila() } as Partial<HrCandidatoFilaDto>;
    delete sinZona.ciudad;
    const svc = api({ candidatos: vi.fn(() => of({ total: 1, por_etapa: { aptitudes: 1 }, filas: [sinZona] })) });
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('tr.rc-zona').length).toBe(0);
    expect(el.querySelector('.rc-meta')?.textContent?.trim()).toBe('Cajera · Zamora');
  });

  it('[RH.13.6] tocar cualquier parte de la fila abre la ficha, una sola vez', async () => {
    const svc = api();
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    const el = f.nativeElement as HTMLElement;
    (el.querySelector('tbody tr .rc-tel') as HTMLElement).click();
    expect(svc['ficha']).toHaveBeenCalledTimes(1);
    (el.querySelector('tbody tr .rc-nom') as HTMLElement).click();
    expect(svc['ficha']).toHaveBeenCalledTimes(2);   // el nombre es parte de la fila: una sola apertura por clic
  });

  it('[RH.13.6] la fila se abre con el teclado: Tab llega a ella y Enter o Espacio abre la ficha', async () => {
    const svc = api();
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    const fila = (f.nativeElement as HTMLElement).querySelector('tbody tr:not(.rc-zona)') as HTMLElement;
    expect(fila.getAttribute('tabindex')).toBe('0');
    expect(fila.getAttribute('aria-label')).toBe('Abrir la ficha de Ana Prueba');
    fila.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(svc['ficha']).toHaveBeenCalledTimes(1);
    const espacio = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    fila.dispatchEvent(espacio);
    expect(svc['ficha']).toHaveBeenCalledTimes(2);
    expect(espacio.defaultPrevented).toBe(true);   // Espacio no desplaza la página
    // Sin un segundo botón dentro: una sola parada de tabulador por candidato.
    expect(fila.querySelector('button')).toBeNull();
  });

  it('[RH.13.6] el embudo: los pasos en orden con su cifra, y aparte cómo terminó; «Ver» separa lo de trabajar del archivo', async () => {
    const f = await montar(RhCandidatosComponent, api(), [Permission.HR_RECRUITMENT_VER]);
    const el = f.nativeElement as HTMLElement;
    const grupo = (sel: string) => [...el.querySelectorAll(`${sel} button`)].map((b) => [b.querySelector('.rc-emb-l')?.textContent?.trim(), b.querySelector('.rc-emb-n')?.textContent?.trim()]);
    expect(grupo('[aria-label="Todas las etapas"]')).toEqual([['Todas', '7']]);
    // Las que no vinieron del servidor salen en 0: nunca vacías.
    expect(grupo('.rc-flujo')).toEqual([['Filtro', '5'], ['Conductual', '0'], ['Aptitudes', '2'], ['Psicométricas', '0']]);
    expect(grupo('.rc-fin')).toEqual([['Contratados', '0'], ['Rechazados', '0']]);
    const c = f.componentInstance as RhCandidatosComponent;
    expect(c.opcionesVer.map((g) => [g.label, g.items.map((o) => o.value)])).toEqual([
      ['Para trabajar', ['postulados', 'en_proceso']],
      ['Archivo', ['no_recontratables', 'spam', 'papelera']],
    ]);
    // Cada opción lleva lo que significa (se lee en el menú, no en un title).
    expect(c.opcionesVer[1].items.every((o) => o.ayuda.length > 10)).toBe(true);
  });

  it('elegir una etapa o una lista vuelve a pedir al servidor con ese filtro', async () => {
    const svc = api();
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    boton(f, 'Aptitudes')!.click();
    expect(svc['candidatos']).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'aptitudes' }));
    // «Ver» es un p-select: se elige por su ngModelChange, como lo hace el menú.
    f.debugElement.query(By.directive(Select)).triggerEventHandler('ngModelChange', 'papelera');
    expect(svc['candidatos']).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'papelera', stage: null }));
    f.detectChanges();
    // En la papelera no hay etapas que elegir.
    expect((f.nativeElement as HTMLElement).querySelector('.rc-embudo')).toBeNull();
  });
});

describe('[RH.2.3] Vacantes', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ NEGATIVA — un campo vacío viaja como null, nunca como texto en blanco', () => {
    const f = { ...formDe(null), name: '  Cajera  ', salary_text: '   ', area: 'Tienda' };
    expect(cuerpoDe(f)).toEqual(expect.objectContaining({ name: 'Cajera', salary_text: null, area: 'Tienda', is_active: true, sort_order: 999 }));
    // Las sucursales viajan como lista (de ahí sale la ciudad en la bolsa de trabajo).
    expect(cuerpoDe({ ...f, branch_codes: ['zamora-canindo'] }).branch_codes).toEqual(['zamora-canindo']);
  });

  it('quien sólo ve no tiene «Nueva vacante»; quien gestiona sí', async () => {
    const v: HrVacanteDto = { id: 'v1', name: 'Cajera', description: null, area: null, branch_codes: [], branches_text: 'Zamora', salary_text: null,
      schedule_text: null, requirements: null, image_url: null, competencies_sheet: null, extra: {}, is_active: false, sort_order: 1, created_at: '', updated_at: '' };
    const ver = await montar(RhVacantesComponent, api({ vacantes: vi.fn(() => of([v])) }), [Permission.HR_RECRUITMENT_VER]);
    expect(boton(ver, 'Nueva vacante')).toBeUndefined();
    expect(texto(ver)).toContain('Cerrada');
    TestBed.resetTestingModule();
    const gest = await montar(RhVacantesComponent, api({ vacantes: vi.fn(() => of([v])) }), [Permission.HR_RECRUITMENT_GESTIONAR]);
    expect(boton(gest, 'Nueva vacante')).toBeTruthy();
  });

  it('[RH.13.6] las publicadas primero y las cerradas aparte; el área va bajo el nombre; la fila abre la edición', async () => {
    const base: HrVacanteDto = { id: 'v1', name: 'Cajera', description: null, area: 'Ventas', branch_codes: [], branches_text: null, salary_text: '$9,000',
      schedule_text: null, requirements: null, image_url: null, competencies_sheet: null, extra: {}, is_active: true, sort_order: 1, created_at: '', updated_at: '' };
    // En el orden de captura la cerrada va en medio: la pantalla no la deja ahí.
    const vs = [base, { ...base, id: 'v2', name: 'Chofer', is_active: false, area: null }, { ...base, id: 'v3', name: 'Almacenista', area: 'Almacén' }];
    const f = await montar(RhVacantesComponent, api({ vacantes: vi.fn(() => of(vs)) }), [Permission.HR_RECRUITMENT_GESTIONAR]);
    const el = f.nativeElement as HTMLElement;
    const grupos = [...el.querySelectorAll('tbody')].map((tb) => [
      tb.querySelector('tr.rv-grupo th')?.firstChild?.textContent?.trim(),
      [...tb.querySelectorAll('.rv-nom')].map((b) => b.textContent?.trim()),
    ]);
    expect(grupos).toEqual([['Publicadas', ['Cajera', 'Almacenista']], ['Cerradas', ['Chofer']]]);
    expect(el.querySelector('tbody .rv-meta')?.textContent?.trim()).toBe('Ventas');
    // Sin pastilla por renglón: el grupo ya dice el estado.
    expect(el.querySelector('tbody .pill')).toBeNull();
    const c = f.componentInstance as RhVacantesComponent;
    (el.querySelector('tbody tr:not(.rv-grupo) td[data-label="Sueldo"]') as HTMLElement).click();
    expect(c.peek()).toBe(true);
    expect(c.form()?.name).toBe('Cajera');
  });

  it('sin vacantes publicadas el grupo lo dice, no desaparece', async () => {
    const v: HrVacanteDto = { id: 'v1', name: 'Chofer', description: null, area: null, branch_codes: [], branches_text: null, salary_text: null,
      schedule_text: null, requirements: null, image_url: null, competencies_sheet: null, extra: {}, is_active: false, sort_order: 1, created_at: '', updated_at: '' };
    const f = await montar(RhVacantesComponent, api({ vacantes: vi.fn(() => of([v])) }), [Permission.HR_RECRUITMENT_VER]);
    expect(texto(f)).toContain('Ninguna publicada ahora mismo.');
    // Quien sólo ve no abre la edición desde la fila, ni con el mouse ni con el teclado, y la fila no es una parada de Tab.
    const fila = (f.nativeElement as HTMLElement).querySelector('tbody td[data-label="Plazas"]')?.closest('tr') as HTMLElement;
    fila.click();
    fila.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect((f.componentInstance as RhVacantesComponent).peek()).toBe(false);
    expect(fila.hasAttribute('tabindex')).toBe(false);
  });

  it('[RH.13.6] quien gestiona abre la edición con el teclado: Enter o Espacio sobre la fila', async () => {
    const v: HrVacanteDto = { id: 'v1', name: 'Cajera', description: null, area: null, branch_codes: [], branches_text: null, salary_text: null,
      schedule_text: null, requirements: null, image_url: null, competencies_sheet: null, extra: {}, is_active: true, sort_order: 1, created_at: '', updated_at: '' };
    const f = await montar(RhVacantesComponent, api({ vacantes: vi.fn(() => of([v])) }), [Permission.HR_RECRUITMENT_GESTIONAR]);
    const c = f.componentInstance as RhVacantesComponent;
    const fila = (f.nativeElement as HTMLElement).querySelector('tbody tr:not(.rv-grupo)') as HTMLElement;
    expect(fila.getAttribute('tabindex')).toBe('0');
    expect(fila.getAttribute('aria-label')).toBe('Editar la vacante Cajera');
    fila.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(c.peek()).toBe(true);
    c.peek.set(false);
    const espacio = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    fila.dispatchEvent(espacio);
    expect(c.peek()).toBe(true);
    expect(espacio.defaultPrevented).toBe(true);
  });
});

describe('[RH.2.3] Revisiones', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('el tiempo por etapa contra la meta: sin meta no se juzga', () => {
    const f = (etapa: string, avg: number): HrTiempoPorEtapaDto => ({ etapa, n: 3, avg_horas: avg, min_horas: 1, max_horas: 90 });
    expect(contraMeta(f('filtro_inicial', 30))).toEqual({ meta: 24, pasa: true });
    expect(contraMeta(f('psicometria', 10))).toEqual({ meta: 72, pasa: false });
    expect(contraMeta(f('dictamen', 999))).toEqual({ meta: null, pasa: null });
  });

  it('⭐ lista a quien regresó estando marcado, con el motivo', async () => {
    const svc = api({
      reingresos: vi.fn(() => of([{ id: 'c9', full_name: 'Carlos Prueba', phone: '5213510000000', stage: 'filtro_inicial', created_at: '2026-10-10T00:00:00Z',
        marcado_id: 'c1', marcado_nombre: 'Carlos P.', motivo: 'abandonó el puesto en Yurécuaro', marcado_por: 'rh', marcado_en: '2026-08-01T00:00:00Z' }])),
    });
    const f = await montar(RhReclutamientoRevisionesComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    expect(texto(f)).toContain('Carlos Prueba');
    expect(texto(f)).toContain('abandonó el puesto en Yurécuaro');
    expect(texto(f)).toContain('351 000 0000');
    // [RH.13.6] El veredicto arriba, y el tiempo por etapa ya no vive aquí (se mudó al Resumen).
    expect((f.nativeElement as HTMLElement).querySelector('.rr2-veredicto')?.textContent?.replace(/\s+/g, ' ').trim())
      .toBe('1 por revisar: 1 persona marcada que regresó');
    expect(svc['tiempoPorEtapa']).not.toHaveBeenCalled();
  });

  it('[RH.13.6] los duplicados en tabla: un grupo por teléfono, con etapa, origen, fecha y CV de cada registro', async () => {
    const svc = api({
      duplicados: vi.fn(() => of([{ phone_key: '3511234567', candidatos: [
        { id: 'a', full_name: 'Ana Uno', source: 'bot', created_at: '2026-08-31T12:00:00Z', has_cv: true, stage: 'aptitudes' },
        { id: 'b', full_name: 'Ana Dos', source: 'portal', created_at: '2026-11-10T12:00:00Z', has_cv: false, stage: 'filtro_inicial' },
      ] }])),
    });
    const f = await montar(RhReclutamientoRevisionesComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('tr.rr2-grupo th .mono')?.textContent?.trim()).toBe('351 123 4567');
    const filas = [...el.querySelectorAll('.rr2-tabla tbody tr:not(.rr2-grupo)')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim()));
    expect(filas[0]).toEqual(['Ana Uno', 'Aptitudes y Entrevista Técnica', 'bot', expect.stringContaining('ago'), 'Con CV']);
    expect(filas[1][4]).toBe('Sin CV');
    expect(el.querySelector('.rr2-veredicto')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 por revisar: 1 teléfono con más de un registro');
  });

  it('⛔ NEGATIVA — si una lista no se pudo leer, la otra se muestra y NO se dice «nada por revisar»', async () => {
    const svc = api({ duplicados: vi.fn(() => throwError(() => ({ status: 500 }))) });
    const f = await montar(RhReclutamientoRevisionesComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    const el = f.nativeElement as HTMLElement;
    expect(texto(f)).not.toContain('Nada por revisar');
    expect(el.querySelector('.rr2-veredicto')?.textContent).toContain('No se pudo revisar todo');
    // La de reingresos sí se leyó y lo dice; la de duplicados declara su falla en su lugar.
    expect(texto(f)).toContain('Nadie en proceso comparte teléfono con alguien marcado.');
    expect(el.querySelectorAll('.rr2-err').length).toBe(1);
  });
});

describe('[RH.8.1] Resumen y la ciudad en Candidatos', () => {
  afterEach(() => TestBed.resetTestingModule());
  const vacio = { filtro_inicial: 0, entrevista_rh: 0, aptitudes: 0, psicometria: 0, contratado: 0, rechazado: 0 };
  const resumen = {
    total: 5,
    ciudades: [
      { ciudad: 'Morelia', total: 3, por_etapa: { ...vacio, filtro_inicial: 2, aptitudes: 1 } },
      { ciudad: 'sin_ciudad', total: 2, por_etapa: { ...vacio, filtro_inicial: 2 } },
    ],
    etapas: [
      { etapa: 'filtro_inicial', total: 4, rezago: 1, fuera_de_meta: 2 }, { etapa: 'entrevista_rh', total: 0, rezago: 0, fuera_de_meta: 0 },
      { etapa: 'aptitudes', total: 1, rezago: 0, fuera_de_meta: 0 }, { etapa: 'psicometria', total: 0, rezago: 0, fuera_de_meta: 0 },
      { etapa: 'contratado', total: 0, rezago: 0, fuera_de_meta: null }, { etapa: 'rechazado', total: 0, rezago: 0, fuera_de_meta: null },
    ],
    sin_ciudad: { vacia: 1, no_reconocida: 1 },
    rezago_dias: 30,
  };

  it('⭐ el Resumen abre con el veredicto y el embudo con su reparto; cada número lleva a Candidatos con etapa y ciudad', async () => {
    const { RhReclutamientoResumenComponent } = await import('./rh-reclutamiento-resumen.component');
    const f = await montar(RhReclutamientoResumenComponent, api({ resumen: vi.fn(() => of(resumen)) }), [Permission.HR_RECRUITMENT_VER]);
    const c = f.componentInstance as InstanceType<typeof RhReclutamientoResumenComponent>;
    const el = f.nativeElement as HTMLElement;
    // [RH.13.6] Filtro: 4 = 1 dentro + 2 fuera de meta + 1 sin moverse. El reparto siempre suma el total.
    expect(c.pasos().map((p) => [p.id, p.total, p.dentro, p.fuera, p.rezago])).toEqual([
      ['filtro_inicial', 4, 1, 2, 1], ['entrevista_rh', 0, 0, 0, 0], ['aptitudes', 1, 1, 0, 0], ['psicometria', 0, 0, 0, 0],
    ]);
    expect(el.querySelector('.rr-veredicto')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Donde más se atora: Filtro, con 2 fuera de su meta de 24 h.');
    // El paso del embudo lleva a la lista de esa etapa; el desenlace va aparte.
    const paso = el.querySelector('.rr-flujo a.rr-paso') as HTMLAnchorElement;
    expect(paso.getAttribute('href')).toContain('/rh/reclutamiento?view=en_proceso&stage=filtro_inicial');
    expect(paso.textContent?.replace(/\s+/g, ' ')).toContain('2 fuera de meta');
    expect(paso.textContent?.replace(/\s+/g, ' ')).toContain('1 sin moverse +30 días');
    expect([...el.querySelectorAll('.rr-fin .rr-paso-l')].map((x) => x.textContent?.trim())).toEqual(['Contratados', 'Rechazados']);
    const liga = el.querySelector('a[aria-label^="1 en Aptitudes"]') as HTMLAnchorElement | null;
    expect(liga?.getAttribute('href')).toContain('/rh/reclutamiento?view=en_proceso&stage=aptitudes&city=Morelia');
    expect(texto(f)).toContain('Sin ciudad reconocida');
    expect(texto(f)).toContain('no la escribieron');
    // Los encabezados de la matriz dicen el número de paso, igual que el embudo.
    expect([...el.querySelectorAll('thead .rr-h-largo')].map((x) => x.textContent?.trim()))
      .toEqual(['1 · Filtro', '2 · Conductual', '3 · Aptitudes', '4 · Psicométricas', 'Contratados', 'Rechazados']);
  });

  it('sin nadie fuera de meta el veredicto lo dice, y la barra no inventa un reparto', () => {
    const quietos = { ...resumen, etapas: resumen.etapas.map((e) => ({ ...e, fuera_de_meta: e.fuera_de_meta === null ? null : 0, rezago: 0 })) };
    expect(pasosDe(quietos)[0]).toEqual(expect.objectContaining({ total: 4, dentro: 4, fuera: 0, rezago: 0 }));
    // ⛔ Datos que no cuadran (más fuera de meta que gente) no producen negativos: se topa al total.
    const raro = { ...resumen, etapas: [{ etapa: 'filtro_inicial' as const, total: 2, rezago: 1, fuera_de_meta: 5 }] };
    expect(pasosDe(raro)[0]).toEqual(expect.objectContaining({ total: 2, rezago: 1, fuera: 1, dentro: 0 }));
    expect(pasosDe(null)).toEqual([]);
  });

  it('[RH.13.6] «¿Cuánto tarda cada paso?» vive en el Resumen: en orden, la misma escala para todos y la meta marcada', async () => {
    const t = (etapa: string, avg: number): HrTiempoPorEtapaDto => ({ etapa, n: 3, avg_horas: avg, min_horas: 1, max_horas: 500 });
    const filas = tiemposDe([t('psicometria', 60), t('filtro_inicial', 30)]);
    expect(filas.map((x) => [x.nombre, x.promedio, x.meta, x.pasa])).toEqual([['1 · Filtro', '30 h', '24 h', true], ['4 · Psicométricas', '2.5 días', '3 días', false]]);
    // La escala la pone la meta más grande (72 h × 1.15), no el máximo de 500 h: las barras no se aplastan.
    expect(filas[1].pctMeta).toBeCloseTo((72 / (72 * 1.15)) * 100, 0);
    expect(filas[0].pctPromedio).toBeLessThan(filas[1].pctPromedio);
    const { RhReclutamientoResumenComponent } = await import('./rh-reclutamiento-resumen.component');
    const f = await montar(RhReclutamientoResumenComponent, api({
      resumen: vi.fn(() => of(resumen)), tiempoPorEtapa: vi.fn(() => of({ fases: [t('filtro_inicial', 30)], total: 3 })),
    }), [Permission.HR_RECRUITMENT_VER]);
    expect((f.nativeElement as HTMLElement).querySelector('.rr-tiempos .pill')?.textContent?.trim()).toBe('Pasa la meta');
  });

  it('⛔ NEGATIVA — si el tiempo por paso falla, el resto del Resumen sigue y la falla se dice en su sección', async () => {
    const { RhReclutamientoResumenComponent } = await import('./rh-reclutamiento-resumen.component');
    const f = await montar(RhReclutamientoResumenComponent, api({
      resumen: vi.fn(() => of(resumen)), tiempoPorEtapa: vi.fn(() => throwError(() => ({ status: 500 }))),
    }), [Permission.HR_RECRUITMENT_VER]);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.rr-embudo')).not.toBeNull();
    expect(el.querySelector('.rr-err')).not.toBeNull();
    expect(texto(f)).not.toContain('Todavía no hay cambios de etapa');
  });

  it('Candidatos pide la ciudad, la muestra y se puede quitar', async () => {
    const svc = api();
    const f = await montar(RhCandidatosComponent, svc, [Permission.HR_RECRUITMENT_VER]);
    const c = f.componentInstance;
    c.setCiudad('sin_ciudad');
    f.detectChanges();
    expect(svc['candidatos']).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'sin_ciudad' }));
    expect(texto(f)).toContain('sin ciudad reconocida');
    c.setCiudad(null);
    expect(svc['candidatos']).toHaveBeenLastCalledWith(expect.objectContaining({ city: null }));
  });
});
