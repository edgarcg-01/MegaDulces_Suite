import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { HrSinPersonaDto, HrSinPersonaResponse } from '@megadulces/contracts';
import { RhService } from '../rh.service';
import { MOTIVO_CANDIDATO, RhSinPersonaComponent, nombreInicial } from './rh-sin-persona.component';

/**
 * `[RH.1.12]` La bandeja de códigos sin persona. Lo que se defiende: la Suite sugiere y RH confirma (ligar llama al
 * servidor con la persona elegida); si el código ya es de otra persona NO se reemplaza solo, se pide confirmar; el alta
 * no sale sin nombre completo y sección; y quien sólo ve no tiene con qué ligar.
 */
const fila = (o: Partial<HrSinPersonaDto> = {}): HrSinPersonaDto => ({
  enrollment_id: 'e1', site_code: 'zamora-canindo', site_name: 'Zamora Canindo', device_label: 'Entrada', serial_number: 'S1',
  codigo: '214', nombre_reloj: 'ANA LOPEZ RUIZ', ultima_checada: '2026-10-15T15:00:00Z', checadas_14d: 6, seccion: null, promotora: false,
  candidatos: [{ user_id: 'u-ana', nombre: 'Ana López Ruiz', status: 'active', motivo: 'mismo_nombre', sugerido: true }],
  ...o,
});
const resp = (filas: HrSinPersonaDto[]): HrSinPersonaResponse => ({ filas, total: filas.length, secciones: ['CAJAS', 'BODEGA'] });

describe('[RH.1.12] reglas de la bandeja', () => {
  it('el nombre del reloj sólo sirve de punto de partida si ya parece completo', () => {
    expect(nombreInicial('ANA LOPEZ')).toBe('ANA LOPEZ');
    expect(nombreInicial('Clau')).toBe('');
    expect(nombreInicial(null)).toBe('');
  });
  it('cada motivo tiene su texto', () => {
    expect(Object.keys(MOTIVO_CANDIDATO).sort()).toEqual(['mismo_codigo', 'mismo_nombre', 'nombre_parecido']);
  });
});

describe('[RH.1.12] RhSinPersonaComponent', () => {
  let fix: ComponentFixture<RhSinPersonaComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const boton = (t: string) => [...(fix.nativeElement as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;

  async function render(filas: HrSinPersonaDto[], gestiona = true) {
    api = {
      sinPersona: vi.fn(() => of(resp(filas))),
      buscarPersonas: vi.fn(() => of([{ user_id: 'u-beto', nombre: 'Beto Gómez', status: 'active', warehouse_code: null }])),
      ligarCodigo: vi.fn(() => of({ user_id: 'u-ana', nombre: 'Ana López Ruiz', enrolamientos: 2 })),
      altaDesdeReloj: vi.fn(() => of({ user_id: 'u-new', nombre: 'Carla Vega', enrolamientos: 1 })),
    };
    await TestBed.configureTestingModule({ imports: [RhSinPersonaComponent], providers: [{ provide: RhService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(RhSinPersonaComponent);
    fix.componentRef.setInput('gestiona', gestiona);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  const seleccionar = (f: HrSinPersonaDto) => { fix.componentInstance.elegir(f); fix.detectChanges(); };

  afterEach(() => TestBed.resetTestingModule());

  it('lista los códigos con su sugerencia; sin códigos, lo dice', async () => {
    await render([fila()]);
    expect(texto()).toContain('Zamora Canindo');
    expect(texto()).toContain('Ana López Ruiz');
    TestBed.resetTestingModule();
    await render([]);
    expect(texto()).toContain('Todos los códigos que checan tienen persona');
  });

  it('⭐ ligar al sugerido llama al servidor con esa persona, avisa y recarga', async () => {
    const f = fila();
    await render([f]);
    seleccionar(f);
    boton('Ligar a Ana López Ruiz')!.click();
    fix.detectChanges();
    expect(api['ligarCodigo']).toHaveBeenCalledWith('e1', { user_id: 'u-ana', reemplazar: false });
    expect(texto()).toContain('ligado a Ana López Ruiz (2 reloj(es))');
    expect(api['sinPersona']).toHaveBeenCalledTimes(2);
  });

  it('⛔ si el código ya es de otra persona: NO reemplaza solo, pide confirmar y sólo entonces reemplaza', async () => {
    const f = fila();
    await render([f]);
    api['ligarCodigo'].mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 409, error: { message: 'El código 214 ya es de Beto' } })));
    seleccionar(f);
    boton('Ligar a Ana López Ruiz')!.click();
    fix.detectChanges();
    expect(texto()).toContain('ya es de Beto');
    expect(api['ligarCodigo']).toHaveBeenCalledTimes(1);
    boton('Sí, reemplazar')!.click();
    fix.detectChanges();
    expect(api['ligarCodigo']).toHaveBeenLastCalledWith('e1', { user_id: 'u-ana', reemplazar: true });
  });

  it('buscar a mano y ligar al encontrado', async () => {
    const f = fila({ candidatos: [] });
    await render([f]);
    seleccionar(f);
    fix.componentInstance.q.set('beto');
    fix.componentInstance.buscar();
    fix.detectChanges();
    boton('Ligar a Beto Gómez')!.click();
    expect(api['ligarCodigo']).toHaveBeenCalledWith('e1', { user_id: 'u-beto', reemplazar: false });
  });

  it('⛔ el alta no sale sin nombre completo y sección; con ellos, da de alta y liga', async () => {
    const f = fila({ nombre_reloj: 'Clau', candidatos: [] });
    await render([f]);
    seleccionar(f);
    expect(fix.componentInstance.puedeAlta()).toBe(false);
    fix.componentInstance.nombre.set('Carla Vega');
    expect(fix.componentInstance.puedeAlta()).toBe(false); // falta la sección
    fix.componentInstance.seccion.set('CAJAS');
    fix.detectChanges();
    expect(fix.componentInstance.puedeAlta()).toBe(true);
    boton('Dar de alta y ligar')!.click();
    expect(api['altaDesdeReloj']).toHaveBeenCalledWith('e1', { nombre: 'Carla Vega', seccion: 'CAJAS', promotora: false });
  });

  it('⛔ NEGATIVA — quien sólo ve, ve los códigos pero no tiene con qué ligar', async () => {
    const f = fila();
    await render([f], false);
    seleccionar(f);
    expect(boton('Ligar a Ana López Ruiz')).toBeUndefined();
    expect(boton('Dar de alta y ligar')).toBeUndefined();
    expect(texto()).toContain('Sólo quien administra los relojes puede ligarlo');
  });
});
