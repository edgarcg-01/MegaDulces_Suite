/**
 * `[CC.20]` La bandeja de Cobranza con las fichas que subieron los clientes:
 *  1. Abre en «Por revisar», con los conteos en el selector y lo declarado junto a lo que leyó la Suite.
 *  2. «Ligar al cobro» muestra los cobros candidatos y liga el elegido; después recarga.
 *  3. «Rechazar» exige un motivo (el cliente lo lee) y lo manda tal cual.
 *  4. ⛔ Un error al ligar SE DICE.
 */
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { FichasClientesComponent } from './fichas-clientes.component';
import { FichasClientesService, FichaClienteBandeja } from '../deposito-cliente.service';

const ficha = (o: Partial<FichaClienteBandeja> = {}): FichaClienteBandeja => ({
  id: 'f1', status: 'recibido', cuenta_sucursal: '01', cliente_code: 'C1', cliente_nombre: 'ABARROTES PEÑA',
  files: [{ url: 'https://s3/firmada', kind: 'image' }], sucursal: '01', folio: null, monto: 12500, fecha: '2026-11-15',
  nota: 'pago factura 4820', ocr_monto: 12500, ocr_fecha: '2026-11-15', ocr_banco: 'BBVA', ocr_referencia: '123',
  ocr_status: 'ok', monto_match: true, motivo_rechazo: null, validated_by: null, validated_at: null,
  enviado: new Date().toISOString(), ...o,
});

describe('FichasClientesComponent — [CC.20]', () => {
  let svc: Record<string, ReturnType<typeof vi.fn>>;
  afterEach(() => TestBed.resetTestingModule());
  beforeEach(() => {
    svc = {
      bandeja: vi.fn(() => of({ estado: 'recibido', por_estado: { recibido: 1, validado: 4, rechazado: 0 }, fichas: [ficha()] })),
      candidatos: vi.fn(() => of({ cobros: [{ sucursal: '00', folio: '9001', cobro_date: '2026-11-16', cliente_code: 'C1', cliente_nombre: 'ABARROTES PEÑA', forma_pago: 'deposito', monto: 12500, deposits: 0, del_cliente: true }] })),
      ligar: vi.fn(() => of({ id: 'f1', status: 'validado' })),
      rechazar: vi.fn(() => of({ id: 'f1', status: 'rechazado' })),
    };
  });
  function crear() {
    TestBed.configureTestingModule({
      imports: [FichasClientesComponent],
      providers: [provideZonelessChangeDetection(), { provide: FichasClientesService, useValue: svc }],
    });
    const f = TestBed.createComponent(FichasClientesComponent);
    f.detectChanges();
    return f;
  }
  const txt = (f: { nativeElement: HTMLElement }) => f.nativeElement.textContent || '';

  it('1 · abre en «Por revisar» con conteos, lo declarado y lo que leyó la foto', () => {
    const f = crear();
    expect(svc['bandeja']).toHaveBeenCalledWith('recibido');
    expect(txt(f)).toContain('Por revisar (1)');
    expect(txt(f)).toContain('Ligadas (4)');
    expect(txt(f)).toContain('ABARROTES PEÑA');
    expect(txt(f)).toContain('Cuadra');
    expect(txt(f)).toContain('«pago factura 4820»');
  });

  it('2 · ligar al cobro elegido y recargar', () => {
    const f = crear();
    const c = f.componentInstance;
    c.abrirLigar(ficha());
    f.detectChanges();
    expect(txt(f)).toContain('9001');
    c.ligar(ficha(), { sucursal: '00', folio: '9001', cobro_date: null, cliente_code: 'C1', cliente_nombre: null, forma_pago: null, monto: 12500, deposits: 0, del_cliente: true });
    expect(svc['ligar']).toHaveBeenCalledWith('f1', '00', '9001');
    expect(svc['bandeja']).toHaveBeenCalledTimes(2);
  });

  it('3 · rechazar exige motivo y lo manda tal cual', () => {
    const f = crear();
    const c = f.componentInstance;
    c.abrirRechazo(ficha());
    c.motivo = 'no';
    c.rechazar(ficha());
    expect(svc['rechazar']).not.toHaveBeenCalled();
    c.motivo = 'La foto no se lee, súbela otra vez';
    c.rechazar(ficha());
    expect(svc['rechazar']).toHaveBeenCalledWith('f1', 'La foto no se lee, súbela otra vez');
  });

  it('4 · ⛔ un error al ligar se dice', () => {
    svc['ligar'] = vi.fn(() => throwError(() => ({ error: { message: 'el cobro 00/9001 no está en el espejo de Kepler' } })));
    const f = crear();
    f.componentInstance.ligar(ficha(), { sucursal: '00', folio: '9001', cobro_date: null, cliente_code: 'C1', cliente_nombre: null, forma_pago: null, monto: 1, deposits: 0, del_cliente: true });
    f.detectChanges();
    expect(txt(f)).toContain('no está en el espejo de Kepler');
  });
});
