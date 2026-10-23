// `[MCP.3.3]` La pantalla de "Pedido agendado": el vendedor tiene que poder volver al inicio.
//
// Captura de David (2026-10-19): sólo se veía "Capturar exhibición". El botón que regresa al
// inicio ("Finalizar visita") existía, pero los botones estaban fijos a 1.75rem del fondo con
// z-index 5 y la barra de abajo de la app (fija, 5rem, z-index 10) lo tapaba.
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { VendorService } from '../vendor.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorOrderSuccessComponent } from './vendor-order-success.component';

const QUERY = { code: 'PD-2026-00087', total: '9.90', units: '1', name: 'ABARROTES ADELA', customer: 'c-adela', date: '2026-10-19' };

async function montar(query: Record<string, string> = QUERY, finish = vi.fn(() => of({}))) {
  await TestBed.configureTestingModule({
    imports: [VendorOrderSuccessComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
      { provide: VendorService, useValue: { finishVisit: finish } },
      { provide: HapticService, useValue: { notification: vi.fn() } },
    ],
  }).compileComponents();
  const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fix = TestBed.createComponent(VendorOrderSuccessComponent);
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const boton = (t: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(t)) as HTMLButtonElement | undefined;
  return { fix, el, nav, finish, boton };
}

describe('VendorOrderSuccessComponent · volver al inicio (MCP.3.3)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ hay un botón que dice que lleva al inicio', async () => {
    const { boton } = await montar();
    expect(boton('ir al inicio')).toBeDefined();
  });

  it('⭐ cierra la visita (con pedido) y lleva al inicio de la ruta', async () => {
    const { boton, finish, nav, fix } = await montar();
    boton('ir al inicio')!.click();
    fix.detectChanges();
    expect(finish).toHaveBeenCalledWith('c-adela', { had_order: true });
    expect(nav).toHaveBeenCalledWith(['/vendor/route-home']);
  });

  it('si cerrar la visita falla, igual lo lleva al inicio (no se queda atorado)', async () => {
    const { boton, nav } = await montar(QUERY, vi.fn(() => throwError(() => new Error('red'))));
    boton('ir al inicio')!.click();
    expect(nav).toHaveBeenCalledWith(['/vendor/route-home']);
  });

  it('sin cliente (pedido sin visita) también lleva al inicio', async () => {
    const { boton, nav, finish } = await montar({ ...QUERY, customer: '' });
    boton('ir al inicio')!.click();
    expect(finish).not.toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith(['/vendor/route-home']);
  });

  it('⭐ los botones quedan ARRIBA de la barra de abajo (5rem, z-index 10), no debajo', async () => {
    const { el } = await montar();
    const acts = el.querySelector('.acts') as HTMLElement;
    const css = getComputedStyle(acts);
    // La barra de la app es fija con z-index 10: por debajo de eso la tapa.
    expect(Number(css.zIndex)).toBeGreaterThan(10);
    // El fondo de los botones arranca después de los 5rem de la barra.
    expect(css.bottom).toContain('5rem');
  });
});

describe('VendorOrderSuccessComponent · pedido agrupado [MCP.3.13]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ un pedido surtido en dos sucursales lo dice: «Se surte en LPA y PH»', async () => {
    const { el } = await montar({ ...QUERY, surte: 'LPA,PH' });
    expect(el.querySelector('.surte')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Se surte en LPA y PH · el cliente recibe un ticket de cada sucursal');
  });

  it('un pedido de una sola sucursal no dice nada de más', async () => {
    const { el } = await montar();
    expect(el.querySelector('.surte')).toBeNull();
  });
});
