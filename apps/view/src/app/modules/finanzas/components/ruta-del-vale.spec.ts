import type { ComprobacionEnLaCola, EstadoKeplerDelGasto, KeplerDelVale } from '@megadulces/contracts';
import { pasoActual, resumenDeLaRuta, rutaDelVale, segmentosDeLaRuta, tieneComprobante, type PasoDeLaRuta } from './ruta-del-vale';

/**
 * `[PGP.123]` G-RED.1 — La ruta del vale. Lo que cuida:
 * - que ningún paso afirme lo que no pasó (un vale sin firmar no dice «Firmado»; el gasto que no se leyó no es «después»);
 * - que haya UN solo paso «toca ahora» (o el que tiene problema), que es lo que la persona viene a buscar;
 * - que el rechazo corte la ruta en vez de dejar pasos «después» que nunca van a ocurrir.
 */
const V = (over: Record<string, unknown> = {}) => ({
  status: 'recibida', requiere_evidencia: true, tiene_evidencia: false, created_by: 'demo.capturista',
  folio_solicitud: '0000101', validated_by: null, motivo_rechazo: null, ...over,
}) as Parameters<typeof rutaDelVale>[0];

const G = (gasto: Partial<EstadoKeplerDelGasto> | null, listo = true): ComprobacionEnLaCola => ({
  comprobacion: listo ? { listo: true, fecha: '2026-11-23' } : { listo: false, motivo: 'lectura_distinta', quien: 'finanzas', texto: 'El comprobante dice otro monto' },
  gasto: gasto ? { id: 'v', status: null, folio: null, poliza: null, fecha: null, nota: null, intentos: 0, siguiente: null, ...gasto } : null,
  escritura: { abierta: true, motivo: null, detalle: null },
});

const K = (over: Partial<KeplerDelVale> = {}): KeplerDelVale => ({
  solicitud: 'XA1501-0000101', estado: 'A', suite: { resultado: 'escrito' as never, at: '2026-11-23T17:00:00Z', nota: null, firmo: 'demo.firma' }, ...over,
});

const estados = (r: PasoDeLaRuta[]) => r.map((p) => `${p.clave}:${p.estado}`).join(' ');

