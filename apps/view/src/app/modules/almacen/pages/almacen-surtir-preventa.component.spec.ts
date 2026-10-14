import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import type { PresalePickDetail, PresalePickInboxResponse, PresalePickInboxRow } from '@megadulces/contracts';
import { AlmacenSurtirPreventaComponent } from './almacen-surtir-preventa.component';
import { PresalePickingService } from '../presale-picking.service';
import { AlertsSocketService } from '../../dashboard/command-center/alerts-socket.service';

/**
 * `[MCP.3]` La bandeja del surtidor de preventa, montada de verdad (plantilla + signals) con el
 * servidor simulado. Se recorre como lo hace el surtidor: ver los de hoy, abrir uno desde el aviso,
 * empezar, marcar lo que hubo y cerrar (completo o con reporte a la vendedora).
 */
const fila = (p: Partial<PresalePickInboxRow> = {}): PresalePickInboxRow => ({
  order_id: 'o-rosy', code: 'PD-2026-00072', customer_name: 'ABARROTES ROSY', seller_name: 'Paulina Placencia',
  warehouse_id: 'w-02', warehouse_name: 'La Piedad Abastos', requested_delivery_date: '2026-10-14',
  bucket: 'hoy', days_late: 0, arrived_at: '2026-10-14T15:42:00.000Z', lines: 2, total: 475.44,
  state: 'nuevo', started: null, finished: null, unseen: true, ...p,
});

const BANDEJA = (): PresalePickInboxResponse => ({
  today: '2026-10-14',
  counts: { hoy: 2, manana: 1, proximos: 0 },
  scope: 'propios',
  data: [
    fila(),
    fila({ order_id: 'o-vero', code: 'PD-2026-00070', customer_name: 'VERO VASCO', days_late: 2, requested_delivery_date: '2026-10-12', unseen: false }),
    fila({ order_id: 'o-esc', code: 'PD-2026-00065', customer_name: 'ESCUELA AMARILLA', bucket: 'manana', requested_delivery_date: '2026-10-15' }),
  ],
});

const DETALLE = (estado: PresalePickInboxRow['state'] = 'nuevo'): PresalePickDetail => ({
  order: fila({
    state: estado,
    started: estado === 'nuevo' ? null : { user_id: 'yo', name: 'Juan Pérez', at: '2026-10-14T15:43:00.000Z' },
  }),
  lines: [
    { line_id: 'l1', product_id: 'p1', sku: '70012', product_name: 'BOMBON GRANDE', qty: 5, unit: 'PAQ', factor: 1, picked: null },
    { line_id: 'l2', product_id: 'p2', sku: '99124', product_name: 'SALSA MAGA 1 1/2', qty: 1, unit: 'CJA', factor: 1, picked: null },
  ],
});

describe('AlmacenSurtirPreventaComponent · la bandeja del surtidor (MCP.3)', () => {
  let fix: ComponentFixture<AlmacenSurtirPreventaComponent>;
  let api: Record<'inbox' | 'detail' | 'start' | 'finish', ReturnType<typeof vi.fn>>;
  let alert$: Subject<{ type: string }>;

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

  async function montar(detalle: PresalePickDetail = DETALLE()): Promise<void> {
    api = {
      inbox: vi.fn(() => of(BANDEJA())),
      detail: vi.fn(() => of(detalle)),
      start: vi.fn(() => of(fila({ state: 'surtiendo', started: { user_id: 'yo', name: 'Juan Pérez', at: '2026-10-14T15:43:00.000Z' } }))),
      finish: vi.fn(() => of({ order_id: 'o-rosy', outcome: 'con_faltantes', report: { removed: [], adjusted: [], total_before: 475.44, total_after: 161.4 } })),
    };
    alert$ = new Subject();
    await TestBed.configureTestingModule({
      imports: [AlmacenSurtirPreventaComponent],
      providers: [
        provideRouter([]),
        { provide: PresalePickingService, useValue: api },
        { provide: AlertsSocketService, useValue: { connect: vi.fn(), alert$, connected: signal(true) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenSurtirPreventaComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('abre en Hoy con lo de hoy y lo vencido, y cuenta lo que falta por día', async () => {
    await montar();
    expect(texto()).toContain('Hoy · 2');
    expect(texto()).toContain('Mañana · 1');
    expect(texto()).toContain('ABARROTES ROSY');
    expect(texto()).toContain('vencido 2 días');
    expect(texto()).not.toContain('ESCUELA AMARILLA');
  });

  it('cambiar a Mañana muestra los de mañana', async () => {
    await montar();
    fix.componentInstance.pestana.set('manana');
    fix.detectChanges();
    expect(texto()).toContain('ESCUELA AMARILLA');
    expect(texto()).not.toContain('VERO VASCO');
  });

  it('el aviso en vivo vuelve a pedir la bandeja sin esperar', async () => {
    await montar();
    expect(api.inbox).toHaveBeenCalledTimes(1);
    alert$.next({ type: 'order_to_pick' });
    expect(api.inbox).toHaveBeenCalledTimes(2);
    alert$.next({ type: 'otra_cosa' });
    expect(api.inbox).toHaveBeenCalledTimes(2);
  });

  it('?pedido= abre el pedido (es a donde lleva la campana) y empezar registra al surtidor', async () => {
    await montar();
    await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
    fix.detectChanges();
    expect(api.detail).toHaveBeenCalledWith('o-rosy');
    expect(texto()).toContain('Al empezar queda registrado quién surte');
    clic('Empezar a surtir');
    expect(api.start).toHaveBeenCalledWith('o-rosy');
    expect(texto()).toContain('Surte: Juan Pérez');
    expect(boton('Completo')).toBeDefined();
  });

  it('no deja terminar sin marcar todo; con un faltante manda el reporte con lo que sí hubo', async () => {
    await montar(DETALLE('surtiendo'));
    await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
    fix.detectChanges();
    expect(boton('Marca todos los productos')?.disabled).toBe(true);

    const completos = Array.from(el().querySelectorAll('button')).filter((b) => b.textContent?.includes('Completo'));
    (completos[0] as HTMLButtonElement).click();
    fix.detectChanges();
    // SALSA: no hubo → baja de 1 a 0.
    (el().querySelector('[aria-label="Menos SALSA MAGA 1 1/2"]') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(texto()).toContain('no hubo');
    clic('Enviar reporte a Paulina Placencia · faltaron 1');
    expect(api.finish).toHaveBeenCalledWith('o-rosy', { lines: [{ line_id: 'l1', picked: 5 }, { line_id: 'l2', picked: 0 }] });
  });

  it('si hubo todo, el botón es «Confirmar: hubo todo»', async () => {
    await montar(DETALLE('surtiendo'));
    await TestBed.inject(Router).navigate([], { queryParams: { pedido: 'o-rosy' } });
    fix.detectChanges();
    for (const b of Array.from(el().querySelectorAll('button')).filter((x) => x.textContent?.includes('Completo'))) (b as HTMLButtonElement).click();
    fix.detectChanges();
    expect(boton('Confirmar: hubo todo')).toBeDefined();
    expect(boton('Enviar reporte')).toBeUndefined();
  });

  it('sin sucursal asignada lo dice en vez de mostrar una bandeja vacía muda', async () => {
    await montar();
    api.inbox.mockReturnValue(of({ today: '2026-10-14', counts: { hoy: 0, manana: 0, proximos: 0 }, data: [], scope: 'ninguno' }));
    fix.componentInstance.cargar();
    fix.detectChanges();
    expect(texto()).toContain('no tiene una sucursal asignada');
  });
});
