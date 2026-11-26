import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PedidoPublico } from '@megadulces/contracts';
import { PedidoPublicoComponent } from './pedido-publico.component';
import { PedidoPublicoService } from '../pedido-publico.service';
import { esRutaPublica } from '../../../core/auth/rutas-publicas';

const PEDIDO = (): PedidoPublico => ({
  folio: 'PD-2026-00039', paso: { clave: 'revisado', texto: 'Revisado, listo para entregar' },
  cliente: 'ABARROTES DE PRUEBA', vendedor: 'Vendedor de prueba', sucursal: 'Sucursal de prueba',
  entrega: '2026-11-26', creado: '2026-11-24T16:00:00.000Z',
  renglones: [
    { producto: 'PALETA DE PRUEBA', sku: '1', cantidad: 2, unidad: 'caja', precio: 50.25, importe: 100.5 },
    { producto: 'CHICLE DE PRUEBA', sku: '2', cantidad: 1, unidad: null, precio: null, importe: null },
  ],
  subtotal: 100.5, descuento: null, impuestos: 0, total: 100.5, moneda: 'MXN', liga_vence: '2026-12-25T16:00:00.000Z',
});

describe('[MCP.36] PedidoPublicoComponent · el pedido desde el QR de su etiqueta', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function montar(params: { folio?: string; k?: string }, respuesta: ReturnType<PedidoPublicoService['pedido']>) {
    const svc = { pedido: vi.fn(() => respuesta) };
    await TestBed.configureTestingModule({
      imports: [PedidoPublicoComponent],
      providers: [
        { provide: PedidoPublicoService, useValue: svc },
        { provide: ActivatedRoute, useValue: { snapshot: {
          paramMap: convertToParamMap(params.folio ? { folio: params.folio } : {}),
          queryParamMap: convertToParamMap(params.k ? { k: params.k } : {}),
        } } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(PedidoPublicoComponent);
    fix.detectChanges();
    const texto = (): string => (fix.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';
    return { svc, texto };
  }

  it('es una pantalla pública: no pide sesión', () => {
    expect(esRutaPublica('/pedido/PD-2026-00039?k=abc')).toBe(true);
  });

  it('muestra de quién es, en qué paso va, qué lleva y cuánto', async () => {
    const { svc, texto } = await montar({ folio: 'PD-2026-00039', k: 'firma' }, of(PEDIDO()));
    expect(svc.pedido).toHaveBeenCalledWith('PD-2026-00039', 'firma');
    const t = texto();
    expect(t).toContain('ABARROTES DE PRUEBA');
    expect(t).toContain('PD-2026-00039');
    expect(t).toContain('Revisado, listo para entregar');
    expect(t).toContain('jue 26 nov');
    expect(t).toContain('Productos');
    expect(t).toContain('Total');
    expect(t).toContain('PALETA DE PRUEBA');
    expect(t).toContain('$100.50');
    expect(t).not.toContain('Descuento'); // sin descuento no hay renglón
  });

  it('⛔ un monto que no llegó se dice «—», nunca $0.00', async () => {
    const { texto } = await montar({ folio: 'PD-2026-00039', k: 'firma' }, of(PEDIDO()));
    expect(texto()).toContain('CHICLE DE PRUEBA1 × ——');
    expect(texto()).not.toContain('CHICLE DE PRUEBA1 × $0.00');
  });

  it('negativa: una liga que ya no sirve se DICE con el motivo del servidor, no se muestra vacía', async () => {
    const { texto } = await montar({ folio: 'PD-2026-00039', k: 'mala' },
      throwError(() => ({ status: 403, error: { message: 'Esta etiqueta ya no abre el pedido. Pide al almacén que la vuelva a imprimir.' } })));
    expect(texto()).toContain('Esta etiqueta ya no abre el pedido');
    expect(texto()).not.toContain('ABARROTES');
  });

  it('negativa: sin la firma no se pregunta al servidor', async () => {
    const { svc, texto } = await montar({ folio: 'PD-2026-00039' }, of(PEDIDO()));
    expect(svc.pedido).not.toHaveBeenCalled();
    expect(texto()).toContain('La liga está incompleta');
  });
});
