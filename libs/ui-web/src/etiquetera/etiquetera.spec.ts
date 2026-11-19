import { describe, expect, it } from 'vitest';
import { etiquetasDelRenglon, type BoxLabelLineRow } from '@megadulces/contracts';
import { anchoBarrasMm, barrasSvg, enFilas, formatoCode128, modulosCode128 } from './etiquetera';
import { etiquetaCajaHtml, etiquetasCajaHtml, tamanoConsecutivo, tamanoNombre } from './etiqueta-caja';
import { tsplEtiquetasCaja, tsplTexto } from './tspl';

/** El espécimen de la foto (Suc 08, orden 0000474), medido en prod el 2026-11-19. */
const ESPECIMEN: BoxLabelLineRow = {
  sucursal: '08', sucursal_nombre: 'Sucursal Morelia Abastos', serie: 1, folio: '0000474', linea: 1,
  sku: '70106', nombre: 'LA ROSA BOTA GRANDE 418GR', unidad: 'CJA', unidad_base: 'PZA',
  uxc: 18, cajas: 20, cajas_completas: 20, piezas_sueltas: 0, codigo: 'C70106',
  kepler_unidad_caja: 'CJA', kepler_factor_caja: 18, kepler_codigo_caja: 'C70106', sin_catalogo: false,
};

describe('[RE.ETQ.1.1] etiquetera — primitivos', () => {
  it('filas de 3', () => {
    expect(enFilas([1, 2, 3, 4]).map((f) => f.length)).toEqual([3, 1]);
  });
  it('CODE128C sólo para dígitos en número par', () => {
    expect([formatoCode128('000278110003'), formatoCode128('C70106'), formatoCode128('12345')]).toEqual(['CODE128C', 'CODE128', 'CODE128']);
  });
  it('C+clave de 5 dígitos = 90 módulos = 22.5 mm a 2 puntos (cabe en los 29 mm útiles)', () => {
    expect(modulosCode128('C70106')).toBe(90);
    expect(anchoBarrasMm('C70106')).toBe(22.5);
  });
  it('el SVG de caja sale con su ancho calculado; el de GP.4 sin ancho (lo pone su CSS)', () => {
    expect(barrasSvg('C70106', 'ec-bar', 22.5)).toContain('width:22.5mm"');
    expect(barrasSvg('000278120001')).not.toContain('width:');
  });
});

describe('[RE.ETQ.1.2] plantilla de caja', () => {
  const todas = etiquetasDelRenglon(ESPECIMEN, '320-26');

  it('el espécimen: 20 etiquetas en 7 filas, con clave, consecutivo, UXC, fecha, nombre completo y pie', () => {
    const html = etiquetasCajaHtml(todas);
    expect((html.match(/class="et-fila"/g) ?? []).length).toBe(7);
    expect((html.match(/class="et ec"/g) ?? []).length).toBe(20);
    const una = etiquetaCajaHtml(todas[6]);
    for (const t of ['70106', '7:20', 'C70106', 'UXC 18', '320-26', 'LA ROSA BOTA GRANDE 418GR', 'Suc 08 Sucursal Morelia Abastos']) {
      expect(una).toContain(t);
    }
  });

  it('el pie va igual en las tres etiquetas de la fila (Kepler lo cortaba en la 2.ª y 3.ª)', () => {
    const fila = etiquetasCajaHtml(todas.slice(0, 3));
    expect((fila.match(/Suc 08 Sucursal Morelia Abastos/g) ?? []).length).toBe(3);
  });

  it('la caja incompleta se marca', () => {
    const [e] = etiquetasDelRenglon({ ...ESPECIMEN, cajas_completas: 0, piezas_sueltas: 50, unidad_base: 'PAQ' }, '300-26');
    expect(etiquetaCajaHtml(e)).toContain('class="et ec ec-inc"');
    expect(etiquetaCajaHtml(e)).toContain('50 PAQ');
  });

  it('el nombre nunca se corta: se achica la letra', () => {
    expect(tamanoNombre('CAJETA ENVINADA TOPPER 1KG')).toBe('');
    expect(tamanoNombre('X'.repeat(55))).toBe('ec-n-m');
    expect(tamanoNombre('X'.repeat(80))).toBe('ec-n-s');
    const largo = 'CAJETA ENVINADA TOPPER 1/2 KG CON TAPA DE SEGURIDAD';
    expect(etiquetaCajaHtml({ ...todas[0], nombre: largo })).toContain(largo);
  });

  it('el consecutivo largo se achica', () => {
    expect([tamanoConsecutivo('7:20'), tamanoConsecutivo('120:120')]).toEqual(['', 'ec-c-s']);
  });

  it('escapa el texto', () => {
    expect(etiquetaCajaHtml({ ...todas[0], nombre: 'A <B> & "C"' })).toContain('A &lt;B&gt; &amp; &quot;C&quot;');
  });
});

describe('[RE.ETQ.1.6] vía B — TSPL', () => {
  const todas = etiquetasDelRenglon(ESPECIMEN, '320-26');
  const tspl = tsplEtiquetasCaja(todas);
  const lineas = tspl.split('\r\n');

  it('encabezado del rollo de 100 × 48 mm con 3 por fila', () => {
    expect(lineas.slice(0, 5)).toEqual(['SIZE 100 mm,48 mm', 'GAP 2 mm,0 mm', 'DIRECTION 1', 'REFERENCE 0,0', 'CODEPAGE 1252']);
  });
  it('20 etiquetas = 7 PRINT (6 filas de 3 y una de 2) y 20 barras', () => {
    expect(lineas.filter((l) => l === 'PRINT 1,1')).toHaveLength(7);
    expect(lineas.filter((l) => l.startsWith('BARCODE '))).toHaveLength(20);
    expect(lineas.filter((l) => l === 'CLS')).toHaveLength(7);
  });
  it('la barra va a 2 puntos por módulo, centrada en su columna', () => {
    // 29 mm útiles = 232 puntos; C70106 = 90 módulos × 2 = 180 → (232-180)/2 = 26 → x = 12 + 26 = 38.
    expect(lineas).toContain('BARCODE 38,56,"128",68,0,0,2,2,"C70106"');
  });
  it('la tercera columna empieza a 68 mm + margen', () => {
    expect(lineas.some((l) => l.startsWith('TEXT 556,12,"3",0,1,1,"70106"'))).toBe(true);
  });
  it('comillas y saltos de renglón no rompen el comando', () => {
    expect(tsplTexto('MEDIDA 1/2" \nX')).toBe('"MEDIDA 1/2\\["]  X"');
  });
});
