import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';
import type { WarehouseOrdersResponse } from '@megadulces/contracts';
import { AlmacenPedidosComponent } from './almacen-pedidos.component';
import { AlmacenPedidosService } from '../almacen-pedidos.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[GP.3]` La puerta a Surtir desde el tablero. `/almacen/surtir` es pantalla de FOCO: su entrada
 * en `almacen-tabs` sólo decide a dónde cae quien abre el área, no pinta ningún botón. Quien ve el
 * tablero y además surte se quedaba sin cómo llegar (lo encontró Francisco en prod, 2026-10-08).
 */
describe('AlmacenPedidosComponent · botón Surtir (GP.3)', () => {
  async function montar(permisos: Record<string, boolean>, rol = 'almacenista'): Promise<HTMLElement> {
    const perms = new PermissionsService();
    perms.load(permisos, rol);
    await TestBed.configureTestingModule({
      imports: [AlmacenPedidosComponent],
      providers: [
        provideRouter([]),
        { provide: AlmacenPedidosService, useValue: { list: () => NEVER, detail: () => NEVER } },
        { provide: PermissionsService, useValue: perms },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(AlmacenPedidosComponent);
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  }

  const surtir = (el: HTMLElement): HTMLAnchorElement | undefined =>
    Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.trim() === 'Surtir') as HTMLAnchorElement | undefined;

  it('⭐ quien ve el tablero y surte tiene el botón, y lleva a /almacen/surtir', async () => {
    const el = await montar({ [Permission.ALMACEN_PEDIDOS_VER]: true, [Permission.COMMERCIAL_PICKING_GESTIONAR]: true });
    const a = surtir(el);
    expect(a).toBeDefined();
    expect(a?.getAttribute('href')).toBe('/almacen/surtir');
  });

  it('prueba negativa: quien sólo ve el tablero no lo tiene (tomar trabajo escribe)', async () => {
    const el = await montar({ [Permission.ALMACEN_PEDIDOS_VER]: true, [Permission.COMMERCIAL_PICKING_VER]: true });
    expect(surtir(el)).toBeUndefined();
  });

  it('un rol de plataforma lo tiene', async () => {
    const el = await montar({}, 'superadmin');
    expect(surtir(el)).toBeDefined();
  });
});

/**
 * `[MCP.3.2]` El surtidor ve el tablero reducido a la lista: sólo Pedido y Cliente / destino, de lo
 * autorizado por surtir. Lo pidió David (2026-10-19) quitando a mano cada pieza del tablero.
 */
describe('AlmacenPedidosComponent · vista del surtidor (MCP.3.2)', () => {
  const RESP = (): WarehouseOrdersResponse => ({
    periodo: { from: '2026-09-19', to: '2026-10-19' },
    alcance: { todas: false, sucursales: [{ codigo: '02', nombre: 'La Piedad Abastos' }] },
    filtros: { estatus: ['AUTORIZADO'], origen: null, sucursal: null, q: null },
    conteos: [{ estatus: 'AUTORIZADO', pedidos: 1, renglones: 3, mas_antiguo_horas: 2 }],
    totales: { pedidos: 1, renglones: 3, importe: null },
    items: [{
      clave: '02-1-0000900', sucursal: '02', sucursal_nombre: 'La Piedad Abastos', serie: 1, folio: '0000900',
      documento: 'UD4001-0000900', fecha: '2026-10-19', hora: '10:00', origen: 'TELEMARK', estatus: 'AUTORIZADO',
      cliente_code: 'C001', destino_nombre: 'SUCURSAL ZAMORA CANINDO', destino_ciudad: 'ZAMORA', vendedor_code: null,
      vendedor_nombre: null, renglones: 3, volumen: [], importe: null, guia: null, transporte: null, chofer: null,
      resp_surtido: null, resp_checado: null, resp_embarque: null, horas_abierto: 2,
    }],
    truncado: false,
    generado_en: '2026-10-19T16:53:00.000Z',
  });

  async function montar(permisos: Record<string, boolean>) {
    const perms = new PermissionsService();
    perms.load(permisos, 'surtidor');
    const list = vi.fn(() => of(RESP()));
    await TestBed.configureTestingModule({
      imports: [AlmacenPedidosComponent],
      providers: [
        provideRouter([]),
        { provide: AlmacenPedidosService, useValue: { list, detail: vi.fn(() => NEVER) } },
        { provide: PermissionsService, useValue: perms },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(AlmacenPedidosComponent);
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    const texto = (): string => el.textContent?.replace(/\s+/g, ' ') ?? '';
    const columnas = (): string[] => Array.from(el.querySelectorAll('th')).map((t) => t.textContent?.trim() ?? '');
    return { fix, el, list, texto, columnas };
  }
  const SURTIDOR = { [Permission.COMMERCIAL_PICKING_GESTIONAR]: true, [Permission.COMMERCIAL_PICKING_VER]: true };

  it('⭐ el surtidor ve sólo Pedido y Cliente / destino', async () => {
    const { columnas, texto } = await montar(SURTIDOR);
    expect(columnas()).toEqual(['Pedido', 'Cliente / destino']);
    expect(texto()).toContain('UD4001-0000900');
    expect(texto()).toContain('SUCURSAL ZAMORA CANINDO');
    expect(texto()).toContain('Pedidos por surtir');
  });

  it('⭐ sin estatus, periodos, rango, filtros, Surtir/Checar ni totales', async () => {
    const { el, texto } = await montar(SURTIDOR);
    expect(el.querySelector('.gp-chips')).toBeNull();
    expect(el.querySelector('.gp-actions')).toBeNull();
    expect(el.querySelector('.gp-filters')).toBeNull();
    expect(el.querySelector('.gp-foot')).toBeNull();
    expect(el.querySelector('p-datepicker')).toBeNull();
    for (const t of ['Mes en curso', 'Sólo autorizados', 'Todos los orígenes', 'Kepler leído', 'renglones', 'Importe', 'Estatus', 'Guía']) {
      expect(texto()).not.toContain(t);
    }
  });

  it('pide lo AUTORIZADO de los últimos 30 días, sin filtros del tablero', async () => {
    const { list } = await montar(SURTIDOR);
    const f = (list.mock.calls[0] as unknown as [{ estatus: string[]; from: string; to: string; month?: string }])[0];
    expect(f.estatus).toEqual(['AUTORIZADO']);
    expect(f.month).toBeUndefined();
    const dias = (new Date(f.to).getTime() - new Date(f.from).getTime()) / 86400000;
    expect(dias).toBe(30);
  });

  it('tocar un renglón no abre el detalle (es del tablero; el surtidor no tiene esa clave)', async () => {
    const { fix } = await montar(SURTIDOR);
    const c = fix.componentInstance;
    c.pick(RESP().items[0]);
    expect(c.sel()).toBeNull();
  });

  it('prueba negativa: quien SÍ ve el tablero lo sigue viendo completo', async () => {
    const { el, columnas } = await montar({ [Permission.ALMACEN_PEDIDOS_VER]: true });
    expect(columnas()).toContain('Importe');
    expect(columnas()).toContain('Estatus');
    expect(el.querySelector('.gp-chips')).not.toBeNull();
    expect(el.querySelector('.gp-foot')).not.toBeNull();
  });
});
