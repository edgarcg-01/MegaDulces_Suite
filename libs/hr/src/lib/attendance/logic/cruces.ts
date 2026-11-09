import type { HrClaseCruce, HrCrucesDto, HrDiaCruce, HrEstanciaCruce, HrPersonaCruce } from '@megadulces/contracts';

/**
 * Fase RH · `[RH.7.4]` — QUIÉN CHECÓ EN OTRA PLAZA. Copia de la regla de `mega-talento-90/api/src/agente-horarios/
 * cruces-plazas.ts` @ 331dccf (`clasificarDia`, `claseMasGrave`, la sede de oficinas y el orden de la lista).
 *
 * ══ LO QUE CAMBIA RESPECTO DE MEGA TALENTO: LA LLAVE ══
 * Allá cada plaza tenía su padrón y el #17 de Madero y el #17 de Abastos eran personas distintas: la única llave que
 * cruzaba plazas era el NOMBRE (normalizado, 2+ palabras), con su riesgo de casualidad. Aquí la persona es una sola
 * (`identity.users`) y la carga ya unió a quien rota (`[RH.1.4b]`): el cruce sale de su `user_id` con enrolamientos en
 * dos sedes. Sin adivinar por nombre.
 *
 * ══ LO QUE SE EXCLUYE A PROPÓSITO ══
 * Oficinas tiene TRES relojes (jornada, comida y el .196) que son la MISMA sede: cruzarse ahí es el diseño (35 personas
 * a diario, medido por Mega Talento el 20/08/2026). Van agrupados por sede.
 *
 * ══ NO TODO CRUCE ES LO MISMO ══ (de los casos reales de Mega Talento, 20/08/2026)
 *  · `traslape` — dos JORNADAS que se pisan (06:56→16:56 en corporativo y 08:21→15:06 en Zamora Canindo): o checan
 *    por ella, o su código lo usa otra persona. Exige que las DOS estancias tengan ventana real (2+ marcas).
 *  · `marca_ajena` — una marca SUELTA en la plaza de otro, a media jornada propia. A propósito NO se llama imposible:
 *    pudo ir y volver. Acusar de más hace que la lista se descarte la primera vez que alguien demuestra que fue por un
 *    pedido.
 *  · `jornada_partida` — cubrió dos tiendas y su día quedó cortado (entra 08:06 en Vicente Guerrero, sale 16:09 en
 *    Abastos): no es falta, es por qué aparece con «una sola marca» en cada plaza.
 *  · `ruta_promotora` — la ruta de una promotora: es su trabajo. Se marca aparte, no se esconde.
 */

/** Relojes que son la MISMA sede física: cruzarse entre ellos es normal. */
const MISMA_SEDE: Record<string, string> = {
  'corporativo': 'oficinas',
  'corporativo-comida': 'oficinas',
  'reloj-196': 'oficinas',
};
export const sedeDe = (siteCode: string): string => MISMA_SEDE[siteCode] || siteCode;

/** Hueco máximo entre dos estancias para leerlas como UNA jornada partida. */
const HUECO_JORNADA_MIN = 240;

const hhmm = (h: string): string => String(h || '').slice(0, 5);
const aMin = (h: string): number | null => {
  const [hh, mm] = hhmm(h).split(':').map(Number);
  return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : null;
};

/** Clasifica un día con estancias en dos o más sedes (copia textual de Mega Talento). */
export function clasificarDia(estancias: HrEstanciaCruce[], esPromotora: boolean): { clase: HrClaseCruce; huecoMin: number | null } {
  const orden = estancias.slice().sort((a, b) => (aMin(a.primera) ?? 0) - (aMin(b.primera) ?? 0));

  // El hueco más chico entre una estancia y la siguiente. Negativo = se enciman.
  let peorHueco: number | null = null;
  for (let i = 1; i < orden.length; i++) {
    const finAnterior = aMin(orden[i - 1].ultima);
    const inicio = aMin(orden[i].primera);
    if (finAnterior === null || inicio === null) continue;
    const hueco = inicio - finAnterior;
    if (peorHueco === null || hueco < peorHueco) peorHueco = hueco;
  }

  // UNA ESTANCIA DE UNA SOLA MARCA NO ES UNA ESTANCIA: es un instante, no una ventana de presencia.
  const conVentana = orden.filter((e) => e.marcas >= 2 && (aMin(e.ultima) ?? 0) > (aMin(e.primera) ?? 0));
  const seEnciman = (a: HrEstanciaCruce, b: HrEstanciaCruce): boolean =>
    (aMin(a.primera) ?? 0) < (aMin(b.ultima) ?? 0) && (aMin(b.primera) ?? 0) < (aMin(a.ultima) ?? 0);

  // 1) Dos jornadas de verdad que se pisan: nadie está en dos plazas a la vez.
  for (let i = 0; i < conVentana.length; i++) {
    for (let j = i + 1; j < conVentana.length; j++) {
      if (sedeDe(conVentana[i].site_code) === sedeDe(conVentana[j].site_code)) continue;
      if (seEnciman(conVentana[i], conVentana[j])) return { clase: 'traslape', huecoMin: peorHueco };
    }
  }

  // 2) Una ruta de promotora explica estar en dos plazas el mismo día (no a la misma hora: eso ya se descartó).
  if (esPromotora) return { clase: 'ruta_promotora', huecoMin: peorHueco };

  // 3) Marca suelta en la plaza ajena, con su jornada corriendo en otra.
  const instantes = orden.filter((e) => !conVentana.includes(e));
  for (const s of instantes) {
    const hora = aMin(s.primera);
    if (hora === null) continue;
    const dentro = conVentana.some((e) =>
      sedeDe(e.site_code) !== sedeDe(s.site_code) && hora >= (aMin(e.primera) ?? 0) && hora <= (aMin(e.ultima) ?? 0));
    if (dentro) return { clase: 'marca_ajena', huecoMin: peorHueco };
  }

  // 4) Dos estancias pegadas: cubrió dos tiendas y su día quedó cortado.
  if (peorHueco !== null && peorHueco >= 0 && peorHueco <= HUECO_JORNADA_MIN) {
    return { clase: 'jornada_partida', huecoMin: peorHueco };
  }
  return { clase: 'sueltas', huecoMin: peorHueco };
}

