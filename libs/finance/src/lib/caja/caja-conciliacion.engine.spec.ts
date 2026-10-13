import { conciliacion, documentoEnLaGlosa, MOTIVO_MIN } from './caja-conciliacion.engine';

/**
 * ⭐⭐ `[CG.124]` — **Ningún movimiento de caja se guarda sin conciliar.**
 *
 * Los dos casos reales de prod (2026-10-13) están acá como aserción, con sus cifras:
 * `CG-2026-00006` ($6,303.00, glosa `X-D-26 0000161`, documento real $6,302.78) y
 * `CG-2026-00028` ($10,490.00, glosa `X-D-26 0023047`, documento real $1,250.00). Los dos
 * se guardaron sin enlace **y los dos documentos siguen en la bandeja**.
 */
describe('[CG.124] conciliacion — un movimiento sin origen no se guarda', () => {
  it('con enlace, pasa', () => {
    const v = conciliacion({ origen_ref: '00|X-D-26|0023047|0011', origen_tipo: 'pago_proveedor' });
    expect(v).toEqual({ ok: true, via: 'enlazado' });
  });

  /**
   * ⛔ El caso de `CG-2026-00028`: la glosa la ARMA el sistema al elegir el documento
   * (`${doc_tipo} ${folio} · ${beneficiario}`), así que si está y el enlace no, se cayó en el
   * camino. Dejarlo pasar deja el documento ofreciéndose para una segunda captura.
   */
  it('⛔ glosa que nombra documento SIN enlace: se bloquea, y se dice por qué', () => {
    const v = conciliacion({ glosa: 'X-D-26 0023047 · GASTOS GENERALES OFICINAS' });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('inalcanzable');
    expect(v.motivo).toBe('enlace_perdido');
    // El texto nombra el documento: sin eso, quien captura no sabe cuál volver a elegir.
    expect(v.texto).toContain('X-D-26 0023047');
    // Y dice la consecuencia, que es la parte que no es obvia.
    expect(v.texto).toContain('bandeja');
  });

  it('⛔ el otro caso real, con otro documento', () => {
    const v = conciliacion({ glosa: 'X-D-26 0000161 · GUILLERMO LOPEZ GUTIERREZ' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motivo).toBe('enlace_perdido');
  });

  it('sin documento y CON motivo declarado, pasa', () => {
    // El caso legítimo: las rutas 501/502/503 de Canindo, cuyo cobro nadie registró en Kepler.
    const v = conciliacion({ sin_documento_motivo: 'Ruta 501 del 08-oct: Kepler no tiene el cobro' });
    expect(v).toEqual({ ok: true, via: 'motivo_declarado' });
  });

  it('⛔ [negativa] sin documento y SIN motivo: se bloquea', () => {
    const v = conciliacion({ glosa: 'VENTA 08/10' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motivo).toBe('sin_declarar');
  });

  it('⛔ [negativa] un motivo de trámite no alcanza', () => {
    // «ok», «n/a», «varios» no son razones: no se pueden auditar dentro de seis meses.
    for (const m of ['ok', 'n/a', 'varios', 'sin doc']) {
      const v = conciliacion({ sin_documento_motivo: m });
      expect(v.ok, `"${m}" no debería pasar`).toBe(false);
    }
    expect(MOTIVO_MIN).toBeGreaterThanOrEqual(12);
  });

  /**
   * ⭐ La prueba que protege a quien escribe en prosa. `"pago de X-D-26 0023047"` es una glosa
   * legítima escrita a mano, y bloquearla mandaría a la persona a buscar un enlace que nunca
   * eligió. La firma de una glosa ARMADA es el `·` y el ancla al principio.
   */
  it('⭐ [negativa] la prosa que MENCIONA un folio no es una glosa armada', () => {
    expect(documentoEnLaGlosa('pago de X-D-26 0023047 a proveedor')).toBeNull();
    expect(documentoEnLaGlosa('X-D-26 0023047 sin separador')).toBeNull();
    expect(documentoEnLaGlosa('VENTA 08/10')).toBeNull();
    expect(documentoEnLaGlosa(null)).toBeNull();
    expect(documentoEnLaGlosa('')).toBeNull();
  });

  it('la glosa armada sí se reconoce, con sus dos partes', () => {
    expect(documentoEnLaGlosa('X-D-26 0023047 · GASTOS')).toEqual({ doc: 'X-D-26', folio: '0023047' });
    expect(documentoEnLaGlosa('U-A-5 0000009 · RD 21')).toEqual({ doc: 'U-A-5', folio: '0000009' });
  });

  /**
   * ⛔ El enlace perdido gana al motivo: si el documento EXISTE y se eligió, un motivo escrito
   * encima no lo arregla — lo tapa. Sin esto, la salida fácil sería teclear doce caracteres.
   */
  it('⛔ [negativa] un motivo NO compra el permiso de perder el enlace', () => {
    const v = conciliacion({
      glosa: 'X-D-26 0023047 · GASTOS GENERALES OFICINAS',
      sin_documento_motivo: 'no encontré el documento en la lista',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.motivo).toBe('enlace_perdido');
  });
});
