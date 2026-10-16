/**
 * Mapa voseo (rioplatense) → tuteo (español de México).
 *
 * Por qué existe: la interfaz de producción le habla al usuario de "vos"
 * ("tenés", "revisá", "elegí"). Quien usa la suite es mexicano y el tuteo es el
 * registro correcto. El mapa es explícito a propósito: las irregularidades
 * (tenés→tienes, cerrá→cierra, enviá→envía, poné→pon) NO salen de una regla de
 * sufijos, y una regla que se las come en silencio es peor que no tener regla.
 *
 * - INDICATIVO: 2ª persona del presente (tenés → tienes).
 * - IMPERATIVO_AR / _ER: imperativo (revisá → revisa, poné → pon).
 * - IMPERATIVO_IR_AMBIGUO: AMBIGUO con el pretérito de 1ª persona ("yo elegí"
 *   es correcto). No se reemplaza a ciegas: se revisa caso por caso.
 */

const INDICATIVO = {
  tenés: 'tienes', podés: 'puedes', querés: 'quieres', sabés: 'sabes',
  hacés: 'haces', debés: 'debes', decís: 'dices', ponés: 'pones',
  venís: 'vienes', salís: 'sales', creés: 'crees', traés: 'traes',
  perdés: 'pierdes', prendés: 'prendes', volvés: 'vuelves', movés: 'mueves',
  devolvés: 'devuelves', entendés: 'entiendes', reconocés: 'reconoces',
  respondés: 'respondes', elegís: 'eliges', repetís: 'repites',
  seguís: 'sigues', abrís: 'abres', subís: 'subes', escribís: 'escribes',
  recibís: 'recibes', decidís: 'decides', cubrís: 'cubres', excluís: 'excluyes',
  cerrás: 'cierras', contás: 'cuentas', encontrás: 'encuentras',
  probás: 'pruebas', empezás: 'empiezas', recordás: 'recuerdas',
  pensás: 'piensas', mostrás: 'muestras', acordás: 'acuerdas',
  capturás: 'capturas', confirmás: 'confirmas', necesitás: 'necesitas',
  cobrás: 'cobras', pasás: 'pasas', mirás: 'miras', llevás: 'llevas',
  ayudás: 'ayudas', agregás: 'agregas', hablás: 'hablas', guardás: 'guardas',
  escaneás: 'escaneas', entrás: 'entras', buscás: 'buscas', asignás: 'asignas',
  acabás: 'acabas', validás: 'validas', trabajás: 'trabajas', tomás: 'tomas',
  tecleás: 'tecleas', retecleás: 'retecleas', mandás: 'mandas',
  esperás: 'esperas', cambiás: 'cambias', terminás: 'terminas',
  simulás: 'simulas', seleccionás: 'seleccionas', scrolleás: 'scrolleas',
  saltás: 'saltas', sacás: 'sacas', reclamás: 'reclamas', quitás: 'quitas',
  pegás: 'pegas', navegás: 'navegas', ligás: 'ligas',
  interpretás: 'interpretas', flojeás: 'flojeas', filtrás: 'filtras',
  especificás: 'especificas', dudás: 'dudas', descartás: 'descartas',
  desactivás: 'desactivas', dejás: 'dejas', clasificás: 'clasificas',
  bajás: 'bajas', armás: 'armas', aplicás: 'aplicas', apartás: 'apartas',
  alcanzás: 'alcanzas', ahorrás: 'ahorras', usás: 'usas', llamás: 'llamas',
  marcás: 'marcas', registrás: 'registras', firmás: 'firmas',
  intentás: 'intentas', ingresás: 'ingresas', revisás: 'revisas',
  verificás: 'verificas', completás: 'completas', cargás: 'cargas',
  editás: 'editas', eliminás: 'eliminas', enviás: 'envías', ampliás: 'amplías',
  continuás: 'continúas', actuás: 'actúas', evaluás: 'evalúas',
};

