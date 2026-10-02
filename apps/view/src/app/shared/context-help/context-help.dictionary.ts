/**
 * DESIGN §P — Diccionario de negocio para la ayuda contextual (`<app-context-help>`).
 * FUENTE ÚNICA y versionada de las explicaciones de reglas/jerga por módulo. NO se
 * redactan descripciones ad-hoc en los templates: se agregan aquí. Cada `topic` = un
 * apartado; sus definiciones se muestran en el cajón lateral de ayuda.
 *
 * Definiciones ancladas al comportamiento real del sistema (backend libs/fiscal, etc.),
 * no inventadas.
 */
export interface HelpEntry { term: string; def: string; }
export interface HelpGroup { heading: string; entries: HelpEntry[]; }
/** Bloque "cómo se resuelve": pasos accionables. kind='fix' = se corrige (en Kepler/aquí);
 *  kind='info' = no requiere acción (se explica por qué). */
export interface HelpResolveBlock { heading: string; kind?: 'fix' | 'info'; intro?: string; steps: string[]; }
export interface HelpTopic { title: string; intro?: string; groups?: HelpGroup[]; resolve?: HelpResolveBlock[]; }

export const CONTEXT_HELP: Record<string, HelpTopic> = {
  // `[PR.V4]` El motor habla con siete verbos y cinco grados de certeza, y ninguno es obvio.
  // Siete roles lo leen (compras, finanzas, marketing, direccion, gerente_compras y dos mas) y
  // ninguno es tecnico, asi que el registro de TODO este topico es palabra llana: nada de
  // "veredicto", "coeficiente" ni nombres de columna. Cada definicion esta anclada a la regla
  // real de `analytics.v_price_action`, no a lo que la etiqueta sugiere.
  // `[PR.X2]` Para qué sirve el módulo y cómo se encadenan sus tres pantallas. Es un topico
  // aparte del vocabulario (`motor-margen`) y del de la medición externa (`competencia`): esos
  // dos explican QUÉ significa cada palabra, y éste explica QUÉ HACÉS, en qué orden y con quién.
  // Se escribió porque la pregunta llegó tal cual: «¿y para qué sirve este motor?».
  'control-de-margen': {
    title: 'Control de margen — para qué sirve y cómo se usa',
    intro: 'Cada producto tiene su propio precio en cada plaza, y son decenas de miles de combinaciones: nadie puede revisarlas una por una. El módulo las mira todas cada noche y dice UNA sola cosa de cada una — qué se puede hacer con ese precio, cuánto vale hacerlo, y qué tan en firme está esa afirmación. No cambia ningún precio: la captura sigue siendo en Kepler, a mano. Es un triage, no un ejecutor.',
    groups: [
      {
        heading: 'Las tres pantallas, y por qué son tres',
        entries: [
          { term: 'Motor', def: 'Dice QUÉ MOVER. Revisa cada producto en cada plaza y propone una acción, con el dinero que mueve y la certeza que tiene. Es por donde se empieza.' },
          { term: 'Competencia', def: 'Dice SI EL MERCADO TE ACOMPAÑA. El motor mira sólo números propios: puede proponerte subir un precio en una categoría donde ya venías perdiendo terreno. Esta pantalla trae la medición mensual de afuera para que esa decisión no se tome a ciegas.' },
          { term: 'Experimentos', def: 'Dice SI TE ANIMÁS. Es lo ÚNICO que convierte una acción de "efecto no medido" a medida. Sin esto, subir precio es una apuesta razonada; con esto, es una decisión con evidencia.' },
        ],
      },
      {
        heading: 'Lo que hay que leer del tablero, y casi nadie lee',
        entries: [
          { term: 'Que la mayoría no diga nada está BIEN', def: 'Medido el 2026-10-01: de 86,233 combinaciones, 64,062 — tres de cada cuatro — salen como "sin acción defendible". No es que el motor falle: es que prefiere callarse antes que inventar una recomendación. Un motor que propone algo en todas las filas no sirve para priorizar.' },
          { term: 'La acción que más dinero mueve es la MENOS segura', def: 'Medido el mismo día: "subir el precio" mueve $333 mil, más que las otras tres juntas — y es la única cuya certeza es "efecto no medido". La cuenta supone que el cliente sigue comprando igual después del alza, y eso nadie lo comprobó. Por eso existe la pestaña de Experimentos.' },
          { term: 'Las acciones aritméticas son las que se pueden tomar hoy', def: 'Aterrizar precio, revisar costo y corregir escalera suman unos $210 mil y la cuenta se cierra sola: no dependen de adivinar qué hace el cliente. Son menos dinero, pero no hay nada que medir antes.' },
        ],
      },
    ],
    resolve: [
      {
        heading: 'El proceso del Motor — de la cola a Kepler',
        kind: 'fix',
        intro: 'Todo se captura en Kepler. Esta pantalla no escribe ningún precio.',
        steps: [
          'El motor lee cada noche el costo, el precio, la venta de 30 días y la existencia, directo del ERP.',
          'Para cada producto en cada plaza prueba sus reglas EN ORDEN y se queda con la primera que aplica. Por eso cada renglón dice una sola cosa y no una lista de sugerencias.',
          'Le pone precio a esa acción: cuántos pesos mueve. Y le pone certeza, que es lo que decide si le creés.',
          'Ordena la cola por dinero, de mayor a menor.',
          'Vos abrís el renglón: ahí está la historia del costo contra la venta, y qué pasó las veces anteriores que se tocó ese precio.',
          'Simulás un precio nuevo. El simulador te dice el margen que quedaría, dónde aterriza el número, y cuánto volumen tendrías que perder para que el cambio te deje peor que como estás.',
          'Si convence, lo capturás en Kepler. El motor lo ve en la corrida siguiente.',
        ],
      },
      {
        heading: 'El proceso del Experimento — por qué hace falta y cómo corre',
        kind: 'info',
        intro: 'Sirve para una sola pregunta: si subo el precio, ¿deja de comprar? Diseñar NO cambia ningún precio.',
        steps: [
          'Elegís la terminación a probar y en qué rangos de precio. El motor parte las celdas elegibles en dos mitades parejas.',
          'Una mitad es TRATAMIENTO y lleva el precio nuevo. La otra es CONTROL y se queda exactamente igual. El control es lo que compra el calendario: si subís en diciembre y la venta sube, sin control no sabés si fue el precio o fue diciembre.',
          'El reparto es al azar pero REPRODUCIBLE: la semilla queda guardada, así que cualquiera puede rehacerlo y verificar que no se eligieron a dedo las celdas convenientes.',
          'Capturás en Kepler SÓLO las del tratamiento, y vas marcando cada una conforme la aplicás.',
          'Pasada la ventana, el sistema compara el volumen de las dos mitades y da uno de cuatro resultados: no inferior, inferior, no concluyente, o abortado.',
          'Los rangos marcados NO ALCANZA no se corren a propósito: arriba de $100 el margen que el negocio tolera es tan chico que harían falta más de cien mil celdas por mitad, y hay mil. Correrlo igual daría "no concluyente", que se lee como "no funciona" y no es lo mismo.',
        ],
      },
      {
        heading: 'El proceso de Competencia — qué preguntarle antes de mover un precio',
        kind: 'info',
        intro: 'Sale de la medición mensual de ISCAM, que mide a un panel de mayoristas y nos incluye. Restando lo nuestro queda lo que vendió el resto del canal.',
        steps: [
          '¿Cuánto peso tengo en esa categoría? Con una parte grande el precio lo ponés vos; con una chica lo tomás del mercado. No es lo mismo decidir que seguir.',
          '¿Estoy caro o barato en esa marca? La pantalla compara nuestro precio implícito contra el del resto del canal, y dice con palabras si la comparación se sostiene o si vendemos tan poco de esa marca que el número es ruido.',
          '¿El terreno se está moviendo? Si el mercado de esa categoría creció y nosotros caímos, subir el precio ahí empuja en la dirección en la que ya venías perdiendo.',
          '¿Hay marcas que el canal compra y nosotros no vendemos? Ahí no hay nada que corregir de precio: es surtido, y es una conversación con compras.',
          'Lo que esta pantalla NO puede decirte es QUIÉN vende a ese precio: el panel esconde los nombres. Los competidores con nombre y domicilio salen de otra fuente y esa no dice cuánto vende nadie.',
        ],
      },
    ],
  },
  competencia: {
    title: 'Competencia — de dónde sale cada número',
    intro: 'Todo lo de esta pantalla viene de ISCAM, la medición de mercado que llega una vez al mes. ISCAM mide a un panel de mayoristas, nos incluye a nosotros, y devuelve cuánto se vendió de cada marca. Restando lo nuestro queda lo que vendió el resto del canal: eso es "la competencia" acá.',
    groups: [
      {
        heading: 'Qué quiere decir cada columna',
        entries: [
          { term: 'Competencia', def: 'Lo que vendió TODO EL RESTO del canal bajo esa marca: el mercado medido menos lo nuestro. Cuando el panel mide menos mercado que venta nuestra, los dos números se contradicen y la resta no significa nada: ahí dice un guion, no cero.' },
          { term: 'Precio nuestro / Precio competencia', def: 'No es un precio de lista ni de etiqueta. Es el precio IMPLÍCITO: el dinero dividido entre las unidades. ISCAM no publica precios, así que éste se deduce. Sirve para comparar nuestra marca contra la misma marca en el resto del canal, y para nada más: dos marcas distintas no se pueden comparar entre sí porque la unidad en que se mide cada una no está verificada.' },
          { term: 'Dif.', def: 'Cuánto por ciento más caro o más barato vendemos nosotros esa marca, contra lo que cobró el resto del canal.' },
          { term: 'Share', def: 'Qué parte de esa marca o categoría vendimos nosotros. Con 16% de una categoría el precio lo ponemos; con 2% lo tomamos. Es la diferencia entre fijar precio y seguirlo.' },
          { term: 'Creció la competencia', def: 'Cuántos pesos MÁS vendió el resto del canal contra el mes anterior. Se ordena por esto y no por tamaño de mercado, porque el tamaño pondría arriba a los gigantes donde este mes no pasó nada.' },
        ],
      },
      {
        heading: 'Qué tan en firme está el precio',
        entries: [
          { term: 'Medida', def: 'Vendemos suficiente de esa marca como para que nuestro precio promedio sea estable. Es el caso en que la comparación se sostiene.' },
          { term: 'Poca venta nuestra', def: 'Vendemos tan poco de esa marca que nuestro precio promedio salta con cualquier movimiento. El número se publica igual, pero con esta marca al lado: la diferencia contra la competencia puede ser real o puede ser ruido. Medido: con menos del 10% de participación la dispersión se cuadruplica.' },
          { term: 'No calculable', def: 'Falta uno de los dos lados de la división. Se dice así en vez de mostrar un cero, porque un cero se leería como "vendemos al mismo precio".' },
        ],
      },
      {
        heading: 'Lo que esta pantalla NO puede decirte',
        entries: [
          { term: 'Quién vende a ese precio', def: 'ISCAM esconde los nombres de los mayoristas de su panel. Sabemos cuánto vende la competencia en total, nunca cuál de ellos. Los competidores con nombre y domicilio salen de otra fuente (el censo de INEGI), y esa fuente no dice cuánto vende nadie. No hay manera de cruzarlas, y no se inventó una.' },
          { term: 'El precio de anaquel', def: 'Nadie publica los precios del mayoreo de dulce. Se buscó: PROFECO no trae código de barras, mide en supermercados y de nuestras plazas sólo cubre Morelia; Mercado Libre bloquea el acceso.' },
          { term: 'Por qué el share cambia según el filtro', def: 'Porque hay dos universos y los dos son ciertos. En Mayoreo Puro, que es donde vendemos, la participación es más alta; en el mayoreo total es más baja, porque incluye subcanales donde no vendemos nada. Cuál de los dos se publica es una decisión que todavía no se tomó.' },
          { term: 'Qué tanto confiar en lo nuestro', def: 'A ISCAM se le mandan todas las salidas, traspasos entre sucursales incluidos. Comparado contra nuestros libros, sobre las mismas sucursales, nos sobra alrededor de un 10% que sigue sin explicarse.' },
        ],
      },
    ],
  },
  'motor-margen': {
    title: 'Motor de margen — qué significa cada cosa',
    intro: 'La pantalla mira cada producto en cada plaza y dice UNA cosa que se puede hacer con su precio, cuánto vale y qué tan en firme está. No cambia ningún precio: la captura sigue siendo en Kepler.',
    groups: [
      {
        heading: 'Las siete cosas que puede decir, en el orden en que las decide',
        entries: [
          { term: 'Corregir la escalera', def: 'La caja sale MÁS CARA por pieza que comprar sueltas. Es un error de catálogo: le estás cobrando más a quien compra más. ⚠️ Hoy la alarma se dispara también por diferencias de UN CENTAVO, que no se pueden corregir porque los precios se guardan al centavo: 248 de los 696 casos difieren un centavo o menos (la más chica, seis diezmilésimas de peso) y se llevan $76,610 de la cola, contra $2,138 de las 349 que sí están rotas de verdad, algunas por más de $340 por pieza.' },
          { term: 'Revisar el costo', def: 'El costo de hoy se apartó 5% o más del costo con el que se fijó el precio, y nadie tocó el precio en 90 días. No dice cuánto subir: dice que el número con el que se decidió ya no es el de ahora.' },
          { term: 'Liberar capital', def: 'El producto está en sobrestock o parado, y hay inventario que se puede mover bajando el precio. Es una regla de almacén, no una medición de precio: el motor no sabe cuánto hay que bajar.' },
          { term: 'Precio atípico', def: 'Para llegar al siguiente precio redondo habría que subirlo más del 20%. No es mercancía ordinaria: suelen ser recargas, servicios o productos de paso. Se aparta a propósito y no se propone nada, porque falta la marca de PRECIO PACTADO, que no existe en el sistema.' },
          { term: 'Aterrizar el precio', def: 'El precio está a un pelo de un número redondo y la subida es tan chica que el cliente no la distingue. Por ejemplo, de $6.95 a $6.99. Es la más segura de las siete: la cuenta se cierra sola.' },
          { term: 'Subir el precio', def: 'Hay espacio hasta el siguiente precio redondo y el producto vende. ⚠️ Es la única donde NO se sabe qué pasa con el volumen: el motor calcula cuánto ganarías si nadie deja de comprar, pero no si alguien deja de comprar.' },
          { term: 'Sin acción defendible', def: 'Ninguna de las seis anteriores aplica. Es el resultado de la mayoría de los renglones, y está bien que lo sea: el motor prefiere callarse a inventar una recomendación.' },
        ],
      },
      {
        heading: 'Qué tan en firme está lo que dice',
        entries: [
          { term: 'Aritmética', def: 'La cuenta se cierra sola y no depende de adivinar nada. Si el motor dice esto, el número es el número.' },
          { term: 'Efecto no medido', def: 'La cuenta está bien, pero supone que el cliente compra lo mismo después del cambio. Nadie lo ha comprobado: el experimento que lo mediría existe y no se ha corrido.' },
          { term: 'Regla de operación', def: 'No sale de medir precios sino de una política de inventario. Vale, pero el motor no puede calcular cuánto conviene mover.' },
          { term: 'Fuera de alcance', def: 'El motor detecta algo raro y se declara incompetente a propósito, porque le falta un dato que nadie captura.' },
          { term: 'Sin evidencia', def: 'No hay con qué sostener una recomendación. No significa que el precio esté bien: significa que no se sabe.' },
        ],
      },
      {
        heading: 'Las palabras de las columnas',
        entries: [
          { term: 'En juego 30 días', def: 'La venta de ese producto en esa plaza en los últimos 30 días. ⚠️ Es lo que está EXPUESTO, no lo que vas a ganar: sirve para ordenar la lista por tamaño, no para prometer un resultado.' },
          { term: 'Margen vs meta', def: 'El margen que de verdad se cobró, contra el que la ficha del producto fija como objetivo. La diferencia va en puntos: +2 pp significa dos puntos de margen arriba de la meta.' },
          { term: 'Escalera', def: 'Los escalones de venta del mismo producto: pieza, paquete, caja. Cada escalón tiene su precio, y el de arriba debería salir más barato por pieza.' },
          { term: 'Umbral de percepción', def: 'Por debajo de ese porcentaje el cliente no nota el cambio de precio. Es lo que separa aterrizar de subir: la misma subida es segura o arriesgada según de qué lado caiga.' },
          { term: 'Capital inmovilizado', def: 'Dinero parado en mercancía. Va aparte de los otros montos y sin barra porque no es lo mismo: los demás son dinero que se mueve en 30 días, éste es un saldo. Para compararlos haría falta saber cuánto cuesta tener el dinero parado, y ese dato no existe todavía.' },
          { term: 'Con bloqueo', def: 'El renglón tiene una razón para no tocarse ahora: por ejemplo sin existencia, o el precio se movió hace menos de 21 días. Se muestra igual, apagada, porque esconderla haría parecer que el problema no existe.' },
          { term: 'En N plazas de esta lista', def: 'El mismo producto con la misma decisión y el mismo precio en varias plazas, juntas en un renglón. Dice de esta lista porque agrupa sólo lo que cabe en la página: las plazas que venden poco pueden quedar fuera del corte.' },
        ],
      },
    ],
    resolve: [
      {
        heading: 'Cómo se corrige cada cosa',
        kind: 'fix',
        intro: 'Todo se captura en Kepler. Esta pantalla no escribe nada.',
        steps: [
          'Escalera: ajustar el precio de la caja para que, dividido entre las piezas que trae, quede por debajo del precio de la pieza suelta.',
          'Costo: revisar el costo del producto en la ficha y, si cambió de verdad, volver a decidir el precio con el número nuevo.',
          'Aterrizar o subir: cambiar el precio en la ficha de esa plaza. El motor propone el número redondo más cercano hacia arriba.',
          'Liberar capital: es decisión de compras y almacén, no de precio a secas.',
        ],
      },
      {
        heading: 'Lo que esta pantalla NO puede responder',
        kind: 'info',
        steps: [
          'Qué precio tiene la competencia: no existe ninguna fuente. Se midió y se descartó — el catálogo público de PROFECO cubre el 0% de nuestros productos.',
          'Cuánto volumen se pierde al subir un precio: el experimento que lo mediría está construido y no se ha corrido.',
          'Cuánto cuesta tener el dinero parado: nadie ha fijado esa tasa, y por eso el capital no se puede ordenar contra los demás montos.',
        ],
      },
    ],
  },

  // IC.12 — la pantalla acumuló cuatro vistas y cada una trajo su propio vocabulario. Cuatro
  // roles la leen (almacén cuenta, compras concilia, prevención investiga, dirección mira el
  // total) y ninguno usa las mismas palabras para lo mismo.
  'inventario-diferencias': {
    title: 'Diferencias de inventario — guía',
    intro: 'Cuatro preguntas sobre el mismo hecho: qué descuadró (Diferencias), qué toca contar (Programa), qué descuadra SIEMPRE (Reincidencia) y a dónde se fue la mercancía (Conciliación). Todo sale del ERP: acá no se captura nada.',
    groups: [
      {
        heading: 'Lo básico, que no significa lo que parece',
        entries: [
          { term: 'Sobrante', def: 'Se contó MÁS de lo que el sistema decía. Suena bueno y casi nunca lo es: suele ser una entrada sin registrar, una unidad mal declarada o un error de captura.' },
          { term: 'Faltante', def: 'Se contó MENOS. Es lo que normalmente se llama merma, pero cuidado: el descuadre contra el ERP arrastra errores viejos. El faltante REAL del período está en Conciliación.' },
          { term: 'Carga inicial', def: 'Cuando una sucursal migra de Wincaja a Kepler, el ERP emite una captura y una entrada que cuadran línea por línea. NO es un conteo ni un descuadre: son $30.8M en el histórico y por eso están fuera por default.' },
          { term: 'Cobertura', def: 'Cuántos SKUs con existencia quedaron SIN contar en ese evento. Sin este número, el descuadre se lee como si fuera el del almacén entero, y el trimestral de Kepler deja fuera entre el 7% y el 31% según la sucursal.' },
          { term: 'Debía haber', def: 'DERIVADO, no un dato de Kepler: el ERP guarda lo contado y emite la diferencia, nunca el teórico. Se reconstruye restando. Sale con guion cuando el ajuste excede lo capturado, que pasa en el 7% de los casos.' },
        ],
      },
      {
        heading: 'Reincidencia — dos ejes, y hacen falta los dos',
        entries: [
          { term: 'Retiene', def: 'Cuánto del descuadre NO se compensó entre un conteo y otro. Un SKU puede mover millones y devolverlos: eso es unidad o captura, no mercancía perdida.' },
          { term: 'Se compensa', def: 'Entra y sale: el dinero vuelve. Huele a error de captura o a unidad mal declarada, no a faltante. Mandar a alguien al anaquel por uno de estos es perder el día.' },
          { term: 'Merma', def: 'Falta siempre y no vuelve. Es el caso que sí hay que ir a ver.' },
          { term: 'Sobra', def: 'Sobra siempre y no vuelve: entradas sin registrar, o una unidad declarada más chica de la real.' },
          { term: 'Un evento / sostenido', def: 'El segundo eje, y el que decide a quién se persigue. «Un evento» = un solo conteo explica casi todo el desvío, o sea un hecho puntual (una captura mal hecha). «Sostenido» = pasa en todos los conteos. Descuadrar seguido y perder seguido NO son lo mismo.' },
        ],
      },
      {
        heading: 'Conciliación — a dónde se fue la mercancía',
        entries: [
          { term: 'La cadena', def: 'Había (lo contado la vez anterior) + Entró (compras y traspasos recibidos) − Salió (ventas y traspasos enviados) = Debía quedar. Contra lo que se contó ahora.' },
          { term: 'Falta sin explicar', def: 'La diferencia que los movimientos NO justifican. Ésta sí es la merma del período: mercancía que estaba, se movió y no llegó. Es distinta del faltante contra el ERP.' },
          { term: 'Sin recontar', def: 'Estaba en el primer conteo y no en el segundo. Su diferencia es DESCONOCIDA, no cero. Si son la mayoría, el total de arriba no mide el almacén — el peor período tiene 2,265 de 2,403.' },
          { term: 'Debía quedar imposible', def: 'Salió más de lo que el conteo anterior decía que había, así que el resultado da negativo. Significa que falta una entrada sin capturar. No es simétrico: sólo puede inflar el sobrante, nunca la merma.' },
          { term: 'Sin comparación posible', def: 'Un almacén necesita DOS conteos del MISMO almacén para conciliarse. Padre Hidalgo tiene dos capturas pero una es de la tienda y otra de la Ruta 28: compararlas sería mezclar cosas distintas.' },
        ],
      },
      {
        heading: 'Programa — qué toca contar',
        entries: [
          { term: 'Los tres ritmos', def: 'Trimestral lo hace Kepler solo y nosotros lo LEEMOS. Semanal es la ola rotativa. Diario son los de clase A del ABC.' },
          { term: 'La ola', def: 'El catálogo se parte en olas y cada una se cuenta en su turno, de modo que en un ciclo completo se cubra todo sin contar todo el mismo día.' },
          { term: 'Score', def: 'Prioridad de 0 a 1 combinando cuatro señales: clase ABC, venta reciente, inventario parado y descuadre histórico. Los pesos se reparten sólo entre las señales DISPONIBLES, para que un almacén sin historia no salga siempre al final.' },
          { term: 'Señales n/4', def: 'Cuántas de las cuatro se pudieron medir para ese SKU. Con menos señales el score es menos confiable, y por eso se muestra.' },
        ],
      },
    ],
    resolve: [
      {
        heading: 'Encontré un faltante grande. ¿Qué hago?',
        kind: 'fix',
        steps: [
          'Mirá primero la Conciliación de ese almacén: si el movimiento lo explica, no hay nada que investigar.',
          'Si sigue sin explicarse, revisá en Reincidencia si ese SKU es «sostenido» o «un evento». Un evento aislado casi siempre es una captura, y se resuelve mirando ESE conteo.',
          'Si es sostenido y siempre falta, ahí sí corresponde abrir expediente en Prevención.',
        ],
      },
      {
        heading: '¿Por qué un número sale con guion?',
        kind: 'info',
        steps: [
          'Un guion NUNCA es cero: significa que ese dato no se pudo medir, y el motivo aparece al pasar el cursor.',
          'Los tres motivos habituales: el SKU no se volvió a contar, el ajuste del ERP excede lo capturado, o no hay suficientes conteos para calcular una tasa.',
          'Un cero sí es un cero medido. La diferencia importa: «no había» y «no se sabe» son afirmaciones distintas.',
        ],
      },
    ],
  },

  // RE.16 — la pantalla con más jerga del proyecto no tenía ninguna ayuda. Cuatro roles
  // distintos leen los mismos números y cada uno les daba un nombre propio.
  'compras-entradas': {
    title: 'Facturas de entrada — guía',
    intro: 'Cada orden de entrada de Kepler necesita su factura del proveedor en PDF. La sucursal la captura, un revisor la valida o la devuelve, y Control de entradas mira la red completa. No escribe nada en Kepler: es evidencia.',
    groups: [
      {
        heading: 'Los cuatro estados del papel (mismos nombres en todas las pantallas)',
        entries: [
          { term: 'Sin factura', def: 'Kepler registró la entrada y todavía no hay PDF. Es lo que le toca a la sucursal.' },
          { term: 'Por revisar', def: 'Ya se subió el PDF y espera decisión del revisor. El reloj ahora es de él, no de la sucursal.' },
          { term: 'Validada', def: 'El revisor la aceptó: el expediente cierra y sostiene el pago.' },
          { term: 'Devuelta', def: 'El revisor la rechazó con un motivo (ilegible, no corresponde, el total no cuadra, falta una hoja, duplicada). Vuelve a la sucursal, que la corrige y la sube de nuevo. Es el único camino de regreso.' },
        ],
      },
      {
        heading: 'Descartada — la salida para lo que nunca va a tener factura',
        entries: [
          { term: 'Para qué está', def: 'Devolver le pide a la sucursal que suba algo que sí existe. Pero un traspaso entre sucursales o una entrada en $0 no tienen proveedor externo que facture: sin esta salida se quedan Sin factura para siempre e inflan el atraso de esa sucursal.' },
          { term: 'Quién puede', def: 'Sólo quien valida. Si el que tiene que subir la factura pudiera declarar que no hace falta, la cobertura sería autoevaluación.' },
          { term: 'Los motivos', def: 'Traspaso entre sucursales (el proveedor es otra sucursal, código TI…) · Cancelada o capturada por error en el ERP · Ya está capturada en otra orden · Entrada sin costo ($0: muestra, bonificación, corrección) · Otro, que obliga a escribir por qué.' },
          { term: 'Qué le pasa al número', def: 'Sale del denominador del % comprobado, pero se sigue contando aparte en su propia columna. Si sólo restara, descartar sería el camino más corto al 100%.' },
          { term: 'Reactivar', def: 'Deshace el descarte y la entrada vuelve a pedir factura. Pasa: se descarta como traspaso y después aparece el papel. Las dos decisiones quedan en el historial.' },
          { term: 'No se descarta con factura subida', def: 'Si el PDF ya está, la respuesta es validarlo o devolverlo. Descartarlo borraría del tablero un expediente que sí existe.' },
        ],
      },
      {
        heading: 'El cuadre',
        entries: [
          { term: 'Cuadra', def: 'El total que el OCR leyó en la factura coincide con el de Kepler dentro de la tolerancia (configurable en Ajustes, hoy centavos).' },
          { term: 'Δ (descuadre)', def: 'La diferencia entre el papel del proveedor y lo que Kepler registró. No siempre es error: puede ser una nota de crédito o una devolución posterior.' },
          { term: 'Cuadra con oficinas', def: 'El importe no casa con la captura de la sucursal pero sí con la de oficinas de la misma recepción. Se acepta: es la misma compra vista por dos capturas.' },
          { term: 'Vencida', def: 'Pasó su plazo. Hay dos plazos distintos a propósito: el de la sucursal para subir y el del revisor para decidir (Ajustes).' },
        ],
      },
      {
        heading: 'Capturada dos veces (gemelas)',
        entries: [
          { term: 'Por qué pasa', def: 'La misma recepción se captura en el Kepler de la sucursal y otra vez en el de oficinas (servidor 9.95, sucursal 00). La de la sucursal es la buena: trae los productos y movió inventario.' },
          { term: 'Par', def: 'Las dos copias enlazadas. Mientras andan sueltas, esa compra se cuenta dos veces y a la sucursal se le puede pedir evidencia de algo ya cubierto.' },
          { term: 'Automático vs por dictaminar', def: 'El motor corre cada 5 minutos y enlaza solo lo que puede defender (mismo importe, día y proveedor, o un solo renglón de concepto). Lo dudoso queda esperando que una persona decida, y esa decisión el motor nunca la sobrescribe.' },
          { term: 'Es la misma / Son distintas', def: 'Confirmar deja de contar la copia de oficinas. Rechazar la devuelve a contar como compra propia de oficinas y el motor no la vuelve a proponer.' },
        ],
      },
      {
        heading: 'Cobertura por sucursal',
        entries: [
          { term: '% comprobado', def: 'Órdenes con factura sobre el total del periodo. Se mira por sucursal y no en global: CEDIS pesa el 74% del volumen y puede tapar a una sucursal que lleva tres semanas sin subir nada.' },
          { term: 'Quién sube', def: 'Las personas con permiso de subir en esa sucursal. Vacío no significa que nadie trabaja: significa que falta el permiso, y son dos conversaciones distintas.' },
          { term: 'Antigüedad p50 / p90', def: 'La mitad de lo pendiente lleva p50 días o más; el 10% peor, p90. El promedio esconde la cola larga, que es la que hay que perseguir.' },
          { term: 'Rezago', def: 'Órdenes anteriores al arranque del proceso. Nunca van a tener comprobante, así que se cuentan aparte: si entraran al %, el número dejaría de servir para exigirle a nadie.' },
        ],
      },
      {
        heading: 'El documento',
        entries: [
          { term: 'Sólo PDF', def: 'Un expediente que sostiene un pago no se sostiene con una foto torcida de una hoja de tres. El escáner de oficina ya produce PDF; desde el celular, la app de Archivos o Cámara escanea a PDF, endereza la hoja y junta varias en un archivo.' },
          { term: 'Varias hojas', def: 'Todas en el mismo PDF, o agregadas una por una al mismo expediente.' },
          { term: 'Lote', def: 'Soltar varios PDFs de una sola vez sobre la tabla de pendientes. Se enlazan por folio y sólo se confirma. No hay pantalla aparte: es la misma.' },
        ],
      },
    ],
  },
  'compras-descuentos': {
    title: 'Descuentos y apoyos — guía',
    intro: 'Hace visible lo que la recepción no mostraba: los ajustes de compra de Kepler (notas de crédito y devoluciones) clasificados por su motivo, más detectores de facturas duplicadas y de descuento no capturado. Es lectura (evidencia), no edita el ERP.',
    groups: [
      {
        heading: 'Qué es cada documento',
        entries: [
          { term: 'Nota de crédito (X-D-55)', def: 'Ajuste a favor sobre una compra: descuento comercial, apoyo de marca o pronto pago que el proveedor reconoce después de facturar.' },
          { term: 'Devolución de compra (X-D-40)', def: 'Mercancía que se regresa al proveedor (faltante, mal estado, no solicitada); baja el costo de la compra.' },
          { term: 'Motivo', def: 'Texto capturado en el documento (campo c24 de Kepler) del que se deduce la categoría y el grupo.' },
        ],
      },
      {
        heading: 'Grupos (clasificación del motivo)',
        entries: [
          { term: 'Descuentos y apoyos', def: 'Comercial: pronto pago, apoyo de marca, descuento comercial. Es dinero a favor, el foco de esta pantalla.' },
          { term: 'Faltantes / devoluciones', def: 'Operacional: faltante, mal estado, no solicitado, cambios. Corrige la compra, no es un beneficio.' },
          { term: 'Errores de captura', def: 'Factura duplicada o diferencia de monto: sospecha de captura equivocada; revisar.' },
          { term: 'Sin clasificar', def: 'El motivo no permitió deducir la categoría. Requiere revisión manual.' },
        ],
      },
      {
        heading: 'Las 4 vistas',
        entries: [
          { term: 'Ajustes', def: 'El listado de todas las notas/devoluciones con su grupo, categoría, proveedor y monto, más el resumen por grupo arriba.' },
          { term: 'Posibles duplicados', def: 'Detector: un mismo proveedor facturó el MISMO monto exacto ≥2 veces dentro de la ventana (30 días). Señal de captura doble del comprobante. "$ en riesgo" = lo que se pagaría de más si son duplicados reales.' },
          { term: 'Reconciliación', def: 'De dónde viene el descuento de cada proveedor: por canal de pago (al liquidar) vs por nota de crédito. "Usan ambos canales" marca posible doble conteo.' },
          { term: 'Descuento no capturado', def: 'Fuga: proveedores que SÍ dan descuento pero tienen pagos liquidados sin él. Oportunidad = tasa habitual × monto pagado completo.' },
        ],
      },
      {
        heading: 'Términos de reconciliación',
        entries: [
          { term: 'Canal pago (c84)', def: 'Descuento aplicado al momento de pagar (pronto pago), registrado en el documento de pago de Kepler (campo c84).' },
          { term: 'Canal nota (X-D-55)', def: 'Descuento que llegó como nota de crédito separada, después de la factura.' },
          { term: '% compras', def: 'El descuento total del proveedor como porcentaje de lo que le compraste en el periodo.' },
        ],
      },
    ],
  },
  // MR.5 — la pantalla publica DOS márgenes distintos en la misma tira de KPIs y
  // ninguno se explicaba solo. La confusión cara es leer "negociado" como si ya
  // trajera todo: le faltan las tres restas del margen integral.
  rentabilidad: {
    title: 'Rentabilidad — guía',
    intro: 'Mide el margen sobre la venta REAL —lo que cobró el punto de venta— y explica de dónde viene y dónde se pierde. Es lectura: no edita Kepler ni el catálogo.',
    groups: [
      {
        heading: 'Los márgenes (van en cascada, en este orden)',
        entries: [
          { term: 'Por unidad', def: 'El más simple: cuánto se le gana a UNA unidad vendida (precio menos costo, los dos en la unidad en que cobra el punto de venta). Sólo aparece en la vista por Producto: promediar el precio de un paquete con el de un kilo no significa nada. Cuando la equivalencia de caja es confiable, muestra también lo que deja la caja completa.' },
          { term: 'Comercial bruto', def: 'Venta menos costo, sobre la parte de la venta que trae costo. Es el mismo margen de arriba pero acumulado, y existe por producto, marca, categoría y proveedor. Dueño: Comercial + Compras.' },
          { term: 'Negociado', def: 'El bruto MÁS lo que el proveedor devuelve (notas de crédito y descuento al pagar). Dueño: Compras. Sólo existe a nivel total y por proveedor: repartir una nota de crédito a cada SKU todavía no está construido.' },
          { term: 'Integral', def: 'El negociado menos lo que le devolvemos al cliente. Se publica marcado como INCOMPLETO porque le faltan dos restas que hoy no tienen fuente: las promociones que absorbemos y el costo logístico. Se listan al pie de la cascada en vez de omitirlas en silencio — un integral que se calla un componente es peor que uno incompleto y honesto. Dueño: Dirección.' },
        ],
      },
      {
        heading: 'Las 5 palancas del proveedor (lo que suma el negociado)',
        entries: [
          { term: 'Descuento comercial', def: 'Lo que el proveedor reconoce por nota de crédito después de facturar. Es la palanca más grande. Dueño: Compras.' },
          { term: 'Apoyo de marca', def: 'Aportación promocional del proveedor. Dueño: Compras + Marketing.' },
          { term: 'Pronto pago', def: 'Descuento por pagar antes, cobrado como nota de crédito. Dueño: Compras + Finanzas.' },
          { term: 'Bonificación', def: 'Saldo a favor que el proveedor reconoce. Dueño: Compras.' },
          { term: 'Descuento al pagar', def: 'El que se toma en el momento de liquidar, no por nota (campo c84 de Kepler). Si un proveedor da pronto pago por los DOS canales, puede ser el mismo descuento contado dos veces: la ficha del proveedor lo avisa.' },
          { term: 'Negociado vs "a margen"', def: 'Son dos columnas distintas a propósito. El descuento se gana sobre lo que COMPRÁS y el margen se mide sobre lo que VENDÉS, así que a margen sólo entra la parte de esa compra que ya se vendió. Sumar el monto crudo daría un margen imposible.' },
        ],
      },
      {
        heading: 'La brecha, descompuesta (quién debe cada punto)',
        entries: [
          { term: 'Para qué', def: 'Decir "faltan 3.5 puntos" no le sirve a nadie si no se sabe de dónde salen ni quién los debe. La cascada llega hasta el objetivo y cada renglón tiene un dueño y una acción.' },
          { term: 'Es aditiva', def: 'Los renglones suman y restan puntos sobre la MISMA venta, y el último es el residuo: bruto + palancas − descuento al cliente + no cobrado + sin fuente = objetivo, exacto. Si no cerrara, serían cinco números sueltos y cada área discutiría el suyo.' },
          { term: 'No cobrado', def: 'Lo que faltó cobrarle al proveedor comparado con la tasa que ÉL suele dar. Es la palanca accionable de Compras y el renglón lista quién deja más dinero sobre la mesa.' },
          { term: 'Tasa habitual, no contrato', def: 'La referencia es la tasa observada de cada proveedor, no un acuerdo firmado. La brecha se lee "está dando menos de lo que suele dar", no "incumple lo pactado". La diferencia importa antes de sentarse a reclamar.' },
          { term: 'Techo', def: 'Hasta dónde llegaría el margen si se cobrara todo lo habitual. Lo que queda debajo del objetivo después de eso es lo que ninguna palanca medible explica.' },
          { term: 'Sin fuente todavía', def: 'El residuo, de Dirección. No es "lo que falta negociar": es lo que hoy no se puede atribuir a nada medible. Puede ser precio, mezcla de producto, o un componente que todavía no tiene dato.' },
          { term: 'Doble conteo', def: 'Cuando un proveedor da pronto pago por nota de crédito Y por descuento al pagar, parte puede ser el mismo dinero contado dos veces. La pantalla lo acota (el mínimo de ambos canales) y lo avisa: acota el número, no lo invalida.' },
        ],
      },
      {
        heading: 'Las 6 vistas (el mismo margen, cortado distinto)',
        entries: [
          { term: 'Producto', def: 'La vista de trabajo. Es la única con el margen por unidad y con el detalle de qué marca, proveedor y clase ABC tiene cada renglón.' },
          { term: 'Marca · Categoría · Proveedor', def: 'Resúmenes por lo que se vende. Proveedor abre la ficha con sus palancas negociadas; marca baja a sus productos.' },
          { term: 'Sucursal · Canal', def: 'Cortan por DÓNDE se vendió, no por qué. Contestan "¿qué sucursal gana y cuál no?" y "¿qué canal deja más?". Un clic baja a los productos de esa sucursal o canal.' },
          { term: 'Todas cuadran', def: 'Las seis miden el mismo universo: el total de cualquier vista da el mismo margen que el resumen de arriba. Si alguna no cuadrara, sería un error, no un matiz.' },
          { term: 'Inventario por canal', def: 'Dice "n/a" a propósito: la existencia vive en la sucursal, no en el canal. Un $0 se leería como "no hay stock" en vez de "esta pregunta no aplica acá".' },
        ],
      },
      {
        heading: 'Objetivo, brecha y bandas',
        entries: [
          { term: 'Objetivo', def: 'El margen contra el que se mide todo. Es editable arriba a la derecha, y los cortes de las bandas se mueven con él.' },
          { term: 'Brecha (pp)', def: 'Distancia al objetivo en puntos porcentuales. La del resumen ya descuenta las palancas: es lo que de verdad falta resolver.' },
          { term: 'Brecha $', def: 'Los pesos que faltaron para llegar al objetivo. Ordená por esta columna para atacar por tamaño del problema y no por porcentaje: un producto al 2% que vende poco pesa menos que uno al 13% que vende mucho.' },
          { term: 'Bandas', def: 'Cada contador es un filtro: hacé clic y la tabla se acota a esa banda. "Bajo costo" es margen negativo; los demás cortes salen del objetivo, no son fijos.' },
        ],
      },
      {
        heading: 'Capital y rotación',
        entries: [
          { term: 'Capital en inventario', def: 'Existencia por costo de catálogo, sobre TODO el stock. La columna de la tabla sólo cubre productos con venta en la ventana, por eso el indicador dice aparte cuánto es stock sin movimiento: así los dos números cuadran.' },
          { term: 'GMROI', def: 'Margen anualizado por cada peso invertido en inventario. Un producto al 10% que rota rápido puede rendir más que uno al 20% parado. Queda en blanco cuando el costo con que se valúa no es confiable.' },
          { term: 'Promo', def: 'Beneficio de la promoción vigente del producto, en CRUDO. La unidad no está confirmada —el campo sólo toma los valores 2, 3, 4 y 5—, así que no se publica como porcentaje ni se resta del margen.' },
        ],
      },
      {
        heading: 'De dónde salen los números',
        entries: [
          { term: 'Venta y costo', def: 'La venta es el sell-out real. El costo NO es homogéneo: en los canales Wincaja es el que registró la caja en la transacción, pero en los canales Kepler (la mitad de la venta) se despeja del markup del catálogo, así que ahí el margen no reacciona a los descuentos. No compares el margen de un canal Kepler contra uno Wincaja.' },
          { term: 'Por qué no el catálogo', def: 'El costo de catálogo viene por CAJA en buena parte del catálogo y las unidades vendidas vienen por PIEZA. Multiplicarlos mezclaba unidades: inflaba el costo de unos pocos productos y movía el margen de toda la empresa más de 3 puntos.' },
          { term: 'Cobertura', def: 'Qué parte de la venta trae costo con qué juzgarla. Lo que no lo trae queda fuera del margen y se dice; no se esconde en el promedio.' },
          { term: 'Por unidad vendida', def: 'La unidad en que factura el punto de venta: según el producto puede ser la pieza o el paquete. No se nombra más fino a propósito, porque la unidad del catálogo se contradice con la de Kepler en más de la mitad de los productos. Los que se venden a granel dicen "por kilo".' },
          { term: 'Datos al', def: 'Hasta qué día llega el sell-out. Las compras y los pagos se leen hasta hoy, así que al arranque del mes pueden ir un paso adelante.' },
        ],
      },
    ],
    resolve: [
      {
        heading: 'Un renglón trae un triángulo en Inventario y "n/d" en GMROI',
        kind: 'fix',
        intro: 'El costo de catálogo de ese producto contradice al que cobra el punto de venta: está capturado en otra unidad (caja contra pieza). El margen no lo usa —sale del sell-out— pero la valuación de su inventario sí, y por eso no se publica su GMROI.',
        steps: [
          'Abrí el producto en el catálogo y compará su costo contra el precio al que se vende.',
          'Si el costo es el de la caja, corregilo a la unidad en que se vende (o registrá el factor de caja).',
          'El aviso de arriba dice cuánto capital total está valuado así: sirve para priorizar cuáles corregir primero.',
        ],
      },
      {
        heading: 'Dice que no hay ajustes de compra cargados',
        kind: 'fix',
        intro: 'Las cuatro palancas por categoría aparecen en cero porque la fuente no tiene datos, no porque el mes no haya tenido descuentos. Son dos cosas distintas y la pantalla lo distingue a propósito.',
        steps: [
          'Verificá que el feed de ajustes de compra haya corrido.',
          'Mientras tanto, leé el margen negociado como incompleto: sólo trae el descuento tomado al pagar.',
          'El detalle documento por documento vive en Compras → Descuentos y apoyos.',
        ],
      },
      {
        heading: 'El margen negociado es casi igual al bruto',
        kind: 'info',
        intro: 'No siempre es un problema. Puede significar tres cosas distintas y conviene descartarlas en este orden.',
        steps: [
          'Que la fuente de ajustes esté vacía: la pantalla lo avisa arriba de la cascada.',
          'Que se compró poco en la ventana: el descuento se gana sobre las compras, así que con poca compra el efecto en margen es chico aunque la tasa sea buena.',
          'Que efectivamente no se esté cobrando lo pactado: abrí un proveedor y compará "Lo pactado" contra lo que se cobró.',
        ],
      },
    ],
  },
  'ventas-generales': {
    title: 'Ventas generales — guía',
    intro: 'Consultá la venta global de la red y desglosala como quieras (métrica × dimensión). Los números salen tal cual de la base — la interfaz solo los ordena y grafica; no calcula ni inventa. Venta REAL (POS/ERP), no pedidos B2B.',
    groups: [
      {
        heading: 'Qué estás viendo',
        entries: [
          { term: 'Venta real vs pedidos', def: 'Esta pantalla mide la venta REAL registrada (POS/ERP), no el pipeline de pedidos B2B. Por eso puede diferir de "Pedidos".' },
          { term: 'Ventas ($)', def: 'Monto vendido. Es la métrica por default: es la más confiable.' },
          { term: 'Unidades', def: 'Cantidad vendida. OJO: tiene ruido conocido desde oct-2025 (quiebre de captura) — úsala con criterio, el monto es la verdad.' },
          { term: 'Margen y cobertura de costo', def: 'Margen = ventas − costo. Solo aplica a lo que tiene costo capturado; el % de "cobertura de costo" te dice qué tan completo está — si es bajo, el margen es parcial.' },
          { term: 'Ticket promedio', def: 'Ventas ÷ tickets (número de operaciones).' },
        ],
      },
      {
        heading: 'Cómo preguntar',
        entries: [
          { term: 'Métrica × dimensión', def: 'Elegí qué medir (ventas/margen/unidades/tickets) y por qué cortarlo (canal, marca, categoría, sucursal, producto, cliente o tiempo).' },
          { term: 'Participación (Part.)', def: 'Cuánto pesa cada fila sobre el total del corte (share %).' },
          { term: 'Ver en Sell-Out / Salidas', def: 'El botón lleva al reporte especializado con más detalle y export, filtrado por lo que estás viendo.' },
        ],
      },
    ],
  },
  'compras-360': {
    title: 'Costo por compra — guía',
    intro: 'El "Excel" de recepción, vivo: una fila por compra —la orden de entrada de Kepler— con su OC, la factura, el ajuste ligado y el neto que realmente se pagó. Es lectura sobre el ERP, no lo edita. Es la MISMA pantalla que el Listado de Control de entradas, con el otro lente: acá la pregunta es "¿cuánto pagamos?" y allá "¿tengo el papel?". El selector de arriba cambia entre las dos sin perder los filtros.',
    groups: [
      {
        heading: 'Qué es cada columna',
        entries: [
          { term: 'Orden de entrada (XA2001)', def: 'El documento de Kepler "Aplica Orden Entrada": la recepción de mercancía que se firma y se factura. Cada fila es una de estas.' },
          { term: 'OC', def: 'Folio de la Orden de Compra que originó la entrada. Puede venir vacío si la entrada no se ligó a una OC en Kepler.' },
          { term: 'Vale', def: 'Vale de entrada (X-A-37) intermedio de la cadena de recepción. Referencia de trazabilidad.' },
          { term: 'Factura', def: 'Monto facturado por el proveedor para esa entrada (con IVA), tal como quedó en Kepler.' },
          { term: 'Ajuste', def: 'Suma de devoluciones (X-D-40) y notas de crédito (X-D-55) ligadas a la entrada. Se muestra en negativo porque baja el costo.' },
          { term: 'Neto', def: 'Lo que realmente costó la entrada = Factura − Ajuste. Es el número a usar para el costo real de compra.' },
        ],
      },
      {
        heading: 'Cómo se liga el ajuste',
        entries: [
          { term: 'Match exacto', def: 'La devolución/nota apunta al mismo folio de entrada en Kepler. Es una liga confiable.' },
          { term: 'Match proveedor+fecha (heurístico)', def: 'Kepler no ligó la nota a la entrada; se asocia por mismo proveedor dentro de una ventana de fechas (±15 días). Es una estimación — revisar antes de darla por cierta.' },
          { term: 'Solo con ajuste', def: 'Filtro que deja solo las recepciones que tienen alguna devolución o nota ligada (las filas marcadas con la línea ámbar).' },
        ],
      },
    ],
  },
  'compras-costo-neto': {
    title: 'Costo por proveedor — guía',
    intro: 'Tu costo neto con cada proveedor: lo comprado menos los descuentos que de verdad conseguiste. Sirve para decidir el reabasto con el costo verdadero, no con el de lista. Es lectura sobre datos de Kepler, no edita nada. Compra por compra está en Costo por compra.',
    groups: [
      {
        heading: 'Los números',
        entries: [
          { term: 'Compras (bruto)', def: 'Total facturado por el proveedor en el periodo, antes de cualquier descuento o devolución.' },
          { term: 'Descuento efectivo', def: 'Lo que realmente te descontaron = pronto pago al pagar (campo c84 de Kepler) + notas de crédito comerciales. NO incluye devoluciones de mercancía.' },
          { term: '% (tasa efectiva)', def: 'Descuento efectivo ÷ compras. Es cuánto más barato te sale ese proveedor vs su lista.' },
          { term: 'Costo neto', def: 'Compras − descuento efectivo. El costo real de comprarle a ese proveedor.' },
        ],
      },
      {
        heading: 'Cómo leerlo',
        entries: [
          { term: 'Tasa anómala (⚠ >20%)', def: 'Un % muy alto casi nunca es "puro descuento": suele arrastrar devoluciones o errores de captura. La fila se marca con línea ámbar y ⚠ — revísala (clic → Descuentos del proveedor) antes de usar ese % como costo.' },
          { term: 'Para reabasto', def: 'Costo real de un producto ≈ costo de lista × (1 − %). Úsalo para comparar proveedores y decidir a quién comprar.' },
          { term: 'Solo con compras ≥ $100k', def: 'Filtra al ruido: deja solo proveedores con volumen relevante. Quítalo para ver todos.' },
        ],
      },
    ],
  },
  'almacen-movimientos': {
    title: 'Diario de movimientos — guía',
    intro: 'Entradas y salidas de inventario por día (mejora del reporte de Kepler). Abrí un día para ver sus documentos, y un documento para validar contra su contraparte antes de auditarlo. La pestaña "Cuadre de traspasos" concilia que cada salida entre sucursales tenga su recepción. Es lectura + auditoría; no mueve inventario.',
    groups: [
      {
        heading: 'Diario',
        entries: [
          { term: 'Documento y contraparte', def: 'Un traspaso genera una salida en el origen (TrsfShip) y una recepción en el destino (TrsfRcv). Al abrir uno se muestra el otro al lado para verificar que lo enviado = lo recibido.' },
          { term: 'Destino (sucursal/ruta/cliente)', def: 'A dónde va el traspaso. Por defecto se muestran los tres; podés acotar a solo sucursales para conciliar traspasos entre tiendas.' },
          { term: 'Estado', def: 'En tránsito (salió, aún no se recibe), Completado (recibido y cuadra) o Con diferencia (enviado ≠ recibido).' },
          { term: 'Auditar', def: 'Marca el documento como revisado (queda quién y cuándo). Requiere permiso de gestión de movimientos.' },
        ],
      },
      {
        heading: 'Cuadre de traspasos',
        entries: [
          { term: 'Mayor 515', def: 'Cuenta puente de Kepler "Ajuste traspasos internos". Cada salida (515-002) debe tener su entrada (515-001) → el mayor debe netear $0. Δ ≠ 0 = traspasos sin cuadrar o en tránsito al corte.' },
          { term: '515-001 / 515-002', def: 'Subcuentas: 001 = entrada (recepción), 002 = salida (despacho). Se comparan por importe.' },
          { term: 'Sin rastro', def: 'Una póliza de salida (o entrada) sin su contraparte que cuadre por importe (±tolerancia) ni en la ventana de fechas. Es lo que hay que localizar en Kepler.' },
          { term: 'Pareo tolerante', def: 'Como Kepler no liga origen↔destino 1:1, se emparejan por importe con una tolerancia de % + una ventana de ±1 mes.' },
          { term: 'Cuadre Kepler → Wincaja', def: 'Las tiendas 30/32/50 no están en Kepler; su recepción vive en Wincaja. Se cuadra por totales en $ (la unidad de Wincaja ≠ piezas de Kepler), no línea a línea.' },
        ],
      },
    ],
  },
  // La pantalla que más se va a comparar contra otra. Lo primero que va a preguntar todo el
  // mundo es "¿por qué no coincide con Pedido?", así que eso va PRIMERO, no al final.
  existencia: {
    title: 'Existencia — guía',
    intro: 'Una fila por producto y una columna por almacén: cuánto hay, dónde, en qué unidad y cuánto vale. Sale del ERP (del ODS), que es la fuente que acierta. Es una pantalla de CONSULTA: la decisión de comprar vive en Compras › Pedido, y el ajuste de saldo en Almacén › Ajustes de stock.',
    groups: [
      {
        heading: 'Por qué no coincide con otras pantallas',
        entries: [
          { term: 'vs. Pedido (Compras)', def: 'Las dos tienen razón. Existencia lee el ERP directo cada vez que abrís la pantalla; Pedido lee una foto que se recalcula cada 15-30 minutos, porque además necesita venta, tránsito y estacionalidad. Si acabás de mover mercancía, Existencia lo ve antes.' },
          { term: 'vs. Ajustes de stock (Almacén)', def: 'Esa pantalla muestra el libro interno de la app —el que lleva los apartados y el que escriben los ajustes— y su cantidad discrepa del punto de venta alrededor del 9%. Para saber qué hay físicamente, esta pantalla. Medido: contra el POS, el ERP acierta 100% y el libro interno 91%.' },
          { term: '¿Y el apartado?', def: 'No se muestra, y no es un olvido: el apartado sólo existe en el libro interno y hoy tiene 1 producto con 15 unidades en toda la red. Mezclarlo daría una cifra que no es ni el físico ni lo disponible.' },
        ],
      },
      {
        heading: 'La edad del dato',
        entries: [
          { term: 'Frescura por rama', def: 'Los almacenes no se actualizan al mismo ritmo, así que hay una edad por grupo y un aviso en cada columna. Sucursales 01-06 vienen de Kepler; el CEDIS 00 y los de Morelia (MD-30 / MD-32) vienen de Wincaja.' },
          { term: '¿Por qué no dice "en vivo"?', def: 'Porque no siempre lo está. La pantalla consulta el ERP al momento, pero el ERP se alimenta de feeds que a veces se atrasan horas. En vez de prometer frescura, se publica la edad real y vos decidís si sirve.' },
        ],
      },
      {
        heading: 'Cuando una celda no dice cajas',
        entries: [
          { term: 'Por ejemplo "2,679 kg ⚠"', def: 'Ahí no se pudo convertir a cajas con confianza: el costo que se pagó por esa unidad contradice el divisor que usaríamos. La cantidad suelta SÍ es verdad —hay 2,679 kg— así que se muestra tal cual, con el rótulo que usa el ERP.' },
          { term: 'Por qué el dinero sale en raya', def: 'Porque valuar exige multiplicar cantidad por costo, y si no se sabe en qué unidad está la cantidad el resultado sería inventado. Raya significa "no se está midiendo", nunca "vale cero".' },
          { term: 'La cifra "de referencia"', def: 'Es lo que ese inventario valdría según el costo que efectivamente se pagó. Sirve para dimensionar el hueco y priorizar la revisión; no es una cifra publicable ni entra en los totales.' },
        ],
      },
      {
        heading: 'Las columnas',
        entries: [
          { term: 'Existencia (cajas)', def: 'La cantidad del almacén dividida entre las unidades que ese almacén mete en una caja. El divisor es por almacén y producto, no por producto: Kepler y Wincaja no guardan la existencia en la misma unidad.' },
          { term: 'Estado', def: 'Compara la existencia contra la política de reorden de ESE almacén: agotado, bajo mínimo, bajo reorden, sano o sobrestock. Vacío = ese producto no tiene política ahí, así que no hay contra qué compararlo.' },
          { term: 'Valor', def: 'Existencia × costo unitario, sumando sólo los almacenes cuya unidad está verificada. El encabezado dice cuántos quedaron fuera.' },
          { term: 'Total (cajas)', def: 'Σ de las columnas medibles. No se suman las unidades crudas: sumar kilos con paquetes y con piezas da un número que no está en ninguna unidad.' },
        ],
      },
    ],
  },
  'pedido-compras': {
    title: 'Pedido / Reabastecimiento — guía',
    intro: 'Una fila por producto con lo que conviene pedir. El pedido sugerido = venta × cobertura − existencia − tránsito (en cajas). Clic en una fila abre el desglose por sucursal: qué comprar, qué traspasar desde su CEDIS y su sobrestock, con cantidad editable.',
    groups: [
      {
        heading: 'Cómo se calcula el pedido',
        entries: [
          { term: 'Pedido (cajas)', def: 'Lo que falta para cubrir la venta durante la cobertura: máx(0, venta diaria × días de cobertura − existencia − en tránsito). Si da 0 o menos, no hace falta pedir.' },
          { term: 'Cobertura (días)', def: 'Cuántos días de venta querés tener en piso. Es el control de arriba; súbelo/bájalo y todo el pedido se recalcula.' },
          { term: 'En tránsito', def: 'Cajas ya pedidas al proveedor que aún no llegan (OC sin entrada). Se restan del pedido para no pedir de más.' },
          { term: '$ Pedido', def: 'Valor del pedido sugerido: cajas a pedir × costo por caja.' },
        ],
      },
      {
        heading: 'Columnas de la tabla',
        entries: [
          { term: 'Vta', def: 'Venta de los últimos 30 días, en cajas. Por sucursal (desglosado) o de toda la red (englobado).' },
          { term: 'Exist.', def: 'Existencia actual disponible, en cajas.' },
          { term: 'Unidad x caja', def: 'Piezas por caja (y, si es multipack, paquetes × piezas). Es el factor con que se convierte piezas ↔ cajas.' },
          { term: 'Costo/Cja', def: 'Costo real por caja (costo por pieza × piezas por caja).' },
          { term: 'Σ Ped. cajas / Σ Piezas', def: 'Total a pedir del producto sumando todas sus columnas, en cajas y en piezas.' },
          { term: 'Valor venta', def: 'Venta de 30 días en dinero ($) — el peso comercial del producto.' },
          { term: 'Valor exist.', def: 'Dinero inmovilizado en existencia: existencia × costo.' },
        ],
      },
      {
        heading: 'Reorden y clasificación',
        entries: [
          { term: 'Reorden', def: 'Punto de reorden de la red (cajas): nivel al que conviene volver a pedir. Suma de los puntos de reorden de las sucursales.' },
          { term: 'Máx', def: 'Máximo de la red (cajas): techo objetivo de inventario.' },
          { term: 'ABC', def: 'Importancia por venta ($): A = los pocos que hacen la mayor parte de la venta, C = la cola larga (Pareto).' },
          { term: 'XYZ', def: 'Estabilidad de la demanda: X estable · Y variable · Z errático. Al englobar se muestra el peor caso entre sucursales. "—" = aún sin clasificar.' },
          { term: 'Tend.', def: 'Índice de Aceleración de Demanda (−2..+2): compara el ritmo reciente vs el previo + estacional año-vs-año. ▲ acelera · ═ estable · ▼ desacelera. Es informativo; no cambia el sugerido.' },
        ],
      },
      {
        heading: 'Acciones por sucursal (al desplegar una fila)',
        entries: [
          { term: 'Comprar', def: 'Compra real al proveedor: lo que falta y NO alcanza a cubrirse con traspaso desde el CEDIS.' },
          { term: 'Traspaso', def: 'Mover producto desde el CEDIS/otra sucursal con sobrante hacia la que tiene déficit, en vez de comprar. Primero traspaso, luego compra.' },
          { term: 'Sobrestock', def: 'Existencia por encima del máximo (capital inmovilizado). Candidata a traspasar a otra sucursal o a dejar de pedir.' },
          { term: 'Señal', def: 'La métrica que dispara la acción: cobertura en días (compra) · déficit en cajas (traspaso) · días en mano (sobrestock).' },
          { term: 'Cant. (✎)', def: 'Cantidad a pedir, editable. Arranca en el sugerido; podés ajustarla antes de armar la requisición o exportar.' },
          { term: 'Pedir en: caja / paquete / pieza', def: 'Unidad de captura de la cantidad. No cambia el producto, solo cómo cuentas lo que pides (1 caja = N piezas).' },
        ],
      },
      {
        heading: 'Vista y filtros',
        entries: [
          { term: 'Desglosar por sucursal', def: 'Una columna Vta/Exist/Pedido por cada sucursal — para ver dónde está la venta y el faltante.' },
          { term: 'Englobar columnas', def: 'Una sola columna con la red completa — para decidir la compra total sin el detalle por sucursal.' },
          { term: 'Solo con pedido', def: 'Oculta lo que no necesita pedido (sugerido = 0); deja solo lo accionable.' },
          { term: 'Stock muerto', def: 'Vista aparte: productos con existencia y sin rotación — capital inmovilizado a liquidar.' },
        ],
      },
      {
        heading: 'Exportar / armar',
        entries: [
          { term: 'XLSX', def: 'Descarga la vista actual (con sus filtros y desglosar/englobar) en un archivo: hoja "Todos" (plano) + una hoja por proveedor.' },
          { term: 'Requisición', def: 'Convierte las cantidades en una solicitud formal (folio RQ-AAAA-NNNNN) para aprobar → ordenar → recibir. Compra y traspaso se separan automáticamente.' },
        ],
      },
    ],
  },
  'route-activity': {
    title: 'Actividad de flota — guía',
    intro: 'Reconstruye el día de cada unidad a partir del rastro GPS: viajes, paradas y tiempos. Las paradas se matchean a la tienda/cliente más cercano por coordenadas. Si el proceso nocturno aún no corrió, "Reconstruir día" recalcula todo desde las posiciones crudas.',
    groups: [
      {
        heading: 'Tiempos del día',
        entries: [
          { term: 'En movimiento', def: 'Minutos con el vehículo desplazándose (ignición + velocidad).' },
          { term: 'Detenido', def: 'Minutos parado con señal (incluye paradas productivas y esperas).' },
          { term: 'Tiempo muerto', def: 'Detenido improductivo: paradas largas (≥20 min) que no cayeron en un cliente/tienda. Es el desperdicio a vigilar.' },
          { term: 'Sin señal', def: 'Minutos sin posición GPS (equipo apagado, sin cobertura o desconectado).' },
        ],
      },
      {
        heading: 'Paradas',
        entries: [
          { term: 'Paradas en tienda', def: 'Paradas que matchearon a una tienda de trade por cercanía.' },
          { term: 'Paradas con cliente', def: 'Paradas que matchearon a un cliente (flota de logística).' },
          { term: 'Paradas muertas', def: 'Paradas largas sin cliente/tienda cerca — tiempo muerto en forma de conteo.' },
          { term: 'Auditadas', def: 'Paradas en tienda donde además se levantó captura de auditoría (foto/checklist), no solo el paso del camión. Se muestra auditadas / paradas en tienda.' },
          { term: 'Sin captura', def: 'Paró en la tienda pero no se registró captura de auditoría.' },
        ],
      },
      {
        heading: 'Productividad',
        entries: [
          { term: 'Km/entrega', def: 'Kilómetros recorridos ÷ paradas con cliente. Más bajo = ruta más eficiente (menos km por entrega).' },
          { term: 'Reconstruir día', def: 'Recalcula paradas y resumen desde el rastro GPS crudo. Útil si el proceso nocturno aún no corrió o si acaban de llegar posiciones.' },
        ],
      },
    ],
  },
  'route-compliance': {
    title: 'Cumplimiento de ruta — guía',
    intro: 'Cruza el PLAN de la ruta (las tiendas que la unidad debía servir ese día) contra lo REAL (dónde paró el camión según GPS, matcheado a cada cliente). Solo se puede evaluar una unidad si el día tiene posiciones GPS y su ruta tiene tiendas con coordenadas.',
    groups: [
      {
        heading: 'Estado de la unidad',
        entries: [
          { term: 'Evaluable', def: 'La unidad se detuvo en tiendas geolocalizadas de una ruta ese día, así que su plan se puede comparar contra el recorrido real.' },
          { term: 'Sin plan evaluable', def: 'No hay con qué comparar: la unidad no paró en tiendas geolocalizadas de una ruta (sin GPS ese día, sin ruta asignada, o sus tiendas no tienen coordenadas).' },
        ],
      },
      {
        heading: 'Métricas',
        entries: [
          { term: 'Cobertura', def: 'Tiendas visitadas ÷ tiendas del plan con coordenadas, en %. Verde ≥85%, ámbar 60–84%, rojo <60%.' },
          { term: 'Visitadas', def: 'Tiendas del plan (con coordenadas) donde el camión efectivamente paró. Se muestra visitadas / plan.' },
          { term: 'Auditadas', def: 'De las visitadas, en cuántas además hubo una captura de auditoría de ejecución (foto/checklist), no solo el paso del camión.' },
          { term: 'Saltadas', def: 'Tiendas del plan con coordenadas donde el camión NO paró.' },
          { term: 'Fuera de ruta', def: 'Paradas del camión en tiendas que no pertenecen a la ruta planeada de ese día.' },
        ],
      },
      {
        heading: 'Tiendas del plan (detalle)',
        entries: [
          { term: 'Capturada', def: 'Visitada y con captura de auditoría registrada.' },
          { term: 'Sin captura', def: 'El camión paró en la tienda pero no se levantó captura de auditoría.' },
          { term: 'Sin coords', def: 'La tienda no tiene coordenadas, así que no se puede confirmar la parada por GPS — queda fuera del cálculo de cobertura.' },
          { term: 'Saltada', def: 'Tienda del plan con coordenadas que el camión no visitó.' },
        ],
      },
    ],
  },
  cfdi: {
    title: 'CFDI — ¿qué significan las claves?',
    intro: 'Comprobantes fiscales digitales (CFDI 4.0) del SAT. Aquí el significado de cada clave que ves en los filtros y la tabla.',
    groups: [
      {
        heading: 'Rol',
        entries: [
          { term: 'Recibidas', def: 'CFDI que tus proveedores te emitieron a ti (gastos y compras).' },
          { term: 'Emitidas', def: 'CFDI que tú emitiste a tus clientes (ventas).' },
        ],
      },
      {
        heading: 'Tipo de comprobante',
        entries: [
          { term: 'I — Ingreso', def: 'Factura de venta: dinero que entra (lo que cobras a un cliente).' },
          { term: 'E — Egreso', def: 'Nota de crédito: devoluciones, descuentos o bonificaciones sobre una factura previa.' },
          { term: 'P — Pago (REP)', def: 'Complemento de recepción de pagos: acredita el pago de una factura a crédito (PPD). No lleva importe propio.' },
          { term: 'N — Nómina', def: 'Recibo de nómina emitido a los empleados.' },
          { term: 'T — Traslado', def: 'Movimiento de mercancía sin venta (p. ej. entre sucursales o al transportista).' },
        ],
      },
      {
        heading: 'Método de pago',
        entries: [
          { term: 'PUE', def: 'Pago en Una sola Exhibición: se paga de contado al emitir. No genera complemento de pago.' },
          { term: 'PPD', def: 'Pago en Parcialidades o Diferido: es a crédito; cada pago posterior se documenta con un CFDI tipo P (REP).' },
        ],
      },
      {
        heading: 'Estatus ante el SAT',
        entries: [
          { term: 'Vigente', def: 'El CFDI está activo y es válido ante el SAT.' },
          { term: 'Cancelado', def: 'El emisor lo canceló; no tiene efectos fiscales.' },
          { term: 'Sin verificar', def: 'Aún no se ha consultado su estatus real ante el SAT.' },
        ],
      },
    ],
  },

  facturar: {
    title: 'Facturación — guía',
    intro: 'Emisión y timbrado de CFDI 4.0 vía PAC (SW/Conectia). Aquí el significado de cada opción.',
    groups: [
      {
        heading: 'Tipo de factura',
        entries: [
          { term: 'Global (mostrador)', def: 'Un solo CFDI a PÚBLICO EN GENERAL (XAXX010101000) que agrupa las ventas de mostrador del periodo. Lleva nodo de Información Global.' },
          { term: 'Nominativa', def: 'Factura a un cliente específico con sus datos fiscales (RFC, razón social, régimen, CP, uso de CFDI).' },
        ],
      },
      {
        heading: 'Método de pago',
        entries: [
          { term: 'PUE', def: 'Pago en Una Exhibición: se paga de contado al emitir.' },
          { term: 'PPD', def: 'Pago en Parcialidades o Diferido: a crédito; cada pago se documenta después con un REP.' },
        ],
      },
      {
        heading: 'Forma de pago (SAT)',
        entries: [
          { term: '01', def: 'Efectivo.' },
          { term: '03', def: 'Transferencia electrónica de fondos.' },
          { term: '04', def: 'Tarjeta de crédito.' },
          { term: '28', def: 'Tarjeta de débito.' },
          { term: '99', def: 'Por definir (habitual en PPD).' },
        ],
      },
      {
        heading: 'Motivo de cancelación (SAT)',
        entries: [
          { term: '01', def: 'Comprobante con errores CON relación: requiere el UUID del CFDI que lo sustituye.' },
          { term: '02', def: 'Comprobante con errores SIN relación (el más común).' },
          { term: '03', def: 'No se llevó a cabo la operación.' },
          { term: '04', def: 'Operación nominativa incluida en una factura global.' },
        ],
      },
      {
        heading: 'Notas',
        entries: [
          { term: 'NC (Egreso)', def: 'Nota de crédito: CFDI de Egreso relacionado (01) a una factura, para devoluciones/descuentos/bonificaciones.' },
          { term: 'REP', def: 'Complemento de recepción de pagos: acredita el pago de una factura a crédito (PPD).' },
        ],
      },
    ],
  },

  conciliacion: {
    title: 'Conciliación fiscal — guía',
    intro: 'Cruce determinista de lo descargado del SAT contra tus pagos y tu contabilidad. Solo cubre periodos ya descargados.',
    groups: [
      {
        heading: 'Vistas',
        entries: [
          { term: 'PUE/PPD ↔ REP', def: 'Verifica que las facturas a crédito (PPD) tengan su complemento de pago (REP) y sin saldo pendiente.' },
          { term: 'CFDI ↔ póliza', def: 'Cruza los CFDI descargados contra los gastos registrados en la contabilidad (heurístico).' },
        ],
      },
      {
        heading: 'Complementos de pago (REP)',
        entries: [
          { term: 'PUE', def: 'Pago en Una Exhibición: se pagó de contado; no requiere REP.' },
          { term: 'PPD', def: 'Pago en Parcialidades o Diferido: a crédito; cada pago debe documentarse con un REP.' },
          { term: 'PPD sin REP', def: 'Factura a crédito que aún no tiene su complemento de pago — hay que emitirlo/exigirlo.' },
          { term: 'Saldo insoluto', def: 'Parte de una factura PPD que todavía no se ha pagado (total − pagado).' },
        ],
      },
      {
        heading: 'Cruce CFDI ↔ póliza',
        entries: [
          { term: 'Gastos sin CFDI', def: 'Egreso registrado en la póliza sin un CFDI que lo respalde: riesgo de no poder deducir.' },
          { term: 'CFDI sin póliza', def: 'Comprobante recibido del SAT que aún no está registrado en la contabilidad.' },
        ],
      },
    ],
  },

  diagnostico: {
    title: 'Diagnóstico de facturación — guía',
    intro: 'Errores de timbrado/cancelación/REP traducidos con la base de conocimiento SAT/PAC, con su causa y solución.',
    groups: [
      {
        heading: 'Tipo de error',
        entries: [
          { term: 'Timbrado', def: 'Falló el sellado/timbrado de una factura ante el PAC/SAT.' },
          { term: 'Nota de crédito', def: 'Falló la emisión de un CFDI de Egreso (devolución/descuento).' },
          { term: 'Complemento de pago (REP)', def: 'Falló la emisión del complemento que acredita el pago de una PPD.' },
          { term: 'Cancelación', def: 'Falló la solicitud de cancelación de un CFDI ante el SAT.' },
        ],
      },
      {
        heading: 'Severidad',
        entries: [
          { term: 'Crítico', def: 'Bloquea la operación fiscal; requiere atención inmediata.' },
          { term: 'Aviso', def: 'Debe resolverse pero no bloquea del todo.' },
          { term: 'Info', def: 'Informativo; útil para contexto.' },
        ],
      },
      {
        heading: 'Cómo funciona',
        entries: [
          { term: 'Auto-registro', def: 'Cada error se registra solo cuando falla un timbrado/cancelación/REP.' },
          { term: 'Auto-resolución', def: 'Se marca resuelto cuando un intento posterior tiene éxito.' },
          { term: 'Reintentar', def: 'Vuelve a intentar el timbrado de los pedidos pendientes; es idempotente (no duplica).' },
        ],
      },
    ],
  },

  diot: {
    title: 'DIOT / IVA — guía',
    intro: 'Declaración Informativa de Operaciones con Terceros + resumen de IVA, calculado con flujo efectivo sobre los CFDI.',
    groups: [
      {
        heading: 'Tipo de tercero',
        entries: [
          { term: '04 Nacional', def: 'Proveedor con RFC mexicano.' },
          { term: '05 Extranjero', def: 'Proveedor del extranjero (sin RFC mexicano).' },
          { term: '15 Global', def: 'Operaciones agrupadas con público en general.' },
        ],
      },
      {
        heading: 'IVA',
        entries: [
          { term: 'IVA trasladado', def: 'El IVA que cobras en tus ventas (emitidas).' },
          { term: 'IVA acreditable', def: 'El IVA que pagas en tus compras y puedes descontar (recibidas).' },
          { term: 'IVA a cargo', def: 'Trasladado − acreditable, cuando es positivo: es lo que pagas al SAT.' },
          { term: 'IVA a favor', def: 'Cuando el acreditable supera al trasladado: queda saldo a favor.' },
        ],
      },
      {
        heading: 'Flujo efectivo',
        entries: [
          { term: 'PUE', def: 'Pago en Una Exhibición: el IVA cuenta en el mes de emisión.' },
          { term: 'PPD', def: 'Parcialidades/Diferido: el IVA cuenta cuando se paga (al recibirse el REP), no al emitir.' },
        ],
      },
    ],
  },

  impuestos: {
    title: 'Impuestos provisionales — guía',
    intro: 'Cálculo de APOYO del pago provisional mensual (ISR + IVA). Siempre valida con tu contador antes de declarar.',
    groups: [
      {
        heading: 'ISR provisional',
        entries: [
          { term: 'Coeficiente de utilidad', def: 'Factor de tu declaración anual del año pasado; estima la utilidad a partir de los ingresos (ingresos × coeficiente).' },
          { term: 'Ingresos nominales acum.', def: 'Ingresos del ejercicio acumulados hasta el mes, sin ajuste inflacionario.' },
          { term: 'Base gravable', def: 'Utilidad estimada − PTU pagada − pérdidas pendientes. Sobre esto se aplica la tasa.' },
          { term: 'PTU pagada', def: 'Participación de los Trabajadores en las Utilidades pagada en el año; se resta de la base.' },
          { term: 'Pérdidas pendientes', def: 'Pérdidas fiscales de años anteriores por amortizar; se restan de la base.' },
          { term: 'Tasa ISR', def: 'Tasa aplicable (30% para personas morales).' },
          { term: 'Pagos previos / retenido', def: 'Pagos provisionales de meses anteriores e ISR que te retuvieron; se acreditan contra el ISR causado.' },
        ],
      },
      {
        heading: 'IVA (flujo efectivo)',
        entries: [
          { term: 'IVA trasladado', def: 'El IVA que cobraste y que efectivamente se pagó (PUE, o PPD con REP).' },
          { term: 'IVA acreditable', def: 'El IVA que pagaste en compras y puedes descontar.' },
          { term: 'IVA a cargo / a favor', def: 'Trasladado − acreditable − retenido: si es positivo pagas al SAT; si es negativo queda a favor.' },
        ],
      },
    ],
  },

  materialidad: {
    title: 'Materialidad — guía',
    intro: 'Expediente de defensa por proveedor: demuestra que la operación fue real. Crítico si el proveedor aparece en listas negras del SAT.',
    groups: [
      {
        heading: 'Listas negras del SAT',
        entries: [
          { term: 'EFOS 69-B', def: 'Empresas que Facturan Operaciones Simuladas: el SAT presume que sus facturas son falsas. Comprar a un EFOS pone en riesgo tu deducción.' },
          { term: 'Art. 69', def: 'Contribuyentes con incumplimientos publicados (no localizados, créditos firmes, etc.).' },
        ],
      },
      {
        heading: 'Cadena de suministro',
        entries: [
          { term: 'Orden → Recepción → Factura → Pago', def: 'La secuencia que prueba que la operación existió.' },
          { term: 'Recepción', def: 'La entrada física a almacén: es la evidencia MÁS fuerte de materialidad.' },
          { term: 'Materialidad', def: 'Demostrar con documentos y hechos que el bien/servicio realmente se recibió y se pagó.' },
        ],
      },
      {
        heading: 'Conciliación CFDI ↔ operación',
        entries: [
          { term: 'Confirmada', def: 'Ligaste el CFDI a una operación real: cuenta como evidencia.' },
          { term: 'Sugerida', def: 'El motor propone el enlace por RFC + importe (±$1) + fecha (±5 días); falta que confirmes.' },
          { term: 'Match débil / sin RFC', def: 'La operación no trae RFC; se cruzó solo por importe+fecha. Verifica el nombre antes de confirmar.' },
          { term: 'Sin operación', def: 'No hay operación que respalde el CFDI en el rango: es un riesgo.' },
        ],
      },
      {
        heading: 'Veredicto',
        entries: [
          { term: 'Sólida / Revisar / Crítico', def: 'Nivel de defensa del expediente según listas negras, % de recepción física y completitud de la cadena.' },
        ],
      },
    ],
  },

  credenciales: {
    title: 'Credenciales SAT — guía',
    intro: 'Bóveda de la e.firma para autorizar la descarga masiva del SAT. El material privado se cifra y nunca se devuelve por la API.',
    groups: [
      {
        heading: 'Qué es cada cosa',
        entries: [
          { term: 'e.firma (FIEL)', def: 'Firma Electrónica Avanzada: identifica al contribuyente ante el SAT. Autoriza la descarga masiva de CFDI. (No es el CSD del timbrado, ese vive en el PAC.)' },
          { term: '.cer', def: 'El certificado (parte pública) de la e.firma.' },
          { term: '.key', def: 'La llave privada de la e.firma — el material secreto; se cifra en reposo.' },
          { term: 'Contraseña de la llave', def: 'La clave que protege el archivo .key.' },
          { term: 'CIEC', def: 'Clave de acceso al portal web del SAT (usuario/contraseña). Opcional aquí.' },
        ],
      },
      {
        heading: 'Estado',
        entries: [
          { term: 'Vigente / Vencida', def: 'Si el certificado sigue válido según su fecha de vencimiento.' },
          { term: 'Días', def: 'Días restantes antes de que venza el certificado (se marca en rojo si faltan menos de 30).' },
        ],
      },
      {
        heading: 'Seguridad',
        entries: [
          { term: 'AES-256-GCM', def: 'El .key y las contraseñas se cifran en reposo; solo se descifran un instante al firmar ante el SAT.' },
        ],
      },
    ],
  },

  'listas-sat': {
    title: 'Listas SAT — guía',
    intro: 'Proveedores tuyos que aparecen en las listas negras del SAT, cruzados contra tus egresos. El triage alimenta a Maat.',
    groups: [
      {
        heading: 'Listas',
        entries: [
          { term: 'EFOS 69-B', def: 'Empresas que Facturan Operaciones Simuladas: el SAT presume factura falsa. Comprarles arriesga tu deducción.' },
          { term: 'Art. 69', def: 'Contribuyentes con incumplimientos publicados (no localizados, créditos firmes, etc.).' },
        ],
      },
      {
        heading: 'Situación (severidad)',
        entries: [
          { term: 'Definitivo / Firme', def: 'Crítico: el estatus en la lista es definitivo. Máximo riesgo fiscal.' },
          { term: 'Presunto / No localizado / Exigible', def: 'Medio: aún no definitivo, pero requiere revisión.' },
          { term: 'Otros', def: 'Informativo.' },
        ],
      },
      {
        heading: 'Triage',
        entries: [
          { term: 'Confirmado', def: 'Revisaste y el riesgo es real; queda registrado para defensa/decisión.' },
          { term: 'Descartado', def: 'Falso positivo (p. ej. RFC homónimo); no se vuelve a marcar.' },
          { term: 'RFC con problema', def: 'RFC con formato inválido o genérico en tus egresos: corrige la captura.' },
        ],
      },
    ],
  },

  'polizas-cuadre': {
    title: 'Auditor de pólizas — guía',
    intro: 'Verifica que cada póliza cuadre (cargos = abonos) y detecta las que se subieron mal. Fuente: ContPAQi (libros fiscales) y Kepler (por sucursal).',
    groups: [
      {
        heading: 'Qué detecta',
        entries: [
          { term: 'No cuadra', def: 'La suma de cargos ≠ suma de abonos. Toda póliza debe cuadrar (partida doble).' },
          { term: 'Cuenta no afectable', def: 'Se posteó a una cuenta de agrupación en vez de una de detalle (hoja).' },
          { term: 'Periodo equivocado', def: 'La fecha de la póliza cae en un mes/año distinto al que se registró.' },
          { term: 'Duplicado', def: 'Misma referencia + cuenta + importe en folios distintos el mismo mes.' },
          { term: 'Importe ≠ CFDI', def: 'El importe posteado no coincide con el total del CFDI vinculado por UUID.' },
        ],
      },
      {
        heading: 'Fuentes',
        entries: [
          { term: 'ContPAQi', def: 'Libros fiscales (verdad del contador y el SAT). Trae el cuadre y el UUID del CFDI.' },
          { term: 'Kepler', def: 'Operación por sucursal (lo que ContPAQi consolida).' },
        ],
      },
    ],
  },
  'contabilidad-e': {
    title: 'Contabilidad electrónica — guía',
    intro: 'Genera los XML que exige el SAT (contabilidad electrónica 1.3) desde tu balanza contable.',
    groups: [
      {
        heading: 'Documentos',
        entries: [
          { term: 'Catálogo de cuentas', def: 'Estructura de tus cuentas con nivel, naturaleza y código agrupador SAT.' },
          { term: 'Balanza de comprobación', def: 'Saldo inicial, cargos (Debe), abonos (Haber) y saldo final por cuenta.' },
        ],
      },
      {
        heading: 'Código agrupador SAT',
        entries: [
          { term: 'Qué es', def: 'Clave del catálogo estándar del SAT (formato NNN o NNN.NN) a la que se mapea cada cuenta mayor tuya. Hace el catálogo 100% válido.' },
          { term: 'Cuenta mayor', def: 'Tu cuenta contable de primer nivel.' },
          { term: 'Naturaleza (D/A)', def: 'Deudora (D) o Acreedora (A).' },
          { term: 'manual / auto', def: 'Origen del mapeo: capturado por ti (manual) o auto-sugerido (conviene revisarlo).' },
        ],
      },
      {
        heading: 'Tipo de envío',
        entries: [
          { term: 'Normal', def: 'Primer envío del periodo.' },
          { term: 'Complementaria', def: 'Corrige una balanza ya enviada del mismo periodo.' },
        ],
      },
    ],
  },

  descarga: {
    title: 'Descarga masiva — ¿cómo funciona?',
    intro: 'Solicitudes de descarga de CFDI ante el SAT. El pipeline corre en segundo plano firmando con tu e.firma; el estado avanza solo.',
    groups: [
      {
        heading: 'Estado de la solicitud',
        entries: [
          { term: 'Nueva / Solicitada', def: 'Se registró y se pidió al SAT; esperando que la acepte.' },
          { term: 'En proceso', def: 'El SAT está generando los paquetes. Puede tardar minutos u horas.' },
          { term: 'Terminada', def: 'El SAT terminó de generar los paquetes; listos para descargar.' },
          { term: 'Descargada', def: 'Los paquetes se bajaron y sus CFDI ya están en el almacén.' },
          { term: 'Error / Rechazada / Vencida', def: 'La solicitud falló, el SAT la rechazó, o pasó la ventana de 72 h para descargar.' },
        ],
      },
      {
        heading: 'Requisitos',
        entries: [
          { term: 'e.firma', def: 'Se requiere la e.firma (FIEL) del RFC cargada en Credenciales para firmar la solicitud.' },
          { term: 'Ventana de 72 h', def: 'El SAT limita a 72 horas la descarga de los paquetes una vez generados.' },
        ],
      },
    ],
  },

  // [CV.24] El verificador de mostrador: la clienta ve el precio, así que las dos reglas
  // que importan son de dónde salió la cifra y qué unidad está cotizando.
  verificador: {
    title: 'Verificador de precios — guía',
    intro: 'Consulta el precio de venta de un producto por su clave o su código de barras. El precio sale del ERP en el momento; si no hay red, sale del respaldo descargado en esta máquina y la pantalla lo advierte.',
    groups: [
      {
        heading: 'De dónde sale el precio',
        entries: [
          { term: 'Precio en línea', def: 'Se consultó al ERP en ese instante. Es el precio vigente.' },
          { term: 'Precio de respaldo', def: 'No hubo red (o tardó más de 2.5 segundos) y el precio salió del catálogo descargado en esta máquina. Puede haber cambiado desde entonces: antes de cobrar, confirma en caja.' },
          { term: 'Sin conexión y sin respaldo', def: 'No hay red y esta máquina nunca descargó el catálogo, así que no hay con qué contestar. No significa que el producto no exista.' },
          { term: 'Respaldo local', def: 'Copia del catálogo de precios de ESTA sucursal guardada en el navegador. Se actualiza sola al entrar si tiene más de 12 horas, y con el botón Actualizar respaldo cuando haga falta.' },
        ],
      },
      {
        heading: 'Qué precio se muestra',
        entries: [
          { term: 'IVA incluido', def: 'La cifra grande es lo que paga el público. El IVA y el IEPS que le aplican se anotan debajo.' },
          { term: 'Unidad', def: 'El precio va por unidad de venta (pieza, paquete, caja). Si el producto se vende en varias, las demás aparecen listadas debajo con su equivalencia.' },
          { term: 'Sin precio cargado', def: 'El producto existe pero el ERP no tiene precio de venta para él: no se puede verificar y hay que preguntar en caja.' },
        ],
      },
      {
        heading: 'La sucursal importa',
        entries: [
          { term: 'Por qué se elige sucursal', def: 'El mismo código puede tener precio distinto entre plazas. La pantalla usa la sucursal de tu cuenta; si la máquina del mostrador no tiene cuenta propia, se le pasa la sucursal en la dirección (?sucursal=NN).' },
          { term: 'Datos hace N', def: 'Qué tan reciente es el dato del ERP para esa sucursal. Si dice horas, el precio pudo cambiar y aún no llegar.' },
          { term: 'Frescura del ERP sin medir', def: 'El sistema no sabe de cuándo es el dato de esa sucursal porque no le llega el latido del ERP. No significa que el precio esté mal: significa que nadie puede afirmar que esté al día. Es dato para Sistemas.' },
        ],
      },
    ],
  },
  arqueo: {
    title: 'Arqueo de caja — guía',
    intro: 'Conteo del efectivo físico en la caja. Es CIEGO: cuentas por denominación sin ver el monto esperado; al guardar, el sistema revela tu diferencia real. Solo ves tu sucursal.',
    groups: [
      {
        heading: 'Tipo de arqueo',
        entries: [
          { term: 'Cierre de día', def: 'Conteo final de la jornada de una caja; se compara contra el corte del sistema.' },
          { term: 'Relevo (cambio de turno)', def: 'Entrega de la caja de un cajero saliente a uno entrante; se sella el monto entregado.' },
        ],
      },
      {
        heading: 'Resultado',
        entries: [
          { term: 'Contado', def: 'La suma del efectivo que capturaste por denominación.' },
          { term: 'Esperado', def: 'Lo que el sistema (corte) dice que debería haber en la caja. No lo ves hasta guardar.' },
          { term: 'Faltante', def: 'Contaste MENOS de lo esperado (diferencia positiva): falta dinero en la caja.' },
          { term: 'Sobrante', def: 'Contaste MÁS de lo esperado (diferencia negativa): sobra dinero en la caja.' },
          { term: 'Cuadrado', def: 'Contado = esperado: la caja cuadra exacto.' },
          { term: 'Sin corte aún', def: 'Se guardó tu conteo pero todavía no hay corte del sistema para comparar; la diferencia aparecerá cuando se procese.' },
        ],
      },
      {
        heading: 'Por qué es ciego',
        entries: [
          { term: 'Arqueo ciego', def: 'Cuentas sin ver el esperado para que el conteo sea honesto y no se ajuste al número objetivo. La diferencia se revela solo al final.' },
        ],
      },
    ],
  },
  bancos: {
    title: 'Conciliación bancaria — guía',
    intro: 'Reemplaza el Excel manual de bancos. Cada mes: subís los estados de cuenta, el motor clasifica los movimientos contra un catálogo alineado a Kepler, y la pantalla te dice si TODO cuadra — y si no, exactamente qué falta y dónde.',
    groups: [
      {
        heading: 'Las vistas',
        entries: [
          { term: 'Cierre', def: 'La respuesta del mes: ¿cuadra o no? Arriba el veredicto y el resumen del dinero; abajo la lista de "qué falta", ordenada por impacto, con un botón que te lleva al lugar exacto de arreglarlo.' },
          { term: 'Movimientos', def: 'Todos los ingresos y egresos del periodo. Aquí clasificás (asignás categoría) lo que el motor dejó "sin clasificar".' },
          { term: 'Concentrado', def: 'Pivote cuenta × grupo (ingresos, compras, gastos, traspasos…): en qué se movió el dinero por banco.' },
          { term: 'Conciliación', def: 'Cruce contra Kepler: cuántos retiros ya tienen su pago en el mayor, y qué quedó sin conciliar por ambos lados.' },
          { term: 'Cuentas', def: 'Cuadre de saldos por cuenta. Clic en una cuenta para ver sus movimientos.' },
        ],
      },
      {
        heading: 'Cuadre de saldos',
        entries: [
          { term: 'Cuadre', def: 'Saldo inicial + depósitos − retiros debe dar el saldo final del estado de cuenta. Si no da, falta capturar un movimiento o el saldo está mal tecleado.' },
          { term: 'Δ (delta)', def: 'La diferencia entre el saldo calculado y el saldo final real. Δ = 0 (o ±$1,000 de tolerancia) = cuadra.' },
          { term: 'Renglón donde salta', def: 'Cuando una cuenta no cuadra, la fila expande el/los movimiento(s) exactos donde el saldo del banco salta más de lo que explica el movimiento: ahí está el error.' },
          { term: 'TI = TE', def: 'Traspasos internos: dinero movido entre cuentas propias. Lo que entra (TI) debe ser igual a lo que sale (TE) y netear a cero. Si no netean, falta el otro lado del traspaso.' },
        ],
      },
      {
        heading: 'Conciliación vs Kepler',
        entries: [
          { term: '102', def: 'La cuenta contable única con la que Kepler agrupa TODOS los bancos. El workbook es el detalle por banco que Kepler colapsa en ese 102.' },
          { term: 'Conciliado / sin conciliar', def: 'Un retiro del banco se "concilia" cuando se encuentra su pago equivalente en el 102 de Kepler (mismo monto ± fecha). "Sin conciliar" = aún no se le encontró par.' },
          { term: 'Caja (control-total)', def: 'Compara el total de depósitos/retiros del banco contra los cargos/abonos del 102. Excluye traspasos internos.' },
          { term: 'Retiros vs depósitos', def: 'El lado de RETIROS (banco vs abonos del 102) es la conciliación real: cada diferencia se persigue. El lado de DEPÓSITOS es un memo — mezcla banco + CAJA GENERAL (efectivo) + cobranza de otra sucursal, y el 102 no es su espejo, así que ese Δ no se persigue 1 a 1.' },
          { term: 'Factoraje', def: 'Financiamiento de compras. Los pagos por factoraje reducen el pasivo en Kepler (cuenta 210), NO son abono al 102 — por eso nunca concilian contra el 102 y no son un gap.' },
        ],
      },
      {
        heading: 'Clasificación',
        entries: [
          { term: 'Sin clasificar', def: 'Movimiento sin categoría asignada. No entra a ningún grupo del cuadre → hay que clasificarlo (a mano o creando una regla).' },
          { term: 'Regla', def: 'Patrón (código + concepto → categoría) que el motor aplica automáticamente al importar. Editable en ⚙ Config. "Reclasificar" re-aplica las reglas respetando lo que marcaste a mano.' },
          { term: 'Categoría', def: 'Etiqueta limpia alineada a una cuenta contable de Kepler (nómina, compra_mercancia, comisión_bancaria…).' },
        ],
      },
    ],
  },
  // ── Abouts enfocados por sección del tablero de bancos (CB.13.1) ──
  bancos_caja: {
    title: 'Cuadre de caja: cómo cerrarlo',
    intro: 'Compara lo que entró/salió del banco contra el 102 de Kepler. El lado de RETIROS es la conciliación real (cada diferencia se persigue); el de DEPÓSITOS es un memo. El número rojo del lado retiros NO es todo error de Kepler — se parte en tres cosas, y solo una se captura en Kepler.',
    resolve: [
      {
        heading: 'Depósitos (Δ del lado que entra) — memo',
        kind: 'info',
        intro: 'No es un gap. Los depósitos mezclan banco + efectivo de CAJA GENERAL (que Kepler asienta en caja, no en el 102) + cobranza que entra por otra sucursal. La columna de depósitos no es espejo del mayor 102.',
        steps: [
          'No se corrige contra el 102: es informativo.',
          'Si se quiere cuadrar, se hace por caja/sucursal por separado, no contra el 102 de banco.',
        ],
      },
      {
        heading: 'Retiros ① — Factoraje',
        kind: 'info',
        intro: 'Los pagos por factoraje reducen el pasivo en Kepler (cuenta 210); no son abono al 102, así que nunca concilian contra el 102.',
        steps: [
          'En Kepler confirmá que el pago esté en 210 (acreedor factoraje).',
          'Si está en 210, es correcto — no se toca.',
        ],
      },
      {
        heading: 'Retiros ② — Nómina, comisiones y tarjeta',
        kind: 'info',
        intro: 'Kepler los agrupa en una póliza mensual (nómina en 601, comisiones bancarias en 611-003), no transfer por transfer. El dinero YA está en el 102, solo que agrupado.',
        steps: [
          'No se corrige: es diferencia de granularidad de captura.',
          'Por eso el cuadre casa por monto pero no 1 a 1 por conteo.',
        ],
      },
      {
        heading: 'Retiros ③ — Pagos a proveedor sin póliza en el 102',
        kind: 'fix',
        intro: 'Éste SÍ se captura en Kepler: pagos de mercancía que salieron del banco pero no tienen egreso aplicado en el 102.',
        steps: [
          'En Kepler abrí el auxiliar del 102 (bancos) del periodo.',
          'Buscá la póliza de egreso por beneficiario + monto + fecha.',
          'Si NO existe → capturala: abono al 102 / cargo al proveedor (aplicá el pago a su factura).',
          'Si existe pero en otra cuenta de banco → reclasificala al 102 correcto.',
          'La lista exacta por proveedor está en el tab Conciliación → "Pagos Kepler (102) sin conciliar".',
        ],
      },
    ],
  },

  bancos_sin_clasificar: {
    title: 'Movimientos sin clasificar',
    intro: 'Movimientos del banco a los que el motor aún no les asignó categoría. Por ahora la clasificación NO se edita aquí — para el cuadre lo que importa es que el movimiento esté bien registrado en Kepler.',
    resolve: [
      {
        heading: 'Qué hacer en Kepler',
        kind: 'fix',
        steps: [
          'En Kepler, buscá cada movimiento por monto + fecha en el auxiliar del 102 (o en la cuenta del beneficiario).',
          'La contracuenta que usó Kepler te dice su naturaleza: nómina 601, servicios 603, comisión bancaria 611-003, etc.',
          'Si el movimiento NO está registrado en Kepler, capturalo en la cuenta correcta — ese es el gap real que cierra el cuadre.',
          'Los patrones que más pesan salen listados abajo (código + concepto) para ubicarlos rápido.',
        ],
      },
    ],
  },

  bancos_saldo_no_cuadra: {
    title: 'El saldo de una cuenta no cierra',
    intro: 'Saldo inicial + depósitos − retiros debería dar el saldo final del estado de cuenta. Si no da, falta capturar un movimiento o un saldo/monto está mal tecleado.',
    resolve: [
      {
        heading: 'Encontrar y corregir el error',
        kind: 'fix',
        steps: [
          'La fila expande el/los renglón(es) donde el saldo del banco salta más de lo que explica el movimiento: ahí está el error.',
          'Si falta un movimiento, capturalo (o volvé a subir el estado de cuenta si el Excel venía incompleto).',
          'Si el saldo inicial/final está mal tecleado, corregilo en la fuente y reimportá.',
        ],
      },
    ],
  },

  bancos_traspaso_descuadre: {
    title: 'Los traspasos internos no netean',
    intro: 'Los traspasos entre cuentas propias (TI = entra, TE = sale) deben netear a cero: lo que sale de una cuenta entra en otra.',
    resolve: [
      {
        heading: 'Qué hacer en Kepler',
        kind: 'fix',
        steps: [
          'Si TI ≠ TE, en Kepler revisá que el traspaso tenga sus DOS lados capturados (cuenta origen y cuenta destino).',
          'Si falta un lado, capturalo en Kepler.',
          'Los traspasos reales (TI/TE) ya se miden aparte y netean a cero; un Spei u otro movimiento mal etiquetado como traspaso también descuadra — en Kepler verificá su cuenta real.',
        ],
      },
    ],
  },

  bancos_cuenta_sin_cargar: {
    title: 'Cuenta sin estado de cuenta',
    intro: 'La cuenta existe en el catálogo pero no tiene estado de cuenta cargado en este periodo, así que su movimiento no entra al cuadre.',
    resolve: [
      {
        heading: 'Cargarla o desactivarla',
        kind: 'fix',
        steps: [
          'Subí el estado de cuenta del periodo para esa cuenta.',
          'Si la cuenta ya no aplica, desactivala en Admin → Cuentas.',
          'CAJA GENERAL tiene un layout de columnas distinto — puede requerir su importador propio.',
        ],
      },
    ],
  },

  bancos_retiros_sin_casar: {
    title: 'Retiros del banco sin conciliar',
    intro: 'Retiros que salieron del banco y no encontraron su pago equivalente en el 102 de Kepler. NO todos son un error — mirá la columna "Categoría": según qué sean, se resuelven distinto (o no requieren nada).',
    resolve: [
      {
        heading: '① Pago a factoraje / Compra con factoraje',
        kind: 'info',
        intro: 'Reducen el pasivo de factoraje en Kepler (cuenta 210); no son abono al 102, por eso nunca concilian.',
        steps: [
          'En Kepler confirmá que el pago esté en 210 (acreedor factoraje).',
          'Si está en 210, es correcto — no se toca.',
        ],
      },
      {
        heading: '② Nómina, comisión bancaria, tarjeta/TPV',
        kind: 'info',
        intro: 'Kepler los agrupa en una póliza mensual (nómina 601, comisión 611-003), no transfer por transfer. El dinero YA está en el 102, solo agrupado.',
        steps: [
          'No se corrige: es diferencia de granularidad, no un gap.',
        ],
      },
      {
        heading: '③ Compra de mercancía / gasto directo',
        kind: 'fix',
        intro: 'Éstos SÍ se capturan en Kepler: pagos que salieron del banco sin egreso aplicado en el 102 (p. ej. REM BOLSAS, SWEETS DIMENSION, CANEL\'S).',
        steps: [
          'En Kepler abrí el auxiliar del 102 (bancos) del periodo.',
          'Buscá la póliza de egreso por beneficiario + monto + fecha.',
          'Si NO existe → capturala: abono al 102 / cargo al proveedor (aplicá el pago a su factura).',
          'Si existe pero en otra cuenta de banco → reclasificala al 102 correcto.',
        ],
      },
    ],
  },

  bancos_kepler_sin_casar: {
    title: 'Pagos de Kepler (102) sin conciliar',
    intro: 'El lado inverso: pagos que Kepler registró en el 102 pero que no encontraron su retiro equivalente en el banco (por monto + fecha). Kepler dice que pagó; el banco no lo muestra o no casó.',
    resolve: [
      {
        heading: 'Qué hacer en Kepler',
        kind: 'fix',
        steps: [
          'Abrí cada póliza por su folio (columna Doc) y mirá contra qué banco y fecha se registró.',
          'Si salió de OTRA cuenta de banco (o de caja/factoraje) → es correcto, solo no casó contra este banco.',
          'Si tiene fecha/monto mal capturado o está duplicada en Kepler → corregila ahí.',
          'Si de verdad no salió del banco → revisá si es una provisión / cuenta por pagar que todavía no se paga.',
        ],
      },
    ],
  },

  egresos: {
    title: 'Egresos contables — guía',
    intro: 'Todo lo que sale (pólizas de cargo del mayor de Kepler): compras a proveedor, gastos operativos, compra de activo fijo y gastos financieros e impuestos. Podés ver el árbol por cuenta, la tendencia mensual, el ranking de proveedores y hacer drill hasta el documento y su cadena.',
    groups: [
      {
        heading: 'Familia del egreso',
        entries: [
          { term: 'Compra', def: 'Pago/registro de mercancía a proveedor (cuenta 511/510 y afines). Es el grueso del egreso.' },
          { term: 'Gasto', def: 'Egreso operativo que no es mercancía: nómina, servicios, comisiones, renta, viáticos (cuentas 6xx).' },
          { term: 'Activo no circulante', def: 'Compra que NO se gasta: se capitaliza como activo fijo (cuenta 150 — mobiliario, equipo de cómputo y reparto, edificio, terrenos, licencias). El dinero sale igual, por eso cuenta acá; en el P&L no es gasto sino depreciación posterior.' },
          { term: 'Financiero e impuesto', def: 'Intereses y comisiones bancarias (702) e impuestos propios: IMSS/SUA (762), ISR (761), estatales (760), cedular (763), PTU (764). NO incluye la 701 PRODUCTOS FINANCIEROS, que es ingreso.' },
        ],
      },
      {
        heading: 'Cómo leer',
        entries: [
          { term: 'Cuenta', def: 'Cuenta contable de Kepler (código + nombre). Agrupa el gasto por su naturaleza.' },
          { term: 'Beneficiario', def: 'A quién se le pagó (proveedor o tercero). El drill por beneficiario acumula el filtro de cuenta.' },
          { term: 'Póliza / documento', def: 'El asiento contable concreto. Su detalle abre la cadena pedido → factura → pago (materialidad de la operación).' },
          { term: 'Δ vs periodo previo', def: 'Variación del gasto contra el mes anterior. ▲ = subió, ▼ = bajó.' },
        ],
      },
    ],
  },
  hallazgos: {
    title: 'Hallazgos de Maat — guía',
    intro: 'Patrones que el motor detecta en los libros. Vos confirmás o descartás cada uno: ese veredicto ENTRENA la precisión de la regla (las reglas ruidosas se auto-suprimen). El motor decide, vos validás, el LLM queda fuera del número.',
    groups: [
      {
        heading: 'Clase de hallazgo',
        entries: [
          { term: 'Riesgo', def: 'Posible pérdida o exposición (pago sin soporte, duplicado, descuadre). Máxima prioridad.' },
          { term: 'Error de captura', def: 'Dato mal tecleado o inconsistente (saldo que no cierra, sin clasificar). Se corrige en la fuente.' },
          { term: 'Oportunidad', def: 'Ahorro o mejora detectable (descuento no aplicado, condición mejor).' },
        ],
      },
      {
        heading: 'Severidad',
        entries: [
          { term: 'Crítico', def: 'Impacto alto ($ grande o riesgo serio) — atender primero.' },
          { term: 'Alerta', def: 'Impacto medio — revisar.' },
          { term: 'Info', def: 'Bajo impacto / informativo.' },
        ],
      },
      {
        heading: 'Triage (tu veredicto entrena)',
        entries: [
          { term: 'Confirmar', def: 'Es real y útil → sube la precisión de esa regla y queda para seguimiento.' },
          { term: 'Descartar (falso positivo)', def: 'No aplica → baja la precisión; si una regla acumula falsos, se auto-suprime.' },
          { term: 'Precisión de regla', def: '% de aciertos según tu feedback. Reglas de baja precisión se silencian salvo que las fijes (pin).' },
        ],
      },
    ],
  },
  reembolsos: {
    title: 'Reembolsos / comprobaciones — guía',
    intro: 'Comprobación de gastos: ligás la evidencia (facturas, tickets, XMLs) a una solicitud de gasto de Kepler para que el egreso quede soportado.',
    groups: [
      {
        heading: 'Estado',
        entries: [
          { term: 'Recibida', def: 'Se subió la comprobación; falta validarla.' },
          { term: 'Validada', def: 'Revisada y aceptada como soporte del gasto.' },
          { term: 'Rechazada', def: 'No cumple; se indica el motivo para recapturar.' },
        ],
      },
      {
        heading: 'Archivos',
        entries: [
          { term: 'Comprobante por rol', def: 'Cada gasto puede pedir distintos documentos (factura, ticket, XML). Subí el archivo en su casilla.' },
          { term: 'Solicitud (Kepler)', def: 'El folio de gasto autorizado en Kepler al que se liga la comprobación.' },
        ],
      },
    ],
  },
  solicitudes: {
    title: 'Solicitudes de gasto — guía',
    intro: 'Solicitudes de gasto capturadas en Kepler. Desde aquí ves su estado y saltás a comprobarlas (subir soporte) o a ver el egreso ya contabilizado.',
    groups: [
      {
        heading: 'Estado de la solicitud',
        entries: [
          { term: 'Nueva', def: 'Capturada, pendiente de aprobación.' },
          { term: 'Aprobada', def: 'Autorizada; puede ejercerse el gasto.' },
          { term: 'Cerrada / ejercida', def: 'Gasto realizado y contabilizado.' },
          { term: 'Cancelada', def: 'Anulada; no procede.' },
        ],
      },
      {
        heading: 'Acciones',
        entries: [
          { term: 'Comprobar', def: 'Ir a Reembolsos con el folio y proveedor precargados para subir el soporte.' },
          { term: 'Ver gasto', def: 'Abrir el egreso contable ligado a esta solicitud (si ya se contabilizó).' },
          { term: 'Comprobante recibido/validado', def: 'Indicador de si la solicitud ya tiene soporte cargado y en qué estado está.' },
        ],
      },
    ],
  },

  // `[AU.14]` Las tres pantallas de la organización comparten un vocabulario que no
  // se explica en ningún otro lado, y del que depende entender por qué alguien ve
  // o no ve algo.
  'organizacion-personas': {
    title: 'Personas, puestos y responsabilidades — guía',
    intro:
      'Una persona ocupa un puesto, y del puesto salen su perfil de acceso, su jefe y de qué responde. Apartarse de lo que el puesto propone se puede, dejando escrito el motivo.',
    groups: [
      {
        heading: 'Los tres ejes que NO se mezclan',
        entries: [
          { term: 'Permiso', def: 'Decide si podés ABRIR una pantalla. Sale del rol, y se edita en Roles y permisos.' },
          { term: 'Responsabilidad', def: 'Decide si un trabajo ES TUYO. No abre nada: si el puesto responde de una bandeja que su perfil no abre, lo que corresponde es arreglar el rol.' },
          { term: 'Tarea', def: 'Dice que alguien te asignó algo en concreto. Es lo que aparece en Mi trabajo.' },
          { term: 'Por qué separados', def: 'Juntarlos crearía un cuarto sistema de autorización. Ya pasó: se midieron cuatro compuertas muertas por tener la autorización en dos lugares.' },
        ],
      },
      {
        heading: 'El puesto',
        entries: [
          { term: 'Lo que propone', def: 'Perfil de acceso, complementos, jefe y responsabilidades. Propone: no otorga. Quien concede sigue siendo el rol de la persona.' },
          { term: 'Motivo de apartarse', def: 'Si se elige un perfil distinto del que propone el puesto, hay que escribir por qué. Queda en la bitácora de la persona.' },
          { term: 'Raíz', def: 'Un puesto que no cuelga de ningún otro. Algunos lo son a propósito (Dirección); otros quedaron sueltos y su escalamiento no llega a nadie.' },
          { term: 'Vacante', def: 'Un puesto sin nadie. Un jefe declarado sobre un puesto vacante es una cadena correcta que no despierta a ninguna persona.' },
        ],
      },
      {
        heading: 'Dónde opera, y por qué importa',
        entries: [
          { term: 'Eje de alcance', def: 'Qué se le pregunta para saber qué filas ve: su ruta, su tienda, su plaza, o nada si es de oficina (red). Sale del puesto, o del departamento si el puesto no lo declara.' },
          { term: 'Fail-closed', def: 'Sin regla de alcance, no ve NADA. Es a propósito: es preferible que alguien pida acceso a que vea de más sin que nadie se entere.' },
          { term: 'La cadena es por zona', def: 'El mismo puesto existe varias veces con jefes distintos. Por eso el jefe se declara entre PUESTOS y la zona desempata cuál de ellos corresponde.' },
        ],
      },
      {
        heading: 'El estado de una cuenta',
        entries: [
          { term: 'Invitada', def: 'Creada y todavía no entró.' },
          { term: 'Activa', def: 'En uso.' },
          { term: 'Suspendida', def: 'Baja temporal: vuelve.' },
          { term: 'Dada de baja', def: 'Ya no trabaja acá. Conserva su historial; no es lo mismo que suspendida.' },
          { term: 'Sesión larga', def: 'Una credencial que dura meses. Es para un kiosco o una tableta que nadie vuelve a desbloquear, no para una persona.' },
        ],
      },
    ],
  },

  // CE.9 — DESIGN §P + §Q.7. La pantalla tenía las definiciones sueltas en un Record del
  // template, que es justo lo que §P prohíbe: la fuente de la explicación es este diccionario.
  // Los siete veredictos son el vocabulario que decide a quién se persigue, y tres de ellos
  // son AUSENCIAS distintas entre sí — confundirlas es el error que la vista existe para evitar.
  'costo-estandar': {
    title: 'Costo estándar — guía',
    intro: 'Con qué costo está poniendo precio Kepler, y si se parece a lo que cuesta reponer hoy. Todo sale del ERP: acá no se captura ni se corrige nada.',
    groups: [
      {
        heading: 'Los dos costos que se comparan',
        entries: [
          { term: 'Costo estándar', def: 'El que vive en la ficha del producto de Kepler. NO es un promedio: cambia de golpe cuando alguien edita la ficha. Es el que FIJA EL PRECIO — precio = costo x (1 + margen) x (1 + impuesto) cuadra en el 97.75% del catálogo.' },
          { term: 'Costo de reposición', def: 'Lo que el ERP dice que cuesta reponer esa pieza en ESA plaza hoy. Es el testigo contra el que se juzga la ficha.' },
          { term: 'Último costo', def: 'Lo último que se pagó, con su fecha. Contexto, no árbitro: una compra puntual no desmiente al costo de reposición.' },
          { term: 'Desviación', def: 'Cuánto se aleja la reposición de la ficha, en porcentaje SOBRE LA FICHA. Positiva = reponer cuesta más de lo que dice la ficha.' },
          { term: 'Impacto 30 d', def: 'La desviación por unidad multiplicada por lo que se vendió en la ventana. Es el dinero real en juego. Sale vacío cuando las dos magnitudes no están en la misma unidad.' },
        ],
      },
      {
        heading: 'El peldaño — por qué a veces no se puede restar',
        entries: [
          { term: 'Peldaño', def: 'Kepler guarda hasta tres unidades por producto (pieza, paquete, caja) con su factor. El testigo del ERP no siempre viene en la misma que el costo estándar.' },
          { term: 'base', def: 'El testigo vino en la unidad base, la misma del costo estándar. Se puede restar: la cifra es comparable.' },
          { term: 'no resuelve', def: 'El testigo no cae en ninguno de los tres peldaños. Restarlo inventaría una desviación de 10x o 20x, así que NO se resta: la fila sale sin cifra. Es el 4.17% de los pares.' },
          { term: 'Sin valorar', def: 'Cuántas filas quedaron FUERA de las sumas de dinero. Va siempre pegado al total: leer la suma sin este acompañante afirma más de lo que el dato sostiene.' },
        ],
      },
      {
        heading: 'Los siete veredictos — y las tres ausencias que NO son la misma',
        entries: [
          { term: 'Estándar por debajo', def: 'La ficha cuesta menos que reponer. Es el que cuesta dinero: subdeclara el costo de lo vendido e INFLA el margen publicado.' },
          { term: 'Estándar por encima', def: 'La ficha cuesta más que reponer. Sobredeclara el costo. Compensa parcialmente al anterior, por eso se publica el neto y no sólo una mitad.' },
          { term: 'Al día', def: 'Ficha y reposición coinciden dentro de un centavo.' },
          { term: 'No comparable', def: 'AUSENCIA 1 de 3. Hay testigo pero viene en otro peldaño. No es un hueco de datos: es una unidad que no empata, y se declara en vez de estimarse.' },
          { term: 'Sin costo en el ERP', def: 'AUSENCIA 2 de 3, y el HUECO REAL: el producto SÍ vendió y el ERP no le tiene costo en esa plaza. Son pocos y estaban enterrados bajo 125 veces su tamaño hasta que se separaron de la siguiente.' },
          { term: 'Sin operación en la plaza', def: 'AUSENCIA 3 de 3, y no es un hueco: la ficha existe en las 9 plazas aunque el producto no se maneje ahí. Es el maestro replicado, y son más de la mitad de las filas. Por eso están escondidas por default.' },
          { term: 'Sin costo estándar', def: 'La ficha no tiene costo capturado. Sin eso, el precio de ese producto no se puede explicar.' },
        ],
      },
      {
        heading: 'El cuadre del precio',
        entries: [
          { term: 'Precio que no cuadra', def: 'La fórmula de Kepler reconstruida no da el precio que tiene la ficha. Algo de los tres insumos (costo, margen, impuesto) no es el que se usó.' },
          { term: 'No medible', def: 'No alcanza para juzgar, y se dice el motivo. El caso típico: sin venta en la ventana no hay tasa de impuesto observada, y un producto sin venta NO es un producto exento — por eso va vacío y nunca en cero.' },
          { term: 'Tasas distintas', def: 'El mismo producto cobró más de una tasa en la ventana. El impuesto que se usa es la moda, y la pantalla lo avisa en el detalle.' },
        ],
      },
      {
        heading: 'Hasta dónde llega lo que ves',
        entries: [
          { term: 'Ventana de actividad', def: 'Los últimos 30 días, sostenidos por una vista materializada. Si no se refrescó, esa frase deja de ser cierta — por eso la fecha de corte se imprime en pantalla y no en un log.' },
          { term: 'Alcance del tablero', def: 'Los mosaicos y los chips miden la sucursal + el texto del buscador, igual que la tabla. El chip de veredicto NO se aplica a los conteos: los chips son el selector, y tienen que seguir mostrando el reparto completo.' },
        ],
      },
    ],
    resolve: [
      {
        heading: 'Cómo se corrige un costo estándar',
        kind: 'fix',
        intro: 'Esta pantalla es de sólo lectura sobre el ERP. El costo estándar se edita en Kepler, que es el sistema de registro del catálogo.',
        steps: [
          'Ordená por Impacto 30 d: arriba está el dinero, no el porcentaje más feo. Una desviación del 300% sobre algo que no se vende no es el problema.',
          'Abrí la fila y mirá la escalera: si el testigo dice otro peldaño, lo que hay que arreglar es la UNIDAD de la ficha, no el número del costo.',
          'Mirá el mismo producto en todas las plazas. La ficha se mantiene por sucursal: si sólo una divergió, se corrige esa; si divergieron todas, el criterio cambió.',
          'Corregí la ficha en Kepler. El cambio llega acá por el ODS, y la fila se recalcula sola en el siguiente refresco.',
        ],
      },
      {
        heading: 'Cuando la fila dice No comparable',
        kind: 'info',
        steps: [
          'No hay nada que corregir en el costo: los dos números son correctos y están en unidades distintas.',
          'Si te interesa la cifra, el arreglo de fondo es declarar bien el peldaño del producto en Kepler; mientras tanto la fila se queda sin desviación a propósito.',
        ],
      },
    ],
  },
};
