import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { CapturaKeplerPedido, CapturaKeplerResponse } from '@megadulces/contracts';
import { AlmacenPorCapturarComponent } from './almacen-por-capturar.component';
import { PickingService } from '../../reparto/picking.service';

/**
 * `[GP.3d]` La bandeja de Facturación montada de verdad. Se prueba por lo que LEE la persona: qué
 * pedido va primero, qué le dice que haga y qué cantidad debe dejar en Kepler.
 */
const P = (o: Partial<CapturaKeplerPedido> = {}): CapturaKeplerPedido => ({
  order_id: 'o-1',
  sucursal: '01',
  code: 'UD4001-0002781',
  serie: 1,
  folio: '0002781',
  origen: 'TELEMARK',
  destino: 'ABARROTES LUPITA',
  wave_code: 'W-2026-00001',
  surtido_at: new Date(Date.now() - 20 * 60000).toISOString(),
  surtidores: ['Juan Pérez'],
  estado: 'por_avanzar',
  estatus_kepler: 'AUTORIZADO',
  renglones: 8,
  pendientes: [],
  ...o,
});

const FALTANTE = {
  sku: '70034', producto: 'CHOC RANITA CROA', unidad: 'BTO', pedido: 3, surtido: 2, falta: 1,
  kepler: 3, cuadra: false, renglones_kepler: 1, extra: false,
};

const R = (o: Partial<CapturaKeplerResponse> = {}): CapturaKeplerResponse => ({
  generado_en: new Date().toISOString(),
  kepler_al: new Date(Date.now() - 3 * 60000).toISOString(),
  dias: 30,
  sucursales: ['01'],
  sin_alcance: false,
  pedidos: [
    P({ order_id: 'o-av', code: 'UD4001-0000001' }),
    P({ order_id: 'o-cap', code: 'UD4001-0000002', estado: 'por_capturar', pendientes: [FALTANTE] }),
    P({ order_id: 'o-dif', code: 'UD4001-0000003', estado: 'con_diferencias', estatus_kepler: 'SURTIDO', pendientes: [{ ...FALTANTE, falta: 1, kepler: 3, cuadra: false }] }),
    P({ order_id: 'o-ok', code: 'UD4001-0000004', estado: 'capturado', estatus_kepler: 'SURTIDO' }),
  ],
  capturados_antes: 5,
  sin_congelado: 0,
  ...o,
});