// Imperativo de verbos -ar. El tuteo SÍ diptonga (cerrá→cierra) y los verbos en
// -iar/-uar llevan tilde (enviá→envía): por eso va explícito, no por sufijo.
const IMPERATIVO_AR = {
  cerrá: 'cierra', contá: 'cuenta', probá: 'prueba', empezá: 'empieza',
  soltá: 'suelta', mostrá: 'muestra', encontrá: 'encuentra',
  recordá: 'recuerda', pensá: 'piensa', comenzá: 'comienza', jugá: 'juega',
  despertá: 'despierta', colgá: 'cuelga', acordá: 'acuerda', aprobá: 'aprueba',
  enviá: 'envía', ampliá: 'amplía', vaciá: 'vacía', desviá: 'desvía',
  enfriá: 'enfría', confiá: 'confía', guiá: 'guía', variá: 'varía',
  continuá: 'continúa', actuá: 'actúa', evaluá: 'evalúa',
  acercá: 'acerca', achicá: 'achica', acotá: 'acota', activá: 'activa',
  actualizá: 'actualiza', adaptá: 'adapta', adjuntá: 'adjunta', afiná: 'afina',
  agregá: 'agrega', ajustá: 'ajusta', analizá: 'analiza', andá: 'anda',
  aplicá: 'aplica', apuntá: 'apunta', armá: 'arma', arrancá: 'arranca',
  arrastrá: 'arrastra', asigná: 'asigna', atacá: 'ataca', autorizá: 'autoriza',
  avisá: 'avisa', buscá: 'busca', cambiá: 'cambia', cancelá: 'cancela',
  capturá: 'captura', cargá: 'carga', citá: 'cita', clasificá: 'clasifica',
  compará: 'compara', completá: 'completa', comprá: 'compra',
  comunicá: 'comunica', conciliá: 'concilia', configurá: 'configura',
  confirmá: 'confirma', considerá: 'considera', consultá: 'consulta',
  copiá: 'copia', creá: 'crea', cruzá: 'cruza', declará: 'declara',
  dejá: 'deja', derivá: 'deriva', desactivá: 'desactiva', descartá: 'descarta',
  destildá: 'destilda', dictá: 'dicta', dispará: 'dispara', editá: 'edita',
  eliminá: 'elimina', encuadrá: 'encuadra', enfocá: 'enfoca', enlazá: 'enlaza',
  entregá: 'entrega', entrá: 'entra', escaneá: 'escanea',
  especificá: 'especifica', esperá: 'espera', etiquetá: 'etiqueta',
  explicá: 'explica', explorá: 'explora', filtrá: 'filtra', firmá: 'firma',
  generá: 'genera', guardá: 'guarda', hablá: 'habla',
  identificá: 'identifica', ignorá: 'ignora', importá: 'importa',
  indicá: 'indica', ingresá: 'ingresa', iniciá: 'inicia', intentá: 'intenta',
  interpretá: 'interpreta', invalidá: 'invalida', investigá: 'investiga',
  invitá: 'invita', juntá: 'junta', liberá: 'libera', limpiá: 'limpia',
  listá: 'lista', llamá: 'llama', llená: 'llena', mandá: 'manda',
  mapeá: 'mapea', marcá: 'marca', mirá: 'mira', optimizá: 'optimiza',
  ordená: 'ordena', organizá: 'organiza', pasá: 'pasa', pegá: 'pega',
  populá: 'popula', preguntá: 'pregunta', pulsá: 'pulsa', quitá: 'quita',
  reactivá: 'reactiva', recalculá: 'recalcula', recargá: 'recarga',
  rechazá: 'rechaza', recortá: 'recorta', refiná: 'refina',
  reformulá: 'reformula', refrescá: 'refresca', registrá: 'registra',
  reimportá: 'reimporta', reintentá: 'reintenta', reportá: 'reporta',
  resaltá: 'resalta', reservá: 'reserva', reseteá: 'resetea',
  respetá: 'respeta', revisá: 'revisa', rotá: 'rota', segmentá: 'segmenta',
  seleccioná: 'selecciona', separá: 'separa', sincronizá: 'sincroniza',
  sintetizá: 'sintetiza', sumá: 'suma', tanteá: 'tantea', tecleá: 'teclea',
  terminá: 'termina', tocá: 'toca', tomá: 'toma', ubicá: 'ubica', usá: 'usa',
  validá: 'valida', verificá: 'verifica',
};

