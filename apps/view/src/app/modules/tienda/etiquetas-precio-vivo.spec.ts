import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[TDA.1]` — Candado del aviso EN VIVO de cambio de precio en la etiquetera.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────
 * La cadena Kepler → base ya era rápida (replicación lógica → carril hash @15 s → hop-2
 * sincrónico), pero el último tramo no existía: esta pantalla era 100 % pull y sólo consultaba el
 * precio cuando el operador escaneaba, con la frescura congelada pegada a cada ítem. Si se corregía
 * un precio con etiquetas ya en cola, esas filas conservaban el precio viejo **y se imprimían así**
 * — el incidente del SKU 88222 (un precio 54 % bajo costo) visto desde la pantalla.
 *
 * ── Por qué aserciones sobre el texto fuente ────────────────────────────────
 * Mismo patrón que `etiqueta-hoja.spec.ts`, su vecino: lo que hay que evitar acá no es un cálculo
 * mal hecho sino que alguien **retire** una de las decisiones. Ninguna de las cinco se rompe con un
 * test de comportamiento: las cinco se rompen borrando una línea, y eso es lo que se vigila.
 */

const PAGE = readFileSync(join(__dirname, 'pages', 'tienda-etiquetas.component.ts'), 'utf8');
const SOCKET = readFileSync(join(__dirname, 'store-socket.service.ts'), 'utf8');

describe('etiquetera · el aviso en vivo de cambio de precio', () => {
  it('el socket escucha el evento y lo expone', () => {
    expect(SOCKET).toMatch(/socket\.on\('label_prices_changed'/);
    expect(SOCKET).toMatch(/labelPricesChanged\$ = new Subject<LabelPricesChanged>/);
  });

  it('la forma del evento sale del vocabulario común, no re-declarada a mano', () => {
    // [VP.2.1] El módulo ya tiene `LiveTicket`/`StoreAlert` escritos dos veces (api + view). El
    // evento nuevo NO repite eso: si alguien lo re-declara acá, este candado se pone rojo.
    expect(SOCKET).toMatch(/import type \{[^}]*LabelPricesChanged[^}]*\} from '@megadulces\/contracts'/);
    expect(SOCKET).not.toMatch(/export interface LabelPricesChanged/);
  });

  it('la pantalla se suscribe al evento', () => {
    expect(PAGE).toMatch(/labelPricesChanged\$/);
    expect(PAGE).toMatch(/this\.socket\.connect\(\)/);
  });

  // ── LA NEGATIVA MÁS IMPORTANTE ───────────────────────────────────────────
  // El socket es singleton de root y `tienda-state` lo administra con un refcount que llama
  // `disconnect()` al llegar a cero. Un `disconnect()` desde esta pantalla le cortaría el socket a
  // los otros consumidores — entre ellos el aviso "haz tu arqueo" de la cajera, que conecta una vez
  // y nunca desconecta. El bug no se vería acá: se vería como avisos de arqueo que dejan de llegar.
  it('NO desconecta el socket: se lo cortaría al aviso de arqueo', () => {
    expect(PAGE).not.toMatch(/socket\.disconnect\(\)/);
  });

  it('el aviso recortado se trata aparte del set de ids', () => {
    // "No sé cuáles cambiaron" no es "ninguno cambió". Es el mismo error que esta pantalla ya
    // cometió con la frescura (`unknown` llegando con `stale:false` y el aviso callado): si
    // `truncated` cayera en el mismo camino que los ids, un cambio masivo se leería como que la
    // cola está sana.
    expect(PAGE).toMatch(/avisoTruncado = signal\(false\)/);
    expect(PAGE).toMatch(/if \(p\?\.truncated\) \{ this\.avisoTruncado\.set\(true\); return; \}/);
    // Y con el aviso recortado, `cambiadosEnCola` devuelve TODA la cola, no una lista parcial.
    expect(PAGE).toMatch(/if \(this\.avisoTruncado\(\)\) return q;/);
  });

  it('sólo avisa por lo que está EN LA COLA', () => {
    // Un banner que suena por un producto que nadie va a imprimir se aprende a ignorar, y entonces
    // no sirve el día que sí importa.
    expect(PAGE).toMatch(/this\.queue\(\)\.map\(\(it\) => it\.model\.product_id\)\.filter/);
  });

  it('el refresco conserva copias y hero: no rearma el lote del operador', () => {
    expect(PAGE).toMatch(/\.\.\.it, model: \{ \.\.\.fresco, scanned_unit: it\.model\.scanned_unit \}/);
  });

  it('si el refresco FALLA, la marca no se limpia', () => {
    // Limpiar la marca en el error diría "ya está actualizado" sobre una fila que sigue con el
    // precio viejo. El `precioCambiado.update` sólo aparece en el camino `next`.
    const err = /error: \(e\) => \{[\s\S]*?httpMsg\('Actualizar precios'[\s\S]*?\},/.exec(PAGE);
    expect(err).not.toBeNull();
    expect(err![0]).not.toMatch(/precioCambiado/);
    expect(err![0]).not.toMatch(/avisoTruncado/);
  });

  it('el aviso es INFO, no warn: no se confunde con el de rezago', () => {
    // Son dos cosas distintas y tienen que verse distintas: warn = "no se sabe si esto es vigente";
    // info = "hay uno más nuevo y acá está el botón". Un solo color borraría la diferencia.
    expect(PAGE).toMatch(/\.etqp-changed\{[\s\S]*?--info-soft-bg/);
    expect(PAGE).not.toMatch(/\.etqp-changed\{[\s\S]*?--warn-soft-bg/);
  });

  it('la fila que cambió se marca en la tabla, no sólo en el banner', () => {
    expect(PAGE).toMatch(/\[class\.etqp-row-changed\]="filaCambiada\(it\)"/);
  });

  it('el precio nuevo se pide por el MISMO camino que el escaneo', () => {
    // No un endpoint nuevo: así el refresco pasa por la misma reconciliación y trae su propia
    // frescura medida. Un atajo daría un precio que el escaneo no habría dado.
    const fn = /refrescarPrecios\(\): void \{[\s\S]*?\n  \}/.exec(PAGE);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/this\.svc\.resolve\(codes\)/);
    expect(fn![0]).toMatch(/lastFreshness\.set/);
  });
});