describe('[PGP.123] G-RED.1 la ruta del vale', () => {
  it('sin vale no hay ruta', () => {
    expect(rutaDelVale(null, null, undefined)).toEqual([]);
  });

  it('recién pedido: la firma toca ahora y nada después dice «hecho»', () => {
    const r = rutaDelVale(V(), null, undefined);
    expect(estados(r)).toBe('pedido:hecho firma:actual comprobante:pendiente revision:pendiente gasto:pendiente');
    expect(r[1].texto).toBe('Espera la firma de quien aprueba gastos');
    expect(pasoActual(r)?.clave).toBe('firma');
  });

  it('⛔ un vale sin firmar NO dice «Firmado» aunque traiga folio (el folio de Kepler existe desde la captura)', () => {
    const r = rutaDelVale(V({ folio_solicitud: '0000101' }), null, undefined);
    expect(r[1].texto).not.toMatch(/Firm/);
  });

  it('firmado y debiendo el comprobante: el comprobante toca ahora; la firma dice quién firmó y la solicitud', () => {
    const r = rutaDelVale(V({ status: 'aprobada' }), K(), undefined);
    expect(estados(r)).toBe('pedido:hecho firma:hecho comprobante:actual revision:pendiente gasto:pendiente');
    expect(r[1].texto).toBe('Firmó demo.firma · solicitud XA1501-0000101 en Kepler');
    expect(r[1].seccion).toBe('kepler');
  });

  it('sin la solicitud de la página, la firma no inventa quién firmó', () => {
    const r = rutaDelVale(V({ status: 'aprobada' }), null, undefined);
    expect(r[1].texto).toBe('Firmado · solicitud 0000101 en Kepler');
    expect(r[1].seccion).toBeNull();
  });

  it('el comprobante vino con el pedido: no queda «toca ahora» en un paso ya hecho', () => {
    const r = rutaDelVale(V({ tiene_evidencia: true }), null, undefined);
    expect(r[2]).toMatchObject({ estado: 'hecho', texto: 'Vino con el pedido' });
    expect(pasoActual(r)?.clave).toBe('firma');
  });

  it('en revisión: Finanzas revisa', () => {
    const r = rutaDelVale(V({ status: 'revision', tiene_evidencia: true }), null, undefined);
    expect(estados(r)).toBe('pedido:hecho firma:hecho comprobante:hecho revision:actual gasto:pendiente');
  });

  it('⛔ cerrado pero el gasto todavía no se lee: «sin leer», nunca «después» ni «hecho»', () => {
    const r = rutaDelVale(V({ status: 'validada', tiene_evidencia: true, validated_by: 'demo.revisor' }), null, undefined);
    expect(r[3]).toMatchObject({ estado: 'hecho', texto: 'Lo cerró demo.revisor' });
    expect(r[4].estado).toBe('sin_medir');
    expect(pasoActual(r)).toBeNull();
  });

  it('cerrado y la lectura del gasto falló: se dice, con su sección', () => {
    const r = rutaDelVale(V({ status: 'validada', tiene_evidencia: true }), null, null);
    expect(r[4]).toMatchObject({ estado: 'sin_medir', seccion: 'gasto' });
  });

  it('cerrado y listo para generar: el gasto toca ahora', () => {
    const r = rutaDelVale(V({ status: 'validada', tiene_evidencia: true }), null, G(null));
    expect(r[4].estado).toBe('actual');
    expect(pasoActual(r)?.clave).toBe('gasto');
  });

  it('gasto escrito: folio y póliza en palabras de Kepler, la ruta termina', () => {
    const r = rutaDelVale(V({ status: 'validada', tiene_evidencia: true }), null, G({ status: 'written', folio: '0000095', poliza: 'kdc22611/D/406' }));
    expect(r[4]).toMatchObject({ estado: 'hecho', texto: 'Folio 0000095 · póliza D 406 (nov 2026)' });
    expect(pasoActual(r)).toBeNull();
  });

  it('⛔ Kepler canceló el gasto: es un problema, no «hecho» aunque traiga folio', () => {
    const r = rutaDelVale(V({ status: 'validada', tiene_evidencia: true }), null, G({ status: 'cancelled', folio: '0000095', nota: 'Kepler canceló su gasto' }));
    expect(r[4].estado).toBe('mal');
    expect(pasoActual(r)?.clave).toBe('gasto');
  });

  it('la solicitud de la Suite no quedó en Kepler: la firma es el problema', () => {
    const r = rutaDelVale(V({ status: 'aprobada' }), K({ solicitud: null, nace_en_la_suite: { status: 'stuck', nota: null, siguiente: null, intentos: 3 } }), undefined);
    expect(r[1]).toMatchObject({ estado: 'mal', texto: 'Firmó demo.firma · la solicitud no quedó en Kepler' });
    expect(pasoActual(r)?.clave).toBe('firma');
  });

  it('rechazado: la ruta se corta con el motivo, sin pasos «después» que no van a ocurrir', () => {
    const r = rutaDelVale(V({ status: 'rechazada', motivo_rechazo: 'falta factura' }), null, undefined);
    expect(estados(r)).toBe('pedido:hecho rechazo:mal');
    expect(r[1].texto).toContain('falta factura');
  });

  it('un gasto sin firmar que no pide comprobante lo dice («no aplica»)', () => {
    const r = rutaDelVale(V({ requiere_evidencia: false }), null, undefined);
    expect(r[2]).toMatchObject({ estado: 'no_aplica', seccion: null });
  });

  it('⛔ G-RED.1b: «aprobada» es SIEMPRE «falta el comprobante» (contrato de approve), diga lo que diga la bandera', () => {
    // approve sólo deja `aprobada` si es provisional o si pide comprobante y no lo trae; el no comprobable cierra en
    // `validada`. Un «no aplica» aquí contradecía a la lista («Te toca subir la evidencia»).
    const r = rutaDelVale(V({ status: 'aprobada', requiere_evidencia: false }), null, undefined);
    expect(estados(r)).toBe('pedido:hecho firma:hecho comprobante:actual revision:pendiente gasto:pendiente');
  });

  describe('G-RED.1b con la forma de /mine (sin requiere_evidencia ni tiene_evidencia)', () => {
    const M = (over: Record<string, unknown>) => V({ requiere_evidencia: undefined, tiene_evidencia: undefined, ...over });
    const archivo = (role: string) => ({ role, url: 'https://x/y.jpg' });

    it('aprobado: el comprobante toca ahora, sin «Ver el comprobante» (no hay nada que ver)', () => {
      const r = rutaDelVale(M({ status: 'aprobada', files: [] }), null, undefined);
      expect(r[2]).toMatchObject({ estado: 'actual', seccion: null });
    });

    it('cerrado con archivo: «Subido» y lleva a verlo; la revisión no repite el enlace', () => {
      const r = rutaDelVale(M({ status: 'validada', files: [archivo('comprobante_1')] }), null, undefined);
      expect(r[2]).toMatchObject({ estado: 'hecho', texto: 'Subido', seccion: 'evidencia' });
      expect(r[3].seccion).toBeNull();
    });

    it('⛔ cerrado sin archivo: NO dice «Subido»', () => {
      const r = rutaDelVale(M({ status: 'validada', files: [], clasificacion: 'fiscal' }), null, undefined);
      expect(r[2]).toMatchObject({ estado: 'hecho', texto: 'Se cerró sin comprobante adjunto', seccion: null });
    });

    it('cerrado sin archivo y su clase no lo pedía: «no aplica»', () => {
      const r = rutaDelVale(M({ status: 'validada', files: [], clasificacion: 'no_comprobable' }), null, undefined);
      expect(r[2]).toMatchObject({ estado: 'no_aplica', texto: 'Este gasto no pedía comprobante' });
    });

    it('⛔ sin archivos que leer ni bandera: no afirma ni «subido» ni «sin comprobante»', () => {
      const r = rutaDelVale(M({ status: 'validada', files: undefined }), null, undefined);
      expect(r[2]).toMatchObject({ estado: 'hecho', texto: 'Se cerró en la Suite', seccion: null });
    });

    it('una cotización no es comprobante; la URL vacía tampoco', () => {
      expect(tieneComprobante({ files: [archivo('cotizacion')] as never })).toBe(false);
      expect(tieneComprobante({ files: [{ role: 'evidencia_1', url: '' }] as never })).toBe(false);
      expect(tieneComprobante({ files: [archivo('evidencia_1')] as never })).toBe(true);
      expect(tieneComprobante({ tiene_evidencia: false, files: [archivo('evidencia_1')] as never })).toBe(false);
    });
  });

  it('hay a lo más UN paso «toca ahora» en cada estado', () => {
    for (const status of ['recibida', 'aprobada', 'revision', 'validada']) {
      const r = rutaDelVale(V({ status }), K(), G(null));
      expect(r.filter((p) => p.estado === 'actual').length).toBeLessThanOrEqual(1);
    }
  });
});

