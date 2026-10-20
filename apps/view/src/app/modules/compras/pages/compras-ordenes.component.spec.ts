import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ComprasOrdenesComponent } from './compras-ordenes.component';
import { ComprasService } from '../compras.service';
import { MultitareaService } from '../../../core/services/multitarea.service';
import { AuthService } from '../../../core/services/auth.service';

/**
 * `[OC.1]` + `[OC.3]` — agrupar por proveedor, filtrar por proveedor e imprimir el pedido.
 *
 * ⛔ Lo que estas pruebas defienden NO es el dibujo del PDF (eso vive en
 * `orden-proveedor-pdf.spec.ts`, sin jsPDF) sino **de dónde sale cada número**: que el agrupado
 * lo pida al SERVIDOR y no lo calcule sobre la página —la lista viene de 50 en 50 sobre 152
 * órdenes, así que agrupar la página daría totales incompletos sin avisar— y que un proveedor
 * sin renglones lo DIGA en vez de bajar un papel en blanco.
 */

const GRUPO = {
  supplier_id: 'aa11bb22-0000-4000-8000-000000000001',
  supplier_code: 'CD015',
  supplier_name: 'DISTRIBUIDORA DE LA ROSA',
  ordenes: 2, unidades: 88, pendiente: 88, importe: 117072.56,
  mas_vieja: '2026-10-10T10:00:00Z', proxima_entrega: '2026-10-24', estados: ['open'],
};

function doble(over: Partial<Record<string, unknown>> = {}) {
  return {
    listPurchaseOrders: vi.fn().mockReturnValue(of({ total: 0, page: 1, pageSize: 50, rows: [] })),
    ordenesPorProveedor: vi.fn().mockReturnValue(of({ estados: ['open', 'partial'], total: 1, rows: [GRUPO] })),
    consolidadoProveedor: vi.fn().mockReturnValue(of({
      supplier: { id: GRUPO.supplier_id, code: 'CD015', name: GRUPO.supplier_name },
      estados: ['open', 'partial'],
      ordenes: [{ id: 'x', folio: 'OC-2026-00412', estado: 'open', expected_date: '2026-10-24', total_cost: 1, created_at: '', warehouse_code: '00' }],
      lineas: [],
      totales: { ordenes: 1, renglones: 0, cantidad: 0, pendiente: 0, importe: 0 },
    })),
    filters: vi.fn().mockReturnValue(of({ warehouses: [], suppliers: [{ id: GRUPO.supplier_id, name: GRUPO.supplier_name, code: 'CD015' }] })),
    ...over,
  };
}

async function montar(api: ReturnType<typeof doble>) {
  TestBed.configureTestingModule({
    imports: [ComprasOrdenesComponent],
    providers: [
      provideRouter([]),
      MessageService,
      { provide: ComprasService, useValue: api },
      { provide: MultitareaService, useValue: { enlaceDetalle: (c: unknown[]) => c, target: () => '_self' } },
      { provide: AuthService, useValue: { user: () => ({ username: 'arizbeth_gonzalez' }) } },
    ],
  });
  const f = TestBed.createComponent(ComprasOrdenesComponent);
  f.detectChanges();
  await f.whenStable();
  return f;
}

describe('[OC.1] /compras/ordenes agrupadas por proveedor', () => {
  it('⭐ abre en «Por proveedor» y el agrupado lo pide al SERVIDOR, no a la página', async () => {
    const api = doble();
    const f = await montar(api);
    expect(f.componentInstance.vista()).toBe('proveedor');
    expect(api.ordenesPorProveedor).toHaveBeenCalled();
    // ⛔ La lista plana NO se pide en esta vista: pedirla sería traer 50 filas para agrupar mal.
    expect(api.listPurchaseOrders).not.toHaveBeenCalled();
    expect(f.componentInstance.grupos().length).toBe(1);
  });

  it('el filtro de proveedor se llena del catálogo y recorta el agrupado', async () => {
    const api = doble();
    const f = await montar(api);
    expect(f.componentInstance.proveedorOpts()).toEqual([{ label: 'CD015 · DISTRIBUIDORA DE LA ROSA', value: GRUPO.supplier_id }]);

    f.componentInstance.fProveedor = 'otro-id-que-no-existe';
    f.componentInstance.reload();
    await f.whenStable();
    expect(f.componentInstance.grupos().length).toBe(0);
  });

  it('«Ver órdenes» pasa a la lista plana YA filtrada por ese proveedor', async () => {
    const api = doble();
    const f = await montar(api);
    f.componentInstance.verDocumentos(GRUPO as never);
    await f.whenStable();
    expect(f.componentInstance.vista()).toBe('documento');
    expect(api.listPurchaseOrders).toHaveBeenCalledWith(expect.objectContaining({ supplier_id: GRUPO.supplier_id }));
  });

  it('⭐ una falla de carga NO se lee como «no hay proveedores»', async () => {
    const api = doble({ ordenesPorProveedor: vi.fn().mockReturnValue(throwError(() => new Error('500'))) });
    const f = await montar(api);
    expect(f.componentInstance.errorGrupos()).toBe(true);
    expect(f.componentInstance.grupos().length).toBe(0);
  });
});

describe('[OC.3] imprimir el pedido del proveedor', () => {
  it('⛔ sin renglones pendientes AVISA, y no baja un papel en blanco', async () => {
    const api = doble();
    const f = await montar(api);
    // El componente provee su PROPIO MessageService (providers: [MessageService]), asi que
    // TestBed.inject devuelve otra instancia y el espia nunca ve nada. Se toma el del componente.
    const add = vi.spyOn(f.debugElement.injector.get(MessageService), 'add');

    f.componentInstance.imprimir(GRUPO as never);
    await f.whenStable();

    expect(api.consolidadoProveedor).toHaveBeenCalledWith(GRUPO.supplier_id, undefined);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn' }));
    // Y se suelta el candado: si no, el botón queda muerto para siempre.
    expect(f.componentInstance.bajando()).toBeNull();
  });

  it('⭐ el CSV sale del MISMO consolidado que el PDF, no de otra llamada', async () => {
    // Si cada botón pidiera lo suyo, dos descargas con segundos de diferencia podrían no
    // coincidir y nadie sabría cuál de los dos papeles creer.
    const api = doble();
    const f = await montar(api);
    f.componentInstance.descargarCsv(GRUPO as never);
    await f.whenStable();
    expect(api.consolidadoProveedor).toHaveBeenCalledWith(GRUPO.supplier_id, undefined);
    expect(f.componentInstance.bajando()).toBeNull();
  });

  it('respeta el filtro de estado al pedir el consolidado', async () => {
    const api = doble();
    const f = await montar(api);
    f.componentInstance.fEstado = 'partial';
    f.componentInstance.imprimir(GRUPO as never);
    await f.whenStable();
    expect(api.consolidadoProveedor).toHaveBeenCalledWith(GRUPO.supplier_id, 'partial');
  });

  it('⭐ si el servidor falla, lo dice y deja volver a intentar', async () => {
    const api = doble({ consolidadoProveedor: vi.fn().mockReturnValue(throwError(() => new Error('500'))) });
    const f = await montar(api);
    const add = vi.spyOn(f.debugElement.injector.get(MessageService), 'add');

    f.componentInstance.imprimir(GRUPO as never);
    await f.whenStable();

    expect(add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
    expect(f.componentInstance.bajando()).toBeNull();
  });
});
