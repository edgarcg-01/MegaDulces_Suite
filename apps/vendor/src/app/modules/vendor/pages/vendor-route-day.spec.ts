// `[MCP.3.6]` Iniciar ruta / Finalizar ruta, del lado del vendedor.
//
// Lo que importa: (1) sin iniciar, la primera vista es «Iniciar ruta»; (2) si no se pudo leer el
// estado, NUNCA se muestra «Iniciar ruta» (un error no es «sin iniciar») y la venta sigue; (3) en
// ruta hay «Finalizar ruta» fijo arriba de la barra de abajo; (4) confirmar llama al POST.
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { MessageService } from 'primeng/api';
import { of, throwError } from 'rxjs';
import type { SellerRouteDay } from '@megadulces/contracts';
import { VendorService } from '../vendor.service';
import { RouteDayService } from '../route-day.service';
import { AuthService } from '../../../core/services/auth.service';
import { GeolocationService } from '../../../core/services/geolocation.service';
import { VendorRouteHomeComponent } from './vendor-route-home.component';
import { VendorRouteFinishComponent, avisoAlFinalizar } from './vendor-route-finish.component';

const dia = (p: Partial<SellerRouteDay> = {}): SellerRouteDay => ({
  id: 'rd1', work_date: '2026-10-21', state: 'en_ruta',
  started_at: '2026-10-21T14:12:00.000Z', finished_at: null, visited: 9, orders: 3, total: 4521.5, ...p,
});

type Resp = SellerRouteDay | Error;
const como = (r: Resp) => (r instanceof Error ? throwError(() => r) : of(r));

function servicios(today: Resp, start: Resp = dia(), finish: Resp = dia({ state: 'finalizada' })) {
  return {
    today: vi.fn(() => como(today)),
    start: vi.fn(() => como(start)),
    finish: vi.fn(() => como(finish)),
  };
}

async function montarHome(rd: ReturnType<typeof servicios>) {
  const vendor = {
    home: vi.fn(() => of([{ id: 'c1', code: 'C1', name: 'ABARROTES ADELA', visited_today: false, pending_count: 0 }])),
    myOrdersToday: vi.fn(() => of([])),
    dayPickState: vi.fn(() => of(null)),
    nearbyCustomers: vi.fn(() => of([])),
  };
  await TestBed.configureTestingModule({
    imports: [VendorRouteHomeComponent],
    providers: [
      provideRouter([]),
      MessageService,
      { provide: VendorService, useValue: vendor },
      { provide: RouteDayService, useValue: rd },
      { provide: GeolocationService, useValue: { supported: false } },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1', username: 'Rosa' }) } },
    ],
  }).compileComponents();
  const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fix = TestBed.createComponent(VendorRouteHomeComponent);
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(t)) as HTMLButtonElement | undefined;
  return { fix, el, texto, boton, nav };
}

describe('Mi ruta · iniciar y finalizar la ruta (MCP.3.6)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ sin iniciar: la primera vista es «Iniciar ruta», con el saludo y sin la cartera', async () => {
    const { texto, boton, el } = await montarHome(servicios(dia({ state: 'sin_iniciar', started_at: null, id: null })));
    expect(boton('Iniciar ruta')).toBeDefined();
    expect(texto()).toContain('Hola, Rosa');
    expect(texto()).toContain('Al finalizar, al surtidor le llega un solo pedido');
    expect(el.querySelector('.list')).toBeNull();
  });

  it('⭐ tocar «Iniciar ruta» llama al POST y muestra Mi ruta en curso', async () => {
    const rd = servicios(dia({ state: 'sin_iniciar', started_at: null, id: null }));
    const { boton, fix, el, texto } = await montarHome(rd);
    boton('Iniciar ruta')!.click();
    fix.detectChanges();
    expect(rd.start).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.list')).not.toBeNull();
    expect(texto()).toContain('En curso desde');
  });

  it('⭐ si el GET falla NO se muestra «Iniciar ruta» y sí se deja Mi ruta con un aviso', async () => {
    const { boton, el, texto } = await montarHome(servicios(new Error('red')));
    expect(el.querySelector('.start')).toBeNull();
    expect(boton('Iniciar ruta')).toBeUndefined();
    expect(el.querySelector('.list')).not.toBeNull();
    expect(texto()).toContain('No pudimos saber si tu ruta está iniciada');
    // Tampoco se ofrece finalizar algo que no se sabe si existe.
    expect(boton('Finalizar ruta')).toBeUndefined();
  });

  it('⭐ en ruta: «En curso desde HH:MM» y «Finalizar ruta» fijo ARRIBA de la barra de abajo', async () => {
    const { boton, el, texto, nav } = await montarHome(servicios(dia()));
    // 14:12 UTC = 08:12 en Ciudad de México.
    expect(texto()).toContain('En curso desde 08:12');
    const fin = boton('Finalizar ruta');
    expect(fin).toBeDefined();
    const dock = getComputedStyle(el.querySelector('.dock') as HTMLElement);
    expect(Number(dock.zIndex)).toBeGreaterThan(10);
    // Ojo: '1.75rem' CONTIENE '5rem'; por eso se exige que arranque con los 5rem de la barra.
    // jsdom simplifica el calc a `calc(5.75rem + env(...))`: se lee el primer término en rem.
    expect(parseFloat(dock.bottom.replace(/^calc\(/, ''))).toBeGreaterThanOrEqual(5);
    fin!.click();
    expect(nav).toHaveBeenCalledWith(['/vendor/route-finish']);
  });

  it('finalizada: Mi ruta se sigue usando y avisa que lo nuevo le llega al surtidor fuera de la ruta', async () => {
    const { boton, el, texto } = await montarHome(
      servicios(dia({ state: 'finalizada', finished_at: '2026-10-21T20:05:00.000Z' })),
    );
    expect(texto()).toContain('Ruta finalizada a las 14:05. Si levantas otro pedido, le llega al surtidor como pedido fuera de la ruta.');
    expect(el.querySelector('.list')).not.toBeNull();
    expect(boton('Finalizar ruta')).toBeUndefined();
    expect(boton('Pedido')).toBeDefined();
  });
});

