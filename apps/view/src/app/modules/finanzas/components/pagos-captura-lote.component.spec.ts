import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { PagosCapturaLoteComponent, FilaLote } from './pagos-captura-lote.component';
import { PagosComprobantesService, PagoCandidate } from '../pagos-comprobantes.service';

/**
 * `[PC.8]` — **Después de guardar, la lista se limpia.** Reportado en producción: tras guardar un lote
 * grande, las filas guardadas se quedaban en pantalla y había que salir y entrar a la página para
 * limpiarla. Lo guardado tiene que SALIR de la lista (lo validado ya no pide nada; lo que tiene
 * diferencias vive en la pestaña «Con diferencias»), y sólo deben quedarse las filas que aún
 * piden algo. Las pruebas negativas cuidan que no se pierda una fila que NO se guardó.
 */
const pago = (folio: string): PagoCandidate => ({
  sucursal: '00', folio, doc_prefix: 'XD2601', metodo_pago: 'transferencia', pago_date: '2026-09-29', pago_dia: '2026-09-29',
  proveedor_code: 'C1', proveedor_nombre: 'PROV', proveedor_rfc: null, concepto: null, monto: 100, deposits: 0,
});

let seq = 0;
const fila = (p: Partial<FilaLote>): FilaLote => ({
  id: ++seq, nombre: `f${seq}.pdf`, bytes: 10, dataUri: 'data:application/pdf;base64,AA==', fase: 'listo',
  ocr: { monto: 100, fecha: '2026-09-29', concepto: null, cuenta_origen: null, cuenta_destino: null, beneficiario: null, clave_rastreo: null, banco_destino: null, metodo: null, ocr_status: 'ok', sha256: 's' + seq },
  subido: { role: 'comprobante', url: 'k' }, candidatos: [], clasif: null, elegido: null, confirmado: false,
  busqueda: '', resultados: [], buscando: false, resultado: null, error: null, copiaDe: null, nota: null, ...p,
});

