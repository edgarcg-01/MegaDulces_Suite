import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { PresaleReviewDetail, PresaleReviewInboxResponse, PresaleReviewInboxRow } from '@megadulces/contracts';
import { AlmacenRevisionPreventaComponent } from './almacen-revision-preventa.component';
import { PresaleReviewService } from '../presale-review.service';

/**
 * `[MCP.10]` La revisión en caja, montada de verdad (plantilla + signals) con el servidor simulado.
 * Se recorre como lo hace la cajera: ver lo que llegó, abrir un pedido, «Está bien», pedir el
 * faltante y confirmarlo, y terminar con lo que se va a cobrar.
 */
const fila = (p: Partial<PresaleReviewInboxRow> = {}): PresaleReviewInboxRow => ({
  order_id: 'o-carm', code: 'PD-2026-00138', customer_name: 'ABARROTES CARMELITA', seller_name: 'Vendedor PH',
  warehouse_name: 'Padre Hidalgo', requested_delivery_date: '2026-10-29', lines: 3, total: 380,
  finished: { user_id: 's1', name: 'Juan Surtidor', at: '2026-10-29T16:00:00.000Z' },
  pick_outcome: 'con_faltantes', state: 'por_revisar', reviewed: null, group_code: null, instructions: null, ...p,
});

const BANDEJA = (): PresaleReviewInboxResponse => ({
  today: '2026-10-29', pending: 2, truncated: false, scope: 'propios',
  data: [
    fila(),
    fila({ order_id: 'o-lupi', code: 'PD-2026-00140', customer_name: 'MISCELANEA LUPITA', pick_outcome: 'completo', finished: { user_id: 's1', name: 'Juan Surtidor', at: '2026-10-27T16:00:00.000Z' } }),
    fila({ order_id: 'o-rev', code: 'PD-2026-00131', customer_name: 'TIENDA YA REVISADA', state: 'revisado', reviewed: { user_id: 'c1', name: 'María Cajera', at: '2026-10-29T15:00:00.000Z' } }),
  ],
});

const DETALLE = (): PresaleReviewDetail => ({
  order: fila(),
  lines: [
    { key: 'l1', product_id: 'p1', product_name: 'PALETA PAYASO GRANDE', unit: 'CJA', factor: 24, ordered: 1, picked: 1, restorable: true, stock: { state: 'con_existencia', qty: 14, checked_at: null } },
    { key: 'l2', product_id: 'p2', product_name: 'MAZAPAN GIGANTE 50 G', unit: 'PAQ', factor: 20, ordered: 3, picked: 2, restorable: true, stock: { state: 'con_existencia', qty: 65, checked_at: null } },
    { key: 'borrado:0', product_id: null, product_name: 'SALSA MAGA', unit: 'CJA', factor: 1, ordered: 1, picked: 0, restorable: false, stock: null },
  ],
});