describe('AlmacenPorCapturarComponent · la entrega a Facturación (GP.3d)', () => {
  let fix: ComponentFixture<AlmacenPorCapturarComponent>;
  let c: AlmacenPorCapturarComponent;
  let api: { porCapturar: ReturnType<typeof vi.fn> };

  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const codigos = (): string[] => Array.from(el().querySelectorAll('.gp-code')).map((n) => n.textContent?.trim() ?? '');
  const boton = (t: string, dentro: ParentNode = el()): HTMLButtonElement | undefined =>
    Array.from(dentro.querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === t) as HTMLButtonElement | undefined;
  const fila = (code: string): HTMLTableRowElement =>
    Array.from(el().querySelectorAll('tr')).find((r) => r.textContent?.includes(code)) as HTMLTableRowElement;

  async function montar(resp: CapturaKeplerResponse = R()): Promise<void> {
    api = { porCapturar: vi.fn(() => of(resp)) };
    await TestBed.configureTestingModule({
      imports: [AlmacenPorCapturarComponent],
      providers: [{ provide: PickingService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenPorCapturarComponent);
    c = fix.componentInstance;
    fix.detectChanges();
  }

  afterEach(() => fix?.destroy());

  it('⭐ primero lo que hay que corregir, luego lo que no cuadra, luego lo que sólo se avanza; lo capturado no está en pendientes', async () => {
    await montar();
    expect(codigos()).toEqual(['UD4001-0000002', 'UD4001-0000003', 'UD4001-0000001']);
    expect(texto()).toContain('Corregir 1 renglón y pasar a SURTIDO');
    expect(texto()).toContain('Revisar: 1 renglón no cuadra');
    expect(texto()).toContain('Pasar a SURTIDO');
    expect(texto()).toContain('5 pedidos surtidos en días anteriores ya están en Kepler');
    expect(texto()).toContain('Se revisan los surtidos de los últimos 30 días.');
  });

  it('⭐ el detalle dice qué cantidad dejar en Kepler, en la unidad de Kepler', async () => {
    await montar();
    boton('Ver qué tocar', fila('UD4001-0000002'))?.click();
    fix.detectChanges();
    const t = texto();
    expect(t).toContain('deja estos renglones de UD4001-0000002 como se surtieron y pasa el pedido a SURTIDO');
    expect(t).toContain('CHOC RANITA CROA');
    expect(t).toContain('Dejar en Kepler');
    expect(t).toContain('2 BTO');
  });

  it('con diferencias muestra lo que Kepler trae HOY en la misma unidad, y lo que debe quedar', async () => {
    await montar();
    boton('Ver qué tocar', fila('UD4001-0000003'))?.click();
    fix.detectChanges();
    const t = texto();
    expect(t).toContain('Kepler ya tiene UD4001-0000003 en SURTIDO');
    expect(t).toContain('Kepler trae');
    expect(t).toContain('3 BTO');
    expect(el().querySelector('.gp-sub-table .gp-bad')?.textContent).toContain('3 BTO');
  });

  it('⭐ un renglón que Kepler trae y la Suite no surtió se marca para quitar', async () => {
    await montar(R({ pedidos: [P({ order_id: 'o-x', estado: 'por_capturar', pendientes: [{ ...FALTANTE, sku: '06001', producto: 'MAZAPAN', pedido: 0, surtido: 0, falta: 0, kepler: 2, unidad: 'CJA', extra: true }] })] }));
    boton('Ver qué tocar')?.click();
    fix.detectChanges();
    expect(texto()).toContain('La Suite no lo surtió');
    expect(texto()).toContain('Quitar el renglón');
  });

  it('la clave en varios renglones de Kepler avisa que el TOTAL debe quedar así', async () => {
    await montar(R({ pedidos: [P({ order_id: 'o-n', estado: 'por_capturar', pendientes: [{ ...FALTANTE, renglones_kepler: 2 }] })] }));
    boton('Ver qué tocar')?.click();
    fix.detectChanges();
    expect(texto()).toContain('Viene en 2 renglones: el total debe quedar así');
  });

  it('⭐ un refresco de fondo fallido no se calla: dice desde cuándo no se actualiza', async () => {
    await montar();
    api.porCapturar.mockReturnValueOnce(throwError(() => new Error('red')));
    c.reload(true);
    fix.detectChanges();
    expect(texto()).toContain('No se pudo actualizar desde las');
    expect(codigos()).toHaveLength(3);
  });

  it('en un pedido ya en Kepler el botón dice Ver detalle, no Ver qué tocar', async () => {
    await montar();
    c.pick('capturado');
    fix.detectChanges();
    expect(boton('Ver detalle')).toBeDefined();
    expect(boton('Ver qué tocar')).toBeUndefined();
  });

  it('las tarjetas filtran y la segunda vez regresan a pendientes', async () => {
    await montar();
    expect(c.cuenta('capturado')).toBe(1);
    c.pick('capturado');
    fix.detectChanges();
    expect(codigos()).toEqual(['UD4001-0000004']);
    expect(texto()).toContain('Listo');
    expect(texto()).toContain('Surtidos hoy, ya en Kepler');
    c.pick('capturado');
    fix.detectChanges();
    expect(codigos()).toHaveLength(3);
  });

  it('prueba negativa: sin sucursal asignada lo dice y no pinta una lista vacía como "todo al día"', async () => {
    await montar(R({ sin_alcance: true, sucursales: [], pedidos: [] }));
    expect(texto()).toContain('Tu ficha no tiene una sucursal asignada');
    expect(texto()).not.toContain('No hay surtidos pendientes');
  });

  it('sin pendientes lo dice', async () => {
    await montar(R({ pedidos: [P({ estado: 'capturado', estatus_kepler: 'SURTIDO' })] }));
    expect(texto()).toContain('No hay surtidos pendientes de capturar en Kepler.');
  });

  it('un renglón con surtido 0 se indica como quitar el renglón', async () => {
    await montar(R({ pedidos: [P({ order_id: 'o-z', estado: 'por_capturar', pendientes: [{ ...FALTANTE, surtido: 0, falta: 3 }] })] }));
    boton('Ver qué tocar')?.click();
    fix.detectChanges();
    expect(texto()).toContain('Quitar el renglón');
  });

  it('si falla la carga lo dice y deja reintentar', async () => {
    api = { porCapturar: vi.fn(() => throwError(() => new Error('red'))) };
    await TestBed.configureTestingModule({
      imports: [AlmacenPorCapturarComponent],
      providers: [{ provide: PickingService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenPorCapturarComponent);
    fix.detectChanges();
    expect(texto()).toContain('No se pudo leer la lista');
    expect(boton('Reintentar')).toBeDefined();
  });

  it('dice de cuándo es Kepler', async () => {
    await montar();
    expect(texto()).toContain('Kepler (todas las sucursales) leído hace 3 min');
  });
});
