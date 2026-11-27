import { MessageService } from 'primeng/api';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { PresaleSellerOrder } from '@megadulces/contracts';
import { provideRouter } from '@angular/router';
import { VendorMisPedidosComponent } from './vendor-mis-pedidos.component';
import { PresaleStatusService } from '../presale-status.service';
import { VendorService } from '../vendor.service';
import { RecuentoDiaService } from '../recuento-dia.service';
import { RouteDayService } from '../route-day.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';

/**
 * `[MCP.28]` `[MCP.29]` El buscador de «Mis pedidos» y el cambio de día de entrega, montados con el servidor
 * simulado. Qué encuentra y qué se puede mover lo decide el servidor (`buscar-y-reagendar.it.spec.ts`); aquí se
 * prueba lo que la PANTALLA promete: qué se ve, qué se manda y qué NO se deja hacer.
 */
const HOY = '2026-10-14'; // el «hoy» lo dice el servidor
const pedido = (p: Partial<PresaleSellerOrder> = {}): PresaleSellerOrder => ({
  order_id: 'o-rosy', code: 'PD-2026-00072', customer_id: 'c-1', customer_name: 'ABARROTES ROSY', requested_delivery_date: '2026-10-15',
  total: 1219.26, lines: 1, status: 'confirmed', scheduled_at: '2026-10-14T15:42:00.000Z', warehouse_name: 'La Piedad Abastos',
  started: null, finished: null, report: null, charge: null, delivered_at: null, report_unseen: false, ...p,
});

