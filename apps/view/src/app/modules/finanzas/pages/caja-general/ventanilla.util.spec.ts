import type { VeredictoDePago } from '@megadulces/contracts';
import type { MovimientoPendiente } from '../../cash-ledger.service';
import { armarCola, filaDe, resumenCola } from './ventanilla.util';

/** `[LE.2.13]` La cola de la Ventanilla: el orden de la tarea y el porqué de cada fila. */
const doc = (folio: string, monto: number, over: Partial<MovimientoPendiente> = {}): MovimientoPendiente => ({
  origen_ref: `00|X-D-26|${folio}|0011`, tipo: 'gasto', origen_tipo: 'pago_proveedor', clave_banco: '0011', caja_nombre: 'CAJA GENERAL',
  sucursal: '00', doc_tipo: 'X-D-26', folio, fecha_valor: '2026-11-03', entidad_code: null, beneficiario: 'PROVEEDOR', concepto: null,
  metodo: null, monto, confirmable: true, kepler_cuenta: '201', kepler_concepto: '001', ...over,
});
const ver = (folio: string, over: Partial<VeredictoDePago>): VeredictoDePago => ({
  origen_ref: `00|X-D-26|${folio}|0011`, respaldo: 'compra', puede: true, requiere_firma: false, bloqueo: null, motivo: null, arreglo: null,
  detalle: [], ...over,
});

describe('[LE.2.13] la cola de la Ventanilla', () => {
  it('primero lo que se paga ya, después lo que firma Tesorería, al final lo detenido; dentro, el orden de la cola', () => {
    const docs = [doc('1', 100), doc('2', 200), doc('3', 300), doc('4', 400), doc('5', 500)];
    const v = [
      ver('1', { puede: false, bloqueo: 'gasto_sin_aprobar', respaldo: 'gasto', motivo: 'nadie lo aprobó', arreglo: 'aprobacion_gastos' }),
      ver('2', { respaldo: 'ninguno', requiere_firma: true, motivo: 'Kepler no dice qué gasto o compra paga' }),
      ver('3', { detalle: [{ tipo: 'entrada', folio: 'A', aplicado_minor: '30000', vale_folio: null, aprobado: null }] }),
      ver('4', { respaldo: 'gasto', detalle: [{ tipo: 'gasto', folio: 'G', aplicado_minor: '40000', vale_folio: '0000308', aprobado: true }] }),
      ver('5', { puede: false, bloqueo: 'vale_rechazado', respaldo: 'gasto', motivo: 'rechazado' }),
    ];
    const cola = armarCola(docs, v);
    expect(cola.map((f) => [f.doc.folio, f.estado])).toEqual([['3', 'pagable'], ['4', 'pagable'], ['2', 'firma'], ['1', 'detenido'], ['5', 'detenido']]);
    expect(cola.map((f) => f.etiqueta)).toEqual(['compra · 1 entrada', 'gasto aprobado · vale 0000308', 'firma Tesorería', 'gasto sin aprobar', 'gasto rechazado']);
    expect(cola[3]).toMatchObject({ motivo: 'nadie lo aprobó', arreglo: 'aprobacion_gastos' });
    expect(cola[4].arreglo).toBeNull();
  });

  it('NEGATIVA: sin veredicto no se afirma nada — no sale y dice que no se pudo medir', () => {
    expect(filaDe(doc('9', 50), null)).toMatchObject({ estado: 'detenido', etiqueta: 'sin medir', motivo: 'No se pudo leer qué paga este documento.' });
  });

  it('NEGATIVA: sin cuenta de Kepler no sale aunque el respaldo cuadre, y dice el motivo de la cola', () => {
    const f = filaDe(doc('9', 50, { kepler_cuenta: null, confirmable: false, motivo_texto: 'Falta la cuenta: no hay póliza todavía.' }), ver('9', {}));
    expect(f).toMatchObject({ estado: 'detenido', etiqueta: 'sin cuenta de Kepler', motivo: 'Falta la cuenta: no hay póliza todavía.' });
  });

  it('sin ODS el respaldo es «sin medir»: firma Tesorería y la pastilla no afirma qué paga', () => {
    const f = filaDe(doc('9', 50), ver('9', { respaldo: 'no_medido', requiere_firma: true, motivo: 'no trae vale aprobado' }));
    expect(f).toMatchObject({ estado: 'firma', etiqueta: 'sin medir qué paga · firma Tesorería' });
  });

  it('el resumen cuenta y suma cada estado, y los tres juntos son la cola entera', () => {
    const docs = [doc('1', 100.1), doc('2', 200.2), doc('3', 300.3)];
    const cola = armarCola(docs, [ver('1', {}), ver('2', { requiere_firma: true, respaldo: 'ninguno' }), ver('3', { puede: false, bloqueo: 'ya_ordenado' })]);
    const r = resumenCola(cola);
    expect(r).toEqual({ pagable: { n: 1, monto: 100.1 }, firma: { n: 1, monto: 200.2 }, detenido: { n: 1, monto: 300.3 } });
    expect(r.pagable.n + r.firma.n + r.detenido.n).toBe(docs.length);
  });
});
