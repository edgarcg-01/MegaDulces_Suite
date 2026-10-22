import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { SimilarCustomer } from '@megadulces/contracts';
import { VendorCustomersComponent } from './vendor-customers.component';
import { VendorService } from '../vendor.service';
import { OfflineSyncService } from '../../../core/services/offline-sync.service';
import { AuthService } from '../../../core/services/auth.service';

/**
 * `[MCP.3.8]` Alta de cliente nuevo en la app del vendedor: datos mínimos y, antes de crear,
 * «¿Es este?» con los clientes de su sucursal de nombre parecido (para frenar duplicados).
 */
const PARECIDO = (p: Partial<SimilarCustomer> = {}): SimilarCustomer => ({
  id: 'c-existe', name: 'Tienda Lupita', address: 'Hidalgo 3', phone: '3521112233', sales_route: 'R-02',
  kepler: false, score: 1, ...p,
});

describe('VendorCustomersComponent · alta de cliente nuevo (MCP.3.8)', () => {
  let fix: ComponentFixture<VendorCustomersComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let router: Router;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: string): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').includes(t)) as
      | HTMLButtonElement
      | undefined;
  const escribir = (name: string, v: string): void => {
    const i = el().querySelector(`input[name="${name}"]`) as HTMLInputElement;
    i.value = v;
    i.dispatchEvent(new Event('input'));
    fix.detectChanges();
  };
  const crearYTomar = async (): Promise<void> => {
    (el().querySelector('form.new-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  };

  async function montar(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [VendorCustomersComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ new: '1' }) } } },
        { provide: VendorService, useValue: api },
        { provide: OfflineSyncService, useValue: { guardarClienteOffline: vi.fn(async () => undefined) } },
        { provide: AuthService, useValue: { user: () => ({ sub: 'yo' }) } },
      ],
    }).compileComponents();
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fix = TestBed.createComponent(VendorCustomersComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  beforeEach(() => {
    api = {
      listCustomers: vi.fn(() => of({ data: [], total: 0 })),
      myRoutes: vi.fn(() => of(['R-02'])),
      similarCustomers: vi.fn(() => of({ scope: 'sucursal', warehouse_name: 'La Piedad Abastos', matches: [] })),
      createCustomer: vi.fn(() => of({ id: 'c-nuevo', code: 'V-ABC123', name: 'Abarrotes Lupita', credit_limit: 0, active: true })),
      getCustomer: vi.fn(() => of({ id: 'c-existe', code: 'K02-1', name: 'Tienda Lupita', credit_limit: 0, active: true })),
      setCustomerLocation: vi.fn(() => of({})),
    };
  });
  afterEach(() => TestBed.resetTestingModule());

  it('pide los datos mínimos: nombre, teléfono y dirección (sin RFC ni texto de relleno)', async () => {
    await montar();
    expect(texto()).toContain('Alta de cliente nuevo');
    expect(el().querySelector('input[name="name"]')).not.toBeNull();
    expect(el().querySelector('input[name="phone"]')).not.toBeNull();
    expect(el().querySelector('input[name="notes"]')).not.toBeNull();
    expect(el().querySelector('input[name="rfc"]')).toBeNull();
    expect(texto()).not.toContain('Puedes levantarle pedido de inmediato');
  });

  it('sin parecidos: crea y abre el pedido de inmediato', async () => {
    await montar();
    escribir('name', 'Abarrotes Lupita');
    escribir('phone', '3521112233');
    await crearYTomar();
    expect(api['similarCustomers']).toHaveBeenCalledWith('Abarrotes Lupita');
    expect(api['createCustomer']).toHaveBeenCalledWith(expect.objectContaining({ name: 'Abarrotes Lupita', phone: '3521112233' }));
    expect(api['createCustomer'].mock.calls[0][0]).not.toHaveProperty('rfc');
    expect(router.navigate).toHaveBeenCalledWith(['/vendor/take-order', 'c-nuevo']);
  });

  it('⭐ con parecidos: pregunta «¿Es este?» y NO crea hasta que el vendedor elija', async () => {
    api['similarCustomers'].mockReturnValue(of({ scope: 'sucursal', warehouse_name: 'X', matches: [PARECIDO()] }));
    await montar();
    escribir('name', 'Abarrotes Lupita');
    await crearYTomar();
    expect(texto()).toContain('¿Es este?');
    expect(texto()).toContain('Tienda Lupita');
    expect(texto()).toContain('Hidalgo 3');
    expect(api['createCustomer']).not.toHaveBeenCalled();
  });

  it('«Es este»: no crea un duplicado y le levanta el pedido al que ya existía', async () => {
    api['similarCustomers'].mockReturnValue(of({ scope: 'sucursal', warehouse_name: 'X', matches: [PARECIDO()] }));
    await montar();
    escribir('name', 'Abarrotes Lupita');
    await crearYTomar();
    boton('Es este')!.click();
    fix.detectChanges();
    expect(api['createCustomer']).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/vendor/take-order', 'c-existe']);
  });

  it('«No, es otro»: lo da de alta sin volver a preguntar', async () => {
    api['similarCustomers'].mockReturnValue(of({ scope: 'sucursal', warehouse_name: 'X', matches: [PARECIDO()] }));
    await montar();
    escribir('name', 'Abarrotes Lupita');
    await crearYTomar();
    boton('No, es otro')!.click();
    fix.detectChanges();
    expect(api['createCustomer']).toHaveBeenCalledTimes(1);
    expect(api['similarCustomers']).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/vendor/take-order', 'c-nuevo']);
  });

  it('cambiar el nombre quita los parecidos del nombre anterior', async () => {
    api['similarCustomers'].mockReturnValue(of({ scope: 'sucursal', warehouse_name: 'X', matches: [PARECIDO()] }));
    await montar();
    escribir('name', 'Abarrotes Lupita');
    await crearYTomar();
    expect(texto()).toContain('¿Es este?');
    escribir('name', 'Cremería Don Beto');
    expect(texto()).not.toContain('¿Es este?');
  });

  it('si la revisión de parecidos falla, no frena el alta en campo', async () => {
    api['similarCustomers'].mockReturnValue(throwError(() => ({ status: 500 })));
    await montar();
    escribir('name', 'Abarrotes Lupita');
    await crearYTomar();
    expect(api['createCustomer']).toHaveBeenCalledTimes(1);
  });

  it('en una ruta de Kepler el servidor rechaza el alta y se muestra su motivo', async () => {
    api['createCustomer'].mockReturnValue(throwError(() => ({
      status: 400,
      error: { message: 'Los clientes de esta ruta vienen de Kepler: dalo de alta en Kepler y aparecerá solo en tu ruta.' },
    })));
    await montar();
    escribir('name', 'Abarrotes Lupita');
    await crearYTomar();
    expect(texto()).toContain('Los clientes de esta ruta vienen de Kepler');
  });
});