describe('AlmacenRevisionPreventaComponent · revisión en caja (MCP.10)', () => {
  let fix: ComponentFixture<AlmacenRevisionPreventaComponent>;
  let api: Record<'inbox' | 'detail' | 'finish', ReturnType<typeof vi.fn>>;

  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: string): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').includes(t)) as HTMLButtonElement | undefined;
  const clic = (t: string): void => {
    const b = boton(t);
    if (!b) throw new Error(`no hay botón «${t}»`);
    b.click();
    fix.detectChanges();
  };

  async function montar(detalle: () => PresaleReviewDetail = DETALLE): Promise<void> {
    try { localStorage.clear(); } catch { /* sin almacenamiento */ }
    api = {
      inbox: vi.fn(() => of(BANDEJA())),
      detail: vi.fn(() => of(detalle())),
      finish: vi.fn(() => of({ order_id: 'o-carm', review: { lines: [], total_before: 380, total_after: 420 } })),
    };
    await TestBed.configureTestingModule({
      imports: [AlmacenRevisionPreventaComponent],
      providers: [provideRouter([]), { provide: PresaleReviewService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenRevisionPreventaComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  async function abrir(): Promise<void> {
    await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-carm' } });
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('la lista muestra lo que falta por revisar y, aparte, lo ya revisado', async () => {
    await montar();
    // El veredicto primero: cuántos faltan por revisar, cuántos con faltantes, cuántos ya se revisaron.
    expect(texto()).toContain('Por revisar');
    expect(fix.componentInstance.metricas().map((m) => [m.label, m.value])).toEqual([['Por revisar', 2], ['Con faltantes', 1], ['Revisados', 1]]);
    expect(texto()).toContain('ABARROTES CARMELITA');
    expect(texto()).toContain('Faltó algo');
    expect(texto()).toContain('Revisados');
    expect(texto()).toContain('TIENDA YA REVISADA');
  });

  it('lo que no se revisó no desaparece: dice desde cuándo, y lo de hoy no lleva atraso', async () => {
    await montar();
    const tarjetas = Array.from(el().querySelectorAll('.rv-card')).map((b) => (b.textContent ?? '').replace(/\s+/g, ' '));
    expect(tarjetas.find((t) => t.includes('MISCELANEA LUPITA'))).toContain('Sin revisar · hace 2 días');
    expect(tarjetas.find((t) => t.includes('ABARROTES CARMELITA'))).not.toContain('Sin revisar');
  });

  it('si la lista se cortó en el tope, lo dice con el total real', async () => {
    await montar();
    fix.componentInstance.bandeja.set({ ...BANDEJA(), pending: 340, truncated: true });
    fix.detectChanges();
    expect(texto()).toContain('Hay 340 pedidos sin revisar y aquí se ven los primeros 2');
    expect(fix.componentInstance.metricas()[0].value).toBe(340);
  });

  it('señala un producto a la vez: «Está bien» pasa al siguiente', async () => {
    await montar();
    await abrir();
    expect(api.detail).toHaveBeenCalledWith('o-carm');
    expect(texto()).toContain('Producto 1 de 3');
    expect(texto()).toContain('PALETA PAYASO GRANDE');
    expect(texto()).toContain('Deben ser 1 caja');
    clic('Está bien');
    expect(texto()).toContain('Producto 2 de 3');
    expect(texto()).toContain('faltan 1 paquete');
    expect(texto()).toContain('El sistema dice que sí hay (65 paquetes)');
  });

  it('el faltante se completa con el surtidor; el borrado sin copia sólo deja «No hay»', async () => {
    await montar();
    await abrir();
    clic('Está bien');
    clic('Ya se completó');
    expect(texto()).toContain('SALSA MAGA');
    expect(texto()).toContain('ya no se puede agregar desde aquí');
    expect(boton('Ya se completó')).toBeUndefined();
    // Sin existencia leída se DECLARA, no se dibuja «no hay».
    expect(texto()).toContain('No se pudo saber si hay en el sistema');
    clic('No hay');
    expect(texto()).toContain('Pedido revisado');
    expect(texto()).toContain('No se cobra lo que no hubo: 1 caja de SALSA MAGA');
    clic('Terminar y seguir con el siguiente');
    expect(api.finish).toHaveBeenCalledWith('o-carm', { lines: [
      { key: 'l1', final: 1 }, { key: 'l2', final: 3 }, { key: 'borrado:0', final: 0 },
    ] });
  });

  it('«No coincide» abre el − / + y lo que falta se vuelve faltante', async () => {
    await montar();
    await abrir();
    clic('No coincide');
    expect(texto()).toContain('¿Cuántos vienen?');
    (el().querySelector('[aria-label="Uno menos"]') as HTMLButtonElement).click();
    fix.detectChanges();
    clic('Guardar');
    expect(texto()).toContain('Se pidieron 1 y vienen 0');
  });

  it('«← Anterior» deshace el último toque', async () => {
    await montar();
    await abrir();
    expect(boton('Anterior')).toBeUndefined();
    clic('Está bien');
    clic('Anterior');
    expect(texto()).toContain('Producto 1 de 3');
    expect(texto()).toContain('Deben ser 1 caja');
  });

  it('se puede cambiar a otro pedido por revisar', async () => {
    await montar();
    await abrir();
    expect(boton('MISCELANEA LUPITA')).toBeDefined();
    expect(boton('TIENDA YA REVISADA')).toBeUndefined();
  });

  it('si el servidor rechaza el cierre se dice y la revisión NO se pierde', async () => {
    await montar();
    await abrir();
    api.finish.mockReturnValueOnce(throwError(() => ({ error: { message: 'Este pedido ya lo revisó María Cajera a las 10:00.' } })));
    clic('Está bien');
    clic('Ya se completó');
    clic('No hay');
    clic('Terminar y seguir con el siguiente');
    expect(texto()).toContain('Pedido revisado');
    expect(boton('Terminar y seguir con el siguiente')?.disabled).toBe(false);
  });

  it('un error al cargar la lista se muestra como error, no como «no hay pedidos»', async () => {
    await montar();
    api.inbox.mockReturnValueOnce(throwError(() => ({ error: { message: 'boom' } })));
    fix.componentInstance.bandeja.set(null);
    fix.componentInstance.cargar();
    fix.detectChanges();
    expect(texto()).not.toContain('No hay pedidos por revisar');
    expect(texto()).toContain('boom');
  });
});