describe('Finalizar ruta · confirmación (MCP.3.6)', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function montarFin(rd: ReturnType<typeof servicios>) {
    await TestBed.configureTestingModule({
      imports: [VendorRouteFinishComponent],
      providers: [provideRouter([]), MessageService, { provide: RouteDayService, useValue: rd }],
    }).compileComponents();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const toast = vi.spyOn(TestBed.inject(MessageService), 'add');
    const fix = TestBed.createComponent(VendorRouteFinishComponent);
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
    const boton = (t: string) =>
      Array.from(el.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(t)) as HTMLButtonElement | undefined;
    return { fix, texto, boton, nav, toast };
  }

  it('⭐ el dato principal son los CLIENTES VISITADOS, no los pedidos; confirmar llama al POST y vuelve con aviso', async () => {
    const rd = servicios(dia(), dia(), dia({ state: 'finalizada', visited: 9 }));
    const { texto, boton, nav, toast, fix } = await montarFin(rd);
    expect(texto()).toContain('08:12 a');
    // [MCP.3.6] Primero (y en grande) los clientes visitados; los pedidos ya no se cuentan.
    const primero = fix.nativeElement.querySelector('.rf-sum .rf-row') as HTMLElement;
    expect(primero.classList.contains('rf-total')).toBe(true);
    expect(primero.textContent?.replace(/\s+/g, '')).toBe('Clientesvisitados9');
    expect(texto()).not.toContain('Pedidos');
    expect(texto()).toContain('$4,521.50');
    boton('Finalizar y mandar al surtidor')!.click();
    fix.detectChanges();
    // Primero pregunta: el primer toque NO cierra la ruta.
    expect(rd.finish).not.toHaveBeenCalled();
    expect(texto()).toContain('¿Seguro que quieres cerrar tu ruta?');
    boton('Sí, cerrar mi ruta')!.click();
    fix.detectChanges();
    expect(rd.finish).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'success', summary: 'Ruta finalizada', detail: 'Visitaste 9 clientes. Al surtidor le llegó tu pedido.',
    }));
    expect(nav).toHaveBeenCalledWith(['/vendor/route-home']);
  });

  it('[MCP.3.6] el aviso al finalizar habla de clientes visitados, en singular y plural, y sin pedidos', () => {
    expect(avisoAlFinalizar({ visited: 1, orders: 1 })).toBe('Visitaste 1 cliente. Al surtidor le llegó tu pedido.');
    expect(avisoAlFinalizar({ visited: 4, orders: 0 })).toBe('Visitaste 4 clientes. No hubo pedidos que mandar al surtidor.');
    expect(avisoAlFinalizar({ visited: 0, orders: 0 })).toBe('Visitaste 0 clientes. No hubo pedidos que mandar al surtidor.');
    expect(avisoAlFinalizar({ visited: 12, orders: 7 })).not.toMatch(/7/);
  });

  it('si el POST falla se queda, avisa y deja reintentar (no doble envío mientras va)', async () => {
    const rd = servicios(dia(), dia(), new Error('red'));
    const { boton, nav, toast, fix } = await montarFin(rd);
    boton('Finalizar y mandar al surtidor')!.click();
    fix.detectChanges();
    boton('Sí, cerrar mi ruta')!.click();
    fix.detectChanges();
    expect(nav).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
    expect(boton('Sí, cerrar mi ruta')!.disabled).toBe(false);
  });

  it('si el resumen no carga se declara (sin ceros pintados) y aun así se puede finalizar', async () => {
    const { texto, boton } = await montarFin(servicios(new Error('red')));
    expect(texto()).toContain('No pudimos cargar el resumen de tu ruta');
    expect(texto()).not.toContain('$0.00');
    expect(boton('Finalizar y mandar al surtidor')).toBeDefined();
  });

  it('[MCP.3.6] «No, seguir en ruta» en la advertencia no cierra nada', async () => {
    const rd = servicios(dia());
    const { boton, texto, fix, nav } = await montarFin(rd);
    boton('Finalizar y mandar al surtidor')!.click();
    fix.detectChanges();
    boton('No, seguir en ruta')!.click();
    fix.detectChanges();
    expect(rd.finish).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
    expect(texto()).not.toContain('¿Seguro que quieres cerrar tu ruta?');
    expect(boton('Finalizar y mandar al surtidor')).toBeDefined();
  });

  it('«Seguir en ruta» vuelve sin finalizar', async () => {
    const rd = servicios(dia());
    const { boton, nav } = await montarFin(rd);
    boton('Seguir en ruta')!.click();
    expect(rd.finish).not.toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith(['/vendor/route-home']);
  });
});
