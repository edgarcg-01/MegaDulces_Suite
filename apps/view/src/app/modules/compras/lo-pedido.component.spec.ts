import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { of } from 'rxjs';
import { LoPedidoComponent } from './lo-pedido.component';
import { ComprasService, type RequisitionRow } from './compras.service';
import { PermissionsService } from '../../core/services/permissions.service';

/** `[PQ.28]` «Lo pedido»: lo que salió de Pedido, sin salir de Pedido. */
const fila = (o: Partial<RequisitionRow>): RequisitionRow => ({
  id: 'id-' + (o.folio ?? 'x'), folio: 'RQ-1', estado: 'approved', source_type: 'supplier', total_cost: 1000,
  created_at: '2026-10-29T10:00:00Z', warehouse_code: '00', warehouse_name: 'CEDIS', supplier_name: 'PEPSICO',
  ...o,
} as RequisitionRow);

function montar(opts: { ver?: boolean; autorizar?: boolean; pend?: RequisitionRow[]; todo?: RequisitionRow[]; pendTotal?: number; resumenCompras?: unknown[] | null }) {
  const api = {
    listRequisitions: vi.fn((q: { estado?: string; source_type?: string }) => of({
      total: q.estado ? (opts.pendTotal ?? (opts.pend ?? []).length) : (opts.todo ?? []).length + (opts.pend ?? []).length,
      page: 1, pageSize: 100,
      // `[PQ.31]` La tercera llamada (source_type=supplier) trae el resumen de COMPRAS sobre todas.
      resumen: q.source_type === 'supplier' ? (opts.resumenCompras === undefined ? [] : opts.resumenCompras) : [],
      rows: q.estado ? (opts.pend ?? []) : [...(opts.pend ?? []), ...(opts.todo ?? [])],
    })),
    bulkRequisiciones: vi.fn(() => of({ pedidas: 1, hechas: 1, ok: ['a'], fallas: [] })),
    getRequisition: vi.fn((id: string) => of({ id, lines: [{ id: 'l1', sku: '123', nombre: 'PALETA', destination_warehouse_name: 'CEDIS', final_qty: 4, line_cost: 400 }] })),
    openPurchaseOrderDetail: vi.fn(() => of({ orden: { folio: '0007264', monto: 1000 }, recibido: 0, pct_surtido: 0 })),
  };
  const perms = {
    isAdmin: () => false,
    has: (p: string) => (p === 'COMPRAS_REQUISICIONES_VER' ? opts.ver !== false : p === 'COMPRAS_REQUISICIONES_AUTORIZAR' ? !!opts.autorizar : false),
  };
  TestBed.configureTestingModule({
    imports: [LoPedidoComponent],
    providers: [provideRouter([]), MessageService, { provide: ComprasService, useValue: api }, { provide: PermissionsService, useValue: perms }],
  });
  const f = TestBed.createComponent(LoPedidoComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, api };
}

