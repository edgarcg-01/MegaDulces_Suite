import { conteoDelTope } from './kepler-requisition-sink.adapter';

/**
 * `[AB.NI.8]` **El tope diario cuenta sólo su propio tipo de documento.**
 *
 * ⭐ CONTROL contra un hecho medido, no contra sí mismo: el 2026-11-24, en prod y sólo lectura, el
 * servidor 08 tenía **9 `X-A-30` de compra y 0 `U-D-40` de traspaso** escritos ese día. Con el
 * contador viejo —que sumaba los dos— el traspaso de Morelia Madero se rechazaba con «8 de 1
 * documentos hoy», hablando de documentos que esa persona nunca pidió. Con el contador por tipo,
 * esos 9 ya no tocan el cupo del traspaso.
 *
 * Y no era un caso raro: la compra **no tiene tope en ninguna de las 9 sucursales** (escribe hasta
 * 15 en un día) y el traspaso tiene tope 1; en el servidor 08, **19 de los últimos 30 días**
 * tuvieron al menos un `X-A-30`. *Cero `U-D-40` de la Suite en toda la historia del ODS.*
 *
 * ⛔ PRUEBAS NEGATIVAS ejercidas y VISTAS caer (2026-11-24):
 *   · unir las dos ramas con un `OR` en el lado del traspaso → rojo en «el conteo del TRASPASO no
 *     mira la requisición de compra»;
 *   · el mismo `OR` en el lado de la compra → rojo en «el conteo de la COMPRA no mira el pedido
 *     de sucursal».
 *
 * ⚠️ **LÍMITE DECLARADO — lo que esta prueba NO cubre:** verifica **qué cuenta cada rama**, no que
 * el adapter **elija** la rama correcta. Un `conteoDelTope(!esTraspaso)` en la llamada pasaría estas
 * pruebas en verde. Cubrirlo pide ejercer el método entero contra una base real con el payload de
 * la pantalla (regla 13), que es trabajo de la prueba de ensayo, no de ésta. Queda dicho en vez de
 * descubierto.
 */
describe('[AB.NI.8] el tope diario cuenta sólo su tipo', () => {
  it('⛔ el conteo del TRASPASO no mira la requisición de compra', () => {
    const { sql } = conteoDelTope(true);
    expect(sql).toContain("c2='U'");
    expect(sql).toContain("btrim(c4::text)='40'");
    // La marca del traspaso vive en c24 (texto libre), no en c11.
    expect(sql).toContain('btrim(c24) LIKE $3');
    // ⛔ Ni rastro del documento de compra.
    expect(sql).not.toContain("'X'");
    expect(sql).not.toContain("'30'");
    expect(sql).not.toContain('c11');
    expect(sql).not.toMatch(/\bOR\b/i);
  });

  it('⛔ el conteo de la COMPRA no mira el pedido de sucursal', () => {
    const { sql } = conteoDelTope(false);
    expect(sql).toContain("c2='X'");
    expect(sql).toContain("btrim(c4::text)='30'");
    // En X-A-30 la marca va en c11, que ahí es referencia libre.
    expect(sql).toContain('btrim(c11) LIKE $3');
    expect(sql).not.toContain("'U'");
    expect(sql).not.toContain("'40'");
    expect(sql).not.toContain('c24');
    expect(sql).not.toMatch(/\bOR\b/i);
  });

  it('los dos conteos son DISTINTOS: si fueran iguales, el tope volvería a mezclarse', () => {
    expect(conteoDelTope(true).sql).not.toBe(conteoDelTope(false).sql);
  });

  it('el motivo nombra el documento que sí topó, para no culpar al que no', () => {
    expect(conteoDelTope(true).queCosa).toBe('pedidos de sucursal');
    expect(conteoDelTope(false).queCosa).toBe('requisiciones de compra');
  });

  it('los dos usan los mismos tres parámetros: servidor, fecha y marca', () => {
    for (const es of [true, false]) {
      const { sql } = conteoDelTope(es);
      expect(sql).toContain('c1=$1');
      expect(sql).toContain('c9::date = $2::date');
      expect(sql).toContain('LIKE $3');
      // Nunca un cuarto parámetro: el adapter pasa exactamente tres.
      expect(sql).not.toContain('$4');
    }
  });

  it('cuenta filas, no las trae: un tope no debe leer documentos enteros', () => {
    for (const es of [true, false]) {
      expect(conteoDelTope(es).sql).toContain('count(*)::int AS n');
      expect(conteoDelTope(es).sql).toContain('FROM md.kdm1');
    }
  });
});
