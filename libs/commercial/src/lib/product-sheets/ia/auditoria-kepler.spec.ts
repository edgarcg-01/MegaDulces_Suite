// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import {
  LECTURA_FOTO_VERSION, NOMBRES_CAMPOS,
  type CampoPropuesto, type NivelFisico, type PropuestaAmpliada, type TipoHallazgo,
} from './lectura-foto.contract';
import {
  apareceEnNombre, auditarContraKepler, contenidoDelNombre, descripcionPropuesta, hallazgosDeLegibilidad, saboresDeVariante,
  type FichaKeplerAuditada,
} from './auditoria-kepler';

const cp = <T>(valor: T, evidencia = String(valor), de_cara = 'frente'): CampoPropuesto<T> => ({ valor, confianza: 'alta', evidencia, de_cara, conflicto: null });

const propuesta = (campos: Partial<PropuestaAmpliada['campos']>, nivel: NivelFisico | null = 'empaque_interior', extra: Partial<PropuestaAmpliada> = {}): PropuestaAmpliada => ({
  version: LECTURA_FOTO_VERSION, caras_leidas: ['frente', 'posterior', 'lateral_1', 'lateral_2', 'codigo'],
  nivel_fisico: nivel ? cp(nivel, 'caja de cartón tipo casita', 'frente, posterior') : null,
  persona_visible: false,
  rostro_visible: false,
  campos: { ...(Object.fromEntries(NOMBRES_CAMPOS.map((k) => [k, null])) as PropuestaAmpliada['campos']), ...campos },
  ...extra,
});

/** El 95805 del plan (§7.2), ya fusionado. */
const P_95805 = (): PropuestaAmpliada => propuesta({
  marca: cp('bon o bon'), variante: cp('Fresa'), edicion: cp('Edición Especial'),
  fabricante: cp('Arcor / Mundo Dulce S.A. de C.V.', 'Mundo Dulce S.A. de C.V.', 'posterior'),
  contenido_neto: cp({ cantidad: 120, unidad: 'g' as const }, 'CONT. NET. 120 g'),
  piezas: cp(8, '8 piezas'), contenido_por_pieza: cp({ cantidad: 15, unidad: 'g' as const }, '8 piezas de 15 g'),
  sellos_nom051: cp(['EXCESO CALORÍAS', 'EXCESO AZÚCARES', 'EXCESO GRASAS SATURADAS'] as never),
  alergenos: cp(['leche', 'trigo', 'soya'] as never), puede_contener: cp(['cacahuate'] as never),
  alergenos_otros: cp([] as string[]), // leído y vacío: no es información nueva
  nutricion: cp({
    base: { cantidad: 100, unidad: 'g' as const }, kcal: 564, proteinas_g: null, grasas_totales_g: null, grasas_saturadas_g: null,
    grasas_trans_mg: null, carbohidratos_g: null, azucares_g: null, azucares_anadidos_g: null, fibra_g: null, sodio_mg: null,
  }, '564 kcal / 100 g', 'lateral_2'),
  empaque: cp({ tipo: 'caja de cartón tipo casita', material: 'PAP 21', colores: ['rojo', 'rosa', 'blanco'] }),
  codigo_barras_visible: cp('7500443006889', '7 500443 006889', 'codigo'),
});

const K_95805: FichaKeplerAuditada = { nombre: 'BON O BON FRESA ED ESP 8/15G', principal: 'base', u1: 'CJA', u2: null, f2: null, u3: null, f3: null };

const tipos = (p: PropuestaAmpliada | null, k: FichaKeplerAuditada): TipoHallazgo[] => auditarContraKepler(p, k).hallazgos.map((h) => h.tipo);

describe('auditarContraKepler · el 95805 del plan', () => {
  const a = auditarContraKepler(P_95805(), K_95805);

  it('⭐ sin hallazgos de marca, variante ni contenido (ni de ningún otro tipo)', () => {
    expect(a.hallazgos).toEqual([]);
  });

  it('descripción propuesta sólo con lo leído, al estilo de Kepler, sin truncar', () => {
    expect(a.descripcion_propuesta).toBe('BON O BON FRESA EDICION ESPECIAL 8/15G');
  });

  it('⭐ la Ñ se conserva (Kepler la usa en 190 de 4,230 nombres medidos; los demás acentos se quitan)', () => {
    const d = descripcionPropuesta(propuesta({ marca: cp('Alteño'), denominacion: cp('Garapiñado'), variante: cp('Limón') }));
    expect(d).toBe('ALTEÑO GARAPIÑADO LIMON');
  });

  it('información nueva: lo que kdii no guarda (y una lista vacía no cuenta)', () => {
    expect(a.informacion_nueva).toEqual(['fabricante', 'sellos_nom051', 'alergenos', 'puede_contener', 'nutricion', 'empaque']);
  });
});