// Imperativo de verbos -er. poné→pon / hacé→haz / tené→ten son supletivos.
const IMPERATIVO_ER = {
  poné: 'pon', hacé: 'haz', tené: 'ten', volvé: 'vuelve', corré: 'corre',
  ofrecé: 'ofrece', resolvé: 'resuelve', respondé: 'responde', leé: 'lee',
  devolvé: 'devuelve', promové: 'promueve', traé: 'trae',
  // ⛔ `bebé` NO va: en español es el sustantivo (un bebé) mucho más seguido que
  // el imperativo de beber. Convirtió 'bebé' en 'bebe' dentro de una lista de
  // puestos del bot de RH. Medido el 2026-10-15.
  reabastecé: 'reabastece', aprendé: 'aprende', vendé: 'vende',
  prendé: 'prende', perdé: 'pierde', mové: 'mueve', entendé: 'entiende',
  escogé: 'escoge', recogé: 'recoge', comé: 'come', sabé: 'sabe',
};

/**
 * Imperativo de verbos -ir. La forma es IDÉNTICA al pretérito de 1ª persona
 * ("yo elegí" es español correcto), así que cada palabra de acá se revisó
 * ocurrencia por ocurrencia antes de entrar (2026-10-15: 292 casos, todos
 * imperativos salvo las excepciones de abajo).
 *
 * ⛔ `recibí` NO está y no debe agregarse: en los bots de WhatsApp y RH es 1ª
 * persona en casi todos lados ("Recibí tu comprobante", "Recibí tu archivo") y
 * además es un sustantivo del dominio —el sello de "recibí" en un documento—.
 * Meterlo acá convierte 24 frases correctas en 24 errores.
 */
const IMPERATIVO_IR_AMBIGUO = {
  elegí: 'elige', escribí: 'escribe', abrí: 'abre',
  subí: 'sube', pedí: 'pide', corregí: 'corrige', decí: 'di', seguí: 'sigue',
  preferí: 'prefiere', describí: 'describe', definí: 'define', surtí: 'surte',
  reducí: 'reduce', repetí: 'repite', imprimí: 'imprime', permití: 'permite',
  incluí: 'incluye', emití: 'emite', dividí: 'divide', convertí: 'convierte',
  medí: 'mide', vení: 'ven', salí: 'sal', sentí: 'siente', viví: 'vive',
};

/**
 * Escapes: frases donde la forma SÍ es correcta en 1ª persona. Se prueban
 * contra el texto alrededor del hallazgo.
 */
const EXCEPCIONES = [
  /qué\s+pedí/i, // «¿qué pedí la última vez?» — el usuario hablando de su pedido
];

