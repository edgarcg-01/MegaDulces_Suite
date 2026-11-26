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
import { FichasClientesService, FichaClienteBandeja, AbonoBanco, FichaEnBanco } from '../deposito-cliente.service';

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

  // ── [CC.21] La columna «Banco» ─────────────────────────────────────────────────────────────────────────────────
  const abono = (o: Partial<AbonoBanco> = {}): AbonoBanco => ({
    id: 'm1', fecha: '2026-11-15', monto: 12500, banco: 'BBVA', cuenta: '4176', declarado: null, cobros: null, ...o,
  });
  const banco = (o: Partial<FichaEnBanco> = {}): FichaEnBanco => ({
    estado: 'aplicado', cargado_hasta: '2026-11-16', abonos: [abono()],
    cobro: { sucursal: '00', folio: '9001', cliente_code: 'C1', cliente_nombre: 'ABARROTES PEÑA' }, disputado_con: null, ...o,
  });
  const conFichas = (fichas: FichaClienteBandeja[], banco_medido = true) => {
    svc['bandeja'] = vi.fn(() => of({ estado: 'recibido', por_estado: { recibido: fichas.length }, fichas, banco_medido }));
  };

  it('5 · [CC.21] el banco confirma: veredicto en la fila y «Ligar a 9001» liga al cobro de la conciliación', () => {
    conFichas([ficha({ banco: banco() })]);
    const f = crear();
    expect(txt(f)).toContain('Entró al banco');
    expect(txt(f)).toContain('BBVA 4176');
    expect(txt(f)).toContain('1 ya entraron al banco');
    const btn = [...f.nativeElement.querySelectorAll('button')].find((b) => b.textContent?.includes('Ligar a 9001')) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(svc['ligar']).toHaveBeenCalledWith('f1', '00', '9001');
  });

  it('6 · [CC.21] «Ligar las N que el banco confirma» liga todas y dice cuáles fallaron', () => {
    conFichas([
      ficha({ id: 'a', banco: banco() }),
      ficha({ id: 'b', cliente_nombre: 'DULCERIA SOL', banco: banco({ cobro: { sucursal: '02', folio: '7', cliente_code: 'C1', cliente_nombre: null } }) }),
      ficha({ id: 'c', banco: banco({ disputado_con: 'a' }) }), // disputada: NO entra al lote
    ]);
    svc['ligar'] = vi.fn((id: string) => (id === 'b' ? throwError(() => ({ error: { message: 'x' } })) : of({ id, status: 'validado' })));
    const f = crear();
    f.componentInstance.ligarConfirmadas();
    expect(svc['ligar']).toHaveBeenCalledTimes(2);
    expect(svc['ligar']).toHaveBeenCalledWith('a', '00', '9001');
    f.detectChanges();
    expect(txt(f)).toContain('Se ligaron 1 de 2');
    expect(txt(f)).toContain('DULCERIA SOL');
  });

  it('7 · [CC.21] el abono es de OTRO cliente: alerta y no se ofrece ligar a ese cobro', () => {
    conFichas([ficha({ banco: banco({ estado: 'de_otro_cliente', cobro: null, abonos: [abono({ cobros: [{ sucursal: '00', folio: '5', tipo: 'U-A-5', cliente_code: 'C9', cliente_nombre: 'OTRO SA' }] })] }) })]);
    const f = crear();
    expect(txt(f)).toContain('El abono es de otro cliente');
    expect(txt(f)).toContain('OTRO SA');
    expect(txt(f)).not.toContain('Ligar a 5');
  });

  it('8 · [CC.21] sin abono: «no aparece» sólo si el banco ya está cargado; si no, dice hasta cuándo', () => {
    conFichas([
      ficha({ id: 'a', banco: banco({ estado: 'no_aparece', abonos: [], cobro: null, cargado_hasta: '2026-11-20' }) }),
      ficha({ id: 'b', banco: banco({ estado: 'banco_sin_cargar', abonos: [], cobro: null, cargado_hasta: '2026-11-10' }) }),
    ]);
    const f = crear();
    expect(txt(f)).toContain('No aparece en el banco');
    expect(txt(f)).toContain('Aún no se puede revisar');
    expect(txt(f)).toContain('llega hasta el 2026-11-10');
  });

  it('9 · [CC.21] entró sin cobro en Kepler: «Marcar el abono como suyo» llama al servidor', () => {
    svc['declararAbono'] = vi.fn(() => of({ ok: true, bank_movement_id: 'm1', customer_code: 'C1' }));
    conFichas([ficha({ banco: banco({ estado: 'sin_aplicar', cobro: null }) })]);
    const f = crear();
    expect(txt(f)).toContain('Entró al banco, sin cobro en Kepler');
    f.componentInstance.declararAbono(ficha());
    expect(svc['declararAbono']).toHaveBeenCalledWith('f1');
  });

  it('11 · [CC.22] ⛔ marcado NO es cobrado: dice que falta capturarlo en Kepler', () => {
    // El caso real del 2026-11-23 ($15,539.63, cuadra con el banco, sin cobro en Kepler dos dias despues):
    // decia solo «ya esta marcado como de este cliente» y quien lo presiona puede creer que termino.
    conFichas([ficha({ cliente_code: 'C1', banco: banco({ estado: 'sin_aplicar', cobro: null, abonos: [{ id: 'a1', monto: 100, declarado: 'C1', cobros: [] }] }) })]);
    const f = crear();
    expect(txt(f)).toContain('Marcado como de este cliente');
    expect(txt(f)).toContain('Falta capturar el cobro en Kepler');
    expect(txt(f)).toContain('no recibe complemento de pago');
    // Y el boton ya no se ofrece: el abono ya esta declarado como suyo.
    expect(txt(f)).not.toContain('Marcar el abono como suyo');
  });
  it('10 · [CC.21] ⛔ si la consulta al banco falló se dice, no se pinta «no aparece»', () => {
    conFichas([ficha({ banco: null })], false);
    const f = crear();
    expect(txt(f)).toContain('No se pudo revisar el banco ahora');
    expect(txt(f)).not.toContain('No aparece en el banco');
  });
});