describe('[PGP.123] G-RED.2 la barrita de la fila', () => {
  it('cinco segmentos con el estado de cada paso, y en palabras dónde va', () => {
    const r = rutaDelVale(V({ status: 'aprobada' }), null, undefined);
    expect(segmentosDeLaRuta(r)).toEqual(['hecho', 'hecho', 'actual', 'pendiente', 'pendiente']);
    expect(resumenDeLaRuta(r)).toBe('Paso 3 de 5, Comprobante: toca ahora');
  });

  it('el rechazo corta la ruta: los pasos que ya no van a ocurrir son «cortado», no «después»', () => {
    const r = rutaDelVale(V({ status: 'rechazada', motivo_rechazo: 'x' }), null, undefined);
    expect(segmentosDeLaRuta(r)).toEqual(['hecho', 'mal', 'cortado', 'cortado', 'cortado']);
    expect(resumenDeLaRuta(r)).toBe('Se rechazó: la ruta termina');
  });

  it('el problema manda sobre lo que toca: con el gasto cancelado, dice el paso 5 con problema', () => {
    const r = rutaDelVale(V({ status: 'validada', tiene_evidencia: true }), null, G({ status: 'cancelled', folio: '0000095' }));
    expect(resumenDeLaRuta(r)).toBe('Paso 5 de 5, Gasto en Kepler: con problema');
  });

  it('⛔ cerrado con el gasto sin leer NO es «Ruta terminada»', () => {
    const r = rutaDelVale(V({ status: 'validada', tiene_evidencia: true }), null, undefined);
    expect(segmentosDeLaRuta(r)[4]).toBe('sin_medir');
    expect(resumenDeLaRuta(r)).toBe('Cerrado en la Suite; Gasto en Kepler: sin leer');
  });

  it('gasto escrito: ruta terminada', () => {
    const r = rutaDelVale(V({ status: 'validada', tiene_evidencia: true }), null, G({ status: 'written', folio: '0000095', poliza: 'kdc22611/D/406' }));
    expect(segmentosDeLaRuta(r)).toEqual(['hecho', 'hecho', 'hecho', 'hecho', 'hecho']);
    expect(resumenDeLaRuta(r)).toBe('Ruta terminada');
  });

  it('sin ruta no hay barrita ni resumen', () => {
    expect(segmentosDeLaRuta([])).toEqual([]);
    expect(resumenDeLaRuta([])).toBe('');
  });
});
