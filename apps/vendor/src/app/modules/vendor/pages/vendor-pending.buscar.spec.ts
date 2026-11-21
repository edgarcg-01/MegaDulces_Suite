import { TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { VendorPendingComponent } from './vendor-pending.component';
import { VendorService } from '../vendor.service';

/**
 * `[MCP.30]` «Por entregar»: la lista tiene tope (200, los más recientes) y antes lo callaba («200 por entregar»).
 * Ahora dice cuántos hay de verdad, y el buscador pregunta al SERVIDOR (busca en todos, no en los 200).
 */
describe('[MCP.30] «Por entregar»: el tope se dice y se busca en todos', () => {
  afterEach(() => TestBed.resetTestingModule());
  const orden = (id: string, customer_name: string, status = 'confirmed') => ({
    id, code: id, folio: `PD-2026-${id}`, customer_id: 'c1', customer_name, status, total: 100, created_at: '2026-11-20T15:00:00.000Z', is_preventa: false,
  });
  const esperar = (ms = 350) => new Promise((r) => setTimeout(r, ms));

  async function montar(total: number) {
    const api = {
      pendingDeliveriesPage: vi.fn((q?: string) =>
        of(q ? { data: [orden('01291', 'ABARROTES SAN JUDAS')], total: 1 } : { data: [orden('01367', 'ABARROTES LUPITA'), orden('01366', 'DULCERIA EL TREBOL')], total })),
      orderById: vi.fn(() => of({ lines: [] })),
    };
    await TestBed.configureTestingModule({
      imports: [VendorPendingComponent],
      providers: [provideRouter([]), { provide: VendorService, useValue: api }, { provide: MessageService, useValue: { add: vi.fn() } }],
    }).compileComponents();
    const fix = TestBed.createComponent(VendorPendingComponent);
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
    const escribir = async (q: string) => {
      const i = el.querySelector<HTMLInputElement>('input[type=search]')!;
      i.value = q;
      i.dispatchEvent(new Event('input'));
      fix.detectChanges();
      await esperar();
      fix.detectChanges();
    };
    return { fix, el, api, texto, escribir };
  }

  it('con más pendientes que los que caben, lo DICE (antes: «200 por entregar» y nada más)', async () => {
    const t = await montar(238);
    expect(t.texto()).toContain('Se muestran los 2 más recientes de 238. Usa el buscador para encontrar los demás.');
  });

  it('NEGATIVA: si caben todos, no hay aviso de tope', async () => {
    const t = await montar(2);
    expect(t.texto()).not.toContain('Se muestran los');
  });

  it('el buscador es de PEDIDOS (no de precios) y pregunta al servidor: encuentra uno que no estaba en la lista', async () => {
    const t = await montar(238);
    expect(t.el.querySelector('input[type=search]')?.getAttribute('placeholder')).toBe('Pedido: folio, cliente o producto');
    await t.escribir('san judas');
    expect(t.api.pendingDeliveriesPage).toHaveBeenLastCalledWith('san judas');
    expect(t.texto()).toContain('Resultados · 1');
    expect(t.texto()).toContain('ABARROTES SAN JUDAS');
    expect(t.texto()).not.toContain('ABARROTES LUPITA');
    expect(t.texto()).not.toContain('Se muestran los 2 más recientes'); // el aviso de tope es de la lista, no de la búsqueda
  });

  it('NEGATIVA: una letra no busca, y sin señal lo dice', async () => {
    const t = await montar(238);
    await t.escribir('s');
    expect(t.api.pendingDeliveriesPage).toHaveBeenCalledTimes(1); // sólo la carga inicial
    t.api.pendingDeliveriesPage.mockImplementation(() => throwError(() => ({ status: 0 })));
    await t.escribir('san');
    expect(t.texto()).toContain('Para buscar necesitas señal.');
  });
});
