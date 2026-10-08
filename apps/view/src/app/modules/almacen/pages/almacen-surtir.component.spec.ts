import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { PickerTakeNextResponse, PickerWave, PickerWaveLine } from '@megadulces/contracts';
import { AlmacenSurtirComponent } from './almacen-surtir.component';
import { PickingService } from '../../reparto/picking.service';
import { ComercialService } from '../../comercial/comercial.service';
import { AuthService } from '../../../core/services/auth.service';

/**
 * `[GP.3b]` La pantalla del surtidor, montada de verdad (plantilla + signals) con el servidor
 * simulado. Recorre lo que hace una persona con el celular en la mano: retomar, tomar, marcar
 * Completo / Faltante / No había, corregir, cerrar, quedarse sin trabajo y los errores.
 *
 * Se prueba por la PANTALLA (botones, textos, deshabilitados) y no sólo por los métodos: un
 * botón que se pinta pero no hace nada, o que queda habilitado cuando no debe, es justo el tipo
 * de defecto que `tsc` no ve.
 */

const ALMACENES = [
  { id: 'w-ph', code: '01', name: 'Padre Hidalgo', kind: 'central' },
  { id: 'w-lp', code: '02', name: 'La Piedad Abastos', kind: 'central' },
  { id: 'w-r21', code: 'RUTA-21', name: 'Ruta 21', kind: 'truck' },
  { id: 'w-x', code: '01-002', name: 'Ruta 22 (PH)', kind: 'central' },
];

const L = (p: Partial<PickerWaveLine> = {}): PickerWaveLine => ({
  id: 'l1',
  product_id: 'p1',
  product_name: 'CHOC RANITA CROA',
  sku: '70034',
  barcode: '7501234567890',
  qty_requested: 75,
  qty_unit: 'KG',
  unidad_mixta: false,
  qty_presentacion: 3,
  unidad_presentacion: 'BTO',
  qty_picked: null,
  status: 'pendiente',
  bin_code: null,
  note: null,
  ...p,
});

const OLA = (lines: PickerWaveLine[] = [L()]): PickerWave => ({
  id: 'ola-1',
  code: 'W-2026-00001',
  warehouse_id: 'w-ph',
  status: 'en_surtido',
  notes: null,
  started_at: '2026-10-08T15:00:00.000Z',
  pedidos: ['UD4001-0002840'],
  lines,
});

const ASIGNADA = (ola: PickerWave = OLA(), extra: Partial<PickerTakeNextResponse> = {}): PickerTakeNextResponse =>
  ({ estado: 'asignada', ya_era_tuya: false, ola, atoradas: [], ...extra }) as PickerTakeNextResponse;