describe('[MCP.28] [MCP.29] buscar un pedido y cambiar su día de entrega', () => {
  let fix: ComponentFixture<VendorMisPedidosComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const botonEn = (raiz: Element | null, t: string): HTMLButtonElement | undefined =>
    Array.from(raiz?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (b) => (b.getAttribute('aria-label') || b.textContent?.replace(/\s+/g, ' ').trim()) === t,
    );
  const clic = (b: HTMLButtonElement | null | undefined) => {
    expect(b).toBeTruthy();
    b?.click();
    fix.detectChanges();
  };
  const tarjeta = (id: string) => el().querySelector(`#mp-${id}`);
  const esperar = (ms = 350) => new Promise((r) => setTimeout(r, ms));
  const vendor = {
    orderById: vi.fn(() => of({ id: 'o-rosy', lines: [{ id: 'l1', product_name: 'PALETA PRUEBA', quantity: 48, qty_unit: 'CJA', qty_factor: 24 }] })),
    modificarPedido: vi.fn(() => of({ id: 'o-rosy', total: 999.5, status: 'confirmed' })),
  };
  const toast = { add: vi.fn() };

  async function montar(): Promise<void> {
    vendor.modificarPedido.mockClear();
    toast.add.mockClear();
    api = {
      status: vi.fn(() => of({ today: HOY, date: HOY, data: [pedido()], unseen_reports: 0 })),
      markSeen: vi.fn(() => of({ updated: 0 })),
      unseen: vi.fn(() => of({ unseen_reports: 0 })),
      search: vi.fn(() => of({
        q: 'x', window_days: 60, limit: 30, truncated: false, includes_team: true,
        data: [
          { ...pedido({ order_id: 'o-viejo', code: 'PD-2026-00010', status: 'cancelled' }), created_date: '2026-09-30', seller_name: 'Tú', is_mine: true },
          { ...pedido({ order_id: 'o-equipo', code: 'PD-2026-00020' }), created_date: '2026-10-13', seller_name: 'RUBEN PRUEBA', is_mine: false },
        ],
      })),
    };
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    await TestBed.configureTestingModule({
      imports: [VendorMisPedidosComponent],
      providers: [
        { provide: PresaleStatusService, useValue: api },
        { provide: VendorService, useValue: vendor },
        { provide: RecuentoDiaService, useValue: { dia: vi.fn(() => throwError(() => ({ error: { message: 'sin servidor' } }))) } },
        { provide: OfflineOrderService, useValue: { pendingSummaries: vi.fn(() => Promise.resolve([])) } },
        { provide: MessageService, useValue: toast },
        { provide: RouteDayService, useValue: { today: vi.fn(() => of({ state: 'sin_iniciar' })) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(VendorMisPedidosComponent);
    fix.detectChanges();
  }

  async function escribir(q: string): Promise<void> {
    const i = el().querySelector<HTMLInputElement>('input[type=search]');
    expect(i).toBeTruthy();
    i!.value = q;
    i!.dispatchEvent(new Event('input'));
    fix.detectChanges();
    await esperar();
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('MCP.28 con 2 letras o más busca en el servidor y la lista son los resultados (los días se esconden)', async () => {
    await montar();
    expect(botonEn(el(), 'Otro día')).toBeTruthy();
    await escribir('  lupita payaso ');
    expect(api['search']).toHaveBeenCalledWith('lupita payaso');
    expect(texto()).toContain('Resultados · 2');
    expect(texto()).toContain('Tuyos y de tu equipo · últimos 60 días');
    expect(texto()).toContain('PD-2026-00010'); // un cancelado de otro día
    expect(botonEn(el(), 'Otro día')).toBeUndefined();
  });

  it('MCP.33 la cámara lee la etiqueta del pedido (código de barras o QR) y busca ese folio', async () => {
    await montar();
    expect(el().querySelector('app-lector-codigo button')?.getAttribute('aria-label')).toBe('Leer la etiqueta de un pedido con la cámara');
    fix.componentInstance.alLeerEtiqueta('992026000020');
    fix.detectChanges();
    await esperar();
    fix.detectChanges();
    expect(api['search']).toHaveBeenCalledWith('PD-2026-00020');
    fix.componentInstance.alLeerEtiqueta('PD-2026-00010');
    await esperar();
    expect(api['search']).toHaveBeenLastCalledWith('PD-2026-00010');
  });

  it('MCP.36 la cámara lee la LIGA del QR nuevo (con su firma) y busca ese folio', async () => {
    await montar();
    fix.componentInstance.alLeerEtiqueta('https://megadulcessuite.com/pedido/PD-2026-00039?k=eyJhbGciOiJIUzI1NiJ9.x.y');
    fix.detectChanges();
    await esperar();
    expect(api['search']).toHaveBeenCalledWith('PD-2026-00039');
  });

  it('MCP.33 NEGATIVA: un código de producto no es etiqueta de pedido: lo dice y no busca', async () => {
    await montar();
    fix.componentInstance.alLeerEtiqueta('7501000111206');
    fix.detectChanges();
    await esperar();
    expect(api['search']).not.toHaveBeenCalled();
    expect(texto()).toContain('Leí «7501000111206» y no es la etiqueta de un pedido');
  });

  it('MCP.28 NEGATIVA: una sola letra no busca; borrar regresa al día', async () => {
    await montar();
    await escribir('l');
    expect(api['search']).not.toHaveBeenCalled();
    expect(botonEn(el(), 'Otro día')).toBeTruthy();
    await escribir('lu');
    expect(api['search']).toHaveBeenCalledTimes(1);
    clic(botonEn(el(), 'Borrar la búsqueda'));
    expect(botonEn(el(), 'Otro día')).toBeTruthy();
    expect(texto()).not.toContain('Resultados');
  });

  it('MCP.28 el pedido de alguien del equipo dice de quién es y es SÓLO para consultar (sin Modificar ni Cancelar)', async () => {
    await montar();
    await escribir('rosy');
    expect(tarjeta('o-equipo')?.textContent).toContain('de RUBEN PRUEBA');
    expect(botonEn(tarjeta('o-equipo'), 'Modificar')).toBeUndefined();
    clic(el().querySelector<HTMLButtonElement>('#mp-o-equipo .mp-card-h'));
    expect(tarjeta('o-equipo')?.textContent).toContain('Puedes consultarlo; los cambios los hace quien lo levantó');
    expect(botonEn(tarjeta('o-equipo'), 'Guardar cambios')).toBeUndefined();
  });

  it('MCP.28 sin señal lo DICE (no «sin resultados»)', async () => {
    await montar();
    api['search'].mockImplementation(() => throwError(() => ({ status: 0 })));
    await escribir('rosy');
    expect(texto()).toContain('Para buscar necesitas señal');
    expect(texto()).not.toContain('Ningún pedido');
  });

  /** Abre la tarjeta del día en modo edición y elige otro día en el calendario. */
  async function moverA(dia: string): Promise<void> {
    await montar();
    clic(botonEn(tarjeta('o-rosy'), 'Modificar'));
    await fix.whenStable();
    fix.detectChanges();
    clic(botonEn(tarjeta('o-rosy'), 'Cambiar'));
    const cal = el().querySelector<HTMLInputElement>('#ent-o-rosy');
    expect(cal?.min).toBe(HOY);
    cal!.value = dia;
    cal!.dispatchEvent(new Event('change'));
    fix.detectChanges();
  }

  it('⭐ MCP.29 sólo el día: cuenta como cambio, el motivo viene sugerido y se manda el día en el mismo guardado', async () => {
    await moverA('2026-10-18'); // domingo: el calendario es libre (D5)
    expect(texto()).toContain('1 cambio sin guardar');
    expect(texto()).toMatch(/domingo,? 18 (de )?oct/);
    clic(botonEn(tarjeta('o-rosy'), 'Guardar cambios'));
    const radio = Array.from(el().querySelectorAll<HTMLInputElement>('input[type=radio]')).find((r) => r.value === 'fecha');
    expect(radio?.checked).toBe(true);
    clic(botonEn(el().querySelector('app-vendor-motivo-sheet'), 'Guardar cambios'));
    expect(vendor.modificarPedido).toHaveBeenCalledWith('o-rosy', { reason_code: 'fecha' }, [], false, '2026-10-18');
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringMatching(/^Pedido movido al domingo/) }));
  });

  it('MCP.29 NEGATIVA: un día que ya pasó no se acepta (avisa y no cuenta como cambio)', async () => {
    await moverA('2026-10-13');
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn' }));
    expect(texto()).not.toContain('cambio sin guardar');
    expect(botonEn(tarjeta('o-rosy'), 'Guardar cambios')?.disabled).toBe(true);
  });

  it('MCP.29 NEGATIVA: con el día cambiado, «Agregar otro producto» pide guardar primero y no abre nada', async () => {
    await moverA('2026-10-16');
    clic(botonEn(tarjeta('o-rosy'), 'Agregar otro producto'));
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: 'Primero guarda el día de entrega' }));
    expect(el().querySelector('app-vendor-motivo-sheet')).toBeNull();
    expect(vendor.modificarPedido).not.toHaveBeenCalled();
  });

  it('MCP.29 «Descartar cambios» también regresa el día', async () => {
    await moverA('2026-10-16');
    clic(botonEn(tarjeta('o-rosy'), 'Descartar cambios'));
    expect(texto()).not.toContain('cambio sin guardar');
  });
});
