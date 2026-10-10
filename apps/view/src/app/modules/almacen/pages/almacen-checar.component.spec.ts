import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import type { ChecadoEscaneoResponse, ChecadoPedido, ChecadoRenglon } from '@megadulces/contracts';
import { AlmacenChecarComponent, cerradasTexto } from './almacen-checar.component';
import { PickingService } from '../../reparto/picking.service';
import { AuthService } from '../../../core/services/auth.service';
import * as etiquetas from '../checado-etiquetas';

/**
 * `[GP.4]` La pantalla del checador montada de verdad, con el servidor simulado. Se prueba por lo
 * que hace la persona: tomar, rastrillar (incluido el doble escaneo rápido), cajas sin etiqueta,
 * peso, cerrar caja P (etiqueta por triplicado), terminar (etiquetas 1/N solas), soltar, reimprimir.
 */
const R = (o: Partial<ChecadoRenglon> = {}): ChecadoRenglon => ({
  id: 'l1', sku: '06001', producto: 'CHOC SNICKERS /6', unidad: 'PZA', esperado: 384, checado: 0,
  unidad_mayor: 'CJA', factor_mayor: 192, esperado_mayor: 2, checado_mayor: 0, checado_sueltas: 0, se_pesa: false, estado: 'pendiente',
  unidad_pedida: 'CJA', factor_pedida: 192, pedido_texto: '2 CJA', llevas_texto: '0 CJA', diferencia_texto: null, ...o,
});
const P = (o: Partial<ChecadoPedido> = {}): ChecadoPedido => ({
  id: 'chk-1', order_code: 'UD4001-0002781', destino: 'ABARROTES LUPITA', sucursal: '01', warehouse_id: 'w-01',
  started_at: new Date().toISOString(), renglones: [R()], cajas_p: [], ultimo_escaneo: null, ...o,
});
const OK = (o: Partial<ChecadoEscaneoResponse> = {}): ChecadoEscaneoResponse => ({
  resultado: 'ok', mensaje: '+1 CJA · CHOC SNICKERS /6', producto: 'CHOC SNICKERS /6',
  pedido: P({
    renglones: [R({ checado: 192, checado_mayor: 1, estado: 'falta', llevas_texto: '1 CJA', diferencia_texto: 'Faltan 1 CJA' })],
    ultimo_escaneo: { id: 's1', producto: 'CHOC SNICKERS /6', unidad: 'CJA', cantidad: 1, kind: 'mayor', deshacible: true },
  }),
  ...o,
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
  const escanea = (code: string): void => {
    c.codigo.set(code);
    c.enviar();
    render();
  };

  async function montar(mio: ChecadoPedido | null = null, prefs: Record<string, string> = {}): Promise<void> {
    try {
      localStorage.clear();
      for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v);
    } catch { /* sin almacenamiento */ }
    api = {
      checadoAlmacenes: vi.fn(() => of([{ id: 'w-01', code: '01', nombre: 'Padre Hidalgo' }])),
      checadoMio: vi.fn(() => of(mio)),
      checadoSiguiente: vi.fn(() => of({ estado: 'asignado', ya_era_tuyo: false, pedido: P() })),
      checadoEscanear: vi.fn(() => of(OK())),
      checadoDeshacer: vi.fn(() => of(P())),
      checadoCerrarCaja: vi.fn(() => of({ etiqueta: { id: 'p1', numero: 1, order_code: 'UD4001-0002781', destino: 'ABARROTES LUPITA', articulos: 12, productos: 3 }, pedido: P() })),
      checadoTerminar: vi.fn(() => of({ order_code: 'UD4001-0002781', destino: 'ABARROTES LUPITA', diferencias: [], etiquetas_cj: [{ n: 1, total: 2, sku: '06001', producto: 'SNICKERS', unidad: 'CJA' }, { n: 2, total: 2, sku: '06001', producto: 'SNICKERS', unidad: 'CJA' }], etiqueta_p: null, cajas_p: 1 })),
      checadoSoltar: vi.fn(() => of({ id: 'chk-1', soltado: true })),
      checadoEtiquetas: vi.fn(() => of({ order_code: 'UD4001-0002781', destino: 'X', etiquetas_cj: [{ n: 1, total: 1, sku: '06001', producto: 'SNICKERS', unidad: 'CJA' }], cajas_p: [{ id: 'p1', numero: 1, order_code: 'UD4001-0002781', destino: 'X', articulos: 4, productos: 1 }] })),
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
    expect(texto()).toContain('Pedido: 2 CJA');
  });

  it('sin trabajo lo dice con su porqué', async () => {
    await montar();
    api['checadoSiguiente'].mockReturnValueOnce(of({ estado: 'sin_trabajo', motivo: '2 pedidos surtidos esperan a que Facturación los pase a SURTIDO en Kepler.', esperando_facturacion: 2, checados_fuera: 0 }));
    c.elegirOrigen('TELEMARK');
    boton('Tomar siguiente')?.click();
    render();
    expect(api['checadoSiguiente']).toHaveBeenCalledWith('w-01', 'TELEMARK');
    expect(texto()).toContain('No hay pedidos por checar');
    expect(texto()).toContain('esperan a que Facturación');
  });

  it('⭐ escanear manda el código, avisa y deja el campo libre para el siguiente', async () => {
    await montar(P());
    escanea('C06001');
    expect(api['checadoEscanear']).toHaveBeenCalledWith('chk-1', { code: 'C06001', cantidad: 1, como_cajas: undefined, peso_kg: undefined });
    expect(texto()).toContain('+1 CJA · CHOC SNICKERS /6');
    expect(c.codigo()).toBe('');
    expect(texto()).toContain('Llevas: 1 CJA');
  });

  it('⭐ prueba negativa del doble escaneo: el segundo NO se pierde mientras el primero viaja', async () => {
    await montar(P());
    const primero = new Subject<ChecadoEscaneoResponse>();
    api['checadoEscanear'].mockReturnValueOnce(primero.asObservable());
    escanea('C06001');
    escanea('C06001');
    expect(api['checadoEscanear']).toHaveBeenCalledTimes(1);
    expect(c.pendientesEnCola()).toBe(2);
    expect(texto()).toContain('guardando 2');
    primero.next(OK());
    primero.complete();
    render();
    expect(api['checadoEscanear']).toHaveBeenCalledTimes(2);
  });

  it('cajas sin etiqueta: cantidad + "son cajas" viajan con el escaneo y luego se reinician', async () => {
    await montar(P());
    c.paso(1);
    c.paso(1);
    c.comoCajas.set(true);
    escanea('006001');
    expect(api['checadoEscanear']).toHaveBeenCalledWith('chk-1', { code: '006001', cantidad: 3, como_cajas: true, peso_kg: undefined });
    expect(c.cantidad()).toBe(1);
    expect(c.comoCajas()).toBe(false);
  });

  it('⭐ prueba negativa: tras tocar "+" el foco regresa al escáner (si no, la lectura se perdía y su Enter volvía a sumar)', async () => {
    await montar(P());
    fix.autoDetect = true;
    // Que termine el enfoque pendiente de entrar al pedido: si no, él solo hace pasar la prueba.
    await new Promise((r) => setTimeout(r, 10));
    const mas = el().querySelector('button[aria-label="Una más"]') as HTMLButtonElement;
    mas.focus();
    expect(document.activeElement).toBe(mas);
    mas.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(c.cantidad()).toBe(2);
    expect(document.activeElement?.id).toBe('ck-code');
  });

  it('⭐ prueba negativa: el Enter del escáner se registra aunque "Agregar" siga deshabilitado (sin repintar)', async () => {
    await montar(P());
    const input = el().querySelector('#ck-code') as HTMLInputElement;
    input.value = 'C06001';
    input.dispatchEvent(new Event('input'));
    // Sin render(): el botón "Agregar" sigue deshabilitado, como cuando el escáner teclea más rápido que la pantalla.
    expect(boton('Agregar')?.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(api['checadoEscanear']).toHaveBeenCalledWith('chk-1', { code: 'C06001', cantidad: 1, como_cajas: undefined, peso_kg: undefined });
  });

  it('+5 y +10 suman sin quitarle el foco al escáner', async () => {
    await montar(P());
    // Desde el 1 inicial, +10 da 10 (no 11): "+10 +10" son 20 exactos.
    boton('+10')?.click();
    expect(c.cantidad()).toBe(10);
    boton('+10')?.click();
    expect(c.cantidad()).toBe(20);
    boton('+5')?.click();
    expect(c.cantidad()).toBe(25);
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement?.id).toBe('ck-code');
  });

  it('⭐ cada lectura vuelve a pintar el aviso (dos iguales seguidas ya no se ven idénticas)', async () => {
    await montar(P());
    escanea('C06001');
    const primero = el().querySelector('.ck-destello');
    escanea('C06001');
    const segundo = el().querySelector('.ck-destello');
    expect(c.lecturas()).toBe(2);
    expect(segundo).not.toBe(primero);
  });

  it('⭐ con todo completo dice "Todo listo" y ofrece terminar ahí mismo', async () => {
    await montar(P({
      renglones: [R({ checado: 384, checado_mayor: 2, estado: 'completo', llevas_texto: '2 CJA' })],
      cajas_p: [{ id: 'p1', numero: 1, status: 'abierta', contenido: [{ sku: 'x', producto: 'X', unidad: 'PAQ', cantidad: 3 }] }],
    }));
    expect(texto()).toContain('Todo listo. Al terminar, la caja P1 se cierra y se imprimen sus etiquetas.');
    expect(el().querySelector('.ck-listo button')).not.toBeNull();
  });

  it('prueba negativa: con algo pendiente NO dice "Todo listo"', async () => {
    await montar(P());
    expect(texto()).not.toContain('Todo listo');
  });

  it('la caja P con muchos artículos sugiere cerrarla y seguir en la siguiente', async () => {
    await montar(P({ cajas_p: [{ id: 'p1', numero: 1, status: 'abierta', contenido: [{ sku: 'x', producto: 'X', unidad: 'PAQ', cantidad: 25 }] }] }));
    expect(texto()).toContain('Lleva 25 artículos. Si ya no caben, ciérrala aquí: lo que sigas escaneando abre la P2.');
  });

  it('cerradasTexto distingue cajas de bultos', () => {
    expect(cerradasTexto([{ unidad: 'CJA' }, { unidad: 'CJA' }, { unidad: 'BTO' }])).toBe('2 cajas y 1 bulto');
    expect(cerradasTexto([{ unidad: 'BTO' }, { unidad: 'BTO' }, { unidad: 'CJA' }])).toBe('1 caja y 2 bultos');
    expect(cerradasTexto([{ unidad: 'CJA' }])).toBe('1 caja');
    expect(cerradasTexto([])).toBe('0 cajas');
  });

  it('un producto ajeno se avisa en rojo', async () => {
    await montar(P());
    api['checadoEscanear'].mockReturnValueOnce(of(OK({ resultado: 'ajeno', mensaje: 'MAZAPAN no va en este pedido. Sepáralo.', producto: 'MAZAPAN', pedido: P() })));
    escanea('C99999');
    expect(el().querySelector('.ck-aviso.ck-bad')?.textContent).toContain('no va en este pedido');
  });

  it('⭐ por kilo pide el peso del producto y lo manda con el mismo código', async () => {
    await montar(P());
    api['checadoEscanear'].mockReturnValueOnce(of(OK({ resultado: 'pide_peso', mensaje: 'Pesa ALTOS y escribe los kilos.', producto: 'ALTOS', pedido: P() })));
    escanea('17083');
    expect(texto()).toContain('Peso de ALTOS en la báscula (kg)');
    // Vacío, no "0": con el cero puesto, teclear 2.5 dejaba "02.5".
    expect(c.peso()).toBeNull();
    expect(boton('Agregar')?.disabled).toBe(true);
    c.peso.set(6.14);
    c.enviar();
    expect(api['checadoEscanear']).toHaveBeenLastCalledWith('chk-1', { code: '17083', cantidad: 1, como_cajas: undefined, peso_kg: 6.14 });
  });

  it('⭐ cerrar la caja P imprime su etiqueta por TRIPLICADO (la fila de 3 del rollo)', async () => {
    await montar(P({ cajas_p: [{ id: 'p1', numero: 1, status: 'abierta', contenido: [{ sku: '06001', producto: 'SNICKERS', unidad: 'PAQ', cantidad: 12 }] }] }));
    expect(texto()).toContain('Caja P1 abierta · 12 artículos');
    boton('Cerrar caja P1 e imprimir sus 3 etiquetas')?.click();
    render();
    const [lista] = imprimir.mock.calls[0];
    expect(lista).toHaveLength(3);
    expect(lista[0]).toMatchObject({ grande: 'P1', pedido: 'UD4001-0002781', codigo: '000278110001' });
  });

  it('⭐ antes de terminar enseña qué no cuadra; al terminar las etiquetas 1/N salen solas', async () => {
    await montar(P());
    boton('Terminar checado')?.click();
    render();
    expect(texto()).toContain('Si terminas así, lo que falta sale incompleto');
    expect(texto()).toContain('CHOC SNICKERS /6: Pendiente');
    boton('Sí, terminar')?.click();
    render();
    expect(c.fase()).toBe('terminado');
    const [lista] = imprimir.mock.calls.at(-1) ?? [[]];
    expect(lista.map((e: { grande: string }) => e.grande)).toEqual(['1/2', '2/2']);
    expect(boton('Reimprimir etiquetas 1/2')).toBeDefined();
  });

  it('⭐ muestra la unidad PEDIDA ("2 BOL") y la diferencia que manda el servidor', async () => {
    await montar(P({ renglones: [R({
      sku: '990002', producto: 'PALETA FRESA', unidad: 'PZA', esperado: 40, checado: 20, unidad_mayor: null, factor_mayor: null,
      esperado_mayor: null, unidad_pedida: 'BOL', factor_pedida: 20, estado: 'falta',
      pedido_texto: '2 BOL', llevas_texto: '1 BOL', diferencia_texto: 'Faltan 1 BOL',
    })] }));
    expect(texto()).toContain('Pedido: 2 BOL');
    expect(texto()).toContain('Llevas: 1 BOL');
    expect(texto()).toContain('Faltan 1 BOL');
    expect(texto()).not.toContain('40 PZA');
  });

  it('⭐ prueba negativa: un escaneo que ya va en una caja P cerrada NO ofrece "Deshacer"', async () => {
    await montar(P({ ultimo_escaneo: { id: 's9', producto: 'CACAHUATE', unidad: 'kg', cantidad: 2.5, kind: 'menor', deshacible: false } }));
    expect(texto()).toContain('Último: 2.5 kg · CACAHUATE');
    expect(boton('Deshacer')).toBeUndefined();
    expect(texto()).toContain('Ya va en una caja P cerrada');
  });

  it('abrir Terminar borra el aviso del último escaneo (ya no aplica)', async () => {
    await montar(P());
    api['checadoDeshacer'].mockReturnValueOnce(throwError(() => ({ error: { message: 'La caja P1 ya se cerró y etiquetó: ese escaneo ya no se deshace.' } })));
    c.deshacer('s1');
    render();
    expect(texto()).toContain('ya no se deshace');
    boton('Terminar checado')?.click();
    render();
    expect(texto()).not.toContain('ya no se deshace');
    expect(boton('Sí, terminar')).toBeDefined();
  });

  it('soltar el pedido pide confirmar y regresa a la fila', async () => {
    await montar(P());
    boton('Soltar este pedido')?.click();
    render();
    expect(api['checadoSoltar']).not.toHaveBeenCalled();
    boton('Sí, soltarlo')?.click();
    render();
    expect(api['checadoSoltar']).toHaveBeenCalledWith('chk-1');
    expect(c.fase()).toBe('listo');
    expect(texto()).toContain('volvió a la fila');
  });

  it('reimprime todo el último pedido aunque se haya recargado la página', async () => {
    await montar(null, { 'gp.checar.ultimo': JSON.stringify({ id: 'chk-9', code: 'UD4001-0000009' }) });
    boton('Reimprimir etiquetas de UD4001-0000009')?.click();
    render();
    expect(api['checadoEtiquetas']).toHaveBeenCalledWith('chk-9');
    const [lista] = imprimir.mock.calls.at(-1) ?? [[]];
    expect(lista.map((e: { grande: string }) => e.grande)).toEqual(['P1', 'P1', 'P1', '1/1']);
  });

  it('un error al escanear dice qué código falló y no pierde el pedido', async () => {
    await montar(P());
    api['checadoEscanear'].mockReturnValueOnce(throwError(() => ({ error: { message: 'Este pedido lo está checando otra persona.' } })));
    escanea('X1');
    expect(texto()).toContain('X1: Este pedido lo está checando otra persona.');
    expect(c.pedido()).not.toBeNull();
  });

  it('prueba negativa: si falla leer los almacenes NO manda a pedir sucursal a Sistemas', async () => {
    await montar();
    fix.destroy();
    api['checadoAlmacenes'].mockReturnValueOnce(throwError(() => new Error('red')));
    fix = TestBed.createComponent(AlmacenChecarComponent);
    c = fix.componentInstance;
    render();
    expect(texto()).toContain('No se pudo leer la lista de almacenes.');
    expect(texto()).not.toContain('No tienes una sucursal asignada');
  });
});