describe('auditarContraKepler · un caso por tipo de hallazgo', () => {
  it('marca_no_en_descripcion', () => {
    const a = auditarContraKepler(P_95805(), { ...K_95805, nombre: 'CHOCOLATE FRESA ED ESP 8/15G' });
    expect(a.hallazgos).toHaveLength(1);
    expect(a.hallazgos[0]).toMatchObject({ tipo: 'marca_no_en_descripcion', kepler: 'CHOCOLATE FRESA ED ESP 8/15G' });
    expect(a.hallazgos[0].foto).toContain('bon o bon');
  });

  it('variante_no_en_descripcion', () => {
    expect(tipos(propuesta({ ...P_95805().campos, variante: cp('Chocolate') }), K_95805)).toEqual(['variante_no_en_descripcion']);
  });

  it('contenido_distinto: el nombre dice 100G y el empaque 120 g', () => {
    const p = propuesta({ ...P_95805().campos, piezas: null, contenido_por_pieza: null });
    const a = auditarContraKepler(p, { ...K_95805, nombre: 'BON O BON FRESA 100G' });
    expect(a.hallazgos.map((h) => h.tipo)).toEqual(['contenido_distinto']);
    expect(a.hallazgos[0].kepler).toContain('100G');
    expect(a.hallazgos[0].foto).toContain('CONT. NET. 120 g');
  });

  it('contenido_distinto: mismo total, otra presentación (8/15G contra 6 de 20 g)', () => {
    const p = propuesta({ ...P_95805().campos, piezas: cp(6), contenido_por_pieza: cp({ cantidad: 20, unidad: 'g' as const }) });
    expect(tipos(p, K_95805)).toEqual(['contenido_distinto']);
  });

  it('contenido_distinto: el nombre dice volumen y el empaque peso', () => {
    const p = propuesta({ contenido_neto: cp({ cantidad: 500, unidad: 'g' as const }) }, 'pieza');
    expect(tipos(p, { ...K_95805, nombre: 'CAJETA 500ML' })).toEqual(['contenido_distinto']);
  });

  it('⭐ nivel_fisico_no_coincide: un corrugado con el código de la Base', () => {
    const a = auditarContraKepler(propuesta(P_95805().campos, 'caja_exterior'), K_95805);
    expect(a.hallazgos.map((h) => h.tipo)).toEqual(['nivel_fisico_no_coincide']);
    expect(a.hallazgos[0].kepler).toBe('Base (CJA)');
  });

  it('nivel_fisico_no_coincide: pieza en la Dos, empaque interior en la Tres, «otro» en cualquiera', () => {
    const k = { ...K_95805, nombre: null, u2: 'PAQ', f2: 12, u3: 'CJA', f3: 384 };
    expect(tipos(propuesta({}, 'pieza'), { ...k, principal: 'dos' })).toEqual(['nivel_fisico_no_coincide']);
    expect(tipos(propuesta({}, 'empaque_interior'), { ...k, principal: 'tres' })).toEqual(['nivel_fisico_no_coincide']);
    expect(tipos(propuesta({}, 'otro'), k)).toEqual(['nivel_fisico_no_coincide']);
  });

  it('piezas_distintas: la Dos dice 10 y Kepler factor 12', () => {
    const k: FichaKeplerAuditada = { nombre: null, principal: 'dos', u1: 'PZA', u2: 'PAQ', f2: 12, u3: null, f3: null };
    const a = auditarContraKepler(propuesta({ piezas: cp(10, 'CONTIENE 10 PIEZAS') }, 'empaque_interior'), k);
    expect(a.hallazgos.map((h) => h.tipo)).toEqual(['piezas_distintas']);
    expect(a.hallazgos[0].kepler).toBe('Unidad Dos: PAQ · factor 12');
  });

  it('campo_en_conflicto: uno por campo, y también el nivel físico empatado (sin juzgar el nivel)', () => {
    const variante: CampoPropuesto<string> = { ...cp('Fresa'), conflicto: [{ cara: 'posterior', valor: 'Chocolate', evidencia: 'CHOCOLATE' }] };
    const p = propuesta({ ...P_95805().campos, variante });
    p.nivel_fisico = { ...cp<NivelFisico>('caja_exterior'), conflicto: [{ cara: 'posterior', valor: 'empaque_interior', evidencia: 'caja' }] };
    const a = auditarContraKepler(p, K_95805);
    // caja_exterior en la Base sería hallazgo, pero con el nivel empatado lo decide Catálogo: no se juzga.
    expect(a.hallazgos.map((h) => h.tipo)).toEqual(['campo_en_conflicto', 'campo_en_conflicto']);
    expect(a.hallazgos[0].foto).toContain('nivel_fisico');
    expect(a.hallazgos[1].foto).toBe('variante: Fresa (frente) contra Chocolate (posterior)');
  });

  it('⭐ rostro_visible: un rostro real en alguna cara es hallazgo', () => {
    const a = auditarContraKepler(propuesta(P_95805().campos, 'empaque_interior', { persona_visible: true, rostro_visible: true }), K_95805);
    expect(a.hallazgos.map((h) => h.tipo)).toEqual(['rostro_visible']);
    expect(a.hallazgos[0].kepler).toBeNull();
  });

  it('⭐ una mano o un zapato (persona_visible sin rostro) NO es hallazgo (Francisco, 2026-11-05)', () => {
    // La mano que sostiene la caja, el zapato de quien fotografía: persona sí, rostro no.
    expect(tipos(propuesta(P_95805().campos, 'empaque_interior', { persona_visible: true, rostro_visible: false }), K_95805)).toEqual([]);
    // Ningún hallazgo dice «persona»: el tipo ya no existe.
    const todos = auditarContraKepler(propuesta(P_95805().campos, 'empaque_interior', { persona_visible: true, rostro_visible: true }), K_95805);
    expect(todos.hallazgos.map((h) => h.tipo)).not.toContain('persona_visible' as never);
  });

  it('⭐ revisión: rostro_visible NO afirma un borrado ni un bloqueo que no existen (deuda (a))', () => {
    const [h] = auditarContraKepler(propuesta(P_95805().campos, 'empaque_interior', { persona_visible: true, rostro_visible: true }), K_95805).hallazgos;
    expect(h.explicacion).not.toMatch(/se borra y se pide recaptura/); // ❌ el texto de antes, que se guardaba
    expect(h.explicacion).toMatch(/Aparece un rostro/);
    expect(h.explicacion).toMatch(/NO debe publicarse/);
    expect(h.explicacion).toMatch(/todavía no están construidos \(deuda \(a\)/);
    expect(h.explicacion).toMatch(/a mano/);
  });

  it('⭐ revisión: contenido_distinto con el neto en PIEZAS — se usa piezas × contenido por pieza (500 g contra 600 g)', () => {
    const paleta: FichaKeplerAuditada = { nombre: 'PALETA FRESA 50/12G', principal: 'base', u1: 'CJA', u2: null, f2: null, u3: null, f3: null };
    const campos = {
      contenido_neto: cp({ cantidad: 50, unidad: 'pzas' as const }, 'Contenido: 50 piezas'),
      piezas: cp(50, '50 piezas'), contenido_por_pieza: cp({ cantidad: 10, unidad: 'g' as const }, '50 piezas de 10 g'),
    };
    const a = auditarContraKepler(propuesta(campos), paleta);
    expect(a.hallazgos.map((h) => h.tipo)).toEqual(['contenido_distinto']);
    expect(a.hallazgos[0].foto).toContain('50 piezas de 10 g');
    // Controles: con 12 g por pieza cuadra (sin hallazgo); con sólo el neto en piezas no hay con qué comparar (silencio).
    expect(tipos(propuesta({ ...campos, contenido_por_pieza: cp({ cantidad: 12, unidad: 'g' as const }) }), paleta)).toEqual([]);
    expect(tipos(propuesta({ contenido_neto: campos.contenido_neto, piezas: campos.piezas }), paleta)).toEqual([]);
  });
});

describe('auditarContraKepler · cuándo NO hay hallazgo (no se adivina)', () => {
  it('nombre sin gramaje → no hay contenido_distinto', () => {
    expect(tipos(P_95805(), { ...K_95805, nombre: 'BON O BON FRESA ED ESP' })).toEqual([]);
  });

  it('⭐ factor 1 o null en la Dos → no es piezas_distintas (es factor no capturado)', () => {
    const p = propuesta({ piezas: cp(24) }, 'caja_exterior');
    const k: FichaKeplerAuditada = { nombre: null, principal: 'dos', u1: 'CJA', u2: 'CJA', f2: 1, u3: null, f3: null };
    expect(tipos(p, k)).toEqual([]);
    expect(tipos(p, { ...k, f2: null })).toEqual([]);
    expect(tipos(p, { ...k, f2: 24 })).toEqual([]); // y cuando cuadra, tampoco
  });

  it('la Tres: «32 paquetes» cuadra con factor 384 si la Dos es de 12; «24 × 8 pzas» con 192', () => {
    const k: FichaKeplerAuditada = { nombre: null, principal: 'tres', u1: 'PZA', u2: 'PAQ', f2: 12, u3: 'CJA', f3: 384 };
    expect(tipos(propuesta({ piezas: cp(32) }, 'caja_exterior'), k)).toEqual([]);
    expect(tipos(propuesta({ piezas: cp(24), contenido_por_pieza: cp({ cantidad: 8, unidad: 'pzas' as const }) }, 'caja_exterior'), { ...k, f2: 24, f3: 192 })).toEqual([]);
    expect(tipos(propuesta({ piezas: cp(30) }, 'caja_exterior'), k)).toEqual(['piezas_distintas']);
  });

  it('la Base nunca da piezas_distintas', () => {
    expect(tipos(propuesta({ piezas: cp(7) }, 'empaque_interior'), { ...K_95805, nombre: null, f2: 12 })).toEqual([]);
  });

  it('abreviatura de Kepler: CHOC por «chocolate»; «Sabor» es palabra de enlace', () => {
    const k = { ...K_95805, nombre: 'BON O BON CHOC 8/15G' };
    expect(tipos(propuesta({ ...P_95805().campos, variante: cp('Chocolate') }), k)).toEqual([]);
    expect(tipos(propuesta({ ...P_95805().campos, variante: cp('Sabor Chocolate') }), k)).toEqual([]);
    // ⭐ prueba negativa: «CH» tiene menos de 4 letras, no cuenta como abreviatura
    expect(tipos(propuesta({ ...P_95805().campos, variante: cp('Chocolate') }), { ...k, nombre: 'BON O BON CH 8/15G' })).toEqual(['variante_no_en_descripcion']);
  });

  it('marca = fabricante («Arcor») pero el nombre comercial sí está en la descripción → no es hallazgo', () => {
    const p = propuesta({ ...P_95805().campos, marca: cp('Arcor'), nombre_comercial: cp('Bon o Bon') });
    expect(tipos(p, K_95805)).toEqual([]);
  });

  it('el nombre describe otro peldaño: TURIN 16KG con Base de 500 g y factor 32 (ERP_KEPLER §2.1)', () => {
    const p = propuesta({ contenido_neto: cp({ cantidad: 500, unidad: 'g' as const }) }, 'granel');
    const turin: FichaKeplerAuditada = { nombre: 'TURIN 16KG', principal: 'base', u1: '500', u2: 'CJA', f2: 32, u3: null, f3: null };
    expect(tipos(p, turin)).toEqual([]);
    // Sin el factor capturado no hay con qué cuadrarlo: los dos lados se leyeron y difieren → a revisión.
    expect(tipos(p, { ...turin, f2: null })).toEqual(['contenido_distinto']);
  });

  it('peldaño Dos sin factor capturado → el contenido no se puede relacionar con el nombre', () => {
    const p = propuesta({ contenido_neto: cp({ cantidad: 2.88, unidad: 'kg' as const }) }, 'caja_exterior');
    expect(tipos(p, { ...K_95805, principal: 'dos', u2: 'CJA', f2: null })).toEqual([]);
    expect(tipos(p, { ...K_95805, principal: 'dos', u2: 'CJA', f2: 24 })).toEqual([]); // 24 × 120 g = 2.88 kg
    expect(tipos(p, { ...K_95805, principal: 'dos', u2: 'CJA', f2: 20 })).toEqual(['contenido_distinto']);
  });

  it('sin propuesta (la IA no leyó): nada', () => {
    expect(auditarContraKepler(null, K_95805)).toEqual({ hallazgos: [], descripcion_propuesta: null, informacion_nueva: [] });
  });
});

describe('contenidoDelNombre', () => {
  const total = (n: string) => contenidoDelNombre(n)?.total ?? null;
  it('las formas que sí se interpretan', () => {
    expect(total('X 120G')).toEqual({ cantidad: 120, unidad: 'g' });
    expect(total('X 120 GR')).toEqual({ cantidad: 120, unidad: 'g' });
    expect(total('AZUCAR 1KG')).toEqual({ cantidad: 1000, unidad: 'g' });
    expect(total('REFRESCO 500ML')).toEqual({ cantidad: 500, unidad: 'ml' });
    expect(total('AGUA 1.5L')).toEqual({ cantidad: 1500, unidad: 'ml' });
    expect(contenidoDelNombre('BON O BON FRESA ED ESP 8/15G')).toEqual({
      total: { cantidad: 120, unidad: 'g' }, piezas: 8, por_pieza: { cantidad: 15, unidad: 'g' }, texto: '8/15G', conteo: null,
    });
    expect(contenidoDelNombre('GALLETA 12X25G')).toMatchObject({ total: { cantidad: 300, unidad: 'g' }, piezas: 12 });
    expect(contenidoDelNombre('PALETA 12/20G 240G')).toMatchObject({ total: { cantidad: 240, unidad: 'g' }, piezas: 12 });
  });

  it('⭐ lo que NO se interpreta (null, no un número inventado)', () => {
    expect(contenidoDelNombre('BON O BON FRESA')).toBeNull();
    expect(contenidoDelNombre('TRES LECHES')).toBeNull();
    expect(contenidoDelNombre('DULCE 1/2KG')).toBeNull(); // ¿medio kilo o 1 de 2 kg?
    expect(contenidoDelNombre('CHICLE 10GR X 20')).toBeNull();
    expect(contenidoDelNombre('PALETA 25PZ 10G')).toBeNull(); // ¿10 g cada una o en total?
    expect(contenidoDelNombre('MIX 100G 200G')).toBeNull(); // dos gramajes que no cuadran
    expect(contenidoDelNombre(null)).toBeNull();
  });
});

/**
 * `[NP.7.L.17]` Nombres REALES de Kepler (universo de Padre Hidalgo, 2026-11-04), leídos por tres jueces
 * independientes que no veían lo que entendía la auditoría (88 nombres, unánimes en el tipo). Con la foto
 * simulada de lo que de verdad trae el empaque según ellos. Antes de este arreglo, los tres «por pieza con Base
 * PAQ» daban `contenido_distinto` FALSO.
 */
describe('contenido contra nombres reales de Kepler (conteo al estilo Kepler)', () => {
  const g = (cantidad: number) => ({ cantidad, unidad: 'g' as const });
  const k = (nombre: string, u1: string, f2: number | null, f3: number | null, principal: FichaKeplerAuditada['principal'] = 'base'): FichaKeplerAuditada =>
    ({ nombre, principal, u1, u2: 'PAQ', f2, u3: 'CJA', f3 });
  const contenido = (p: PropuestaAmpliada, kk: FichaKeplerAuditada) => tipos(p, kk).filter((t) => t === 'contenido_distinto');

  it('lee el conteo de Kepler sin cambiar el total, y no confunde «/ 15 KG» con un conteo', () => {
    expect(contenidoDelNombre('LA ROSA JAPONES TUBO 60G 12P NISHIYAMA')).toMatchObject({ total: g(60), conteo: 12 });
    expect(contenidoDelNombre('LA ROSA MAZAPAN GIGANTE 50G /20')).toMatchObject({ total: g(50), conteo: 20 });
    expect(contenidoDelNombre('BUBBALO SWEET MIX 357 GR / 70 MONDELEZ')).toMatchObject({ total: g(357), conteo: 70 });
    expect(contenidoDelNombre('BOT DORITOS NACHO 1350GR / 25.')).toMatchObject({ total: g(1350), conteo: 25 });
    expect(contenidoDelNombre('PASTA PALITO INFINITO PAPA / 15 KG PASTECH')).toMatchObject({ total: g(15000), conteo: null });
    expect(contenidoDelNombre('TOTIS PAPITAS HOT CHILI ( 90 GR ) / 1')).toMatchObject({ total: g(90), conteo: null }); // «/ 1» no es conteo
    expect(contenidoDelNombre('CUERITO RAYADO 700GR LUPITA')).toMatchObject({ total: g(700), conteo: null });
  });

  it('⭐ por pieza con Base PAQ: la foto del paquete (piezas × gramaje) ya no da hallazgo falso', () => {
    const paq = (piezas: number, porPieza: number) => propuesta({ piezas: cp(piezas), contenido_por_pieza: cp(g(porPieza)) });
    expect(contenido(paq(12, 60), k('LA ROSA JAPONES TUBO 60G 12P NISHIYAMA', 'PAQ', 1, 15))).toEqual([]);
    expect(contenido(paq(20, 50), k('LA ROSA MAZAPAN GIGANTE 50G /20', 'PAQ', 1, 16))).toEqual([]);
    expect(contenido(paq(10, 42), k('BARCEL CHIPS FUEGO 10P 42GR', 'PAQ', 1, 4))).toEqual([]);
    expect(contenido(propuesta({ contenido_neto: cp(g(720)) }), k('LA ROSA JAPONES TUBO 60G 12P NISHIYAMA', 'PAQ', 1, 15))).toEqual([]);
  });

  it('el gramaje de un peldaño mayor y el total con conteo siguen sin hallazgo (los resuelve la escalera)', () => {
    expect(contenido(propuesta({ contenido_neto: cp(g(1000)) }), k('SURTIDO CARAMELO Y PAL 18KG LA ROSA', 'KG', 1, 18))).toEqual([]);
    expect(contenido(propuesta({ contenido_neto: cp(g(357)), piezas: cp(70) }), k('BUBBALO SWEET MIX 357 GR / 70 MONDELEZ', 'PAQ', 1, 32))).toEqual([]);
    expect(contenido(propuesta({ contenido_neto: cp(g(39)) }, 'pieza'), k('KINDER DELICE 10P 39G', 'PZA', 10, 140))).toEqual([]);
  });

  it('⭐ prueba negativa: una diferencia de verdad sigue dando hallazgo, con conteo o sin él', () => {
    expect(contenido(propuesta({ contenido_neto: cp(g(500)) }), k('CUERITO RAYADO 700GR LUPITA', 'PAQ', 1, 15))).toEqual(['contenido_distinto']);
    // 12 tubos de 50 g no son ni 60 g ni 12 × 60 g.
    expect(contenido(propuesta({ piezas: cp(12), contenido_por_pieza: cp(g(50)) }), k('LA ROSA JAPONES TUBO 60G 12P NISHIYAMA', 'PAQ', 1, 15)))
      .toEqual(['contenido_distinto']);
  });
});

describe('apareceEnNombre y descripcionPropuesta', () => {
  it('tolerante: espacios, acentos, signos', () => {
    expect(apareceEnNombre('Bon o Bon', 'BONOBON FRESA')).toBe(true);
    expect(apareceEnNombre('Bonobon', 'BON-O-BON FRESA')).toBe(true);
    expect(apareceEnNombre('Limón', 'PALETA LIMON')).toBe(true);
    expect(apareceEnNombre('Mango', 'PALETA LIMON')).toBe(false);
  });

  it('⭐ revisión: el posesivo del empaque no produce un hallazgo falso (nombre real de kdii)', () => {
    expect(apareceEnNombre("HERSHEY'S", 'CHOC HERSHEY BARRA GRANEL 14KG')).toBe(true);
    expect(apareceEnNombre('HERSHEY’S', 'CHOC HERSHEY BARRA GRANEL 14KG')).toBe(true); // apóstrofo tipográfico
    expect(apareceEnNombre("M&M'S", 'M&M CHOC 47G')).toBe(true);
    expect(apareceEnNombre("Kellogg's", 'ZUCARITAS KELLOGG 290G')).toBe(true);
    expect(apareceEnNombre("Lay's", 'PAPAS LAY CLASICAS 45G')).toBe(true);
    // Prueba negativa: quitar el posesivo no tapa una marca que de verdad no está.
    expect(apareceEnNombre("HERSHEY'S", 'CHOC CARLOS V 20G')).toBe(false);
    expect(tipos(propuesta({ marca: cp("HERSHEY'S") }), { ...K_95805, nombre: 'CHOC HERSHEY BARRA GRANEL 14KG' })).toEqual([]);
    expect(tipos(propuesta({ marca: cp("HERSHEY'S") }), { ...K_95805, nombre: 'CHOC CARLOS V 20G' })).toEqual(['marca_no_en_descripcion']);
  });

  it('null sin marca ni denominación; la denominación entra si no hay nombre comercial', () => {
    expect(descripcionPropuesta(propuesta({ variante: cp('Fresa') }))).toBeNull();
    expect(descripcionPropuesta(propuesta({ denominacion: cp('Goma de mascar'), variante: cp('Menta'), contenido_neto: cp({ cantidad: 1, unidad: 'kg' as const }) })))
      .toBe('GOMA DE MASCAR MENTA 1KG');
    // marca y nombre comercial iguales van una vez; sin piezas, el neto
    expect(descripcionPropuesta(propuesta({ marca: cp('Kranky'), nombre_comercial: cp('KRANKY'), contenido_neto: cp({ cantidad: 0.25, unidad: 'kg' as const }) })))
      .toBe('KRANKY 0.25KG');
  });

  it('no se trunca aunque pase de 40 caracteres (el largo de c2 no está medido)', () => {
    const d = descripcionPropuesta(propuesta({
      marca: cp('Mundo Dulce'), denominacion: cp('Bombón de malvavisco cubierto de chocolate'), variante: cp('Fresa con crema'),
      contenido_neto: cp({ cantidad: 120, unidad: 'g' as const }),
    }));
    expect(d).toBe('MUNDO DULCE BOMBON DE MALVAVISCO CUBIERTO DE CHOCOLATE FRESA CON CREMA 120G');
    expect((d ?? '').length).toBeGreaterThan(40);
  });
});

describe('nombre comercial contra la descripción de Kepler', () => {
  const k = (nombre: string): FichaKeplerAuditada => ({ ...K_95805, nombre });

  it('⭐ caso real: Kepler «CHUPI BUMB 1.10LTS / 20 TINAJITA» y el empaque «Chupi Bomb» → hallazgo', () => {
    const a = auditarContraKepler(propuesta({ marca: cp('Tinajita'), nombre_comercial: cp('Chupi Bomb', 'CHUPI BOMB') }), k('CHUPI BUMB 1.10LTS / 20 TINAJITA'));
    expect(a.hallazgos.map((h) => h.tipo)).toEqual(['nombre_comercial_no_en_descripcion']);
    expect(a.hallazgos[0].kepler).toBe('CHUPI BUMB 1.10LTS / 20 TINAJITA');
    expect(a.hallazgos[0].foto).toContain('Chupi Bomb');
    // Control: con la descripción bien escrita, nada.
    expect(tipos(propuesta({ marca: cp('Tinajita'), nombre_comercial: cp('Chupi Bomb') }), k('CHUPI BOMB 1.10LTS / 20 TINAJITA'))).toEqual([]);
  });

  it('casos que NO dan hallazgo: «Bon o Bon», «Xplosoda» y una abreviatura de Kepler', () => {
    expect(tipos(propuesta({ ...P_95805().campos, marca: cp('Arcor'), nombre_comercial: cp('Bon o Bon') }), k('BON O BON FRESA ED ESP 8/15G'))).toEqual([]);
    expect(tipos(propuesta({ marca: cp('Tinajita'), nombre_comercial: cp('Xplosoda') }), k('XPLOSODA 150GR / 16 TINAJITA'))).toEqual([]);
    // CHOC por «Chocolate» (abreviatura que ya acepta apareceEnNombre).
    expect(tipos(propuesta({ marca: cp('Arcor'), nombre_comercial: cp('Bon o Bon Chocolate') }), k('BON O BON CHOC 8/15G'))).toEqual([]);
  });

  it('nombre comercial = marca (misma clave): lo juzga la marca, sin hallazgo repetido', () => {
    const p = propuesta({ marca: cp('Chupi Bomb'), nombre_comercial: cp('CHUPI BOMB') });
    expect(tipos(p, k('CHUPI BUMB 1.10LTS / 20 TINAJITA'))).toEqual(['marca_no_en_descripcion']);
  });

  it('⭐ revisión 2026-11-05: el posesivo no hace dos palabras distintas (marca «Hershey\'s», nombre comercial «Hershey»)', () => {
    expect(tipos(propuesta({ marca: cp("Hershey's"), nombre_comercial: cp('Hershey') }), k('KISSES 150G'))).toEqual(['marca_no_en_descripcion']);
    expect(tipos(propuesta({ marca: cp('Hershey'), nombre_comercial: cp('HERSHEY’S') }), k('KISSES 150G'))).toEqual(['marca_no_en_descripcion']);
  });

  it('⭐ revisión 2026-11-05: el nombre comercial que trae la marca dentro se busca SIN la marca («Ricolino Bubulubu» → BUBULUBU)', () => {
    const p = propuesta({ marca: cp('Ricolino'), nombre_comercial: cp('Ricolino Bubulubu') });
    // Kepler nombra el producto: no hay hallazgo de nombre comercial. La marca que falta SIGUE siendo hallazgo (la
    // exención de la marca no cambia: exige el nombre comercial COMPLETO, ver la prueba negativa de abajo).
    expect(tipos(p, k('BUBULUBU 35G'))).toEqual(['marca_no_en_descripcion']);
    expect(tipos(p, k('RICOLINO BUBULUBU 35G'))).toEqual([]);
    expect(tipos(propuesta({ marca: cp("Hershey's"), nombre_comercial: cp("Hershey's Kisses") }), k('KISSES 150G'))).toEqual(['marca_no_en_descripcion']);
    // Sin la marca queda «Chocolate», y CHOC ya es su abreviatura: la palabra pegada BONOBON la cubre la marca.
    expect(tipos(propuesta({ marca: cp('Bon o Bon'), nombre_comercial: cp('Bon o Bon Chocolate') }), k('BONOBON CHOC 8/15G'))).toEqual([]);
    // Prueba negativa: si Kepler no nombra ni la marca ni el producto, salen los dos.
    expect(tipos(p, k('PALETA PAYASO 45G'))).toEqual(['marca_no_en_descripcion', 'nombre_comercial_no_en_descripcion']);
    expect(tipos(propuesta({ marca: cp('Ricolino'), nombre_comercial: cp('Ricolino Bubulubu') }), k('RICOLINO PAYASO 45G')))
      .toEqual(['nombre_comercial_no_en_descripcion']);
    // ⭐ Prueba negativa (sonda del corrector, 2026-11-05): con los campos cruzados por el lector (marca «Chupi Bomb»,
    // nombre comercial «Chupi Bomb Tinajita»), lo propio del nombre comercial es «Tinajita». Si eso eximiera a la
    // marca, el BUMB mal escrito de Kepler se callaría entero.
    expect(tipos(propuesta({ marca: cp('Chupi Bomb'), nombre_comercial: cp('Chupi Bomb Tinajita') }), k('CHUPI BUMB 1.10LTS / 20 TINAJITA')))
      .toEqual(['marca_no_en_descripcion']);
  });

  /**
   * ⚠️ LÍMITES DECLARADOS (NO MEDIDOS contra nombres reales de kdii): una abreviatura de menos de 4 letras («PAL» por
   * «Paleta») y una palabra pegada junto con una abreviatura («BONOBON CHOC» por «Bon o Bon Chocolate» con marca
   * «Arcor») dan hallazgo. Si se resuelven, esta prueba se pone roja y se actualiza a propósito.
   */
  it('límites declarados: abreviatura de 3 letras y palabra pegada + abreviatura siguen dando hallazgo', () => {
    expect(tipos(propuesta({ nombre_comercial: cp('Paleta Payaso') }), k('PAL PAYASO RICOLINO 45G'))).toEqual(['nombre_comercial_no_en_descripcion']);
    expect(tipos(propuesta({ marca: cp('Arcor'), nombre_comercial: cp('Bon o Bon Chocolate') }), k('BONOBON CHOC 8/15G')))
      .toEqual(['marca_no_en_descripcion', 'nombre_comercial_no_en_descripcion']);
  });
});

describe('sabores compactos (variante que es una lista)', () => {
  it('saboresDeVariante: «surtido» en cualquier lugar, o comas con 3 o más sabores; un sabor solo no es lista', () => {
    expect(saboresDeVariante('Surtido Cola, Naranja, Limón')).toEqual(['Cola', 'Naranja', 'Limón']);
    expect(saboresDeVariante('Surtidos: fresa, uva y piña')).toEqual(['fresa', 'uva', 'piña']);
    expect(saboresDeVariante('Cola, Naranja, Limón')).toEqual(['Cola', 'Naranja', 'Limón']); // 3 con comas, sin «surtido»
    expect(saboresDeVariante('fresa, uva y piña')).toEqual(['fresa', 'uva', 'piña']);
    expect(saboresDeVariante('Surtido')).toEqual([]);
    // [revisión 2026-11-05] Como lo dice el empaque en México: «surtido» al final, y «sabores» no es un sabor.
    expect(saboresDeVariante('Sabores surtidos')).toEqual([]);
    expect(saboresDeVariante('Surtido de sabores')).toEqual([]);
    expect(saboresDeVariante('Frutas surtidas')).toEqual(['Frutas']);
    // No son lista:
    expect(saboresDeVariante('Fresa')).toBeNull();
    expect(saboresDeVariante('Fresa con crema')).toBeNull();
    expect(saboresDeVariante('Yogurt')).toBeNull(); // una «y» dentro de la palabra no separa
    expect(saboresDeVariante('Surtidor')).toBeNull(); // «surtid…» dentro de otra palabra no es surtido
    expect(saboresDeVariante(null)).toBeNull();
    expect(saboresDeVariante('  ')).toBeNull();
    // ⭐ [revisión 2026-11-05] «A y B» (o «A, B») sin «surtido» es UN sabor combinado de un SKU, no un surtido.
    expect(saboresDeVariante('Mango y Tamarindo')).toBeNull();
    expect(saboresDeVariante('Avellana y Fresa')).toBeNull();
    expect(saboresDeVariante('Chile y Limón')).toBeNull();
    expect(saboresDeVariante('Fresa, Uva')).toBeNull();
    // «Mix» en la variante NO se toma como surtido: «Sweet Mix» es nombre, y SURTIDO borraría el dato.
    expect(saboresDeVariante('Sweet Mix')).toBeNull();
  });

  it('⭐ la descripción lleva SURTIDO en vez de la lista', () => {
    const campos = {
      marca: cp('Tinajita'), nombre_comercial: cp('Xplosoda'), variante: cp('Surtido Cola, Naranja, Limón'),
      contenido_neto: cp({ cantidad: 160, unidad: 'g' as const }),
    };
    expect(descripcionPropuesta(propuesta(campos))).toBe('TINAJITA XPLOSODA SURTIDO 160G');
    expect(descripcionPropuesta(propuesta({ ...campos, variante: cp('Cola, Naranja, Limón') }))).toBe('TINAJITA XPLOSODA SURTIDO 160G');
    expect(descripcionPropuesta(propuesta({ ...campos, variante: cp('Sabores surtidos') }))).toBe('TINAJITA XPLOSODA SURTIDO 160G');
    // Control: un sabor solo se escribe tal cual.
    expect(descripcionPropuesta(propuesta({ ...campos, variante: cp('Cola') }))).toBe('TINAJITA XPLOSODA COLA 160G');
  });

  it('⭐ revisión 2026-11-05: un sabor combinado («Avellana y Fresa») va tal cual, y dos SKUs no quedan con la misma descripción', () => {
    const duvalin = (variante: string) => descripcionPropuesta(propuesta({
      marca: cp('Ricolino'), nombre_comercial: cp('Duvalin'), variante: cp(variante), contenido_neto: cp({ cantidad: 15, unidad: 'g' as const }),
    }));
    expect(duvalin('Avellana y Fresa')).toBe('RICOLINO DUVALIN AVELLANA Y FRESA 15G');
    expect(duvalin('Avellana y Vainilla')).toBe('RICOLINO DUVALIN AVELLANA Y VAINILLA 15G');
    expect(duvalin('Avellana y Fresa')).not.toBe(duvalin('Avellana y Vainilla'));
    expect(duvalin('Chile y Limón')).not.toContain('SURTIDO');
  });

  /** Nombres de Kepler ARMADOS (no medidos en kdii): la lógica es la que se prueba. */
  it('⭐ revisión 2026-11-05: un sabor combinado se audita con la regla de siempre (todas sus palabras en Kepler)', () => {
    const k = (nombre: string): FichaKeplerAuditada => ({ ...K_95805, nombre });
    const p = (variante: string) => propuesta({ marca: cp('Ricolino'), nombre_comercial: cp('Duvalin'), variante: cp(variante) });
    const a = auditarContraKepler(p('Avellana y Fresa'), k('DUVALIN AVELLANA VAINILLA 15G'));
    expect(a.hallazgos.map((h) => h.tipo)).toEqual(['variante_no_en_descripcion']);
    expect(a.hallazgos[0].explicacion).toBe('El sabor o variante del empaque no aparece en la descripción de Kepler.');
    expect(tipos(propuesta({ marca: cp('Sabritas'), variante: cp('Chile y Limón') }), k('SABRITAS CHILE 45G'))).toEqual(['variante_no_en_descripcion']);
    // Controles: con los dos sabores en Kepler (completos o abreviados), nada.
    expect(tipos(p('Avellana y Fresa'), k('DUVALIN AVELLANA FRESA 15G'))).toEqual([]);
    expect(tipos(p('Avellana y Fresa'), k('DUVALIN AVELL FRESA 15G'))).toEqual([]);
  });

  it('⭐ revisión 2026-11-05: «Sabores surtidos» es surtido (Kepler SURTIDO basta) y la explicación no cita «de sabores» como sabor', () => {
    const k = (nombre: string): FichaKeplerAuditada => ({ ...K_95805, nombre });
    expect(tipos(propuesta({ marca: cp('Xplosoda'), variante: cp('Sabores surtidos') }), k('XPLOSODA SURTIDO 150GR'))).toEqual([]);
    // Prueba negativa: sin SURTIDO/SURT/MIX en Kepler, sigue siendo hallazgo.
    const sin = auditarContraKepler(propuesta({ marca: cp('Xplosoda'), variante: cp('Surtido de sabores') }), k('XPLOSODA 150GR'));
    expect(sin.hallazgos.map((h) => h.tipo)).toEqual(['variante_no_en_descripcion']);
    expect(sin.hallazgos[0].explicacion).toMatch(/surtido \(sin nombrar sus sabores\)/);
    expect(sin.hallazgos[0].explicacion).not.toMatch(/de sabores/);
  });

  /** Nombres de Kepler ARMADOS para la prueba sobre el real «XPLOSODA 150GR / 16 TINAJITA» (los otros no están medidos). */
  it('⭐ variante surtida: hallazgo sólo si Kepler no dice SURTIDO/SURT/MIX ni nombra ninguno de los sabores', () => {
    const p = propuesta({ marca: cp('Tinajita'), nombre_comercial: cp('Xplosoda'), variante: cp('Surtido Cola, Naranja, Limón') });
    const k = (nombre: string): FichaKeplerAuditada => ({ ...K_95805, nombre });
    const a = auditarContraKepler(p, k('XPLOSODA 150GR / 16 TINAJITA'));
    expect(a.hallazgos.map((h) => h.tipo)).toEqual(['variante_no_en_descripcion']);
    expect(a.hallazgos[0].explicacion).toMatch(/surtido \(Cola, Naranja, Limón\)/);
    expect(tipos(p, k('XPLOSODA SURTIDO 150GR / 16 TINAJITA'))).toEqual([]);
    expect(tipos(p, k('XPLOSODA SURT 150GR / 16 TINAJITA'))).toEqual([]);
    expect(tipos(p, k('XPLOSODA MIX 150GR / 16 TINAJITA'))).toEqual([]);
    expect(tipos(p, k('XPLOSODA NARANJA 150GR / 16 TINAJITA'))).toEqual([]); // nombra uno de los sabores
    // «Surtido» sin sabores: sólo SURTIDO/SURT/MIX lo cubren.
    const sinSabores = propuesta({ marca: cp('Tinajita'), variante: cp('Surtido') });
    expect(tipos(sinSabores, k('XPLOSODA 150GR / 16 TINAJITA'))).toEqual(['variante_no_en_descripcion']);
    expect(tipos(sinSabores, k('XPLOSODA MIX 150GR / 16 TINAJITA'))).toEqual([]);
  });
});

describe('hallazgosDeLegibilidad (revisión 2026-11-04: nadie emitía foto_no_legible)', () => {
  it('un hallazgo por cara con legible «no», con la cara y el motivo; «si» y «parcial» no producen', () => {
    const hs = hallazgosDeLegibilidad([
      { cara: 'frente', lectura: { legible: 'no', motivo_no_legible: 'reflejo del flash sobre la tabla' } },
      { cara: 'posterior', lectura: { legible: 'si', motivo_no_legible: null } },
      { cara: 'lateral_1', lectura: { legible: 'parcial', motivo_no_legible: 'borrosa' } },
      { cara: 'codigo', lectura: { legible: 'no', motivo_no_legible: null } },
    ]);
    expect(hs.map((h) => [h.tipo, h.foto])).toEqual([
      ['foto_no_legible', 'frente: reflejo del flash sobre la tabla'],
      ['foto_no_legible', 'codigo: el lector no dio el motivo'],
    ]);
    expect(hs[0].kepler).toBeNull();
    // No afirma una recaptura automática que no existe.
    expect(hs[0].explicacion).toMatch(/Catálogo la marca «recapturar»/);
  });

  it('todas legibles → ninguno', () => {
    expect(hallazgosDeLegibilidad([{ cara: 'frente', lectura: { legible: 'si', motivo_no_legible: null } }])).toEqual([]);
    expect(hallazgosDeLegibilidad([])).toEqual([]);
  });
});