describe('AlmacenSurtirComponent · la pantalla del surtidor (GP.3b)', () => {
  let fix: ComponentFixture<AlmacenSurtirComponent>;
  let c: AlmacenSurtirComponent;
  let api: {
    misOlas: ReturnType<typeof vi.fn>;
    tomarSiguiente: ReturnType<typeof vi.fn>;
    pick: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
  };
  let comercial: { listWarehouses: ReturnType<typeof vi.fn> };
  let user: { warehouse_code?: string } | null;

  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  /** La cantidad como la oyen y la leen: número y unidad van en piezas separadas para verse grandes. */
  const cantidades = (): string[] =>
    Array.from(el().querySelectorAll('.sr-cant')).map((n) => n.getAttribute('aria-label') ?? '');
  const boton =(t: string): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').includes(t)) as
      | HTMLButtonElement
      | undefined;
  const clic = (t: string): void => {
    const b = boton(t);
    if (!b) throw new Error(`no hay botón «${t}»`);
    b.click();
    fix.detectChanges();
  };

  async function montar(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [AlmacenSurtirComponent],
      providers: [
        provideRouter([]),
        { provide: PickingService, useValue: api },
        { provide: ComercialService, useValue: comercial },
        { provide: AuthService, useValue: { user: () => user } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenSurtirComponent);
    c = fix.componentInstance;
    fix.detectChanges();
  }

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* sin almacenamiento */
    }
    user = { warehouse_code: '01' };
    api = {
      misOlas: vi.fn(() => of([])),
      tomarSiguiente: vi.fn(() => of(ASIGNADA())),
      pick: vi.fn((_w: string, lineId: string, dto: { qty_picked: number; status?: string }) => {
        const st = dto.status ?? (dto.qty_picked === 0 ? 'agotado' : dto.qty_picked < 75 ? 'faltante' : 'surtido');
        return of({ id: lineId, qty_picked: dto.qty_picked, status: st });
      }),
      finish: vi.fn(() => of({ id: 'ola-1', status: 'surtida', cambios_en_kepler: [] })),
    };
    comercial = { listWarehouses: vi.fn(() => of(ALMACENES)) };
  });

  afterEach(() => TestBed.resetTestingModule());

  // ── Arranque ────────────────────────────────────────────────────────────────────────────

  it('monta, y sin ola pendiente queda lista para tomar trabajo', async () => {
    await montar();
    expect(c.fase()).toBe('listo');
    expect(boton('Tomar siguiente')).toBeTruthy();
  });

  it('sólo ofrece sucursales Kepler (código de 2 dígitos): ni camiones ni sub-almacenes de ruta', async () => {
    await montar();
    expect(c.almacenes().map((a) => a.code)).toEqual(['01', '02']);
  });

  it('el almacén por omisión es el de la ficha del usuario', async () => {
    await montar();
    expect(c.almacenId()).toBe('w-ph');
    expect(texto()).toContain('Padre Hidalgo');
  });

  it('sin almacén en la ficha ni guardado, "Tomar siguiente" está apagado (prueba negativa)', async () => {
    user = {};
    await montar();
    expect(c.almacenId()).toBe('');
    expect(boton('Tomar siguiente')?.disabled).toBe(true);
  });

  it('⭐ si ya traía una ola, la RETOMA con tomarSiguiente (que la arranca), no pintándola tal cual', async () => {
    api.misOlas = vi.fn(() => of([OLA()]));
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA(), { ya_era_tuya: true })));
    await montar();
    expect(api.tomarSiguiente).toHaveBeenCalledWith({ warehouse_id: 'w-ph', origen: undefined });
    expect(c.fase()).toBe('surtiendo');
  });

  it('⭐ si al RETOMAR falla la red, no se queda cargando para siempre: vuelve a "listo" con el error', async () => {
    api.misOlas = vi.fn(() => of([OLA()]));
    api.tomarSiguiente = vi.fn(() => throwError(() => ({ status: 0, error: { message: 'sin conexión' } })));
    await montar();
    expect(c.fase()).toBe('listo');
    expect(texto()).not.toContain('Cargando');
    expect(texto()).toContain('sin conexión');
    expect(boton('Reintentar')).toBeTruthy();
  });

  it('si no puede leer los almacenes, lo dice y ofrece reintentar', async () => {
    comercial.listWarehouses = vi.fn(() => throwError(() => new Error('red')));
    await montar();
    expect(texto()).toContain('No se pudo leer la lista de almacenes');
    expect(boton('Reintentar')).toBeTruthy();
  });

  // ── Tomar trabajo ───────────────────────────────────────────────────────────────────────

  it('tomar manda el almacén y el origen elegido', async () => {
    await montar();
    clic('Telemarketing');
    clic('Tomar siguiente');
    expect(api.tomarSiguiente).toHaveBeenCalledWith({ warehouse_id: 'w-ph', origen: 'TELEMARK' });
  });

  it('el origen elegido se recuerda en el dispositivo', async () => {
    await montar();
    clic('Sucursal');
    TestBed.resetTestingModule();
    await montar();
    expect(c.origen()).toBe('SUCURSAL');
  });

  it('⭐ con la ola tomada, la cantidad sale en la presentación de la hoja y la base debajo', async () => {
    await montar();
    clic('Tomar siguiente');
    expect(cantidades()).toEqual(['Surtir 3 BTO']);
    expect(texto()).toContain('= 75 KG');
    expect(texto()).toContain('UD4001-0002840');
  });

  it('sin presentación (pedido de la Suite) muestra la unidad base, sin el "=" de abajo', async () => {
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA([L({ qty_presentacion: null, unidad_presentacion: null, qty_requested: 12, qty_unit: 'PAQ' })]))));
    await montar();
    clic('Tomar siguiente');
    expect(cantidades()).toEqual(['Surtir 12 PAQ']);
    expect(texto()).not.toContain('= 12');
  });

  it('una presentación en 0 se ignora: no muestra "0 BTO"', async () => {
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA([L({ qty_presentacion: 0 })]))));
    await montar();
    clic('Tomar siguiente');
    expect(cantidades()).toEqual(['Surtir 75 KG']);
  });

  it('sin trabajo: lo dice y lista los pedidos bloqueados para avisar a la consola', async () => {
    api.tomarSiguiente = vi.fn(() =>
      of({
        estado: 'sin_trabajo',
        motivo: 'No hay pedidos autorizados por surtir en este almacén.',
        armado: {
          creadas: [], fallidas: [], vacios: [],
          bloqueados: [{ code: 'UD4001-0002999', motivo: '1 renglón(es) con clave fuera del catálogo' }],
          atorados: { count: 7, desde: '2026-07-15' },
        },
        atoradas: [],
      } as PickerTakeNextResponse),
    );
    await montar();
    clic('Tomar siguiente');
    expect(c.fase()).toBe('listo');
    expect(texto()).toContain('No hay pedidos por surtir');
    expect(texto()).toContain('UD4001-0002999');
    expect(texto()).toContain('7 pedidos siguen autorizados');
  });

  it('las olas de la consola que no arrancaron se avisan arriba', async () => {
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA(), { atoradas: [{ code: 'W-2026-00007', motivo: 'clave fuera del catálogo' }] })));
    await montar();
    clic('Tomar siguiente');
    expect(texto()).toContain('Avísale a tu supervisor');
    expect(texto()).toContain('W-2026-00007');
  });

  it('si tomar falla, avisa y sigue en "listo" (no se queda cargando)', async () => {
    api.tomarSiguiente = vi.fn(() => throwError(() => ({ error: { message: 'sin conexión' } })));
    await montar();
    clic('Tomar siguiente');
    expect(c.tomando()).toBe(false);
    expect(c.fase()).toBe('listo');
  });

  // ── Surtir ──────────────────────────────────────────────────────────────────────────────

  async function surtiendo(lines: PickerWaveLine[] = [L()]): Promise<void> {
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA(lines))));
    await montar();
    clic('Tomar siguiente');
  }

  it('⭐ Completo manda lo pedido en la unidad BASE y el renglón pasa a "Ya surtidos"', async () => {
    await surtiendo();
    clic('Completo');
    expect(api.pick).toHaveBeenCalledWith('ola-1', 'l1', { qty_picked: 75, status: undefined });
    expect(c.pendientes().length).toBe(0);
    expect(c.hechas().length).toBe(1);
    expect(texto()).toContain('1 / 1');
  });

  it('⭐ Faltante se captura en la presentación (2 BTO) y se guarda convertido a la base (50 KG)', async () => {
    await surtiendo();
    clic('Faltante');
    expect(texto()).toContain('¿Cuánto levantaste? (BTO)');
    c.borrador.set(2);
    fix.detectChanges();
    clic('Guardar');
    expect(api.pick).toHaveBeenCalledWith('ola-1', 'l1', { qty_picked: 50, status: undefined });
    expect(texto()).toContain('Faltaron 1 de 3 BTO');
  });

  it('no deja guardar más de lo pedido (4 BTO de 3) ni el campo vacío (prueba negativa)', async () => {
    await surtiendo();
    clic('Faltante');
    c.borrador.set(4);
    fix.detectChanges();
    expect(boton('Guardar')?.disabled).toBe(true);
    c.borrador.set(null);
    fix.detectChanges();
    expect(boton('Guardar')?.disabled).toBe(true);
  });

  it('capturar la presentación completa guarda lo pedido EXACTO (sin 74.99999 por la división)', async () => {
    await surtiendo([L({ qty_requested: 61.74, qty_presentacion: 3 })]);
    clic('Faltante');
    c.borrador.set(3);
    fix.detectChanges();
    clic('Guardar');
    expect(api.pick).toHaveBeenCalledWith('ola-1', 'l1', { qty_picked: 61.74, status: undefined });
  });

  it('No había manda 0 con causa "agotado"', async () => {
    await surtiendo();
    clic('Faltante');
    clic('No había');
    expect(api.pick).toHaveBeenCalledWith('ola-1', 'l1', { qty_picked: 0, status: 'agotado' });
    expect(texto()).toContain('No había');
  });

  it('un renglón ya surtido se puede corregir', async () => {
    await surtiendo();
    clic('Completo');
    clic('Corregir');
    expect(c.editando()).toBe('l1');
  });

  it('el buscador filtra por nombre o código', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', product_name: 'PAL JUMBO CEREZA', sku: '70079' })]);
    c.busqueda.set('70079');
    fix.detectChanges();
    expect(c.pendientes().map((l) => l.id)).toEqual(['l2']);
  });

  it('al marcar un renglón encontrado con el buscador, el buscador se limpia para escanear el siguiente', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', product_name: 'PAL JUMBO CEREZA', sku: '70079' })]);
    c.busqueda.set('70079');
    fix.detectChanges();
    clic('Completo');
    expect(c.busqueda()).toBe('');
    expect(c.pendientes().map((l) => l.id)).toEqual(['l1']);
  });

  it('⭐ el escáner encuentra el producto por su CÓDIGO DE BARRAS (lo que trae la etiqueta)', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', product_name: 'PAL JUMBO CEREZA', sku: '70079', barcode: '7509999999999' })]);
    c.busqueda.set('7509999999999');
    fix.detectChanges();
    expect(c.visibles().map((l) => l.id)).toEqual(['l2']);
  });

  it('⭐ escanear algo que no está en el surtido lo DICE (no "ya pasaste por todos")', async () => {
    await surtiendo();
    c.busqueda.set('000000');
    fix.detectChanges();
    expect(texto()).toContain('Ningún renglón de este surtido coincide');
    expect(texto()).not.toContain('Ya pasaste por todos');
  });

  it('Enter del escáner con una sola coincidencia lleva el foco a su "Completo" (no lo marca solo)', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', sku: '70079', barcode: '7509999999999' })]);
    c.busqueda.set('70079');
    fix.detectChanges();
    c.enterBuscar();
    expect(document.activeElement?.id).toBe('sr-ok-l2');
    expect(api.pick).not.toHaveBeenCalled();
  });

  it('⭐ un renglón marcado se queda EN SU LUGAR (encogido): la lista no se mueve bajo el dedo', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', sku: '70079' }), L({ id: 'l3', product_id: 'p3', sku: '70080' })]);
    const orden = (): string[] => c.visibles().map((l) => l.id);
    clic('Completo');
    expect(orden()).toEqual(['l1', 'l2', 'l3']);
    expect(el().querySelectorAll('.sr-hecho').length).toBe(1);
  });

  it('"Ocultar los ya surtidos" deja sólo lo pendiente', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', sku: '70079' })]);
    clic('Completo');
    clic('Ocultar los ya surtidos');
    expect(c.visibles().map((l) => l.id)).toEqual(['l2']);
  });

  it('el faltante dice el máximo, y explica por qué no deja guardar si se pasa', async () => {
    await surtiendo();
    clic('Faltante');
    expect(texto()).toContain('Entre 0 y 3 BTO');
    c.borrador.set(5);
    fix.detectChanges();
    expect(texto()).toContain('No puede ser más de 3 BTO');
  });

  it('sin conexión lo avisa arriba', async () => {
    await surtiendo();
    window.dispatchEvent(new Event('offline'));
    fix.detectChanges();
    expect(texto()).toContain('Sin conexión');
    window.dispatchEvent(new Event('online'));
    fix.detectChanges();
    expect(texto()).not.toContain('Sin conexión');
  });

  it('si guardar falla, el renglón sigue pendiente y los botones vuelven a servir', async () => {
    await surtiendo();
    api.pick = vi.fn(() => throwError(() => ({ status: 500, error: { message: 'caído' } })));
    clic('Completo');
    expect(c.pendientes().length).toBe(1);
    expect(c.guardando().size).toBe(0);
    expect(boton('Completo')?.disabled).toBe(false);
  });

  it('⭐ un 409 al guardar (la consola canceló la ola) regresa a "Tomar siguiente": no deja la pantalla sin salida', async () => {
    await surtiendo();
    api.pick = vi.fn(() => throwError(() => ({ status: 409, error: { message: 'La ola está cancelada' } })));
    clic('Completo');
    expect(c.fase()).toBe('listo');
    expect(c.ola()).toBeNull();
  });

  // ── Cerrar ──────────────────────────────────────────────────────────────────────────────

  it('⭐ "Terminé de surtir" está apagado mientras haya renglones sin tocar', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', sku: '70079' })]);
    expect(boton('Terminé de surtir')?.disabled).toBe(true);
    clic('Completo');
    expect(boton('Terminé de surtir')?.disabled).toBe(true);
    clic('Completo');
    expect(boton('Terminé de surtir')?.disabled).toBe(false);
  });

  it('al cerrar muestra el resumen y el aviso si el pedido cambió en Kepler', async () => {
    api.finish = vi.fn(() => of({ id: 'ola-1', status: 'surtida', cambios_en_kepler: ['clave 70034: 75 → 50'] }));
    await surtiendo();
    clic('Completo');
    clic('Terminé de surtir');
    expect(c.fase()).toBe('cerrada');
    expect(texto()).toContain('Surtido terminado');
    expect(texto()).toContain('1 renglón completo');
    expect(texto()).toContain('clave 70034: 75 → 50');
    expect(boton('Tomar siguiente')).toBeTruthy();
  });

  it('si cerrar falla, sigue surtiendo con la ola intacta', async () => {
    api.finish = vi.fn(() => throwError(() => ({ status: 500, error: { message: 'caído' } })));
    await surtiendo();
    clic('Completo');
    clic('Terminé de surtir');
    expect(c.fase()).toBe('surtiendo');
    expect(c.ola()).not.toBeNull();
    expect(c.cerrando()).toBe(false);
  });

  it('Salir va a /almacen y NO al tablero (el almacenista no tiene permiso de verlo: lo rebotaría)', async () => {
    await montar();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    clic('Salir');
    expect(nav).toHaveBeenCalledWith('/almacen');
  });
});