describe('[PQ.28] Lo pedido', () => {
  it('el botón dice cuántas esperan aprobación', () => {
    const { f } = montar({ pend: [fila({ folio: 'RQ-9', estado: 'pending_approval' })] });
    expect((f.nativeElement as HTMLElement).textContent).toContain('1 por aprobar');
  });

  it('lo de Kepler va ESCRITO: requisición y OC, o el motivo completo', () => {
    const { c } = montar({});
    expect(c.enKepler(fila({ kepler_folio: '0003115', oc_folio: '0007264' }))).toBe('Requisición 0003115 · OC 0007264');
    expect(c.enKepler(fila({ kepler_folio: '0003115' }))).toBe('Requisición 0003115 · sin OC todavía');
    expect(c.enKepler(fila({ kepler_error: 'Kepler (sucursal 08) no tiene al proveedor 168' }))).toContain('proveedor 168');
  });

  it('con permiso de autorizar, «Aprobar todas» manda TODAS las pendientes de un clic', () => {
    const p = [fila({ id: 'a', folio: 'RQ-1', estado: 'pending_approval' }), fila({ id: 'b', folio: 'RQ-2', estado: 'pending_approval' })];
    const { c, api } = montar({ autorizar: true, pend: p });
    c.aprobar(c.porAprobar());
    expect(api.bulkRequisiciones).toHaveBeenCalledWith(['a', 'b'], 'approve');
  });

  it('NEGATIVA: sin permiso de autorizar no hay botón de aprobar (control: con permiso, sí)', () => {
    const con = montar({ autorizar: true, pend: [fila({ estado: 'pending_approval' })] });
    con.c.abrir(); con.f.detectChanges();
    expect(document.body.textContent ?? '').toContain('y enviar a Kepler');
    con.f.destroy(); TestBed.resetTestingModule();
    const sin = montar({ autorizar: false, pend: [fila({ estado: 'pending_approval' })] });
    sin.c.abrir(); sin.f.detectChanges();
    expect(document.body.textContent ?? '').not.toContain('y enviar a Kepler');
    expect(document.body.textContent ?? '').toContain('Las aprueba quien tiene permiso');
  });

  it('NEGATIVA: un pedido de SUCURSAL no se rechaza sin motivo', () => {
    const r = fila({ id: 'z', estado: 'pending_approval', requested_by_branch: true });
    const { c, api } = montar({ autorizar: true, pend: [r] });
    c.motivo = '  ';
    c.rechazar(r);
    expect(api.bulkRequisiciones).not.toHaveBeenCalled();
  });

  // ── `[PQ.31]` Lo que encontró la auditoría del 2026-10-29 ──────────────────────────────────
  it('un traspaso con la escritura APAGADA no es una falla: gris y sin prometer (68 de 100 salían en rojo)', () => {
    const { c } = montar({});
    const apagado = fila({ source_type: 'branch', kepler_folio: null, kepler_error: 'La escritura a Kepler de la sucursal 00 está apagada (falta KEPLER_PUSH_URL_00)' });
    expect(c.keplerApagado(apagado)).toBe(true);
    expect(c.malEnKepler(apagado)).toBe(false);
    expect(c.enKepler(apagado)).toBe('sale cuando se encienda su escritura a Kepler');
    // NEGATIVA: una falla de verdad sigue en rojo y con su motivo completo.
    const falla = fila({ kepler_folio: null, kepler_error: 'Kepler (sucursal 04) no conoce al proveedor CA027' });
    expect(c.malEnKepler(falla)).toBe(true);
    expect(c.enKepler(falla)).toContain('CA027');
  });

  it('en Kepler el traspaso es un PEDIDO, no una requisición', () => {
    const { c } = montar({});
    expect(c.enKepler(fila({ source_type: 'branch', kepler_folio: '0000077' }))).toBe('Pedido 0000077');
  });

  it('las cifras cuentan COMPRAS y sobre TODAS, no sobre las 100 de la ventana', () => {
    const { c } = montar({
      todo: [fila({ source_type: 'branch', estado: 'approved' }), fila({ estado: 'approved' })],
      resumenCompras: [{ estado: 'approved', n: 3 }, { estado: 'ordered', n: 155 }, { estado: 'received', n: 34 }],
    });
    const v = Object.fromEntries(c.cifras().map((x) => [x.label, x.value]));
    expect(v['Compras aprobadas sin OC']).toBe(3);   // no 2: ni el traspaso ni sólo la ventana
    expect(v['Compras recibidas']).toBe(34);
  });

  it('NEGATIVA: sin resumen del servidor las cifras se DECLARAN no medidas, nunca 0', () => {
    const { c } = montar({ resumenCompras: null });
    const k = c.cifras().find((x) => x.label === 'Compras recibidas')!;
    expect(k.value).toBe('—');
    expect(k.state).toBe('no_medido');
  });

  it('el tope de «por aprobar» se dice: el conteo es del universo, no de las 200 traídas', () => {
    const { c } = montar({ pend: [fila({ estado: 'pending_approval' })], pendTotal: 250 });
    expect(c.totalPorAprobarN()).toBe(250);
  });

  it('el folio abre el detalle AQUÍ (y la OC trae su surtido), no en otra pantalla', () => {
    const r = fila({ id: 'rq1', oc_sucursal: '00', oc_folio: '0007264' });
    const { c, api } = montar({ todo: [r] });
    c.verDetalle(r);
    expect(api.getRequisition).toHaveBeenCalledWith('rq1');
    expect(api.openPurchaseOrderDetail).toHaveBeenCalledWith('00', '0007264');
    expect(c.detalle()?.lines.length).toBe(1);
    c.verDetalle(r);                                  // segundo clic: se cierra
    expect(c.detalleDe()).toBeNull();
  });

  it('NEGATIVA: un traspaso no pide surtido de OC (no tiene)', () => {
    const r = fila({ id: 'tr1', source_type: 'branch', oc_sucursal: '01', oc_folio: '0000077' });
    const { c, api } = montar({ todo: [r] });
    c.verDetalle(r);
    expect(api.openPurchaseOrderDetail).not.toHaveBeenCalled();
  });

  it('NEGATIVA: sin permiso de ver requisiciones, ni se pinta ni se pide nada', () => {
    const { f, api } = montar({ ver: false });
    expect((f.nativeElement as HTMLElement).textContent?.trim()).toBe('');
    expect(api.listRequisitions).not.toHaveBeenCalled();
  });
});
