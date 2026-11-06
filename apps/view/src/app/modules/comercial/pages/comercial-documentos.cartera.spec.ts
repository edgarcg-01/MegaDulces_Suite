import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ComercialDocumentosComponent } from './comercial-documentos.component';
import { SalesDocumentsService, type SalesDocRow, type SalesDocsReport } from '../sales-documents.service';
import { DataScopeService } from '../../../core/services/data-scope.service';

/**
 * `[AX.20]` «Toda su cartera»: se palomea una factura y la guía se completa con lo que ese
 * cliente le debe a ese vendedor, de cualquier fecha.
 *
 * Lo que se fija: pide por cliente + vendedor + sucursal, sin la ventana de la tabla y sólo lo
 * que se debe; SUMA a lo palomeado sin duplicar; lo que no está en la cartera no se agrega a
 * ciegas; con vendedores mezclados no hace nada; si falla, lo palomeado queda igual.
 */

const ROW = (folio: string, over: Partial<SalesDocRow> = {}) => ({
  folio_digital: folio, sucursal: '06', cliente_code: 'C1015', cliente_nombre: 'ABARROTES X',
  vendedor_code: '10001', vendedor_nombre: 'DANIEL', total: '1000.00', saldo: '1000.00',
  estatus_cobro: 'pendiente', ...over,
}) as unknown as SalesDocRow;

const REP = (rows: SalesDocRow[], documentos = rows.length) =>
  ({ rows, kpis: { documentos } }) as unknown as SalesDocsReport;

describe('[AX.20] ComercialDocumentosComponent · Toda su cartera', () => {
  let c: ComercialDocumentosComponent;
  let list: ReturnType<typeof vi.fn>;
  let toast: { add: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    list = vi.fn(() => NEVER);
    await TestBed.configureTestingModule({
      imports: [ComercialDocumentosComponent],
      providers: [
        provideRouter([]),
        { provide: SalesDocumentsService, useValue: { list, filtros: () => NEVER, embarquesSinFactura: () => NEVER } },
        { provide: DataScopeService, useValue: { warehouses: () => of([]) } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(ComercialDocumentosComponent);
    c = fix.componentInstance;
    // El MessageService es del componente (providers), no el del TestBed.
    toast = fix.debugElement.injector.get(MessageService) as unknown as { add: ReturnType<typeof vi.fn> };
    vi.spyOn(toast, 'add');
    list.mockClear(); // la carga inicial de la tabla no es de esta acción
  });

  it('pide la cartera del cliente con ese vendedor, de cualquier fecha y sólo lo que se debe', () => {
    c.sel.set([ROW('06UD0801-0000001')]);
    list.mockReturnValue(of(REP([])));
    c.completarCartera();
    const q = list.mock.lastCall![0];
    expect(q).toMatchObject({ cliente_code: 'C1015', vendedor_code: '10001', warehouse_codes: '06',
      cobro: 'pendiente,parcial,sin_cartera', from: '2020-01-01', pageSize: 500 });
  });

  it('SUMA a lo palomeado sin duplicar, y dice cuánto se agregó', () => {
    const ya = ROW('06UD0801-0000001');
    c.sel.set([ya]);
    list.mockReturnValue(of(REP([ya, ROW('06UD0801-0000002', { saldo: '250.50' }), ROW('06UD0801-0000003', { saldo: '100.00' })])));
    c.completarCartera();
    expect(c.sel().map((d) => d.folio_digital)).toEqual(['06UD0801-0000001', '06UD0801-0000002', '06UD0801-0000003']);
    expect(toast.add.mock.lastCall![0].detail).toContain('Se agregaron 2 facturas con saldo por $350.50');
  });

  it('NEGATIVA — lo que no está en la cartera NO se agrega: se dice', () => {
    c.sel.set([ROW('06UD0801-0000001')]);
    list.mockReturnValue(of(REP([ROW('06UD0801-0000009', { estatus_cobro: 'sin_cartera', saldo: null })])));
    c.completarCartera();
    expect(c.sel()).toHaveLength(1);
    const t = toast.add.mock.lastCall![0];
    expect(t.severity).toBe('warn');
    expect(t.detail).toContain('1 no aparece en la cartera');
  });

  it('NEGATIVA — con vendedores mezclados no consulta nada', () => {
    c.sel.set([ROW('06UD0801-0000001'), ROW('06UD0801-0000002', { vendedor_code: '20002' })]);
    c.completarCartera();
    expect(list).not.toHaveBeenCalled();
  });

  it('un cliente por consulta: dos clientes del mismo vendedor piden dos carteras', () => {
    c.sel.set([ROW('06UD0801-0000001'), ROW('06UD0801-0000002', { cliente_code: 'C2000' })]);
    list.mockReturnValue(of(REP([])));
    c.completarCartera();
    expect(list.mock.calls.map((x) => x[0].cliente_code)).toEqual(['C1015', 'C2000']);
  });

  it('declara el tope: si el cliente debe más de lo que vino, lo dice', () => {
    c.sel.set([ROW('06UD0801-0000001')]);
    list.mockReturnValue(of(REP([ROW('06UD0801-0000002')], 612)));
    c.completarCartera();
    expect(toast.add.mock.lastCall![0].detail).toContain('más de 500');
  });

  it('NEGATIVA — si falla, lo palomeado queda igual y se dice', () => {
    c.sel.set([ROW('06UD0801-0000001')]);
    list.mockReturnValue(throwError(() => ({ error: { message: 'timeout' } })));
    c.completarCartera();
    expect(c.sel()).toHaveLength(1);
    expect(c.busy()).toBeNull();
    expect(toast.add.mock.lastCall![0].severity).toBe('error');
  });
});
