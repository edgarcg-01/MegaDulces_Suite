/**
 * `[CG.67]` Candados del estado de la firma.
 *
 * ⚠️ NO importar nada de `vitest`: los specs hermanos de esta carpeta usan los globales, y el
 * import rompe la corrida entera con `Cannot read properties of undefined (reading 'config')`.
 * Ya costó una vez en `caja-caos-ingreso.engine.spec.ts`.
 */
import { revisarFirma, pideFirma, FIRMA_MAX_BYTES } from './caja-firma.engine';

/** Un data URI de PNG válido del largo que se pida (el contenido no importa acá). */
const pngDe = (bytes: number) => 'data:image/png;base64,' + 'A'.repeat(Math.ceil(bytes * 4 / 3));

describe('revisarFirma · [CG.67]', () => {
  it('quién pide firma: sólo el gasto', () => {
    expect(pideFirma('gasto')).toBe(true);
    expect(pideFirma('ingreso')).toBe(false);
    // ⚠️ El depósito también es efectivo que SALE y no la pide: quien lo recibe es el banco, y
    // su respaldo es la ficha de depósito que Fase CC ya guarda con OCR y cuadre.
    expect(pideFirma('deposito')).toBe(false);
    expect(pideFirma(null)).toBe(false);
  });

  it('un gasto SIN firma queda sin_firma, no no_aplica', () => {
    // ⭐ Es la distinción que sostiene todo: `sin_firma` es el único estado que alguien tiene que
    // ir a resolver. Si un gasto sin firmar cayera en `no_aplica`, desaparecería de la lista de
    // lo que falta — y el reporte de cumplimiento saldría limpio con el hueco adentro.
    const r = revisarFirma('gasto', null);
    expect(r.estado).toBe('sin_firma');
    expect(r.png).toBeNull();
    expect(r.descartada).toBeNull();
  });

  it('un ingreso sin firma queda no_aplica: nunca se le pidió', () => {
    expect(revisarFirma('ingreso', '').estado).toBe('no_aplica');
    expect(revisarFirma('deposito', undefined).estado).toBe('no_aplica');
  });

  it('con un PNG válido queda firmado, y el PNG se guarda', () => {
    const png = pngDe(4_000);
    const r = revisarFirma('gasto', png);
    expect(r.estado).toBe('firmado');
    expect(r.png).toBe(png);
    expect(r.descartada).toBeNull();
  });

  it('⭐ una firma en un movimiento que NO la pedía igual se guarda', () => {
    // Nadie firma de más por accidente. Rechazarla sería tirar evidencia por no haberla pedido.
    const r = revisarFirma('ingreso', pngDe(3_000));
    expect(r.estado).toBe('firmado');
    expect(r.png).not.toBeNull();
  });

  it('⛔ [negativa] lo que NO es un PNG no se guarda, y se dice que se descartó', () => {
    // `firma_png = 'ok'` pasaría cualquier chequeo de "no nulo" — y el CHECK de la tabla también.
    for (const basura of ['ok', 'firmado', 'data:image/png,sin-base64', 'https://ejemplo/x.png']) {
      const r = revisarFirma('gasto', basura);
      expect(r.estado, basura).toBe('sin_firma');
      expect(r.png, basura).toBeNull();
      expect(r.descartada, basura).toBe('no_es_png');
    }
  });

  it('⛔⛔ [negativa] un data URI que NO es imagen no entra ni por casualidad', () => {
    // `data:text/html,<script>` también empieza con "data:". Guardarlo en una columna que
    // después alguien renderiza es el camino corto a XSS almacenado.
    const r = revisarFirma('gasto', 'data:text/html;base64,PHNjcmlwdD4=');
    expect(r.estado).toBe('sin_firma');
    expect(r.png).toBeNull();
    expect(r.descartada).toBe('no_es_png');
  });

  it('⛔ [negativa] por arriba del techo se descarta, y NO como "no es png"', () => {
    // Los dos descartes tienen arreglos distintos: uno es un cliente roto, el otro un cliente
    // que manda de más. Con un solo motivo, el de la pantalla no sabría qué decirle a nadie.
    const r = revisarFirma('gasto', pngDe(FIRMA_MAX_BYTES + 1_000));
    expect(r.estado).toBe('sin_firma');
    expect(r.png).toBeNull();
    expect(r.descartada).toBe('muy_grande');
  });

  it('justo por debajo del techo SÍ entra', () => {
    // Sin esta, el techo podría estar en cero y la prueba de arriba seguiría pasando.
    const r = revisarFirma('gasto', pngDe(FIRMA_MAX_BYTES - 2_000));
    expect(r.estado).toBe('firmado');
    expect(r.png).not.toBeNull();
  });

  it('⛔ [negativa] el motor NUNCA devuelve "previo"', () => {
    // `previo` es un hecho del pasado —la fila es anterior al mecanismo— y sólo lo escribe el
    // relleno de la migración. Si el motor lo pudiera producir, un movimiento nuevo podría
    // declararse exento por una vía que nadie revisa.
    const casos: Array<[string | null, string | null]> = [
      ['gasto', null], ['gasto', pngDe(1_000)], ['ingreso', null],
      ['deposito', 'basura'], [null, null], ['lo-que-sea', pngDe(1_000)],
    ];
    for (const [tipo, png] of casos) {
      expect(revisarFirma(tipo, png).estado, `${tipo}/${png?.slice(0, 12)}`).not.toBe('previo');
    }
  });
});
