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

function montar(opts: { ver?: boolean; autorizar?: boolean; pend?: RequisitionRow[]; todo?: RequisitionRow[] }) {
  const api = {
    listRequisitions: vi.fn((q: { estado?: string }) => of({
      total: q.estado ? (opts.pend ?? []).length : (opts.todo ?? []).length + (opts.pend ?? []).length,
      page: 1, pageSize: 100, resumen: [],
      rows: q.estado ? (opts.pend ?? []) : [...(opts.pend ?? []), ...(opts.todo ?? [])],
    })),
    bulkRequisiciones: vi.fn(() => of({ pedidas: 1, hechas: 1, ok: ['a'], fallas: [] })),
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

  it('NEGATIVA: sin permiso de ver requisiciones, ni se pinta ni se pide nada', () => {
    const { f, api } = montar({ ver: false });
    expect((f.nativeElement as HTMLElement).textContent?.trim()).toBe('');
    expect(api.listRequisitions).not.toHaveBeenCalled();
  });
});
