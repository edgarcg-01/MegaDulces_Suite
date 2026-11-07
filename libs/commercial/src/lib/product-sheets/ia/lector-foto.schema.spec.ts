/**
 * `[NP.7.L.11d]` Compuerta del esquema de `output_config.format`: lo que la API de structured outputs rechaza con
 * 400 se detecta aquí, sin gastar una llamada. Reglas (documentación pública de structured outputs, leída el
 * 2026-11-04): todo objeto con `additionalProperties: false`; a lo más 16 parámetros con unión y 24 opcionales;
 * sin restricciones numéricas, de longitud ni de arreglos. Se rompe a propósito una vez (regla 12).
 */
import { ALERGENOS, LECTURA_FOTO_VERSION, LEYENDAS_NOM051, NIVELES_FISICOS, NOMBRES_CAMPOS, SELLOS_NOM051 } from './lectura-foto.contract';
import { ESQUEMA_LECTURA_FOTO, SYSTEM_LECTOR_FOTO, TOPE_UNIONES_STRUCTURED_OUTPUTS } from './lector-foto.schema';

type Nodo = Record<string, any>;

/**
 * Lo que la API no admite. `minItems` sí lo admite con 0 o 1, y `$ref` también, pero aquí se prohíben los dos:
 * el esquema no los necesita, y una referencia escondería uniones al conteo de esta compuerta.
 */
const PROHIBIDAS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', '$ref',
];

/** Recorre el esquema y junta lo que la API rechazaría. */
function auditarEsquema(raiz: Nodo): { uniones: number; opcionales: number; problemas: string[] } {
  let uniones = 0;
  let opcionales = 0;
  const problemas: string[] = [];
  const visitar = (n: Nodo, ruta: string) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n['anyOf']) || Array.isArray(n['type'])) uniones++;
    for (const p of PROHIBIDAS) if (p in n) problemas.push(`${ruta}: ${p} no lo admite la API`);
    if (n['type'] === 'object') {
      if (n['additionalProperties'] !== false) problemas.push(`${ruta}: additionalProperties no es false`);
      const props = Object.keys(n['properties'] ?? {});
      const req: string[] = n['required'] ?? [];
      opcionales += props.filter((k) => !req.includes(k)).length;
      for (const k of props) visitar(n['properties'][k], `${ruta}.${k}`);
    }
    if (n['items']) visitar(n['items'], `${ruta}[]`);
    for (const alt of n['anyOf'] ?? []) visitar(alt, ruta);
  };
  visitar(raiz, '$');
  return { uniones, opcionales, problemas };
}

