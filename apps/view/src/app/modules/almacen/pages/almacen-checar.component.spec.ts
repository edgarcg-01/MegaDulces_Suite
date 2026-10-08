import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { ChecadoPedido, ChecadoRenglon } from '@megadulces/contracts';
import { AlmacenChecarComponent } from './almacen-checar.component';
import { PickingService } from '../../reparto/picking.service';
import { AuthService } from '../../../core/services/auth.service';
import * as etiquetas from '../checado-etiquetas';

/**
 * `[GP.4]` La pantalla del checador montada de verdad, con el servidor simulado. Se prueba por lo
 * que hace la persona: tomar, escanear (bien, ajeno, pide peso), deshacer, cerrar caja P (sale la
 * etiqueta por triplicado) y terminar.
 */
const R = (o: Partial<ChecadoRenglon> = {}): ChecadoRenglon => ({
  id: 'l1', sku: '06001', producto: 'CHOC SNICKERS /6', unidad: 'PZA', esperado: 384, checado: 0,
  unidad_mayor: 'CJA', factor_mayor: 192, esperado_mayor: 2, checado_mayor: 0, se_pesa: false, estado: 'pendiente', ...o,
});
const P = (o: Partial<ChecadoPedido> = {}): ChecadoPedido => ({
  id: 'chk-1', order_code: 'UD4001-0002781', destino: 'ABARROTES LUPITA', sucursal: '01', warehouse_id: 'w-01',
  started_at: new Date().toISOString(), renglones: [R()], cajas_p: [], ultimo_escaneo: null, ...o,
});

