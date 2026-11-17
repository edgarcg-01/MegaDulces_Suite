import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CierreCanceladaDialogComponent, type CierreHecho } from './cierre-cancelada-dialog.component';
import { ComprobacionesService, type ValeEsperaKepler } from '../comprobaciones.service';

/**
 * `[PGP.123]` G.UI.1e — El diálogo que cierra el caso de una cancelada en Kepler (pedido de Francisco, 2026-11-16).
 *
 * Lo que cuida: que «Ya lo revisé» no se guarde sin lo que se hizo (la misma regla que el servidor), que ligar mande
 * EXACTAMENTE el folio de la recaptura, que el rechazo por repetido nazca con su motivo y use el rechazo de siempre, que
 * un error del servidor se diga con su texto, y que «Cancelar» con algo escrito pregunte antes de tirarlo.
 */
const VALE = (over: Partial<ValeEsperaKepler> = {}): ValeEsperaKepler => ({
  id: 'v1', folio_solicitud: '0010142', sucursal: '00', proveedor: 'PROVEEDOR DEMO', importe: 0, importe_capturado: 5000,
  created_by: 'demo.capturista', validated_by: 'demo.revisor', revisado_at: '2026-10-01T10:00:00.000Z', dias: 40,
  espera: null, hallazgo: false, kepler_estado: 'C', cancelada_revisada: null,
  pista_cancelada: { forma_pago: 'efectivo', pagos: [], recapturas: [{ folio: '0010181', estado: 'N', fecha: '2026-10-07', con_vale: false }], gasto_vivo: null },
  ...over,
});

describe('[PGP.123] G.UI.1e CierreCanceladaDialogComponent', () => {
  let c: CierreCanceladaDialogComponent;
  let fix: ReturnType<typeof TestBed.createComponent<CierreCanceladaDialogComponent>>;
  let svc: { revisarCancelada: ReturnType<typeof vi.fn>; ligarCancelada: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> };
  let hechos: CierreHecho[];

  const montar = (modo: 'revisar' | 'ligar' | 'repetido', folio: string | null = null, vale = VALE()) => {
    fix = TestBed.createComponent(CierreCanceladaDialogComponent);
    c = fix.componentInstance;
    hechos = [];
    c.hecho.subscribe((e) => hechos.push(e));
    fix.componentRef.setInput('vale', vale);
    fix.componentRef.setInput('modo', modo);
    fix.componentRef.setInput('folio', folio);
    fix.componentRef.setInput('open', true);
    fix.detectChanges();
  };
  const escribir = (t: string) => { c.textoV = t; c.texto.set(t); };

  beforeEach(async () => {
    svc = {
      revisarCancelada: vi.fn(() => of({ id: 'v1', resultado: 'revisada', folio_solicitud: '0010142', por: 'X', nota: 'n' })),
      ligarCancelada: vi.fn(() => of({ id: 'v1', resultado: 'ligada', folio_solicitud: '0010181', por: 'X', nota: null })),
      reject: vi.fn(() => of({ id: 'v1', status: 'rechazada' })),
    };
    await TestBed.configureTestingModule({
      imports: [CierreCanceladaDialogComponent],
      providers: [{ provide: ComprobacionesService, useValue: svc }],
    }).compileComponents();
  });

  it('⛔ «Ya lo revisé» no se guarda sin lo que se hizo; con la nota, la manda y avisa', () => {
    montar('revisar');
    expect(c.falta()).toBe('qué se hizo o por qué se queda así');
    escribir('ok');
    expect(c.falta()).not.toBeNull();
    c.enviar();
    expect(svc.revisarCancelada).not.toHaveBeenCalled();
    escribir('Se volvió a capturar en Kepler como XA1501-0010200');
    expect(c.falta()).toBeNull();
    c.enviar();
    expect(svc.revisarCancelada).toHaveBeenCalledWith('v1', 'Se volvió a capturar en Kepler como XA1501-0010200');
    expect(hechos).toEqual([{ modo: 'revisar', id: 'v1', folio: null }]);
    expect(c.open()).toBe(false);
  });

  it('ligar manda exactamente el folio de la recaptura y lo dice en el botón', () => {
    montar('ligar', '0010181');
    expect(c.etiqueta()).toBe('Ligar a XA1501-0010181');
    expect(c.falta()).toBeNull();
    c.enviar();
    expect(svc.ligarCancelada).toHaveBeenCalledWith('v1', '0010181');
    expect(hechos[0]).toEqual({ modo: 'ligar', id: 'v1', folio: '0010181' });
  });

  it('rechazar por repetido nace con su motivo y usa el rechazo de siempre', () => {
    montar('repetido', '0010181');
    expect(c.texto()).toBe('Repetido: la recaptura XA1501-0010181 ya tiene su vale');
    c.enviar();
    expect(svc.reject).toHaveBeenCalledWith('v1', 'Repetido: la recaptura XA1501-0010181 ya tiene su vale');
    expect(hechos[0].modo).toBe('repetido');
  });

  it('⛔ un error del servidor se dice con su texto y el diálogo sigue abierto', () => {
    svc.revisarCancelada.mockReturnValueOnce(throwError(() => ({ error: { message: 'Este caso ya se revisó' } })));
    montar('revisar');
    escribir('Se capturó otra vez');
    c.enviar();
    expect(c.error()).toBe('Este caso ya se revisó');
    expect(c.open()).toBe(true);
    expect(hechos).toEqual([]);
  });

  it('⛔ «Cancelar» con algo escrito pregunta antes de tirarlo; sin nada, cierra', () => {
    montar('revisar');
    escribir('algo a medias');
    c.pedirCerrar();
    expect(c.confirmClose()).toBe(true);
    expect(c.open()).toBe(true);
    montar('ligar', '0010181');
    c.pedirCerrar();
    expect(c.open()).toBe(false);
  });

  it('muestra lo que la Suite averiguó y lo capturado (no el 0 de Kepler)', () => {
    montar('revisar');
    const t = fix.nativeElement.ownerDocument.body.textContent as string;
    expect(t).toContain('Pagado en efectivo según el vale');
    expect(t).toContain('Posible recaptura: XA1501-0010181');
    expect(t).toContain('$5,000.00');
  });
});
