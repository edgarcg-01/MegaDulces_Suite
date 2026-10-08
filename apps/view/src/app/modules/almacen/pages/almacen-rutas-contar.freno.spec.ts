import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[RD.45]` — **Un conteo de ruta a medias manda a cero lo que no se contó.**
 *
 * `registerRouteCount` **RESETEA**: a partir del conteo, el saldo de cada producto arranca en lo
 * contado, y *lo que la hoja no lista queda en CERO*. Eso es correcto y deliberado (`[RD.31]`:
 * un conteo que sólo sumara lo que encontró dejaría vivos para siempre los fantasmas que vino a
 * matar) — pero convierte un envío incompleto en un borrado masivo silencioso. Con hojas de 254
 * a 342 renglones, alguien que cierre al renglón 50 pone en cero **~280 productos que están
 * físicamente en el camión**.
 *
 * ⛔ El botón deshabilitado NO es el freno. Es el aviso. El freno vive en `cerrar()`, porque el
 * botón se habilita con un cambio de template, con una herramienta de desarrollo, o con un
 * `disabled` que alguien quita «para probar» — y los tres caminos llegan al mismo POST.
 *
 * ⚠️ **Qué NO afirma este archivo.** Lee el FUENTE del componente: comprueba que el freno esté
 * escrito y dónde, no que Angular lo ejecute. Es el mismo alcance —y la misma limitación— que
 * `inventory-count.asignar.spec.ts`, que lee decoradores en vez de levantar el guard.
 */

const RUTA = join(__dirname, 'almacen-rutas-contar.component.ts');
const SRC = readFileSync(RUTA, 'utf8');

/**
 * El cuerpo de un método del componente, desde su firma hasta la del siguiente.
 *
 * ⚠️ Ancla en la DEFINICIÓN (dos espacios de indentación, principio de línea), no en la primera
 * aparición del nombre. La primera versión usaba `indexOf(metodo + '(')` y para `guardar`
 * devolvía `this.guardar();` —una llamada dentro de otro método—, así que tres aserciones daban
 * rojo con el código correcto. *Buscar un nombre no es lo mismo que buscar dónde se define.*
 */
function cuerpoDe(fuente: string, metodo: string): string {
  const def = new RegExp(`\\n {2}(?:private |protected |public )?${metodo}\\s*\\(`);
  const m = def.exec(fuente);
  if (!m) throw new Error(`No existe la definición de ${metodo}()`);
  const i = m.index;
  const resto = fuente.slice(i + m[0].length);
  // Corta en la próxima firma del mismo nivel, nunca por longitud fija: un corte por caracteres
  // se come el método vecino y pone el candado en rojo con el código intacto (ya pasó en
  // `bin-location.permisos.spec.ts`).
  const sig = resto.search(/\n {2}(?:private |protected |public )?[a-zA-Z]+\s*\(/);
  return sig < 0 ? fuente.slice(i) : fuente.slice(i, i + m[0].length + sig);
}

/**
 * ¿`cerrar()` se niega a enviar cuando quedan pendientes? Busca el patrón completo —la lectura
 * de `pendientes()`, la comparación y el `return`— y no sólo la palabra: una mención en un
 * comentario o en un log pondría el candado en verde sin que exista el freno.
 */
function frenaIncompleto(fuente: string): boolean {
  const cuerpo = cuerpoDe(fuente, 'cerrar');
  return /if\s*\(\s*this\.pendientes\(\)\s*>\s*0\s*\)\s*\{[\s\S]{0,400}?\breturn\b/.test(cuerpo);
}

describe('[RD.45] contar una ruta · el arnés del candado', () => {
  /**
   * Sin esto, un extractor que devolviera cadena vacía pondría en verde TODAS las aserciones
   * de abajo — que son justamente las que protegen el inventario de 11 camiones.
   */
  it('el extractor encuentra los métodos que va a vigilar', () => {
    expect(cuerpoDe(SRC, 'cerrar').length).toBeGreaterThan(100);
    expect(cuerpoDe(SRC, 'marcarCero').length).toBeGreaterThan(20);
    expect(cuerpoDe(SRC, 'saltar').length).toBeGreaterThan(10);
  });
});

describe('[RD.45] un conteo incompleto no se puede enviar', () => {
  it('cerrar() se niega mientras quede un renglón pendiente', () => {
    expect(frenaIncompleto(SRC)).toBe(true);
  });

  /**
   * ⭐ PRUEBA NEGATIVA. Un gate sin ella es una intención: si el detector diera `true` con el
   * freno quitado, estaría midiendo cualquier otra cosa del archivo.
   */
  it('NEGATIVA: quitarle el freno a cerrar() pone el candado en rojo', () => {
    const saboteado = SRC.replace(
      /if \(this\.pendientes\(\) > 0\) \{[\s\S]*?\n {4}\}/,
      '// freno removido a proposito por la prueba negativa',
    );
    expect(saboteado).not.toBe(SRC); // el sabotaje se aplicó de verdad
    expect(frenaIncompleto(saboteado)).toBe(false);
  });

  it('el botón de cerrar además se deshabilita, y dice por qué', () => {
    // El aviso en pantalla no reemplaza al freno, pero sin él la persona toca un botón muerto
    // sin entender qué le falta — y termina mandando el conteo por otro lado.
    expect(SRC).toMatch(/\[disabled\]="pendientes\(\) > 0"/);
    expect(SRC).toMatch(/\[pTooltip\]="pendientes\(\) > 0 \?/);
  });
});

describe('[RD.45] lo que la pantalla NO puede inventar', () => {
  /**
   * `declared_total` es «lo que el papel dice que suma»: un testigo INDEPENDIENTE contra el cual
   * el backend contrasta la suma de los renglones. Mandar nuestra propia suma lo volvería un
   * espejo que siempre cuadra, y `cuadra: true` pasaría a ser un sí sin contenido (ADR-056).
   */
  it('no manda su propia suma como total declarado', () => {
    expect(cuerpoDe(SRC, 'cerrar')).toMatch(/declared_total:\s*null/);
  });

  it('«no está en el camión» se captura como CERO, no se omite el renglón', () => {
    // Omitir y contar cero producen el mismo efecto en el ledger, pero no son la misma
    // afirmación: quien miró y no lo encontró está declarando algo, y eso tiene que quedar.
    expect(cuerpoDe(SRC, 'marcarCero')).toMatch(/this\.aplicar\(this\.idx\(\), 'difiere', 0\)/);
  });

  it('saltar un renglón lo deja PENDIENTE, no lo da por contado', () => {
    const cuerpo = cuerpoDe(SRC, 'saltar');
    expect(cuerpo).toMatch(/this\.avanzar\(\)/);
    expect(cuerpo).not.toMatch(/this\.aplicar\(/);
  });
});

describe('[RD.45] el borrador local no mezcla dos hojas', () => {
  /**
   * El avance se guarda en el navegador. Si la camioneta volvió a reportar mientras alguien
   * contaba, la hoja cambió: pegarle las marcas viejas a los renglones nuevos mezclaría dos
   * conteos distintos y nadie lo notaría — las cantidades «ya contadas» se verían normales.
   */
  it('descarta el borrador cuando la foto del camión cambió', () => {
    const cuerpo = cuerpoDe(SRC, 'restaurar');
    expect(cuerpo).toMatch(/foto_fecha/);
    expect(cuerpo).toMatch(/removeItem/);
  });

  it('cada lectura y escritura del almacenamiento va protegida', () => {
    // localStorage tira excepción en modo privado y con la cuota llena. Una pantalla de conteo
    // que revienta al tercer renglón es peor que una que no guarda nada.
    const guardar = cuerpoDe(SRC, 'guardar');
    const restaurar = cuerpoDe(SRC, 'restaurar');
    expect(guardar).toMatch(/try\s*\{[\s\S]*localStorage\.setItem/);
    expect(restaurar).toMatch(/try\s*\{[\s\S]*localStorage\.getItem/);
  });
});

describe('[RD.45] la fecha del ancla no la pone el navegador', () => {
  /**
   * `[RD.31]` documenta que la fecha equivocada es el modo de falla conocido de esta tabla: el
   * archivo que fundó la fase se llamaba «rd21 05-sep» y era del 5 de OCTUBRE. Un reloj de
   * laptop mal puesto escribiría el ancla en otro día sin que nadie lo note, y el conteo se
   * aplicaría contra las ventas equivocadas.
   */
  it('el valor por defecto de count_date viene del servidor', () => {
    expect(SRC).toMatch(/this\.countDate\.set\(h\.hoy\)/);
    expect(SRC).not.toMatch(/countDate\.set\(new Date\(\)/);
  });
});