describe('AlmacenChecarComponent · la pantalla del checador (GP.4)', () => {
  let fix: ComponentFixture<AlmacenChecarComponent>;
  let c: AlmacenChecarComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let imprimir: ReturnType<typeof vi.spyOn>;

  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: string): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim().includes(t)) as HTMLButtonElement | undefined;
  const render = (): void => fix.detectChanges();

  async function montar(mio: ChecadoPedido | null = null): Promise<void> {
    try { localStorage.clear(); } catch { /* sin almacenamiento */ }
    api = {
      checadoAlmacenes: vi.fn(() => of([{ id: 'w-01', code: '01', nombre: 'Padre Hidalgo' }])),
      checadoMio: vi.fn(() => of(mio)),
      checadoSiguiente: vi.fn(() => of({ estado: 'asignado', ya_era_tuyo: false, pedido: P() })),
      checadoEscanear: vi.fn(() => of({ resultado: 'ok', mensaje: '+1 CJA · CHOC SNICKERS /6', producto: 'CHOC SNICKERS /6', pedido: P({ renglones: [R({ checado: 192, checado_mayor: 1, estado: 'falta' })], ultimo_escaneo: { id: 's1', producto: 'CHOC SNICKERS /6', unidad: 'CJA', cantidad: 1, kind: 'mayor' } }) })),
      checadoDeshacer: vi.fn(() => of(P())),
      checadoCerrarCaja: vi.fn(() => of({ etiqueta: { id: 'p1', numero: 1, order_code: 'UD4001-0002781', destino: 'ABARROTES LUPITA', articulos: 12, productos: 3 }, pedido: P() })),
      checadoTerminar: vi.fn(() => of({ order_code: 'UD4001-0002781', destino: 'ABARROTES LUPITA', diferencias: [], etiquetas_cj: [{ n: 1, total: 2, sku: '06001', producto: 'SNICKERS', unidad: 'CJA' }, { n: 2, total: 2, sku: '06001', producto: 'SNICKERS', unidad: 'CJA' }], etiqueta_p: null, cajas_p: 1 })),
    };
    imprimir = vi.spyOn(etiquetas, 'imprimirEtiquetas').mockImplementation(() => undefined);
    await TestBed.configureTestingModule({
      imports: [AlmacenChecarComponent],
      providers: [
        provideRouter([]),
        { provide: PickingService, useValue: api },
        { provide: AuthService, useValue: { user: () => ({ warehouse_code: '01' }) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenChecarComponent);
    c = fix.componentInstance;
    render();
  }

  afterEach(() => {
    imprimir?.mockRestore();
    fix?.destroy();
  });

  it('⭐ pide los almacenes con la clave del checado y elige el de la persona', async () => {
    await montar();
    expect(api['checadoAlmacenes']).toHaveBeenCalled();
    expect(c.almacenId()).toBe('w-01');
    expect(texto()).toContain('Almacén: 01 · Padre Hidalgo');
  });

  it('si ya traía un pedido lo retoma sin tocar nada', async () => {
    await montar(P());
    expect(c.fase()).toBe('checando');
    expect(texto()).toContain('Retomaste el pedido que traías.');
  });

  it('tomar manda almacén y origen; sin trabajo dice por qué', async () => {
    await montar();
    api['checadoSiguiente'].mockReturnValueOnce(of({ estado: 'sin_trabajo', motivo: 'Hay 2 pedidos surtidos esperando a que Facturación los pase a SURTIDO en Kepler.', esperando_facturacion: 2 }));
    c.elegirOrigen('TELEMARK');
    boton('Tomar siguiente')?.click();
    render();
    expect(api['checadoSiguiente']).toHaveBeenCalledWith('w-01', 'TELEMARK');
    expect(texto()).toContain('esperando a que Facturación los pase a SURTIDO');
  });

  it('⭐ escanear manda el código y la cantidad, muestra el aviso y limpia el campo', async () => {
    await montar(P());
    c.codigo.set('C06001');
    c.escanear();
    render();
    expect(api['checadoEscanear']).toHaveBeenCalledWith('chk-1', { code: 'C06001', cantidad: 1, peso_kg: undefined });
    expect(texto()).toContain('+1 CJA · CHOC SNICKERS /6');
    expect(c.codigo()).toBe('');
    expect(texto()).toContain('Último: 1 CJA');
  });

  it('un producto ajeno se avisa en rojo', async () => {
    await montar(P());
    api['checadoEscanear'].mockReturnValueOnce(of({ resultado: 'ajeno', mensaje: 'MAZAPAN no va en este pedido. Sepáralo.', producto: 'MAZAPAN', pedido: P() }));
    c.codigo.set('C99999');
    c.escanear();
    render();
    expect(el().querySelector('.ck-aviso.ck-bad')?.textContent).toContain('no va en este pedido');
  });

  it('⭐ por kilo pide el peso y lo manda con el mismo código', async () => {
    await montar(P());
    api['checadoEscanear'].mockReturnValueOnce(of({ resultado: 'pide_peso', mensaje: 'Pesa ALTOS y escribe los kilos.', producto: 'ALTOS', pedido: P() }));
    c.codigo.set('17083');
    c.escanear();
    render();
    expect(c.pidePeso()).toBe('17083');
    expect(texto()).toContain('Peso en la báscula (kg)');
    c.peso.set(6.14);
    c.escanear();
    expect(api['checadoEscanear']).toHaveBeenLastCalledWith('chk-1', { code: '17083', cantidad: 1, peso_kg: 6.14 });
  });

  it('⭐ cerrar la caja P imprime su etiqueta por TRIPLICADO (la fila de 3 del rollo)', async () => {
    await montar(P({ cajas_p: [{ id: 'p1', numero: 1, status: 'abierta', contenido: [{ sku: '06001', producto: 'SNICKERS', unidad: 'PAQ', cantidad: 12 }] }] }));
    expect(texto()).toContain('Caja P1 abierta · 12 artículos');
    boton('Cerrar caja P1')?.click();
    render();
    expect(imprimir).toHaveBeenCalledTimes(1);
    const [lista] = imprimir.mock.calls[0];
    expect(lista).toHaveLength(3);
    expect(lista[0]).toMatchObject({ grande: 'P1', pedido: 'UD4001-0002781', codigo: '0002781P1' });
  });

  it('terminar con pendientes avisa que sale incompleto; luego imprime las cajas 1/N', async () => {
    await montar(P());
    boton('Terminar checado')?.click();
    render();
    expect(texto()).toContain('1 producto no cuadra');
    boton('Sí, terminar')?.click();
    render();
    expect(c.fase()).toBe('terminado');
    boton('Imprimir etiquetas de cajas (2)')?.click();
    const [lista] = imprimir.mock.calls.at(-1) ?? [[]];
    expect(lista.map((e: { grande: string }) => e.grande)).toEqual(['1/2', '2/2']);
  });

  it('un error al escanear se dice y no se pierde el pedido', async () => {
    await montar(P());
    api['checadoEscanear'].mockReturnValueOnce(throwError(() => ({ error: { message: 'Este pedido lo está checando otra persona.' } })));
    c.codigo.set('X');
    c.escanear();
    render();
    expect(texto()).toContain('Este pedido lo está checando otra persona.');
    expect(c.pedido()).not.toBeNull();
  });
});
