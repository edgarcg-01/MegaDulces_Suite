import { PLANTILLAS_CHEQUE, PLANTILLA_CHEQUE_BAJIO, PLANTILLA_CHEQUE_SANTANDER, camposDelCheque, datosDeChequeDePrueba } from '@megadulces/contracts';
import { AJUSTAR_CHEQUE_JS, DESPLAZAMIENTO_MAX_MM, chequeHtml, chequeSvg, desplazamiento, hojaDePruebaHtml } from './cheque-svg';

const pl = PLANTILLA_CHEQUE_BAJIO;
const campos = camposDelCheque({ fecha: '2026-11-20', beneficiario: 'A&B <Dulces> SA DE CV', centavos: 10_744_693 });

describe('[PGP.165] el cheque en SVG', () => {
  it('la página es del tamaño del cheque y sin márgenes: la impresora no escala nada', () => {
    const html = chequeHtml(pl, campos);
    expect(html).toContain('@page{size:160mm 70mm;margin:0}');
    expect(html).toContain('viewBox="0 0 160 70"');
    expect(html).toContain('width="160mm" height="70mm"');
    // Medio milímetro menos que la hoja: con el contenido exacto, el redondeo mete una hoja en blanco ([UB.RF.16]).
    expect(html).toContain('.ch-hoja{width:160mm;height:69.5mm;overflow:hidden}');
  });

  it('el Santander sale en SU papel (162.3 × 72.1), no en el de BanBajío', () => {
    const html = chequeHtml(PLANTILLA_CHEQUE_SANTANDER, campos);
    expect(html).toContain('@page{size:162.3mm 72.1mm;margin:0}');
    expect(html).toContain('viewBox="0 0 162.3 72.1"');
    expect(html).toContain('.ch-hoja{width:162.3mm;height:71.6mm;overflow:hidden}');
    // «INICIE AQUÍ»: el importe arranca a la izquierda del recuadro.
    expect(html).toContain(`class="fit ch-importe" x="125" y="31.8" font-size="3.6" text-anchor="start"`);
  });

  it('ningún dato cae en el medio milímetro que se recorta abajo', () => {
    for (const p of PLANTILLAS_CHEQUE) {
      const z = p.zonas;
      for (const zona of [z.fecha, z.beneficiario, z.importe, z.letra, z.leyenda]) expect(zona.base + zona.letraMax, p.clave).toBeLessThan(p.altoMm - 0.5);
    }
  });

  it('el cheque real lleva SÓLO los datos: ni contorno, ni líneas, ni rótulos de prueba', () => {
    const html = chequeHtml(pl, campos);
    expect(html).not.toContain('ch-guias');
    expect(html).not.toContain('stroke-dasharray');
    expect(html).not.toContain('NO ES UN CHEQUE');
    for (const t of ['20 DE NOVIEMBRE DE 2026', '**107,446.93**', '(CIENTO SIETE MIL CUATROCIENTOS CUARENTA Y SEIS PESOS 93/100 M.N.)']) {
      expect(html).toContain(t);
    }
  });

  it('el nombre se escapa: un «&» o un «<» en la razón social no rompen el documento', () => {
    const html = chequeHtml(pl, campos);
    expect(html).toContain('A&amp;B &lt;DULCES&gt; SA DE CV');
    expect(html).not.toContain('<DULCES>');
  });

  it('sin leyenda (DCH8 por firmar) no se dibuja su texto; con leyenda, sí', () => {
    expect(chequeSvg(pl, campos)).not.toContain('ch-leyenda');
    expect(chequeSvg(pl, { ...campos, leyenda: 'PARA ABONO EN CUENTA DEL BENEFICIARIO' })).toContain('PARA ABONO EN CUENTA DEL BENEFICIARIO');
  });

  it('cada dato lleva su ancho y sus tamaños para el ajuste en el navegador (el contrato con AJUSTAR_CHEQUE_JS)', () => {
    const svg = chequeSvg(pl, campos);
    expect(svg).toContain(`class="fit ch-benef" x="8" y="27.7" font-size="3.2" text-anchor="start" data-ancho="106"`);
    expect(svg).toContain(`class="fit ch-letra"`);
    expect(svg).toMatch(/class="fit ch-letra"[^>]*data-renglones="2" data-interlinea="3.2" data-max2="2.7"/);
    for (const attr of ['data-ancho', 'data-min', 'data-max', 'data-renglones', 'data-interlinea', 'data-max2']) expect(AJUSTAR_CHEQUE_JS).toContain(attr);
    expect(AJUSTAR_CHEQUE_JS).toContain('window.__chequeListo = true');
    // ⛔ Nunca se corta: ni recortes de texto ni puntos suspensivos.
    expect(AJUSTAR_CHEQUE_JS).not.toMatch(/substring|substr\(|ellipsis|text-overflow/);
  });

  it('partir en dos renglones conserva cada palabra, en orden, y reparte parejo', () => {
    const fuente = /function partir\(texto\) \{[\s\S]*?return mejor;\s*\}/.exec(AJUSTAR_CHEQUE_JS)?.[0];
    expect(fuente).toBeTruthy();
    const partir = new Function(`${fuente}; return partir;`)() as (t: string) => { a: string; b: string } | null;
    const letra = '(UN MILLÓN SETECIENTOS SETENTA Y SIETE MIL SETECIENTOS SETENTA Y SIETE PESOS 77/100 M.N.)';
    const dos = partir(letra)!;
    expect(`${dos.a} ${dos.b}`).toBe(letra);
    expect(Math.abs(dos.a.length - dos.b.length)).toBeLessThan(15);
    expect(partir('UNA')).toBeNull(); // una sola palabra no se parte: se comprime
  });

  it('el corrimiento de la impresora se aplica a los datos y se acota', () => {
    expect(chequeSvg(pl, campos, { dx: 1.5, dy: -0.75 })).toContain('translate(1.5 -0.75)');
    expect(desplazamiento({ dx: 99, dy: -99 })).toEqual({ dx: DESPLAZAMIENTO_MAX_MM, dy: -DESPLAZAMIENTO_MAX_MM });
    expect(desplazamiento({ dx: 'abc' as unknown as number })).toEqual({ dx: 0, dy: 0 });
    expect(desplazamiento(undefined)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('[PGP.165] la hoja de prueba', () => {
  const prueba = hojaDePruebaHtml(pl, camposDelCheque(datosDeChequeDePrueba('2026-11-20')), { dx: 1 });

  it('va en hoja carta, con el contorno y las líneas del papel, y dice que no es un cheque', () => {
    expect(prueba).toContain('@page{size:letter;margin:0}');
    expect(prueba).toContain('ch-guias');
    expect(prueba).toContain('stroke-dasharray');
    expect(prueba).toContain('ESTA HOJA NO ES UN CHEQUE');
  });

  it('trae sus instrucciones y avisa que la plantilla no está calibrada', () => {
    expect(prueba).toContain('Tamaño real');
    expect(prueba).toContain('cancelado');
    expect(prueba).toContain('16 × 7 cm');
    expect(prueba).toContain('SIN CALIBRAR');
    expect(prueba).toContain('corrimiento aplicado: 1 mm a lo ancho');
  });

  it('la de Santander pide recortar SU tamaño y dice de qué papel es', () => {
    const s = hojaDePruebaHtml(PLANTILLA_CHEQUE_SANTANDER, camposDelCheque(datosDeChequeDePrueba('2026-11-26')));
    expect(s).toContain('16.2 × 7.2 cm');
    expect(s).not.toContain('16 × 7 cm');
    expect(s).toContain('HOJA DE PRUEBA · Santander · PYME (162.3 × 72.1 mm)');
  });
});