describe('[PC.8] PagosCapturaLoteComponent — la lista se limpia al guardar', () => {
  let attach: ReturnType<typeof vi.fn>;
  let comp: PagosCapturaLoteComponent;

  beforeEach(async () => {
    seq = 0;
    attach = vi.fn((b: { folio: string }) => of({
      id: 'x', sucursal: '00', folio: b.folio, monto_match: true,
      status: b.folio === 'DIF' ? 'recibido' : 'validado',
    }));
    await TestBed.configureTestingModule({
      imports: [PagosCapturaLoteComponent],
      providers: [{ provide: PagosComprobantesService, useValue: { attach, uploadFile: vi.fn(() => of({ role: 'comprobante', url: 'k' })) } }],
    }).compileComponents();
    comp = TestBed.createComponent(PagosCapturaLoteComponent).componentInstance;
  });

  it('las guardadas salen de la lista y queda el resumen', async () => {
    comp.filas.set([
      fila({ elegido: pago('A'), confirmado: true }),
      fila({ elegido: pago('B'), confirmado: true }),
      fila({ elegido: pago('DIF'), confirmado: true }),
    ]);
    const emitidos: unknown[] = [];
    comp.guardados.subscribe((e) => emitidos.push(e));
    await comp.guardar();
    expect(comp.filas()).toEqual([]);
    expect(comp.resumen()).toEqual({ guardados: 3, validados: 2, diferencias: 1 });
    expect(emitidos).toEqual([{ guardados: 3, validados: 2 }]);
  });

  it('⛔ se QUEDAN las que no se guardaron: sin pago y sin confirmar', async () => {
    const sinPago = fila({ elegido: null });
    const sinConfirmar = fila({ elegido: pago('C'), confirmado: false });
    comp.filas.set([fila({ elegido: pago('A'), confirmado: true }), sinPago, sinConfirmar]);
    await comp.guardar();
    expect(comp.filas().map((f) => f.id)).toEqual([sinPago.id, sinConfirmar.id]);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('⛔ si el servidor rechaza una, esa se queda (para reintentar) y las demás salen', async () => {
    attach.mockImplementation((b: { folio: string }) => (b.folio === 'MALA'
      ? throwError(() => ({ error: { message: 'pago no existe' } }))
      : of({ id: 'x', sucursal: '00', folio: b.folio, monto_match: true, status: 'validado' })));
    const mala = fila({ elegido: pago('MALA'), confirmado: true });
    comp.filas.set([fila({ elegido: pago('A'), confirmado: true }), mala]);
    await comp.guardar();
    expect(comp.filas().map((f) => f.id)).toEqual([mala.id]);
    expect(comp.filas()[0].fase).toBe('listo');
    expect(comp.resumen()).toEqual({ guardados: 1, validados: 1, diferencias: 0 });
    expect(comp.aviso()).toContain('pago no existe');
  });

  it('sin nada guardado no hay resumen ni evento', async () => {
    const emitidos: unknown[] = [];
    comp.guardados.subscribe((e) => emitidos.push(e));
    comp.filas.set([fila({ elegido: null })]);
    await comp.guardar();
    expect(comp.resumen()).toBeNull();
    expect(emitidos).toEqual([]);
  });

  it('«Ver con diferencias» avisa a la página', () => {
    let visto = false;
    comp.verDiferencias.subscribe(() => { visto = true; });
    comp.resumen.set({ guardados: 2, validados: 1, diferencias: 1 });
    comp.verDiferencias.emit();
    expect(visto).toBe(true);
  });
});

/**
 * `[PGP.130]` **Modo Calendario**: cada comprobante se casa primero con su pago del Calendario. Si casa, queda pagado
 * sin clic y no se busca en Kepler; si no, se sigue el carril de siempre con la MISMA lectura (sin leer otra vez).
 */
describe('[PGP.130] PagosCapturaLoteComponent — modo Calendario', () => {
  const lectura = { monto: 511359.31, fecha: '2026-11-09', concepto: null, cuenta_origen: '4176', cuenta_destino: null, beneficiario: 'PROV CAL',
    clave_rastreo: 'R1', banco_destino: null, metodo: 'SPEI', ocr_status: 'ok', sha256: 'h1' };
  const resp = (estado: string, motivo: string | null = null) => ({
    estado, pago_id: estado === 'sin_pago' ? null : 'p1', comprobante_id: estado === 'casa' ? 'c1' : null, motivo,
    lectura: { importe: lectura.monto, fecha: lectura.fecha, cuenta_origen: lectura.cuenta_origen, beneficiario: lectura.beneficiario, ocr_status: 'ok' },
    ocr: lectura,
  });
  let svc: Record<string, ReturnType<typeof vi.fn>>;
  let comp: PagosCapturaLoteComponent;
  const montar = async (calendario: boolean, calendarioResp: () => unknown) => {
    svc = {
      calendario: vi.fn(calendarioResp),
      ocr: vi.fn(() => of(lectura)),
      matchPago: vi.fn(() => of({ pagos: [] })),
      uploadFile: vi.fn(() => of({ role: 'comprobante', url: 'k' })),
      attach: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [PagosCapturaLoteComponent],
      providers: [{ provide: PagosComprobantesService, useValue: svc }],
    }).compileComponents();
    const fx = TestBed.createComponent(PagosCapturaLoteComponent);
    fx.componentRef.setInput('calendario', calendario);
    comp = fx.componentInstance;
  };
  const correr = async (p: Partial<FilaLote> = {}) => {
    const f = fila({ fase: 'en_cola', ocr: null, subido: null, ...p });
    comp.filas.set([f]);
    await comp['procesar'](f.id);
    return comp.filas()[0];
  };

  it('⭐ casa: queda «pagado» sin clic, avisa a la pantalla y NO lee otra vez ni busca en Kepler ni sube aparte', async () => {
    await montar(true, () => of(resp('casa')));
    const pagados: number[] = [];
    comp.pagadosCalendario.subscribe((n) => pagados.push(n));
    const f = await correr();
    expect(f.fase).toBe('pagado');
    expect(f.nota).toMatch(/PROV CAL/);
    expect(pagados).toEqual([1]);
    expect(svc['ocr']).not.toHaveBeenCalled();
    expect(svc['matchPago']).not.toHaveBeenCalled();
    expect(svc['uploadFile']).not.toHaveBeenCalled();   // el servidor ya lo subió al casar
  });

  it('no casa (pago fuera del Calendario): sigue con Kepler usando la MISMA lectura, sin nota', async () => {
    await montar(true, () => of(resp('sin_pago', 'Ningún pago…')));
    const f = await correr();
    expect(svc['ocr']).not.toHaveBeenCalled();
    expect(svc['matchPago']).toHaveBeenCalledWith(lectura.monto, lectura.fecha, lectura.concepto);
    expect(f.fase).toBe('listo');
    expect(f.ocr?.sha256).toBe('h1');
    expect(f.nota).toBeNull();
  });

  it('⛔ casa con un pago sin autorizar: lo dice y sigue con Kepler (no lo da por pagado)', async () => {
    await montar(true, () => of(resp('sin_autorizar', 'Ese pago no está autorizado')));
    const f = await correr();
    expect(f.fase).toBe('listo');
    expect(f.nota).toMatch(/Calendario: Ese pago no está autorizado/);
    expect(svc['matchPago']).toHaveBeenCalled();
  });

  it('⛔ el pago ya tenía comprobante: se marca repetido con el motivo y no se guarda nada', async () => {
    await montar(true, () => of(resp('ya_tiene', 'Ese pago ya tiene su comprobante.')));
    const f = await correr();
    expect(f.fase).toBe('duplicado');
    expect(f.nota).toMatch(/ya tiene su comprobante/);
    expect(svc['matchPago']).not.toHaveBeenCalled();
  });

  it('⛔ si el Calendario no responde (o no hay permiso), se dice y se sigue con el carril de siempre', async () => {
    await montar(true, () => throwError(() => ({ status: 403 })));
    const f = await correr();
    expect(f.nota).toMatch(/Sin permiso/);
    expect(svc['ocr']).toHaveBeenCalled();
    expect(f.fase).toBe('listo');
  });

  it('⛔ fuera del Calendario (página de Comprobantes) nunca se intenta el Calendario', async () => {
    await montar(false, () => of(resp('casa')));
    const f = await correr();
    expect(svc['calendario']).not.toHaveBeenCalled();
    expect(svc['ocr']).toHaveBeenCalled();
    expect(f.fase).toBe('listo');
  });
});
