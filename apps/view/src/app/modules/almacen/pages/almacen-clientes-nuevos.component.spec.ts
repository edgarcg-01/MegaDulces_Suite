import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { KeplerCustomerLookup, NewCustomerRow, NewCustomersInboxResponse } from '@megadulces/contracts';
import { AlmacenClientesNuevosComponent } from './almacen-clientes-nuevos.component';
import { ClientesNuevosService } from '../clientes-nuevos.service';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * `[MCP.3.8]` La bandeja «Clientes nuevos por dar de alta en Kepler», montada con el servidor
 * simulado. Lo que importa: se ve quién lo dio de alta y sus pedidos; la clave se confirma con el
 * nombre de Kepler ANTES de ligar; lo que no existe o ya está ligado se dice y no deja ligar.
 */
const CLI = (c: Partial<NewCustomerRow> = {}): NewCustomerRow => ({
  id: 'c-lupita', name: 'Abarrotes Lupita', phone: '3521112233', address: 'frente a la iglesia', sales_route: 'R-02',
  warehouse_id: 'wh-02', warehouse_name: 'La Piedad Abastos', branch: '02', created_at: '2026-10-20T15:00:00.000Z',
  created_by_name: 'Ana López',
  orders: [{ order_id: 'o1', code: 'PD-2026-00100', status: 'confirmed', total: 1219.26, requested_delivery_date: '2026-10-21' }],
  ...c,
});
const BANDEJA = (data: NewCustomerRow[] = [CLI()]): NewCustomersInboxResponse => ({ scope: 'propios', data, truncated: false });
const LOOKUP = (r: Partial<KeplerCustomerLookup> = {}): KeplerCustomerLookup => ({
  branch: '02', code: '10281', found: true, name: 'ABARROTES LUPITA SA DE CV', address: 'HIDALGO 12, LA PIEDAD',
  internal: false, linked_to: null, ...r,
});

