import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { ComercialService, ExpedienteBranch } from '../../comercial/comercial.service';
import { TiendaCaducidadesExpedienteComponent } from './tienda-caducidades-expediente.component';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe(): void { /* jsdom */ } unobserve(): void { /* jsdom */ } disconnect(): void { /* jsdom */ } };
}

/**
 * `[P2.8.1]` El expediente se abre YA filtrado cuando llega desde «Capturas por día»:
 * `?fecha=AAAA-MM-DD&sucursal=NN`. La fecha se aplica al instante; la sucursal viaja como CÓDIGO
 * (la llave canónica) y se traduce a su id cuando llega la portada, y hasta entonces no se pide
 * nada — si no, la tabla pintaba «todas» un instante y saltaba.
 */
const SUC = (id: string, code: string): ExpedienteBranch => ({ id, code, name: `Suc ${code}`, hojas: 0, vencidos: 0, riesgosos: 0, ultima_captura: null });

describe('TiendaCaducidadesExpedienteComponent · llegar desde «Capturas por día»', () => {
  let fix: ComponentFixture<TiendaCaducidadesExpedienteComponent>;
  let cmp: TiendaCaducidadesExpedienteComponent;
  let pedidos: Array<{ warehouse_id?: string; from?: string; to?: string }>;
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  async function montar(qp: Record<string, string>, opts: { sucursalesFalla?: boolean } = {}): Promise<void> {
    pedidos = [];
    await TestBed.configureTestingModule({
      imports: [TiendaCaducidadesExpedienteComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(qp) } } },
        {
          provide: ComercialService,
          useValue: {
            expedienteBranches: () => (opts.sucursalesFalla
              ? throwError(() => new Error('sin red'))
              : of({ data: [SUC('id-01', '01'), SUC('id-03', '03')] })),
            listExpediente: (o: { warehouse_id?: string; from?: string; to?: string }) => {
              pedidos.push(o);
              return of({ data: [], pagination: { total: 0 } });
            },
          },
        },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaCaducidadesExpedienteComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
  }

  it('⭐ fecha + sucursal: UNA sola petición, ya con la sucursal traducida a su id y el día como desde=hasta', async () => {
    await montar({ fecha: '2026-10-15', sucursal: '03' });
    expect(pedidos).toHaveLength(1);                       // nada de «todas» primero y salto después
    expect(pedidos[0]).toMatchObject({ warehouse_id: 'id-03', from: '2026-10-15', to: '2026-10-15' });
  });

  it('sólo fecha: se pide de inmediato, sin sucursal', async () => {
    await montar({ fecha: '2026-10-15' });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].warehouse_id).toBeUndefined();
    expect(pedidos[0]).toMatchObject({ from: '2026-10-15', to: '2026-10-15' });
  });

  it('sin parámetros: el expediente se abre como siempre (sin filtros)', async () => {
    await montar({});
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatchObject({ warehouse_id: undefined, from: undefined, to: undefined });
  });

  it('⛔ una fecha mal formada (`ayer`) se ignora; una sucursal de un dígito tampoco filtra (cae igual que una desconocida: sin filtro)', async () => {
    await montar({ fecha: 'ayer', sucursal: '3' });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatchObject({ warehouse_id: undefined, from: undefined, to: undefined });
  });

  it('⛔ una fecha con forma de fecha pero imposible NO se corre sola a otra: se ignora', async () => {
    for (const fecha of ['2026-13-45', '2026-02-30']) {
      TestBed.resetTestingModule();
      await montar({ fecha });
      expect(pedidos).toHaveLength(1);
      expect(pedidos[0]).toMatchObject({ from: undefined, to: undefined });
    }
  });

  it('una sucursal que no está en la portada no deja la pantalla vacía: se muestra el día sin filtrar sucursal', async () => {
    await montar({ fecha: '2026-10-15', sucursal: '55' });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].warehouse_id).toBeUndefined();
    expect(pedidos[0]).toMatchObject({ from: '2026-10-15', to: '2026-10-15' });
  });

  it('si la portada falla, la tabla igual se carga (no se queda esperando a una sucursal que no llegó)', async () => {
    await montar({ fecha: '2026-10-15', sucursal: '03' }, { sucursalesFalla: true });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toMatchObject({ from: '2026-10-15', to: '2026-10-15' });
    expect(cmp.cargandoSuc()).toBe(false);
  });
});