// Pronominales: el enclítico mueve la tilde (fijate→fíjate).
const PRONOMINALES = {
  fijate: 'fíjate', acordate: 'acuérdate', asegurate: 'asegúrate',
  quedate: 'quédate', sentate: 'siéntate', tomate: 'tómate', andate: 'vete',
  dejalo: 'déjalo', dejala: 'déjala', hacelo: 'hazlo', hacela: 'hazla',
  ponelo: 'ponlo', ponela: 'ponla', revisalo: 'revísalo',
  revisala: 'revísala', cargalo: 'cárgalo', cargala: 'cárgala',
  guardalo: 'guárdalo', guardala: 'guárdala', marcalo: 'márcalo',
  marcala: 'márcala', usalo: 'úsalo', usala: 'úsala', pedilo: 'pídelo',
  pedila: 'pídela', elegilo: 'elígelo', elegila: 'elígela', subilo: 'súbelo',
  subila: 'súbela', abrilo: 'ábrelo', abrila: 'ábrela',
  intentalo: 'inténtalo', probalo: 'pruébalo', probala: 'pruébala',
  avisanos: 'avísanos', contanos: 'cuéntanos', escribinos: 'escríbenos',
  mandanos: 'mándanos', deciles: 'diles', decile: 'dile',

  // El enclítico obliga a tildar en tuteo (cancelalo → cancélalo): por eso un
  // "revisá ese vale y cancelalo" quedaba a medio corregir.
  // ⛔ Nada de palabras que también son inglés o CSS: `animate`, `translate`,
  // `rotate`, `activate`, `validate`, `separate` viven en clases de Tailwind y
  // en `transform:`. Tocarlas rompe estilos, no texto.
  acercate: 'acércate', aclarale: 'aclárale', aclaralo: 'acláralo',
  adjuntala: 'adjúntala', adjuntalo: 'adjúntalo', agregalo: 'agrégalo',
  agregalos: 'agrégalos', anotala: 'anótala', anulala: 'anúlala',
  asignale: 'asígnale', asignalos: 'asígnalos', avisale: 'avísale',
  avisame: 'avísame', ayudame: 'ayúdame', buscala: 'búscala',
  buscalo: 'búscalo', callate: 'cállate', cambiala: 'cámbiala',
  cambiale: 'cámbiale', cambialo: 'cámbialo', cancelalo: 'cancélalo',
  capturala: 'captúrala', capturalo: 'captúralo', cerralo: 'ciérralo',
  comparame: 'compárame', configuralo: 'configúralo',
  confirmala: 'confírmala', confirmalo: 'confírmalo', contalos: 'cuéntalos',
  contame: 'cuéntame', copiala: 'cópiala', copialo: 'cópialo',
  corregila: 'corrígela', corregilo: 'corrígelo', dejame: 'déjame',
  desactivala: 'desactívala', devolvela: 'devuélvela', disparalo: 'dispáralo',
  entregalo: 'entrégalo', escribilo: 'escríbelo', llamala: 'llámala',
  mandalo: 'mándalo', mandame: 'mándame', marcalos: 'márcalos',
  mostralo: 'muéstralo', mostrame: 'muéstrame', muestrame: 'muéstrame',
  omitilo: 'omítelo', pegalo: 'pégalo', preguntale: 'pregúntale',
  preguntame: 'pregúntame', quitala: 'quítala', quitalas: 'quítalas',
  reactivalo: 'reactívalo', recibila: 'recíbela', recibilo: 'recíbelo',
  reclasificala: 'reclasifícala', reconocelo: 'reconócelo',
  refrescalo: 'refréscalo', registralo: 'regístralo', reportalo: 'repórtalo',
  respetalo: 'respétalo', revisalas: 'revísalas', revisalos: 'revísalos',
  rompelo: 'rómpelo', sacale: 'sácale', seguila: 'síguela',
  sueltalo: 'suéltalo', terminalo: 'termínalo', tratalo: 'trátalo',
  vacialo: 'vacíalo', validala: 'valídala', verificalo: 'verifícalo',
  pediselo: 'pídeselo', decíselo: 'díselo', decímelo: 'dímelo',
  reconstruila: 'reconstrúyela', setealo: 'setéalo', saludalo: 'salúdalo',
  investigalo: 'investígalo', reasignalos: 'reasígnalos',
};

/**
 * Frases: lo que una tabla palabra-por-palabra no puede ver. Tras una
 * preposición el pronombre es "ti", no "tú" — "Reservado por vos" se había
 * convertido en "Reservado por tú".
 */
const FRASES = [
  // `i` para que "Para vos" al empezar la frase también entre; `$1` conserva
  // la mayúscula original. "Con vos" lleva su propia línea porque "contigo"
  // no se arma con $1 y, al principio de una frase, iría en minúscula.
  { re: /\b(a|para|por|de|en|sin|sobre|hacia|entre|ante|tras|hasta|desde) tú\b/gi, por: '$1 ti' },
  { re: /\b(a|para|por|de|en|sin|sobre|hacia|entre|ante|tras|hasta|desde) vos\b/gi, por: '$1 ti' },
  { re: /\bCon (tú|vos)\b/g, por: 'Contigo' },
  { re: /\bcon (tú|vos)\b/g, por: 'contigo' },
];

// Pronombre y cópula. "acá/allá" no son voseo pero leen regional: se reportan
// aparte y se deciden a mano.
const PRONOMBRE = { vos: 'tú', sos: 'eres' };

const SEGURO = {
  ...INDICATIVO,
  ...IMPERATIVO_AR,
  ...IMPERATIVO_ER,
  ...PRONOMINALES,
  ...PRONOMBRE,
};

module.exports = {
  INDICATIVO,
  IMPERATIVO_AR,
  IMPERATIVO_ER,
  IMPERATIVO_IR_AMBIGUO,
  PRONOMINALES,
  PRONOMBRE,
  FRASES,
  EXCEPCIONES,
  SEGURO,
  AMBIGUO: IMPERATIVO_IR_AMBIGUO,
};