describe('AlmacenClientesNuevosComponent · ligar clientes nuevos con Kepler (MCP.3.8)', () => {
  let fix: ComponentFixture<AlmacenClientesNuevosComponent>;
  let api: Record<'bandeja' | 'resumen' | 'buscarClave' | 'ligar', ReturnType<typeof vi.fn>>;
  let gestiona: boolean;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: string): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').includes(t)) as
      | HTMLButtonElement
      | undefined;
  const teclear = (v: string): void => {
    const i = el().querySelector('.cn-clave') as HTMLInputElement;
    i.value = v;
    i.dispatchEvent(new Event('input'));
    fix.detectChanges();
  };
  const buscar = async (): Promise<void> => {
    boton('Buscar')!.click();
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  };

  async function montar(bandeja: NewCustomersInboxResponse | Error = BANDEJA()): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [AlmacenClientesNuevosComponent],
      providers: [
        provideRouter([]),
        { provide: ClientesNuevosService, useValue: api },
        { provide: PermissionsService, useValue: { has: () => gestiona } },
      ],
    }).compileComponents();
    api['bandeja'].mockReturnValue(bandeja instanceof Error ? throwError(() => ({ error: { message: bandeja.message } })) : of(bandeja));
    fix = TestBed.createComponent(AlmacenClientesNuevosComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  beforeEach(() => {
    gestiona = true;
    api = {
      bandeja: vi.fn(),
      resumen: vi.fn(),
      buscarClave: vi.fn(() => of(LOOKUP())),
      ligar: vi.fn(() => of({
        id: 'c-lupita', name: 'ABARROTES LUPITA SA DE CV', previous_name: 'Abarrotes Lupita', code: 'K02-10281',
        branch: '02', erp_customer_code: '10281', pending_orders: 1,
      })),
    };
  });
  afterEach(() => TestBed.resetTestingModule());

  it('muestra cada cliente con quién lo dio de alta y sus pedidos pendientes', async () => {
    await montar();
    expect(texto()).toContain('Abarrotes Lupita');
    expect(texto()).toContain('Ana López');
    expect(texto()).toContain('PD-2026-00100');
    expect(texto()).toContain('$1,219.26');
    expect(texto()).toContain('1 pedido esperando');
    expect(texto()).toContain('Clave que le diste en Kepler');
  });

  it('⭐ la clave se busca en Kepler y se muestra el nombre de allá antes de ligar', async () => {
    await montar();
    expect(boton('Ligar con Kepler')!.disabled).toBe(true); // sin buscar, no se liga
    teclear(' 10281 ');
    await buscar();
    expect(api['buscarClave']).toHaveBeenCalledWith('c-lupita', '10281');
    expect(texto()).toContain('En Kepler: ABARROTES LUPITA SA DE CV');
    expect(boton('Ligar con Kepler')!.disabled).toBe(false);
    boton('Ligar con Kepler')!.click();
    fix.detectChanges();
    expect(api['ligar']).toHaveBeenCalledWith('c-lupita', '10281');
    // Ligado: sale de la bandeja.
    expect(texto()).not.toContain('Abarrotes Lupita PD-2026');
    expect(texto()).toContain('No hay clientes nuevos por ligar');
  });

  it('clave que no existe: lo dice con la sucursal y no deja ligar', async () => {
    api['buscarClave'].mockReturnValue(of(LOOKUP({ found: false, name: null, address: null, code: '99999' })));
    await montar();
    teclear('99999');
    await buscar();
    expect(texto()).toContain('No existe la clave 99999 en Kepler de la sucursal 02');
    expect(boton('Ligar con Kepler')!.disabled).toBe(true);
  });

  it('clave ya ligada a otro cliente: avisa del duplicado y no deja ligar', async () => {
    api['buscarClave'].mockReturnValue(of(LOOKUP({ linked_to: { id: 'otro', name: 'LUPITA (K02-10281)' } })));
    await montar();
    teclear('10281');
    await buscar();
    expect(texto()).toContain('ya está ligada a otro cliente');
    expect(texto()).toContain('LUPITA (K02-10281)');
    expect(boton('Ligar con Kepler')!.disabled).toBe(true);
  });

  it('cambiar la clave después de buscar vuelve a pedir la búsqueda (no liga con un resultado viejo)', async () => {
    await montar();
    teclear('10281');
    await buscar();
    expect(boton('Ligar con Kepler')!.disabled).toBe(false);
    teclear('10282');
    expect(boton('Ligar con Kepler')!.disabled).toBe(true);
    expect(el().querySelector('.cn-res')).toBeNull(); // el resultado viejo ya no se pinta
  });

  it('sin permiso de gestionar el surtido, ve la bandeja pero no el botón de ligar', async () => {
    gestiona = false;
    await montar();
    expect(boton('Ligar con Kepler')).toBeUndefined();
    expect(texto()).toContain('hace falta el permiso');
  });

  it('cliente sin sucursal conocida: lo declara y no ofrece la clave', async () => {
    await montar(BANDEJA([CLI({ branch: null, warehouse_id: null, warehouse_name: null, orders: [] })]));
    expect(texto()).toContain('No se sabe de qué sucursal es');
    expect(el().querySelector('.cn-clave')).toBeNull();
  });

  it('si el servidor rechaza la liga, lo dice y el cliente sigue en la lista', async () => {
    api['ligar'].mockReturnValue(throwError(() => ({ error: { message: 'La clave 10281 ya está ligada a otro cliente.' } })));
    await montar();
    teclear('10281');
    await buscar();
    boton('Ligar con Kepler')!.click();
    fix.detectChanges();
    expect(texto()).toContain('Abarrotes Lupita');
  });

  it('error ≠ vacío: una falla al cargar no se pinta como «no hay clientes»', async () => {
    await montar(new Error('Se cayó la red'));
    expect(texto()).toContain('Se cayó la red');
    expect(texto()).not.toContain('No hay clientes nuevos por ligar');
  });

  it('vacío de verdad: lo dice', async () => {
    await montar(BANDEJA([]));
    expect(texto()).toContain('No hay clientes nuevos por ligar');
  });
});