describe('[NP.7.L.11d] esquema del lector', () => {
  it('cabe en los topes de structured outputs: 13 uniones (tope 16), 0 opcionales, sin palabras prohibidas', () => {
    const a = auditarEsquema(ESQUEMA_LECTURA_FOTO);
    expect(a.problemas).toEqual([]);
    expect(a.opcionales).toBe(0);
    expect(a.uniones).toBe(13);
    expect(a.uniones).toBeLessThanOrEqual(TOPE_UNIONES_STRUCTURED_OUTPUTS);
  });

  it('prueba negativa: la compuerta SÍ ve 17 uniones, un objeto abierto, un opcional y un minLength', () => {
    const propiedades: Nodo = {};
    for (let i = 0; i < 17; i++) propiedades[`c${i}`] = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    propiedades['c0'] = { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] };
    propiedades['abierto'] = { type: 'object', properties: {}, required: [] };
    // c16 queda fuera de `required`: un opcional.
    const requeridos = Object.keys(propiedades).filter((k) => k !== 'c16');
    const a = auditarEsquema({ type: 'object', properties: propiedades, required: requeridos, additionalProperties: false });
    expect(a.uniones).toBe(17);
    expect(a.uniones).toBeGreaterThan(TOPE_UNIONES_STRUCTURED_OUTPUTS);
    expect(a.opcionales).toBe(1);
    expect(a.problemas).toEqual(['$.c0: minLength no lo admite la API', '$.abierto: additionalProperties no es false']);
  });

  it('describe LecturaFotoV1: los 20 campos del contrato, en su orden, y las listas cerradas como enum', () => {
    const p = ESQUEMA_LECTURA_FOTO['properties'] as Nodo;
    expect(Object.keys(p)).toEqual(['version', 'persona_visible', 'rostro_visible', 'legible', 'motivo_no_legible', 'texto_literal', 'nivel_fisico', 'campos']);
    expect(p['version']).toEqual({ type: 'string', const: LECTURA_FOTO_VERSION });
    // Booleanos obligatorios y NO anulables: «no sé» no existe en el cable (y no suben el conteo de uniones).
    expect(p['persona_visible']).toEqual({ type: 'boolean' });
    expect(p['rostro_visible']).toEqual({ type: 'boolean' });
    expect((ESQUEMA_LECTURA_FOTO['required'] as string[])).toContain('rostro_visible');
    expect(p['nivel_fisico'].properties.valor.enum).toEqual([...NIVELES_FISICOS]);
    const campos = p['campos'].properties as Nodo;
    expect(Object.keys(campos)).toEqual([...NOMBRES_CAMPOS]);
    // Evidencia antes que el valor: el modelo cita y después interpreta.
    for (const k of NOMBRES_CAMPOS) expect(Object.keys(campos[k].properties)).toEqual(['evidencia', 'valor', 'confianza']);
    expect(campos['sellos_nom051'].properties.valor.items.enum).toEqual([...SELLOS_NOM051]);
    expect(campos['leyendas_nom051'].properties.valor.items.enum).toEqual([...LEYENDAS_NOM051]);
    expect(campos['alergenos'].properties.valor.items.enum).toEqual([...ALERGENOS]);
    expect(campos['puede_contener'].properties.valor.items.enum).toEqual([...ALERGENOS]);
    expect(campos['alergenos_otros'].properties.valor.items).toEqual({ type: 'string' });
  });

  it('el system prompt es estable (sin fechas) y no nombra a Kepler ni pide el SKU (testigo independiente)', () => {
    expect(SYSTEM_LECTOR_FOTO).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(SYSTEM_LECTOR_FOTO.toLowerCase()).not.toContain('kepler');
    expect(SYSTEM_LECTOR_FOTO).not.toMatch(/\bSKU\b/i);
    // Las reglas que el contrato fija están dichas.
    for (const t of ['persona_visible', 'rostro_visible', 'evidencia', 'texto_literal', 'codigo_barras_visible', 'empacado_en_tienda', 'caja_exterior']) {
      expect(SYSTEM_LECTOR_FOTO).toContain(t);
    }
  });

  /** El renglón del prompt que DEFINE un campo («nombre = …» o «nombre (…) = …»). */
  const definicion = (campo: string): string =>
    SYSTEM_LECTOR_FOTO.split('\n').find((l) => new RegExp(`^${campo}( \\([^)]*\\))? = `).test(l)) ?? '';

  it('⭐ rostros (Francisco, 2026-11-05): sólo un rostro REAL descarta; el impreso y las otras partes del cuerpo no', () => {
    const rostro = definicion('rostro_visible');
    expect(rostro).toMatch(/descarta la foto/);
    expect(rostro).toMatch(/ojos, nariz, boca, perfil/);
    expect(rostro).toMatch(/REAL/);
    expect(rostro).toMatch(/parcial/);
    expect(rostro).toMatch(/reflejado/);
    // Los ejemplos negativos, dichos con todas sus letras.
    const otrasPartes = SYSTEM_LECTOR_FOTO.split('\n').find((l) => l.includes('no son rostro')) ?? '';
    for (const parte of ['una mano sosteniendo el producto', 'un tatuaje en un brazo', 'una pierna', 'un zapato', 'la ropa']) {
      expect(otrasPartes, parte).toContain(parte);
    }
    expect(otrasPartes).toMatch(/→ rostro_visible false/);
  });

  /**
   * ¿El renglón de la excepción dice SÓLO lo que se decidió? Plan §10b.3 punto 7 (l. 1316) y anexo §2 (l. 57): «un
   * rostro impreso EN EL EMPAQUE es parte del producto y no cuenta». Nada más: ni cartel, ni anuncio, ni volante,
   * ni foto, ni credencial, ni pantalla (Francisco, 2026-11-05, por confirmar por Edgar y legal en D6).
   */
  const FUERA_DE_LA_EXCEPCION = ['cartel', 'anuncio', 'volante', 'pantalla', 'fotograf', 'credencial', 'gafete', 'otro empaque'];
  const excepcionComoSeDecidio = (linea: string): boolean =>
    /diseño impreso del empaque de un producto/.test(linea)
    && /personaje, caricatura, mascota o celebridad/.test(linea)
    && /→ rostro_visible false/.test(linea)
    && FUERA_DE_LA_EXCEPCION.every((t) => !linea.toLowerCase().includes(t));

  it('⭐ revisión 2026-11-05: la ÚNICA excepción es el rostro del diseño impreso del EMPAQUE (ni cartel, ni anuncio, ni foto)', () => {
    const excepciones = SYSTEM_LECTOR_FOTO.split('\n').filter((l) => /excepción|no cuenta/i.test(l));
    expect(excepciones).toHaveLength(1);
    expect(excepcionComoSeDecidio(excepciones[0])).toBe(true);
    // Prueba negativa del instrumento: el renglón de antes (más amplio que la regla) SÍ se detecta.
    const antes = '- Un rostro IMPRESO no cuenta: el personaje, la caricatura, la mascota, la celebridad o la foto de una persona impresos en el empaque del producto, en otro empaque, en un cartel o en un anuncio son parte de lo impreso → rostro_visible false.';
    expect(excepcionComoSeDecidio(antes)).toBe(false);
    expect(excepcionComoSeDecidio(excepciones[0].replace('de un producto', 'de un producto o en un cartel'))).toBe(false);
  });

  it('⭐ revisión 2026-11-05: el rostro en una pantalla, una foto, un cartel o una credencial SÍ cuenta (y la duda es «true»)', () => {
    const lineas = SYSTEM_LECTOR_FOTO.split('\n');
    const pantalla = lineas.filter((l) => l.includes('pantalla'));
    expect(pantalla).toHaveLength(1);
    for (const t of ['celular', 'televisión', 'monitor de cámaras', 'fotografía', 'credencial', 'gafete', 'cartel', 'anuncio', 'volante']) {
      expect(pantalla[0], t).toContain(t);
    }
    expect(pantalla[0]).toMatch(/SÍ cuenta → rostro_visible true, persona_visible true/);
    // ❌ Antes: «de una persona REAL que está en la escena» dejaba fuera la pantalla y la foto (ni escena ni empaque).
    expect(definicion('rostro_visible')).not.toMatch(/que está en la escena/);
    const duda = lineas.find((l) => /^- Si dudas/.test(l)) ?? '';
    expect(duda).toMatch(/diseño impreso del empaque de un producto/);
    expect(duda).toMatch(/rostro_visible true/);
    // persona_visible acompaña a rostro_visible aunque el rostro esté en una pantalla.
    expect(definicion('persona_visible')).toMatch(/si rostro_visible es true/);
  });

  it('⭐ persona_visible es informativo: ya no dice «ante la duda, true» ni descarta la foto', () => {
    const persona = definicion('persona_visible');
    expect(persona).not.toBe('');
    expect(persona).toMatch(/informativo, no descarta la foto/);
    expect(persona).toMatch(/pierna/);
    expect(persona).toMatch(/zapato/);
    expect(persona.toLowerCase()).not.toContain('ante la duda');
    // Prueba negativa del instrumento: con el renglón de antes, la aserción de arriba SÍ se pone roja.
    const antes = 'persona_visible = true si en la foto se ve cualquier parte de una persona: cara, mano, dedos, brazo, tatuaje, uña, o su reflejo. Si sólo se ven productos y anaqueles, false. Ante la duda, true.';
    expect(antes.toLowerCase()).toContain('ante la duda');
    expect(/^persona_visible( \([^)]*\))? = /.test(antes)).toBe(true);
  });
});