/** La clase más grave de un conjunto de días. Es la que le pone cara a la fila. */
const GRAVEDAD: HrClaseCruce[] = ['traslape', 'marca_ajena', 'jornada_partida', 'sueltas', 'ruta_promotora'];
export function claseMasGrave(clases: HrClaseCruce[]): HrClaseCruce {
  for (const c of GRAVEDAD) if (clases.includes(c)) return c;
  return 'sueltas';
}

/** Lo que trae la base: una estancia por persona, plaza, código y día. */
export interface FilaEstancia { user_id: string; site_code: string; codigo: string; fecha: string; primera: string; ultima: string; marcas: number }
/** Las personas enroladas en más de un sitio, con sus altas. */
export interface PersonaMultisitio { user_id: string; nombre: string; esPromotora: boolean; altas: Array<{ site_code: string; codigo: string }> }

/** Arma la lista: sólo los días con estancias en DOS SEDES, clasificados y ordenados como en Mega Talento. */
export function crucesEntrePlazas(desde: string, hasta: string, personasMulti: PersonaMultisitio[], filas: FilaEstancia[]): HrCrucesDto {
  const enDosSedes = personasMulti.filter((p) => new Set(p.altas.map((a) => sedeDe(a.site_code))).size > 1);
  const porPersona = new Map<string, FilaEstancia[]>();
  for (const f of filas) {
    if (!porPersona.has(f.user_id)) porPersona.set(f.user_id, []);
    (porPersona.get(f.user_id) as FilaEstancia[]).push(f);
  }

  const personas: HrPersonaCruce[] = [];
  for (const p of enDosSedes) {
    const porDia = new Map<string, HrEstanciaCruce[]>();
    for (const f of porPersona.get(p.user_id) ?? []) {
      if (!porDia.has(f.fecha)) porDia.set(f.fecha, []);
      (porDia.get(f.fecha) as HrEstanciaCruce[]).push({
        site_code: f.site_code, codigo: f.codigo, primera: hhmm(f.primera), ultima: hhmm(f.ultima), marcas: f.marcas,
      });
    }
    const dias: HrDiaCruce[] = [];
    for (const [fecha, estancias] of porDia) {
      // El cruce es entre SEDES: dos estancias en los relojes de oficinas son un solo lugar.
      if (new Set(estancias.map((e) => sedeDe(e.site_code))).size < 2) continue;
      const { clase, huecoMin } = clasificarDia(estancias, p.esPromotora);
      dias.push({ fecha, estancias, clase, huecoMin });
    }
    if (!dias.length) continue;
    dias.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));   // el más reciente primero
    personas.push({
      user_id: p.user_id, nombre: p.nombre, esPromotora: p.esPromotora,
      altas: p.altas.slice().sort((a, b) => a.site_code.localeCompare(b.site_code)),
      clase: claseMasGrave(dias.map((d) => d.clase)),
      dias,
      diasCruzados: dias.length,
      traslapes: dias.filter((d) => d.clase === 'traslape').length,
      marcasAjenas: dias.filter((d) => d.clase === 'marca_ajena').length,
      ultimoDia: dias[0].fecha,
    });
  }

  // Primero lo que hay que explicar (traslapes), luego lo que hay que arreglar (jornadas partidas), y al final las
  // rutas de promotora, que son normales.
  const rango = (c: HrClaseCruce): number => GRAVEDAD.indexOf(c);
  personas.sort((a, b) =>
    rango(a.clase) - rango(b.clase) || b.traslapes - a.traslapes || b.marcasAjenas - a.marcasAjenas ||
    b.diasCruzados - a.diasCruzados || a.nombre.localeCompare(b.nombre, 'es'));

  return {
    desde, hasta, enDosSedes: enDosSedes.length, personas,
    resumen: {
      personas: personas.length,
      dias: personas.reduce((t, p) => t + p.diasCruzados, 0),
      traslapes: personas.reduce((t, p) => t + p.traslapes, 0),
      marcasAjenas: personas.reduce((t, p) => t + p.marcasAjenas, 0),
      jornadasPartidas: personas.filter((p) => p.clase === 'jornada_partida').length,
      rutas: personas.filter((p) => p.clase === 'ruta_promotora').length,
    },
  };
}
