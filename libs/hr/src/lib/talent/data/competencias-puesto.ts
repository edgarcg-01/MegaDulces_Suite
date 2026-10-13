/**
 * Fase RH · `[RH.2.4]` — COPIA SIN CAMBIOS del catálogo de Mega Talento
 * (`src/app/core/models/competencias-puesto.model.ts`), salvo el import del tipo. Vive sólo en el SERVIDOR: la hoja se
 * congela en el candidato al generar la liga y la página recibe sólo sus competencias (no entra al bundle de la app).
 * Mega Talento lo genera del Excel oficial de RH; si cambian las hojas, se regenera allá y se copia aquí.
 */
// =====================================================================
// CATÁLOGO OFICIAL DE COMPETENCIAS POR PUESTO (entrevista técnica STAR)
// GENERADO AUTOMÁTICAMENTE desde el Excel oficial de RH. NO editar a mano:
// si cambian las hojas, regenerar con scratchpad/generar-catalogo.js.
// =====================================================================
import type { HrCompetenciaStar as CompetenciaStar } from '@megadulces/contracts';

export interface HojaCompetencias {
  key: string;
  nombre: string;
  competencias: CompetenciaStar[];
  preguntasCierre: string[];
}

export const CATALOGO_COMPETENCIAS: Record<string, HojaCompetencias> = {
  "vendedor-a-detalle": {
    "key": "vendedor-a-detalle",
    "nombre": "VENDEDOR A DETALLE",
    "competencias": [
      {
        "key": "experiencia-en-venta-a-detalle",
        "categoria": "Experiencia Comercial",
        "parametro": "Experiencia en venta a detalle",
        "preguntaStar": "Cuéntame de una ocasión en la que hayas trabajado una ruta o zona con clientes de canal detalle. ¿Qué clientes visitabas, cuál era tu objetivo, qué acciones hiciste y qué resultados obtuviste?",
        "anclas": {
          "inferior": "No tiene experiencia real en canal detalle o responde de forma vaga, sin ruta, clientes ni resultados.",
          "cumple": "Ha trabajado rutas o zonas de detalle; explica clientes, objetivo y actividades básicas.",
          "supera": "Domina el canal detalle; describe cobertura, frecuencia, negociación y resultados medibles."
        }
      },
      {
        "key": "cumplimiento-de-metas",
        "categoria": "Resultados",
        "parametro": "Cumplimiento de metas",
        "preguntaStar": "Háblame de un mes o periodo en el que tenías una meta de ventas retadora. ¿Cuál era la meta, qué tan lejos estabas, qué hiciste y cuál fue el resultado final?",
        "anclas": {
          "inferior": "No identifica metas concretas o no demuestra acciones para alcanzarlas.",
          "cumple": "Describe una meta, acciones de seguimiento y cumplimiento aceptable.",
          "supera": "Superó una meta retadora con estrategia clara, seguimiento diario e indicadores comprobables."
        }
      },
      {
        "key": "apertura-de-clientes",
        "categoria": "Prospección",
        "parametro": "Apertura de clientes",
        "preguntaStar": "Dame un ejemplo de una vez que abriste clientes nuevos en una zona. ¿Cómo los identificaste, cómo los abordaste, qué objeciones enfrentaste y cuántos convertiste?",
        "anclas": {
          "inferior": "Tiene poca o nula experiencia prospectando; no convierte ejemplos en resultados.",
          "cumple": "Ha abierto clientes nuevos mediante prospección y seguimiento básico.",
          "supera": "Identifica oportunidades, maneja objeciones y convierte clientes con resultados cuantificables."
        }
      },
      {
        "key": "recuperacion-o-crecimiento-de-cartera",
        "categoria": "Gestión Comercial",
        "parametro": "Recuperación o crecimiento de cartera",
        "preguntaStar": "Cuéntame de una ocasión en la que tomaste una cartera difícil, caída o con clientes poco activos. ¿Qué diagnóstico hiciste, qué plan seguiste y qué mejoras lograste?",
        "anclas": {
          "inferior": "No muestra diagnóstico ni método para reactivar clientes.",
          "cumple": "Realiza seguimiento y recupera actividad en algunos clientes.",
          "supera": "Diagnostica causas, prioriza clientes y logra recuperación o crecimiento medible."
        }
      },
      {
        "key": "negociacion-con-clientes",
        "categoria": "Negociación",
        "parametro": "Negociación con clientes",
        "preguntaStar": "Descríbeme una situación en la que un cliente no quería comprar, cambiar de proveedor o aceptar una promoción. ¿Qué argumentos usaste, cómo manejaste la objeción y cuál fue el resultado?",
        "anclas": {
          "inferior": "Se queda sin argumentos o presiona sin estrategia.",
          "cumple": "Maneja objeciones comunes y logra acuerdos básicos.",
          "supera": "Convierte objeciones complejas en cierres o acuerdos rentables y sostenibles."
        }
      },
      {
        "key": "manejo-de-rechazo",
        "categoria": "Resiliencia",
        "parametro": "Manejo de rechazo",
        "preguntaStar": "Platícame de una ocasión en la que varios clientes te rechazaron o tuviste un día muy bajo en ventas. ¿Cómo reaccionaste, qué hiciste para recuperar el ritmo y qué aprendiste?",
        "anclas": {
          "inferior": "Se desmotiva, culpa al cliente o no presenta acciones correctivas.",
          "cumple": "Mantiene constancia y ajusta su acercamiento.",
          "supera": "Usa el rechazo como retroalimentación, reajusta ruta o discurso y recupera resultados."
        }
      },
      {
        "key": "disciplina-y-planeacion-de-ruta",
        "categoria": "Organización",
        "parametro": "Disciplina y planeación de ruta",
        "preguntaStar": "Cuéntame cómo organizabas tu día cuando tenías varios clientes por visitar. ¿Qué criterios usabas para priorizar, cómo controlabas tiempos y cómo medías si tu ruta fue efectiva?",
        "anclas": {
          "inferior": "No demuestra planeación; trabaja de forma reactiva.",
          "cumple": "Organiza visitas por zona, tiempo y prioridad comercial.",
          "supera": "Optimiza cobertura, frecuencia, cobranza y productividad con control claro de indicadores."
        }
      },
      {
        "key": "logros-comerciales",
        "categoria": "Logro",
        "parametro": "Logros comerciales",
        "preguntaStar": "¿Cuál consideras tu mayor logro en ventas de campo o venta a detalle? ¿Cuál era la situación inicial, qué hiciste tú y qué resultado medible lograste?",
        "anclas": {
          "inferior": "No presenta logros medibles o atribuye el resultado a terceros.",
          "cumple": "Presenta un logro relacionado con ventas y explica su participación.",
          "supera": "Demuestra logro sobresaliente con impacto directo, números y evidencia validable."
        }
      },
      {
        "key": "cobranza-o-manejo-de-dinero",
        "categoria": "Administración",
        "parametro": "Cobranza o manejo de dinero",
        "preguntaStar": "Dame un ejemplo de una situación en la que tuviste que gestionar cobranza, pagos pendientes o manejo de efectivo. ¿Qué hiciste para cuidar la relación con el cliente y asegurar el cumplimiento?",
        "anclas": {
          "inferior": "Muestra riesgo en manejo de efectivo, cobranza o seguimiento.",
          "cumple": "Gestiona pagos pendientes cuidando relación y cumplimiento.",
          "supera": "Mantiene cartera sana, anticipa riesgos y documenta correctamente pagos o acuerdos."
        }
      },
      {
        "key": "servicio-al-cliente",
        "categoria": "Servicio",
        "parametro": "Servicio al cliente",
        "preguntaStar": "Cuéntame de una ocasión en la que un cliente tuvo una queja por entrega, producto, precio o servicio. ¿Cómo atendiste la situación, con quién te coordinaste y qué pasó después?",
        "anclas": {
          "inferior": "Minimiza quejas, culpa a otros o no da seguimiento.",
          "cumple": "Atiende quejas, coordina solución y da seguimiento aceptable.",
          "supera": "Resuelve, recupera confianza del cliente y evita recurrencia mediante coordinación efectiva."
        }
      },
      {
        "key": "estabilidad-laboral",
        "categoria": "Estabilidad",
        "parametro": "Estabilidad laboral",
        "preguntaStar": "Veo que has tenido cambios laborales. Cuéntame de uno de esos cambios importantes. ¿Cuál fue el contexto, qué buscabas, qué aprendiste y qué harías diferente hoy?",
        "anclas": {
          "inferior": "No justifica cambios, muestra inestabilidad o evasión.",
          "cumple": "Explica cambios con lógica laboral y aprendizajes básicos.",
          "supera": "Muestra autocrítica, aprendizaje y decisiones coherentes con crecimiento profesional."
        }
      },
      {
        "key": "permanencia-y-motivacion",
        "categoria": "Motivación",
        "parametro": "Permanencia y motivación",
        "preguntaStar": "Háblame de un trabajo en ventas donde hayas permanecido más tiempo o hayas tenido mejor desempeño. ¿Qué te mantuvo ahí, qué condiciones te ayudaron a rendir bien y por qué saliste?",
        "anclas": {
          "inferior": "Motivación débil o centrada solo en necesidad inmediata.",
          "cumple": "Identifica factores de permanencia, desempeño y salida razonables.",
          "supera": "Muestra motivación por resultados, estabilidad y crecimiento dentro del puesto."
        }
      },
      {
        "key": "trabajo-bajo-presion",
        "categoria": "Adaptabilidad",
        "parametro": "Trabajo bajo presión",
        "preguntaStar": "Descríbeme una ocasión en la que tuviste presión fuerte por cuota, supervisor, cobranza o clientes. ¿Cómo manejaste la presión, qué decisiones tomaste y cuál fue el resultado?",
        "anclas": {
          "inferior": "Se bloquea, reacciona mal o afecta resultados bajo presión.",
          "cumple": "Mantiene desempeño aceptable bajo presión.",
          "supera": "Prioriza, decide con control y sostiene resultados en condiciones exigentes."
        }
      },
      {
        "key": "honestidad-y-responsabilidad",
        "categoria": "Integridad",
        "parametro": "Honestidad y responsabilidad",
        "preguntaStar": "Cuéntame de una situación en la que tuviste que reportar un error, una diferencia de producto, dinero o información de cliente. ¿Qué pasó, cómo lo comunicaste y cómo se resolvió?",
        "anclas": {
          "inferior": "Evade responsabilidad o normaliza errores sin reporte.",
          "cumple": "Reconoce errores, informa y sigue procedimiento.",
          "supera": "Actúa con transparencia, corrige y previene reincidencia."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto implica campo, metas, seguimiento diario, posible variable por comisión y trato constante con clientes. Cuéntame de una experiencia previa parecida: ¿qué fue lo más difícil, qué te gustó más y cómo sabes que puedes sostener ese ritmo?",
        "anclas": {
          "inferior": "No muestra afinidad con campo, metas o seguimiento diario.",
          "cumple": "Se adapta a condiciones similares y entiende exigencias del puesto.",
          "supera": "Tiene alta compatibilidad: experiencia similar, tolerancia a presión y orientación a resultados."
        }
      }
    ],
    "preguntasCierre": [
      "¿Qué indicadores manejabas en tu último puesto: venta, cobertura, clientes visitados, efectividad, cobranza, ticket promedio?",
      "¿Cuál fue tu mejor mes en ventas y qué número lograste?",
      "¿Qué tipo de productos o clientes se te facilitan más vender y cuáles se te dificultan?",
      "¿Qué tendría que tener una empresa para que tú te quedes y crezcas en el puesto?",
      "¿Qué referencias o evidencias podríamos validar sobre tus resultados comerciales?"
    ]
  },
  "bodeguero": {
    "key": "bodeguero",
    "nombre": "BODEGUERO",
    "competencias": [
      {
        "key": "recepcion-de-mercancia",
        "categoria": "Operación",
        "parametro": "Recepción de mercancía",
        "preguntaStar": "Cuéntame una ocasión en la que recibiste mercancía con diferencias o inconsistencias. ¿Qué detectaste, qué hiciste y cuál fue el resultado?",
        "anclas": {
          "inferior": "No identifica errores o no sigue procedimientos.",
          "cumple": "Detecta incidencias y sigue el proceso establecido.",
          "supera": "Detecta desviaciones oportunamente y evita afectaciones al inventario."
        }
      },
      {
        "key": "control-de-inventario",
        "categoria": "Inventarios",
        "parametro": "Control de inventario",
        "preguntaStar": "Háblame de una ocasión en la que participaste en inventarios físicos. ¿Cuál era tu responsabilidad y qué resultados obtuviste?",
        "anclas": {
          "inferior": "Experiencia limitada o errores frecuentes.",
          "cumple": "Realiza conteos correctamente.",
          "supera": "Contribuye a mantener diferencias mínimas y controles confiables."
        }
      },
      {
        "key": "surtido-de-pedidos",
        "categoria": "Operación",
        "parametro": "Surtido de pedidos",
        "preguntaStar": "Cuéntame de un momento donde tuviste que surtir varios pedidos en poco tiempo. ¿Cómo te organizaste?",
        "anclas": {
          "inferior": "Comete errores o retrasa entregas.",
          "cumple": "Cumple tiempos y surtidos correctamente.",
          "supera": "Optimiza el proceso manteniendo velocidad y precisión."
        }
      },
      {
        "key": "orden-y-limpieza",
        "categoria": "Organización",
        "parametro": "Orden y limpieza",
        "preguntaStar": "Describe una situación donde encontraste un área desordenada o con riesgos. ¿Qué hiciste?",
        "anclas": {
          "inferior": "No toma iniciativa.",
          "cumple": "Mantiene orden conforme a instrucciones.",
          "supera": "Implementa mejoras y previene riesgos."
        }
      },
      {
        "key": "apego-a-procedimientos",
        "categoria": "Procesos",
        "parametro": "Apego a procedimientos",
        "preguntaStar": "Cuéntame una ocasión donde tuviste que seguir un procedimiento estricto.",
        "anclas": {
          "inferior": "Omite pasos o desconoce procedimientos.",
          "cumple": "Sigue los procesos establecidos.",
          "supera": "Promueve y asegura el cumplimiento de procesos."
        }
      },
      {
        "key": "trabajo-fisico",
        "categoria": "Resistencia",
        "parametro": "Trabajo físico",
        "preguntaStar": "Describe una jornada con alta carga de trabajo físico. ¿Cómo la manejaste?",
        "anclas": {
          "inferior": "Presenta limitaciones importantes.",
          "cumple": "Cumple con las actividades requeridas.",
          "supera": "Mantiene productividad constante durante toda la jornada."
        }
      },
      {
        "key": "trabajo-en-equipo",
        "categoria": "Colaboración",
        "parametro": "Trabajo en equipo",
        "preguntaStar": "Cuéntame de una ocasión en que ayudaste a un compañero para cumplir un objetivo.",
        "anclas": {
          "inferior": "Muestra poca disposición.",
          "cumple": "Colabora cuando es necesario.",
          "supera": "Contribuye activamente al logro del equipo."
        }
      },
      {
        "key": "cumplimiento-de-tareas",
        "categoria": "Responsabilidad",
        "parametro": "Cumplimiento de tareas",
        "preguntaStar": "Háblame de una tarea crítica que dependía de ti. ¿Cómo garantizaste que se cumpliera?",
        "anclas": {
          "inferior": "Requiere supervisión constante.",
          "cumple": "Cumple con sus responsabilidades.",
          "supera": "Anticipa necesidades y asegura resultados."
        }
      },
      {
        "key": "honestidad",
        "categoria": "Integridad",
        "parametro": "Honestidad",
        "preguntaStar": "Cuéntame una ocasión en que detectaste una diferencia de mercancía o producto. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Evita reportar incidencias.",
          "cumple": "Reporta las diferencias encontradas.",
          "supera": "Actúa con transparencia y propone soluciones."
        }
      },
      {
        "key": "atencion-al-detalle",
        "categoria": "Calidad",
        "parametro": "Atención al detalle",
        "preguntaStar": "Describe una ocasión donde detectaste un error antes de que generara un problema.",
        "anclas": {
          "inferior": "No identifica errores relevantes.",
          "cumple": "Detecta errores comunes.",
          "supera": "Identifica desviaciones críticas oportunamente."
        }
      },
      {
        "key": "manejo-de-incidencias",
        "categoria": "Solución de problemas",
        "parametro": "Manejo de incidencias",
        "preguntaStar": "Háblame de un problema operativo que hayas enfrentado en almacén. ¿Cómo lo resolviste?",
        "anclas": {
          "inferior": "No propone soluciones.",
          "cumple": "Resuelve situaciones habituales.",
          "supera": "Resuelve problemas complejos con eficacia."
        }
      },
      {
        "key": "cumplimiento-de-tiempos",
        "categoria": "Productividad",
        "parametro": "Cumplimiento de tiempos",
        "preguntaStar": "Cuéntame de una ocasión donde tuviste que terminar actividades urgentes.",
        "anclas": {
          "inferior": "No cumple tiempos.",
          "cumple": "Cumple los plazos establecidos.",
          "supera": "Supera expectativas manteniendo calidad."
        }
      },
      {
        "key": "prevencion-de-riesgos",
        "categoria": "Seguridad",
        "parametro": "Prevención de riesgos",
        "preguntaStar": "Describe una situación donde identificaste un riesgo de seguridad. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Ignora riesgos.",
          "cumple": "Sigue medidas básicas de seguridad.",
          "supera": "Previene accidentes y promueve buenas prácticas."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y sus motivos.",
        "anclas": {
          "inferior": "Cambios frecuentes sin justificación.",
          "cumple": "Explica razonablemente sus cambios.",
          "supera": "Muestra estabilidad y crecimiento sostenido."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Cuéntame de una experiencia similar a este puesto. ¿Qué fue lo más difícil y cómo lo manejaste?",
        "anclas": {
          "inferior": "Poca relación con el puesto.",
          "cumple": "Experiencia compatible.",
          "supera": "Amplia experiencia y adaptación comprobada."
        }
      }
    ],
    "preguntasCierre": [
      "¿Cuántas claves o productos manejabas aproximadamente?",
      "¿Participabas en inventarios cíclicos, mensuales o anuales?",
      "¿Cuál era el volumen de mercancía que movías diariamente?",
      "¿Has utilizado algún sistema de inventarios o ERP? ¿Cuál?",
      "¿Qué medidas tomas para evitar errores en surtido o conteo?",
      "¿Qué tendría que ofrecer una empresa para que permanezcas a largo plazo?",
      "¿Qué referencias podrían confirmar tu desempeño en almacén?"
    ]
  },
  "cajera": {
    "key": "cajera",
    "nombre": "CAJERA",
    "competencias": [
      {
        "key": "manejo-de-efectivo",
        "categoria": "Operación",
        "parametro": "Manejo de efectivo",
        "preguntaStar": "Cuéntame de una ocasión en la que tuviste que manejar cantidades importantes de efectivo. ¿Qué controles utilizabas y cuál fue el resultado?",
        "anclas": {
          "inferior": "Tiene poca experiencia o presenta inconsistencias en el manejo de efectivo.",
          "cumple": "Maneja efectivo siguiendo procedimientos establecidos.",
          "supera": "Demuestra control preciso del efectivo y cero incidencias relevantes."
        }
      },
      {
        "key": "exactitud-en-cobros-y-cortes",
        "categoria": "Control",
        "parametro": "Exactitud en cobros y cortes",
        "preguntaStar": "Háblame de una ocasión en la que detectaste una diferencia en caja o un error en un cobro. ¿Qué hiciste y cómo se resolvió?",
        "anclas": {
          "inferior": "No detecta errores o desconoce cómo actuar.",
          "cumple": "Identifica y corrige diferencias conforme al procedimiento.",
          "supera": "Detecta oportunamente errores y evita afectaciones económicas."
        }
      },
      {
        "key": "honestidad",
        "categoria": "Integridad",
        "parametro": "Honestidad",
        "preguntaStar": "Cuéntame una situación donde encontraste una diferencia de dinero o un error que te beneficiaba. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Evita asumir responsabilidad o reportar incidencias.",
          "cumple": "Reporta diferencias y sigue el proceso correspondiente.",
          "supera": "Actúa con total transparencia y protege los intereses de la empresa."
        }
      },
      {
        "key": "atencion-al-cliente",
        "categoria": "Servicio",
        "parametro": "Atención al cliente",
        "preguntaStar": "Describe una ocasión en la que atendiste a un cliente molesto o inconforme. ¿Cómo manejaste la situación?",
        "anclas": {
          "inferior": "Tiene dificultades para controlar conflictos con clientes.",
          "cumple": "Atiende adecuadamente las inconformidades.",
          "supera": "Convierte situaciones difíciles en experiencias positivas para el cliente."
        }
      },
      {
        "key": "orientacion-al-cliente",
        "categoria": "Servicio",
        "parametro": "Orientación al cliente",
        "preguntaStar": "Cuéntame de una ocasión en la que brindaste un servicio que superó las expectativas de un cliente.",
        "anclas": {
          "inferior": "Se limita a cumplir tareas básicas.",
          "cumple": "Brinda una atención adecuada y cordial.",
          "supera": "Genera experiencias positivas y fideliza clientes."
        }
      },
      {
        "key": "trabajo-bajo-presion",
        "categoria": "Adaptabilidad",
        "parametro": "Trabajo bajo presión",
        "preguntaStar": "Háblame de un momento donde había filas largas o alta demanda de clientes. ¿Cómo mantuviste la calidad en tu atención?",
        "anclas": {
          "inferior": "Se bloquea o disminuye significativamente su desempeño.",
          "cumple": "Mantiene un desempeño adecuado bajo presión.",
          "supera": "Conserva precisión y rapidez aun en momentos críticos."
        }
      },
      {
        "key": "atencion-al-detalle",
        "categoria": "Calidad",
        "parametro": "Atención al detalle",
        "preguntaStar": "Describe una ocasión donde detectaste un error antes de que generara un problema para un cliente o la empresa.",
        "anclas": {
          "inferior": "No identifica errores relevantes.",
          "cumple": "Detecta errores comunes y los corrige.",
          "supera": "Previene errores importantes mediante revisiones oportunas."
        }
      },
      {
        "key": "cumplimiento-de-tareas",
        "categoria": "Responsabilidad",
        "parametro": "Cumplimiento de tareas",
        "preguntaStar": "Háblame de una actividad importante que dependía de ti. ¿Cómo garantizaste que se realizara correctamente?",
        "anclas": {
          "inferior": "Requiere supervisión constante.",
          "cumple": "Cumple con las actividades asignadas.",
          "supera": "Demuestra autonomía y seguimiento efectivo."
        }
      },
      {
        "key": "apego-a-procedimientos",
        "categoria": "Procesos",
        "parametro": "Apego a procedimientos",
        "preguntaStar": "Cuéntame de una ocasión en la que tuviste que seguir un procedimiento estricto relacionado con caja o atención al cliente.",
        "anclas": {
          "inferior": "Omite pasos o desconoce procedimientos.",
          "cumple": "Sigue los procedimientos establecidos.",
          "supera": "Promueve y asegura el cumplimiento de los procesos."
        }
      },
      {
        "key": "manejo-de-conflictos",
        "categoria": "Solución de problemas",
        "parametro": "Manejo de conflictos",
        "preguntaStar": "Describe una situación donde un cliente discutió un precio, promoción o cobro. ¿Cómo la resolviste?",
        "anclas": {
          "inferior": "Escala innecesariamente los conflictos.",
          "cumple": "Resuelve situaciones comunes siguiendo lineamientos.",
          "supera": "Resuelve conflictos complejos preservando la satisfacción del cliente."
        }
      },
      {
        "key": "trabajo-en-equipo",
        "categoria": "Colaboración",
        "parametro": "Trabajo en equipo",
        "preguntaStar": "Cuéntame de una ocasión donde apoyaste a compañeros para cumplir un objetivo o resolver un problema operativo.",
        "anclas": {
          "inferior": "Muestra poca disposición para colaborar.",
          "cumple": "Coopera cuando se requiere.",
          "supera": "Contribuye activamente al logro de objetivos colectivos."
        }
      },
      {
        "key": "planeacion-y-organizacion",
        "categoria": "Organización",
        "parametro": "Planeación y organización",
        "preguntaStar": "Háblame de cómo organizabas tus actividades cuando debías atender clientes y realizar otras tareas simultáneamente.",
        "anclas": {
          "inferior": "Tiene dificultades para organizar prioridades.",
          "cumple": "Organiza adecuadamente sus actividades.",
          "supera": "Optimiza tiempos y mantiene productividad constante."
        }
      },
      {
        "key": "manejo-de-sistemas",
        "categoria": "Tecnología",
        "parametro": "Manejo de sistemas",
        "preguntaStar": "Cuéntame de una ocasión donde aprendiste a utilizar un sistema de punto de venta o software nuevo. ¿Cómo fue tu adaptación?",
        "anclas": {
          "inferior": "Presenta resistencia o dificultad para aprender sistemas.",
          "cumple": "Aprende y utiliza correctamente los sistemas.",
          "supera": "Se adapta rápidamente y aprovecha las herramientas tecnológicas."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y las razones que lo motivaron.",
        "anclas": {
          "inferior": "Presenta cambios frecuentes sin justificación clara.",
          "cumple": "Explica razonablemente sus cambios laborales.",
          "supera": "Muestra estabilidad y crecimiento profesional sostenido."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto requiere manejo de efectivo, cortes de caja, atención al cliente y apego a procesos. Cuéntame una experiencia similar y cómo te desempeñaste.",
        "anclas": {
          "inferior": "Tiene poca experiencia relacionada con el puesto.",
          "cumple": "Cuenta con experiencia compatible.",
          "supera": "Demuestra experiencia sólida y alta compatibilidad con el puesto."
        }
      }
    ],
    "preguntasCierre": [
      "¿Cuánto dinero llegabas a manejar aproximadamente durante tu turno?",
      "¿Realizabas cortes de caja? ¿Con qué frecuencia?",
      "¿Has trabajado con terminal bancaria, transferencias o vales?",
      "¿Qué sistema de punto de venta has utilizado?",
      "¿Qué haces cuando detectas una diferencia de dinero en caja?",
      "¿Qué tendría que ofrecer una empresa para que permanezcas a largo plazo?",
      "¿Qué referencias podrían confirmar tu desempeño y honestidad?"
    ]
  },
  "almacenista": {
    "key": "almacenista",
    "nombre": "ALMACENISTA",
    "competencias": [
      {
        "key": "recepcion-de-mercancia",
        "categoria": "Recepción",
        "parametro": "Recepción de mercancía",
        "preguntaStar": "Cuéntame de una ocasión en la que recibiste mercancía y detectaste diferencias contra la documentación. ¿Qué hiciste y cuál fue el resultado?",
        "anclas": {
          "inferior": "No detecta errores o desconoce el proceso.",
          "cumple": "Verifica mercancía y reporta diferencias.",
          "supera": "Detecta oportunamente incidencias y evita afectaciones al inventario."
        }
      },
      {
        "key": "control-de-inventarios",
        "categoria": "Inventarios",
        "parametro": "Control de inventarios",
        "preguntaStar": "Háblame de una ocasión en la que participaste en un inventario físico. ¿Cuál era tu responsabilidad y qué resultados obtuviste?",
        "anclas": {
          "inferior": "Presenta errores frecuentes en conteos.",
          "cumple": "Realiza conteos confiables y precisos.",
          "supera": "Mantiene diferencias mínimas y aporta mejoras al control."
        }
      },
      {
        "key": "acomodo-de-mercancia",
        "categoria": "Operación",
        "parametro": "Acomodo de mercancía",
        "preguntaStar": "Cuéntame cómo organizaste una recepción importante de mercancía para asegurar un acomodo eficiente.",
        "anclas": {
          "inferior": "Desorganiza espacios o genera retrasos.",
          "cumple": "Acomoda mercancía conforme a procedimientos.",
          "supera": "Optimiza espacios y facilita futuras operaciones."
        }
      },
      {
        "key": "surtido-de-pedidos",
        "categoria": "Operación",
        "parametro": "Surtido de pedidos",
        "preguntaStar": "Háblame de una ocasión donde tuviste que surtir pedidos urgentes. ¿Cómo priorizaste y cuál fue el resultado?",
        "anclas": {
          "inferior": "Comete errores o incumple tiempos.",
          "cumple": "Surte correctamente y dentro del tiempo esperado.",
          "supera": "Mantiene velocidad y precisión aun bajo presión."
        }
      },
      {
        "key": "exactitud-operativa",
        "categoria": "Calidad",
        "parametro": "Exactitud operativa",
        "preguntaStar": "Describe una ocasión donde detectaste un error en mercancía, ubicación o documentación antes de que generara un problema.",
        "anclas": {
          "inferior": "No detecta errores importantes.",
          "cumple": "Detecta y corrige errores comunes.",
          "supera": "Previene errores críticos y pérdidas para la empresa."
        }
      },
      {
        "key": "administracion-de-ubicaciones",
        "categoria": "Organización",
        "parametro": "Administración de ubicaciones",
        "preguntaStar": "Cuéntame de una ocasión donde tuviste que localizar mercancía de forma rápida para evitar retrasos.",
        "anclas": {
          "inferior": "Tiene dificultades para ubicar productos.",
          "cumple": "Conoce y utiliza correctamente las ubicaciones.",
          "supera": "Domina completamente la operación y agiliza procesos."
        }
      },
      {
        "key": "apego-a-procedimientos",
        "categoria": "Procesos",
        "parametro": "Apego a procedimientos",
        "preguntaStar": "Háblame de una ocasión donde tuviste que seguir procedimientos estrictos de almacén. ¿Cuál fue el resultado?",
        "anclas": {
          "inferior": "Omite pasos o incumple procesos.",
          "cumple": "Sigue correctamente los procedimientos establecidos.",
          "supera": "Garantiza el cumplimiento y promueve mejores prácticas."
        }
      },
      {
        "key": "cumplimiento-de-tareas",
        "categoria": "Responsabilidad",
        "parametro": "Cumplimiento de tareas",
        "preguntaStar": "Cuéntame de una actividad crítica que dependía completamente de ti. ¿Cómo garantizaste su cumplimiento?",
        "anclas": {
          "inferior": "Requiere supervisión constante.",
          "cumple": "Cumple con las actividades asignadas.",
          "supera": "Actúa con autonomía y seguimiento efectivo."
        }
      },
      {
        "key": "honestidad",
        "categoria": "Integridad",
        "parametro": "Honestidad",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste una diferencia de inventario, producto o documentación. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Omite reportar incidencias.",
          "cumple": "Reporta las diferencias oportunamente.",
          "supera": "Actúa con transparencia y busca soluciones."
        }
      },
      {
        "key": "cumplimiento-de-tiempos",
        "categoria": "Productividad",
        "parametro": "Cumplimiento de tiempos",
        "preguntaStar": "Háblame de una ocasión donde tuviste una carga extraordinaria de trabajo. ¿Cómo lograste cumplir los tiempos?",
        "anclas": {
          "inferior": "No cumple los tiempos establecidos.",
          "cumple": "Cumple las metas operativas.",
          "supera": "Supera objetivos manteniendo calidad."
        }
      },
      {
        "key": "trabajo-en-equipo",
        "categoria": "Colaboración",
        "parametro": "Trabajo en equipo",
        "preguntaStar": "Cuéntame de una ocasión donde colaboraste con otras áreas para resolver una necesidad operativa.",
        "anclas": {
          "inferior": "Muestra poca disposición para colaborar.",
          "cumple": "Coopera cuando es necesario.",
          "supera": "Contribuye activamente al logro de objetivos comunes."
        }
      },
      {
        "key": "manejo-de-incidencias",
        "categoria": "Solución de problemas",
        "parametro": "Manejo de incidencias",
        "preguntaStar": "Háblame de un problema operativo importante en almacén. ¿Qué hiciste para resolverlo?",
        "anclas": {
          "inferior": "Tiene dificultades para resolver problemas.",
          "cumple": "Resuelve incidencias habituales.",
          "supera": "Encuentra soluciones efectivas y evita recurrencias."
        }
      },
      {
        "key": "prevencion-de-riesgos",
        "categoria": "Seguridad",
        "parametro": "Prevención de riesgos",
        "preguntaStar": "Describe una situación donde identificaste un riesgo de seguridad dentro del almacén. ¿Qué acciones tomaste?",
        "anclas": {
          "inferior": "Ignora riesgos o incumple medidas de seguridad.",
          "cumple": "Sigue medidas básicas de seguridad.",
          "supera": "Previene accidentes y promueve buenas prácticas."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y qué aprendiste de esa experiencia.",
        "anclas": {
          "inferior": "Cambios frecuentes sin justificación clara.",
          "cumple": "Explica razonablemente sus movimientos laborales.",
          "supera": "Muestra estabilidad y crecimiento profesional sostenido."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto requiere recepción, acomodo, inventarios, surtido, control y trabajo físico. Cuéntame una experiencia similar y cómo te desempeñaste.",
        "anclas": {
          "inferior": "Tiene poca experiencia relacionada.",
          "cumple": "Cuenta con experiencia compatible.",
          "supera": "Demuestra experiencia sólida y adaptación comprobada."
        }
      }
    ],
    "preguntasCierre": [
      "¿Cuántas claves o SKU manejabas aproximadamente?",
      "¿Participabas en inventarios cíclicos, mensuales o anuales?",
      "¿Qué volumen de mercancía recibías o surtías diariamente?",
      "¿Has utilizado algún sistema ERP, WMS o software de inventarios? ¿Cuál?",
      "¿Cómo controlabas diferencias de inventario o productos faltantes?",
      "¿Qué indicadores utilizaban para medir tu desempeño?",
      "¿Qué tendría que ofrecer una empresa para que permanezcas a largo plazo?",
      "¿Qué referencias podrían validar tu desempeño en almacén?"
    ]
  },
  "surtidor": {
    "key": "surtidor",
    "nombre": "SURTIDOR",
    "competencias": [
      {
        "key": "surtido-de-pedidos",
        "categoria": "Operación",
        "parametro": "Surtido de pedidos",
        "preguntaStar": "Cuéntame de una ocasión en la que tuviste que surtir varios pedidos en poco tiempo. ¿Cómo te organizaste y cuál fue el resultado?",
        "anclas": {
          "inferior": "Comete errores frecuentes o incumple tiempos.",
          "cumple": "Surte correctamente la mayoría de los pedidos.",
          "supera": "Mantiene precisión y velocidad incluso en alta demanda."
        }
      },
      {
        "key": "exactitud-en-surtido",
        "categoria": "Calidad",
        "parametro": "Exactitud en surtido",
        "preguntaStar": "Háblame de una ocasión en la que detectaste un error en un pedido antes de entregarlo. ¿Qué hiciste?",
        "anclas": {
          "inferior": "No detecta errores o genera retrabajos frecuentes.",
          "cumple": "Detecta y corrige errores comunes.",
          "supera": "Previene errores críticos y asegura la calidad del surtido."
        }
      },
      {
        "key": "planeacion-de-actividades",
        "categoria": "Organización",
        "parametro": "Planeación de actividades",
        "preguntaStar": "Cuéntame cómo organizabas tus actividades cuando tenías varios pedidos pendientes al mismo tiempo.",
        "anclas": {
          "inferior": "Carece de método de organización.",
          "cumple": "Prioriza adecuadamente sus actividades.",
          "supera": "Optimiza tiempos y recursos para aumentar productividad."
        }
      },
      {
        "key": "ubicacion-de-mercancia",
        "categoria": "Inventarios",
        "parametro": "Ubicación de mercancía",
        "preguntaStar": "Háblame de una ocasión donde necesitabas localizar productos rápidamente dentro del almacén. ¿Cómo lo lograste?",
        "anclas": {
          "inferior": "Desconoce ubicaciones o pierde tiempo buscando productos.",
          "cumple": "Conoce y utiliza correctamente las ubicaciones.",
          "supera": "Domina completamente las ubicaciones y agiliza operaciones."
        }
      },
      {
        "key": "cumplimiento-de-tiempos",
        "categoria": "Productividad",
        "parametro": "Cumplimiento de tiempos",
        "preguntaStar": "Describe una ocasión donde tuviste que cumplir una meta de surtido o preparación de pedidos. ¿Qué hiciste para lograrlo?",
        "anclas": {
          "inferior": "No alcanza los objetivos establecidos.",
          "cumple": "Cumple las metas asignadas.",
          "supera": "Supera consistentemente los objetivos de productividad."
        }
      },
      {
        "key": "manejo-de-mercancia",
        "categoria": "Operación",
        "parametro": "Manejo de mercancía",
        "preguntaStar": "Cuéntame de una ocasión donde tuviste que manipular mercancía delicada o de alto valor. ¿Cómo evitaste daños?",
        "anclas": {
          "inferior": "Presenta descuidos frecuentes.",
          "cumple": "Maneja adecuadamente los productos.",
          "supera": "Mantiene estándares elevados de cuidado y conservación."
        }
      },
      {
        "key": "apego-a-procedimientos",
        "categoria": "Procesos",
        "parametro": "Apego a procedimientos",
        "preguntaStar": "Háblame de una ocasión donde tuviste que seguir un procedimiento específico para surtir pedidos.",
        "anclas": {
          "inferior": "Omite pasos o desconoce procedimientos.",
          "cumple": "Sigue correctamente los procedimientos establecidos.",
          "supera": "Garantiza el cumplimiento y promueve buenas prácticas."
        }
      },
      {
        "key": "cumplimiento-de-tareas",
        "categoria": "Responsabilidad",
        "parametro": "Cumplimiento de tareas",
        "preguntaStar": "Cuéntame de una tarea importante que dependía totalmente de ti. ¿Cómo garantizaste el resultado?",
        "anclas": {
          "inferior": "Requiere supervisión constante.",
          "cumple": "Cumple con sus responsabilidades.",
          "supera": "Actúa con autonomía y alto compromiso."
        }
      },
      {
        "key": "honestidad",
        "categoria": "Integridad",
        "parametro": "Honestidad",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste una diferencia de producto o inventario. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Omite reportar incidencias.",
          "cumple": "Reporta oportunamente las diferencias.",
          "supera": "Actúa con transparencia y propone soluciones."
        }
      },
      {
        "key": "prevencion-de-riesgos",
        "categoria": "Seguridad",
        "parametro": "Prevención de riesgos",
        "preguntaStar": "Describe una situación donde identificaste un riesgo de seguridad en almacén o piso de venta. ¿Qué acciones tomaste?",
        "anclas": {
          "inferior": "Ignora los riesgos identificados.",
          "cumple": "Sigue medidas básicas de seguridad.",
          "supera": "Previene accidentes y fomenta una cultura de seguridad."
        }
      },
      {
        "key": "trabajo-en-equipo",
        "categoria": "Colaboración",
        "parametro": "Trabajo en equipo",
        "preguntaStar": "Cuéntame de una ocasión donde ayudaste a un compañero para cumplir una meta o terminar un pedido urgente.",
        "anclas": {
          "inferior": "Muestra poca disposición para colaborar.",
          "cumple": "Coopera cuando es necesario.",
          "supera": "Contribuye activamente al éxito del equipo."
        }
      },
      {
        "key": "manejo-de-incidencias",
        "categoria": "Solución de problemas",
        "parametro": "Manejo de incidencias",
        "preguntaStar": "Háblame de un problema que afectó el surtido de pedidos. ¿Cómo lo resolviste?",
        "anclas": {
          "inferior": "Tiene dificultades para resolver problemas.",
          "cumple": "Resuelve incidencias comunes.",
          "supera": "Encuentra soluciones efectivas y evita recurrencias."
        }
      },
      {
        "key": "trabajo-bajo-presion",
        "categoria": "Adaptabilidad",
        "parametro": "Trabajo bajo presión",
        "preguntaStar": "Describe una ocasión donde hubo una carga extraordinaria de trabajo o pedidos urgentes. ¿Cómo respondiste?",
        "anclas": {
          "inferior": "Disminuye significativamente su desempeño.",
          "cumple": "Mantiene resultados aceptables bajo presión.",
          "supera": "Conserva precisión y productividad en situaciones exigentes."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y qué aprendiste de esa experiencia.",
        "anclas": {
          "inferior": "Cambios frecuentes sin justificación clara.",
          "cumple": "Explica razonablemente sus movimientos laborales.",
          "supera": "Muestra estabilidad y crecimiento profesional."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto requiere trabajo físico, rapidez, precisión y apego a procesos. Cuéntame una experiencia similar y cómo te desempeñaste.",
        "anclas": {
          "inferior": "Tiene poca experiencia relacionada.",
          "cumple": "Cuenta con experiencia compatible.",
          "supera": "Demuestra experiencia sólida y adaptación comprobada."
        }
      }
    ],
    "preguntasCierre": [
      "¿Cuántos pedidos surtías aproximadamente por día?",
      "¿Cuántas claves o productos manejabas en promedio?",
      "¿Participabas en inventarios físicos o conteos cíclicos?",
      "¿Qué hacías cuando faltaba mercancía para completar un pedido?",
      "¿Has utilizado escáneres, handhelds o sistemas de inventario?",
      "¿Qué medidas tomas para evitar errores en surtido?",
      "¿Qué tendría que ofrecer una empresa para que permanezcas a largo plazo?"
    ]
  },
  "chofer": {
    "key": "chofer",
    "nombre": "CHOFER",
    "competencias": [
      {
        "key": "conduccion-segura",
        "categoria": "Seguridad Vial",
        "parametro": "Conducción segura",
        "preguntaStar": "Cuéntame de una ocasión en la que enfrentaste una situación de riesgo mientras conducías. ¿Qué ocurrió, qué hiciste y cuál fue el resultado?",
        "anclas": {
          "inferior": "Toma decisiones riesgosas o carece de experiencia.",
          "cumple": "Actúa conforme a las normas de seguridad.",
          "supera": "Previene accidentes y toma decisiones acertadas bajo presión."
        }
      },
      {
        "key": "entrega-de-mercancia",
        "categoria": "Operación",
        "parametro": "Entrega de mercancía",
        "preguntaStar": "Háblame de una ocasión en la que tuviste que realizar varias entregas en un tiempo limitado. ¿Cómo te organizaste?",
        "anclas": {
          "inferior": "Presenta retrasos o incumplimientos frecuentes.",
          "cumple": "Cumple rutas y horarios establecidos.",
          "supera": "Optimiza recorridos y mejora la eficiencia de entrega."
        }
      },
      {
        "key": "organizacion-de-ruta",
        "categoria": "Planeación",
        "parametro": "Organización de ruta",
        "preguntaStar": "Cuéntame cómo organizabas tus rutas diarias para cumplir con todas las entregas programadas.",
        "anclas": {
          "inferior": "Carece de método de organización.",
          "cumple": "Planifica adecuadamente sus recorridos.",
          "supera": "Maximiza tiempos y recursos para aumentar productividad."
        }
      },
      {
        "key": "atencion-al-cliente",
        "categoria": "Servicio",
        "parametro": "Atención al cliente",
        "preguntaStar": "Describe una situación donde un cliente tuvo una inconformidad con una entrega. ¿Cómo la atendiste?",
        "anclas": {
          "inferior": "Genera conflictos o no resuelve adecuadamente.",
          "cumple": "Atiende correctamente las inconformidades.",
          "supera": "Resuelve situaciones difíciles manteniendo una relación positiva."
        }
      },
      {
        "key": "cuidado-de-la-unidad",
        "categoria": "Responsabilidad",
        "parametro": "Cuidado de la unidad",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste una falla mecánica o condición insegura en tu vehículo. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Ignora o retrasa el reporte de fallas.",
          "cumple": "Reporta oportunamente las incidencias.",
          "supera": "Previene daños mayores mediante revisiones y seguimiento."
        }
      },
      {
        "key": "manejo-de-documentacion",
        "categoria": "Control",
        "parametro": "Manejo de documentación",
        "preguntaStar": "Háblame de una ocasión donde tuviste que controlar facturas, remisiones o evidencias de entrega. ¿Cómo evitaste errores?",
        "anclas": {
          "inferior": "Presenta errores frecuentes en documentación.",
          "cumple": "Mantiene documentación correcta y completa.",
          "supera": "Garantiza control documental preciso y sin incidencias."
        }
      },
      {
        "key": "custodia-de-mercancia",
        "categoria": "Inventarios",
        "parametro": "Custodia de mercancía",
        "preguntaStar": "Cuéntame de una situación donde tuviste que proteger mercancía durante una ruta o entrega complicada.",
        "anclas": {
          "inferior": "Presenta descuidos o pérdidas.",
          "cumple": "Protege adecuadamente la mercancía asignada.",
          "supera": "Demuestra alto nivel de control y prevención de pérdidas."
        }
      },
      {
        "key": "honestidad",
        "categoria": "Integridad",
        "parametro": "Honestidad",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste una diferencia de producto, dinero o documentación. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Omite reportar incidencias.",
          "cumple": "Reporta diferencias conforme al procedimiento.",
          "supera": "Actúa con transparencia y propone soluciones inmediatas."
        }
      },
      {
        "key": "manejo-de-incidencias",
        "categoria": "Solución de problemas",
        "parametro": "Manejo de incidencias",
        "preguntaStar": "Háblame de un problema que afectó una entrega, ruta o servicio. ¿Cómo lo resolviste?",
        "anclas": {
          "inferior": "Tiene dificultades para resolver situaciones.",
          "cumple": "Resuelve incidencias habituales.",
          "supera": "Encuentra soluciones efectivas minimizando impactos."
        }
      },
      {
        "key": "trabajo-bajo-presion",
        "categoria": "Adaptabilidad",
        "parametro": "Trabajo bajo presión",
        "preguntaStar": "Describe una ocasión donde tuviste presión por tiempos de entrega, tráfico o carga de trabajo. ¿Cómo respondiste?",
        "anclas": {
          "inferior": "Disminuye significativamente su desempeño.",
          "cumple": "Mantiene resultados aceptables bajo presión.",
          "supera": "Conserva productividad y control en situaciones críticas."
        }
      },
      {
        "key": "trabajo-en-equipo",
        "categoria": "Colaboración",
        "parametro": "Trabajo en equipo",
        "preguntaStar": "Cuéntame de una ocasión donde apoyaste a compañeros de reparto, almacén o ventas para cumplir un objetivo.",
        "anclas": {
          "inferior": "Muestra poca disposición para colaborar.",
          "cumple": "Coopera cuando se requiere.",
          "supera": "Contribuye activamente al logro de objetivos colectivos."
        }
      },
      {
        "key": "cumplimiento-de-entregas",
        "categoria": "Productividad",
        "parametro": "Cumplimiento de entregas",
        "preguntaStar": "Háblame de una ocasión donde superaste una meta de entregas o recorridos. ¿Qué hiciste para lograrlo?",
        "anclas": {
          "inferior": "No cumple los objetivos establecidos.",
          "cumple": "Cumple los objetivos asignados.",
          "supera": "Supera consistentemente las metas operativas."
        }
      },
      {
        "key": "prevencion-de-riesgos",
        "categoria": "Seguridad",
        "parametro": "Prevención de riesgos",
        "preguntaStar": "Cuéntame de una ocasión donde identificaste un riesgo en ruta, carga o descarga. ¿Qué acciones tomaste?",
        "anclas": {
          "inferior": "Ignora riesgos o actúa incorrectamente.",
          "cumple": "Sigue medidas básicas de seguridad.",
          "supera": "Previene accidentes y promueve prácticas seguras."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y qué aprendiste de esa experiencia.",
        "anclas": {
          "inferior": "Cambios frecuentes sin justificación clara.",
          "cumple": "Explica razonablemente sus cambios laborales.",
          "supera": "Muestra estabilidad y crecimiento profesional sostenido."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto requiere conducción segura, entregas, manejo de mercancía, atención al cliente y cumplimiento de rutas. Cuéntame una experiencia similar y cómo te desempeñaste.",
        "anclas": {
          "inferior": "Tiene poca experiencia relacionada.",
          "cumple": "Cuenta con experiencia compatible.",
          "supera": "Demuestra experiencia sólida y alta compatibilidad con el puesto."
        }
      }
    ],
    "preguntasCierre": [
      "¿Qué tipo de unidades has manejado y por cuánto tiempo?",
      "¿Cuál fue la ruta más extensa o compleja que realizabas regularmente?",
      "¿Cuántas entregas realizabas aproximadamente por día?",
      "¿Has tenido accidentes o incidentes viales? ¿Cuál fue la situación?",
      "¿Cómo realizabas la revisión diaria de la unidad?",
      "¿Has manejado mercancía de alto valor o productos delicados?",
      "¿Qué tendría que ofrecer una empresa para que permanezcas a largo plazo?",
      "¿Qué referencias podrían confirmar tu desempeño como operador?"
    ]
  },
  "repartidor": {
    "key": "repartidor",
    "nombre": "REPARTIDOR",
    "competencias": [
      {
        "key": "atencion-al-cliente",
        "categoria": "Servicio",
        "parametro": "Atención al cliente",
        "preguntaStar": "Cuéntame de una ocasión en la que un cliente tuvo una inconformidad con una entrega. ¿Qué ocurrió, qué hiciste y cuál fue el resultado?",
        "anclas": {
          "inferior": "Tiene dificultades para manejar inconformidades.",
          "cumple": "Atiende adecuadamente las situaciones con clientes.",
          "supera": "Resuelve conflictos generando confianza y satisfacción."
        }
      },
      {
        "key": "entrega-de-pedidos",
        "categoria": "Operación",
        "parametro": "Entrega de pedidos",
        "preguntaStar": "Háblame de una ocasión donde tuviste que cumplir múltiples entregas en un tiempo limitado. ¿Cómo te organizaste?",
        "anclas": {
          "inferior": "Presenta retrasos frecuentes o incumplimientos.",
          "cumple": "Cumple con los tiempos de entrega establecidos.",
          "supera": "Optimiza recorridos y mejora la eficiencia operativa."
        }
      },
      {
        "key": "organizacion-de-ruta",
        "categoria": "Planeación",
        "parametro": "Organización de ruta",
        "preguntaStar": "Cuéntame cómo planificabas tu ruta diaria para cumplir con todas las entregas programadas.",
        "anclas": {
          "inferior": "Carece de método de organización.",
          "cumple": "Organiza adecuadamente sus recorridos.",
          "supera": "Maximiza cobertura y reduce tiempos muertos."
        }
      },
      {
        "key": "manejo-y-cuidado-de-mercancia",
        "categoria": "Responsabilidad",
        "parametro": "Manejo y cuidado de mercancía",
        "preguntaStar": "Describe una ocasión donde tuviste que transportar mercancía delicada o de alto valor. ¿Qué hiciste para protegerla?",
        "anclas": {
          "inferior": "Presenta descuidos o daños frecuentes.",
          "cumple": "Protege adecuadamente la mercancía asignada.",
          "supera": "Implementa medidas preventivas que reducen incidencias."
        }
      },
      {
        "key": "conduccion-segura",
        "categoria": "Seguridad Vial",
        "parametro": "Conducción segura",
        "preguntaStar": "Cuéntame de una situación de riesgo o emergencia que enfrentaste durante una ruta. ¿Cómo actuaste?",
        "anclas": {
          "inferior": "Toma decisiones riesgosas o inseguras.",
          "cumple": "Actúa conforme a protocolos de seguridad.",
          "supera": "Previene accidentes y demuestra excelente criterio."
        }
      },
      {
        "key": "carga-y-descarga-de-mercancia",
        "categoria": "Operación",
        "parametro": "Carga y descarga de mercancía",
        "preguntaStar": "Cuéntame de una ocasión donde tuviste que cargar, descargar o acomodar mercancía bajo presión de tiempo o volumen. ¿Cómo te organizaste y cuál fue el resultado?",
        "anclas": {
          "inferior": "Presenta dificultades para realizar actividades físicas o genera daños en mercancía.",
          "cumple": "Realiza correctamente la carga y descarga siguiendo procedimientos.",
          "supera": "Mantiene productividad, orden y cuidado de la mercancía aun en cargas elevadas."
        }
      },
      {
        "key": "manejo-de-documentacion",
        "categoria": "Control",
        "parametro": "Manejo de documentación",
        "preguntaStar": "Háblame de una ocasión donde tuviste que controlar facturas, remisiones o evidencias de entrega. ¿Cómo evitaste errores?",
        "anclas": {
          "inferior": "Presenta errores frecuentes en documentación.",
          "cumple": "Mantiene documentación correcta y completa.",
          "supera": "Garantiza control documental preciso y ordenado."
        }
      },
      {
        "key": "honestidad",
        "categoria": "Integridad",
        "parametro": "Honestidad",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste una diferencia de producto o documentación. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Omite reportar incidencias.",
          "cumple": "Reporta diferencias conforme al procedimiento.",
          "supera": "Actúa con transparencia y propone soluciones."
        }
      },
      {
        "key": "manejo-de-incidencias",
        "categoria": "Solución de Problemas",
        "parametro": "Manejo de incidencias",
        "preguntaStar": "Cuéntame de un problema que afectó una entrega (tráfico, cliente ausente, error de pedido, etc.). ¿Cómo lo resolviste?",
        "anclas": {
          "inferior": "Tiene dificultades para resolver problemas.",
          "cumple": "Resuelve incidencias habituales.",
          "supera": "Encuentra soluciones rápidas minimizando afectaciones."
        }
      },
      {
        "key": "trabajo-bajo-presion",
        "categoria": "Adaptabilidad",
        "parametro": "Trabajo bajo presión",
        "preguntaStar": "Describe una ocasión donde tuviste alta carga de trabajo o presión por tiempos de entrega. ¿Cómo respondiste?",
        "anclas": {
          "inferior": "Disminuye significativamente su desempeño.",
          "cumple": "Mantiene resultados aceptables bajo presión.",
          "supera": "Conserva productividad y calidad en situaciones exigentes."
        }
      },
      {
        "key": "trabajo-en-equipo",
        "categoria": "Colaboración",
        "parametro": "Trabajo en equipo",
        "preguntaStar": "Cuéntame de una ocasión donde colaboraste con almacén, ventas o administración para resolver una situación urgente.",
        "anclas": {
          "inferior": "Muestra poca disposición para colaborar.",
          "cumple": "Coopera cuando es necesario.",
          "supera": "Contribuye activamente al logro de objetivos comunes."
        }
      },
      {
        "key": "cumplimiento-de-objetivos",
        "categoria": "Productividad",
        "parametro": "Cumplimiento de objetivos",
        "preguntaStar": "Háblame de una ocasión donde superaste una meta de entregas o cobertura. ¿Qué hiciste para lograrlo?",
        "anclas": {
          "inferior": "No cumple los objetivos establecidos.",
          "cumple": "Cumple con los objetivos asignados.",
          "supera": "Supera consistentemente las metas operativas."
        }
      },
      {
        "key": "cuidado-de-la-unidad",
        "categoria": "Responsabilidad",
        "parametro": "Cuidado de la unidad",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste una falla o desperfecto en tu unidad. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Ignora o retrasa reportes importantes.",
          "cumple": "Reporta oportunamente las incidencias.",
          "supera": "Previene daños mayores mediante seguimiento adecuado."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y qué aprendiste de esa experiencia.",
        "anclas": {
          "inferior": "Cambios frecuentes sin justificación clara.",
          "cumple": "Explica razonablemente sus movimientos laborales.",
          "supera": "Muestra estabilidad y crecimiento profesional sostenido."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto requiere manejo de mercancía, trabajo físico, entregas en ruta, servicio al cliente y cumplimiento de horarios. Cuéntame una experiencia similar y cómo te desempeñaste.",
        "anclas": {
          "inferior": "Tiene poca experiencia relacionada.",
          "cumple": "Cuenta con experiencia compatible.",
          "supera": "Demuestra experiencia sólida y alta compatibilidad con el puesto."
        }
      }
    ],
    "preguntasCierre": [
      "¿Qué tipo de unidades has manejado y por cuánto tiempo?",
      "¿Cuántas entregas realizabas aproximadamente por día?",
      "¿Has tenido accidentes o incidentes viales? ¿Cuál fue la situación?",
      "¿Cómo realizabas la revisión diaria de la unidad antes de salir a ruta?",
      "¿Has manejado mercancía de alto valor o productos delicados?",
      "¿Cómo verificabas que los pedidos cargados coincidieran con la documentación de entrega?",
      "Este puesto requiere carga, descarga y acomodo de mercancía durante la ruta. ¿Tienes alguna limitación física, condición de salud o situación personal que pudiera dificultarte realizar estas actividades de forma constante?"
    ]
  },
  "anaquelista": {
    "key": "anaquelista",
    "nombre": "ANAQUELISTA",
    "competencias": [
      {
        "key": "acomodo-de-mercancia",
        "categoria": "Operación",
        "parametro": "Acomodo de mercancía",
        "preguntaStar": "Cuéntame de una ocasión en la que tuviste que acomodar una gran cantidad de mercancía en piso de venta. ¿Cómo te organizaste y cuál fue el resultado?",
        "anclas": {
          "inferior": "Presenta desorden o acomodo incorrecto.",
          "cumple": "Mantiene el acomodo conforme a lineamientos.",
          "supera": "Optimiza espacios y mejora la exhibición del producto."
        }
      },
      {
        "key": "frenteo-y-presentacion",
        "categoria": "Exhibición",
        "parametro": "Frenteo y presentación",
        "preguntaStar": "Háblame de una ocasión donde mejoraste la presentación de un área o exhibición. ¿Qué hiciste y qué resultado obtuviste?",
        "anclas": {
          "inferior": "No presta atención a la imagen de exhibición.",
          "cumple": "Mantiene exhibiciones ordenadas y presentables.",
          "supera": "Genera exhibiciones atractivas que favorecen la venta."
        }
      },
      {
        "key": "control-de-existencias",
        "categoria": "Inventarios",
        "parametro": "Control de existencias",
        "preguntaStar": "Cuéntame de una ocasión en la que detectaste faltantes o diferencias de mercancía en anaquel. ¿Qué hiciste?",
        "anclas": {
          "inferior": "No detecta diferencias o no actúa.",
          "cumple": "Reporta y corrige incidencias básicas.",
          "supera": "Detecta oportunamente desviaciones y evita quiebres de stock."
        }
      },
      {
        "key": "resurtido-de-anaqueles",
        "categoria": "Operación",
        "parametro": "Resurtido de anaqueles",
        "preguntaStar": "Describe una situación donde tuviste que mantener abastecido un anaquel durante un periodo de alta demanda.",
        "anclas": {
          "inferior": "Permite faltantes frecuentes.",
          "cumple": "Mantiene niveles adecuados de surtido.",
          "supera": "Anticipa necesidades y evita agotados."
        }
      },
      {
        "key": "atencion-al-detalle",
        "categoria": "Calidad",
        "parametro": "Atención al detalle",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste un error en precios, etiquetas o acomodo antes de que causara un problema.",
        "anclas": {
          "inferior": "No identifica errores importantes.",
          "cumple": "Detecta errores comunes.",
          "supera": "Identifica desviaciones críticas y actúa oportunamente."
        }
      },
      {
        "key": "planeacion-de-actividades",
        "categoria": "Organización",
        "parametro": "Planeación de actividades",
        "preguntaStar": "Háblame de cómo organizabas tus actividades cuando tenías varias áreas o pasillos asignados.",
        "anclas": {
          "inferior": "Carece de método de organización.",
          "cumple": "Administra adecuadamente sus tareas.",
          "supera": "Optimiza tiempos y mantiene altos niveles de productividad."
        }
      },
      {
        "key": "atencion-al-cliente",
        "categoria": "Servicio",
        "parametro": "Atención al cliente",
        "preguntaStar": "Describe una ocasión en la que un cliente te pidió ayuda para localizar un producto. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Muestra poca disposición para ayudar.",
          "cumple": "Brinda apoyo adecuado al cliente.",
          "supera": "Ofrece atención proactiva y genera una experiencia positiva."
        }
      },
      {
        "key": "cumplimiento-de-tareas",
        "categoria": "Responsabilidad",
        "parametro": "Cumplimiento de tareas",
        "preguntaStar": "Cuéntame de una tarea importante que dependía de ti. ¿Cómo garantizaste que se realizara correctamente?",
        "anclas": {
          "inferior": "Requiere supervisión constante.",
          "cumple": "Cumple con las actividades asignadas.",
          "supera": "Demuestra autonomía y seguimiento efectivo."
        }
      },
      {
        "key": "apego-a-procedimientos",
        "categoria": "Procesos",
        "parametro": "Apego a procedimientos",
        "preguntaStar": "Háblame de una ocasión donde tuviste que seguir procedimientos relacionados con acomodo, exhibición o inventario.",
        "anclas": {
          "inferior": "Omite pasos o incumple procedimientos.",
          "cumple": "Sigue correctamente los procesos establecidos.",
          "supera": "Promueve el cumplimiento y las mejores prácticas."
        }
      },
      {
        "key": "cumplimiento-de-tiempos",
        "categoria": "Productividad",
        "parametro": "Cumplimiento de tiempos",
        "preguntaStar": "Cuéntame de una ocasión donde tuviste que terminar una actividad urgente en piso de venta. ¿Cómo lo lograste?",
        "anclas": {
          "inferior": "No cumple tiempos establecidos.",
          "cumple": "Cumple con los tiempos requeridos.",
          "supera": "Supera expectativas manteniendo calidad."
        }
      },
      {
        "key": "trabajo-en-equipo",
        "categoria": "Colaboración",
        "parametro": "Trabajo en equipo",
        "preguntaStar": "Cuéntame de una ocasión donde ayudaste a un compañero o a otra área para cumplir un objetivo.",
        "anclas": {
          "inferior": "Muestra poca disposición para colaborar.",
          "cumple": "Coopera cuando se requiere.",
          "supera": "Contribuye activamente al logro de objetivos comunes."
        }
      },
      {
        "key": "manejo-de-incidencias",
        "categoria": "Solución de problemas",
        "parametro": "Manejo de incidencias",
        "preguntaStar": "Háblame de un problema que afectó el acomodo, exhibición o disponibilidad de mercancía. ¿Cómo lo resolviste?",
        "anclas": {
          "inferior": "Tiene dificultades para resolver incidencias.",
          "cumple": "Resuelve problemas habituales.",
          "supera": "Encuentra soluciones efectivas y evita recurrencias."
        }
      },
      {
        "key": "trabajo-bajo-presion",
        "categoria": "Adaptabilidad",
        "parametro": "Trabajo bajo presión",
        "preguntaStar": "Describe una ocasión donde hubo mucho trabajo por promociones, temporadas altas o cambios de exhibición. ¿Cómo respondiste?",
        "anclas": {
          "inferior": "Disminuye su desempeño bajo presión.",
          "cumple": "Mantiene resultados aceptables.",
          "supera": "Conserva productividad y calidad en situaciones exigentes."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y qué aprendiste de esa experiencia.",
        "anclas": {
          "inferior": "Cambios frecuentes sin justificación clara.",
          "cumple": "Explica razonablemente sus movimientos laborales.",
          "supera": "Muestra estabilidad y crecimiento profesional."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto requiere acomodo, exhibición, resurtido, atención al cliente y trabajo físico. Cuéntame una experiencia similar y cómo te desempeñaste.",
        "anclas": {
          "inferior": "Tiene poca experiencia relacionada.",
          "cumple": "Cuenta con experiencia compatible.",
          "supera": "Demuestra experiencia sólida y adaptación comprobada."
        }
      }
    ],
    "preguntasCierre": [
      "¿Cuántas líneas o categorías de productos tenías asignadas?",
      "¿Cómo controlabas los productos agotados o faltantes en anaquel?",
      "¿Participabas en cambios de planograma o exhibiciones especiales?",
      "¿Qué hacías cuando encontrabas mercancía dañada o mal etiquetada?",
      "¿Con qué frecuencia realizabas resurtidos durante el día?",
      "¿Qué indicadores utilizaban para medir tu desempeño?",
      "¿Qué tendría que ofrecer una empresa para que permanezcas a largo plazo?"
    ]
  },
  "empaque": {
    "key": "empaque",
    "nombre": "EMPAQUE",
    "competencias": [
      {
        "key": "pesado-de-productos",
        "categoria": "Operación",
        "parametro": "Pesado de productos",
        "preguntaStar": "Cuéntame de una ocasión en la que tuviste que pesar productos con precisión utilizando una báscula. ¿Cómo aseguraste que el peso fuera correcto?",
        "anclas": {
          "inferior": "Comete errores frecuentes en el pesado o desconoce el uso de básculas.",
          "cumple": "Pesa correctamente los productos siguiendo el procedimiento.",
          "supera": "Mantiene alta precisión y evita diferencias en el peso de los productos."
        }
      },
      {
        "key": "empaque-de-productos",
        "categoria": "Calidad",
        "parametro": "Empaque de productos",
        "preguntaStar": "Háblame de una ocasión donde tuviste que empacar grandes volúmenes de producto. ¿Cómo mantuviste la calidad y presentación?",
        "anclas": {
          "inferior": "Empaques deficientes o con errores frecuentes.",
          "cumple": "Mantiene una presentación adecuada del producto.",
          "supera": "Logra rapidez sin sacrificar calidad ni presentación."
        }
      },
      {
        "key": "revision-de-caducidades",
        "categoria": "Calidad",
        "parametro": "Revisión de caducidades",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste un producto próximo a vencer o caducado. ¿Qué hiciste?",
        "anclas": {
          "inferior": "No revisa fechas o pasa por alto productos caducos.",
          "cumple": "Revisa y reporta oportunamente las caducidades.",
          "supera": "Previene pérdidas mediante una revisión minuciosa y acciones inmediatas."
        }
      },
      {
        "key": "etiquetado-de-productos",
        "categoria": "Procesos",
        "parametro": "Etiquetado de productos",
        "preguntaStar": "Háblame de una ocasión donde tuviste que colocar etiquetas de entrada y salida en un producto. ¿Cómo verificaste que la información fuera correcta?",
        "anclas": {
          "inferior": "Coloca etiquetas incorrectas o incompletas.",
          "cumple": "Etiqueta correctamente conforme al procedimiento.",
          "supera": "Garantiza total precisión y evita errores de identificación."
        }
      },
      {
        "key": "manejo-de-basculas-digitales",
        "categoria": "Tecnología",
        "parametro": "Manejo de básculas digitales",
        "preguntaStar": "Cuéntame sobre tu experiencia utilizando básculas digitales. ¿Qué hacías cuando detectabas una variación en el peso?",
        "anclas": {
          "inferior": "Tiene poca experiencia o uso incorrecto del equipo.",
          "cumple": "Maneja correctamente las básculas digitales.",
          "supera": "Domina el equipo y detecta desviaciones oportunamente."
        }
      },
      {
        "key": "planeacion-del-trabajo",
        "categoria": "Organización",
        "parametro": "Planeación del trabajo",
        "preguntaStar": "Describe una ocasión donde tuviste varios pedidos o productos por empacar al mismo tiempo. ¿Cómo organizaste tu trabajo?",
        "anclas": {
          "inferior": "Se desorganiza y retrasa la operación.",
          "cumple": "Organiza adecuadamente sus actividades.",
          "supera": "Prioriza eficientemente y mantiene alta productividad."
        }
      },
      {
        "key": "cumplimiento-de-metas",
        "categoria": "Productividad",
        "parametro": "Cumplimiento de metas",
        "preguntaStar": "Háblame de una ocasión donde tuviste que cumplir una meta de producción o empaque. ¿Cómo lo lograste?",
        "anclas": {
          "inferior": "No alcanza las metas establecidas.",
          "cumple": "Cumple con los objetivos asignados.",
          "supera": "Supera consistentemente las metas de producción."
        }
      },
      {
        "key": "precision",
        "categoria": "Atención al detalle",
        "parametro": "Precisión",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste un error antes de que el producto fuera enviado al cliente o a piso de venta.",
        "anclas": {
          "inferior": "No detecta errores importantes.",
          "cumple": "Identifica y corrige errores comunes.",
          "supera": "Detecta oportunamente errores críticos evitando pérdidas."
        }
      },
      {
        "key": "cumplimiento-de-procedimientos",
        "categoria": "Responsabilidad",
        "parametro": "Cumplimiento de procedimientos",
        "preguntaStar": "Háblame de una ocasión donde tuviste que seguir un procedimiento muy específico para evitar errores.",
        "anclas": {
          "inferior": "Omite pasos importantes.",
          "cumple": "Sigue correctamente los procedimientos establecidos.",
          "supera": "Garantiza el cumplimiento y promueve buenas prácticas."
        }
      },
      {
        "key": "limpieza-del-area",
        "categoria": "Orden",
        "parametro": "Limpieza del área",
        "preguntaStar": "Cuéntame de una ocasión donde tuviste que mantener limpia y ordenada tu área de trabajo durante una jornada de alta producción.",
        "anclas": {
          "inferior": "Descuidaba el orden y la limpieza.",
          "cumple": "Mantiene el área limpia y organizada.",
          "supera": "Promueve el orden y mejora la eficiencia del área."
        }
      },
      {
        "key": "trabajo-en-equipo",
        "categoria": "Colaboración",
        "parametro": "Trabajo en equipo",
        "preguntaStar": "Háblame de una ocasión donde apoyaste a un compañero para cumplir una meta de producción.",
        "anclas": {
          "inferior": "Muestra poca disposición para colaborar.",
          "cumple": "Coopera cuando es necesario.",
          "supera": "Contribuye activamente al logro de objetivos del equipo."
        }
      },
      {
        "key": "manejo-de-incidencias",
        "categoria": "Solución de problemas",
        "parametro": "Manejo de incidencias",
        "preguntaStar": "Cuéntame de un problema que surgió durante el proceso de empaque. ¿Cómo lo resolviste?",
        "anclas": {
          "inferior": "Tiene dificultades para resolver problemas.",
          "cumple": "Resuelve incidencias comunes.",
          "supera": "Encuentra soluciones rápidas evitando afectar la producción."
        }
      },
      {
        "key": "trabajo-bajo-presion",
        "categoria": "Adaptabilidad",
        "parametro": "Trabajo bajo presión",
        "preguntaStar": "Describe una ocasión donde hubo una carga extraordinaria de trabajo o pedidos urgentes. ¿Cómo respondiste?",
        "anclas": {
          "inferior": "Disminuye su desempeño bajo presión.",
          "cumple": "Mantiene resultados aceptables.",
          "supera": "Conserva productividad y calidad aun en alta demanda."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y qué aprendiste de esa experiencia.",
        "anclas": {
          "inferior": "Cambios frecuentes sin justificación clara.",
          "cumple": "Explica razonablemente sus cambios laborales.",
          "supera": "Muestra estabilidad y crecimiento profesional."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto requiere pesar productos, empacarlos, revisar caducidades, etiquetar correctamente y mantener un alto nivel de precisión. Cuéntame una experiencia similar y cómo te desempeñaste.",
        "anclas": {
          "inferior": "Tiene poca experiencia relacionada.",
          "cumple": "Cuenta con experiencia compatible.",
          "supera": "Demuestra experiencia sólida y alta compatibilidad con el puesto."
        }
      }
    ],
    "preguntasCierre": [
      "¿Qué tipo de productos has pesado o empacado anteriormente?",
      "¿Has utilizado básculas digitales? ¿Qué tipo de básculas conoces?",
      "¿Cómo verificabas que el peso y la etiqueta coincidieran antes de liberar un producto?",
      "¿Qué hacías cuando detectabas un producto con fecha de caducidad próxima o vencida?",
      "¿Cómo evitabas confundir etiquetas de entrada y salida durante el proceso de empaque?",
      "Este puesto requiere permanecer de pie durante la mayor parte de la jornada y realizar movimientos repetitivos. ¿Tienes alguna limitación física, condición de salud o situación personal que pudiera dificultarte realizar estas actividades?"
    ]
  },
  "analista-de-abasto-de-mercancia": {
    "key": "analista-de-abasto-de-mercancia",
    "nombre": "ANALISTA DE ABASTO DE MERCANCIA",
    "competencias": [
      {
        "key": "control-de-inventario",
        "categoria": "Inventarios",
        "parametro": "Control de inventario",
        "preguntaStar": "Cuéntame de una ocasión donde tuviste que controlar inventarios de múltiples productos. ¿Qué indicadores utilizaste y cuál fue el resultado?",
        "anclas": {
          "inferior": "No demuestra experiencia en control de inventarios.",
          "cumple": "Mantiene niveles adecuados mediante controles básicos.",
          "supera": "Optimiza inventarios utilizando indicadores y análisis de datos."
        }
      },
      {
        "key": "analisis-de-demanda",
        "categoria": "Planeación",
        "parametro": "Análisis de demanda",
        "preguntaStar": "Háblame de una ocasión donde analizaste el comportamiento de ventas para anticipar necesidades de compra. ¿Qué hiciste y qué resultados obtuviste?",
        "anclas": {
          "inferior": "Toma decisiones sin análisis previo.",
          "cumple": "Analiza tendencias y realiza estimaciones adecuadas.",
          "supera": "Desarrolla pronósticos precisos que mejoran la disponibilidad y reducen sobreinventarios."
        }
      },
      {
        "key": "gestion-de-pedidos",
        "categoria": "Abastecimiento",
        "parametro": "Gestión de pedidos",
        "preguntaStar": "Cuéntame de una ocasión donde tuviste que generar pedidos de compra. ¿Cómo determinaste las cantidades y qué resultado obtuviste?",
        "anclas": {
          "inferior": "Genera pedidos sin criterio técnico.",
          "cumple": "Realiza pedidos con base en necesidades identificadas.",
          "supera": "Optimiza cantidades reduciendo faltantes y exceso de inventario."
        }
      },
      {
        "key": "ordenes-de-compra",
        "categoria": "Compras",
        "parametro": "Órdenes de compra",
        "preguntaStar": "Háblame de una ocasión donde elaboraste órdenes de compra y surgió algún inconveniente. ¿Cómo lo resolviste?",
        "anclas": {
          "inferior": "Presenta errores frecuentes en órdenes de compra.",
          "cumple": "Elabora órdenes correctamente.",
          "supera": "Garantiza precisión y seguimiento hasta la entrega."
        }
      },
      {
        "key": "coordinacion-con-proveedores",
        "categoria": "Proveedores",
        "parametro": "Coordinación con proveedores",
        "preguntaStar": "Describe una ocasión donde un proveedor incumplió una entrega o presentó problemas de calidad. ¿Qué acciones tomaste?",
        "anclas": {
          "inferior": "No logra gestionar la situación.",
          "cumple": "Da seguimiento hasta resolver la incidencia.",
          "supera": "Negocia soluciones efectivas minimizando el impacto operativo."
        }
      },
      {
        "key": "revision-de-mercancia",
        "categoria": "Calidad",
        "parametro": "Revisión de mercancía",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste mercancía fuera de especificación o con problemas de calidad. ¿Qué hiciste?",
        "anclas": {
          "inferior": "No detecta desviaciones importantes.",
          "cumple": "Identifica y reporta incidencias.",
          "supera": "Previene pérdidas mediante acciones oportunas y seguimiento."
        }
      },
      {
        "key": "rotacion-y-caducidades",
        "categoria": "Análisis",
        "parametro": "Rotación y caducidades",
        "preguntaStar": "Háblame de una ocasión donde identificaste productos de baja rotación o riesgo de caducidad. ¿Qué estrategia implementaste?",
        "anclas": {
          "inferior": "No identifica riesgos de inventario.",
          "cumple": "Detecta productos críticos y propone acciones básicas.",
          "supera": "Implementa estrategias que reducen pérdidas y mejoran la rotación."
        }
      },
      {
        "key": "elaboracion-de-reportes",
        "categoria": "Reportes",
        "parametro": "Elaboración de reportes",
        "preguntaStar": "Cuéntame de un reporte que desarrollaste para apoyar la toma de decisiones. ¿Qué información incluía y qué resultado generó?",
        "anclas": {
          "inferior": "Presenta reportes incompletos o poco útiles.",
          "cumple": "Elabora reportes claros y oportunos.",
          "supera": "Desarrolla reportes analíticos que facilitan la toma de decisiones."
        }
      },
      {
        "key": "recepcion-y-validacion-de-facturas",
        "categoria": "Control Administrativo",
        "parametro": "Recepción y validación de facturas",
        "preguntaStar": "Háblame de una ocasión donde encontraste diferencias entre una factura y la mercancía recibida. ¿Cómo procediste?",
        "anclas": {
          "inferior": "No detecta inconsistencias.",
          "cumple": "Identifica y reporta diferencias correctamente.",
          "supera": "Resuelve oportunamente evitando afectaciones administrativas."
        }
      },
      {
        "key": "captura-en-erp",
        "categoria": "Sistemas",
        "parametro": "Captura en ERP",
        "preguntaStar": "Cuéntame de tu experiencia registrando entradas de mercancía o capturando facturas en sistemas ERP (Kepler, Remoto, SAP, Oracle u otro).",
        "anclas": {
          "inferior": "Tiene poca experiencia en sistemas.",
          "cumple": "Maneja correctamente sistemas administrativos.",
          "supera": "Domina múltiples sistemas y reduce errores de captura."
        }
      },
      {
        "key": "revision-de-costos",
        "categoria": "Análisis Financiero",
        "parametro": "Revisión de costos",
        "preguntaStar": "Describe una ocasión donde detectaste una variación importante en costos de compra. ¿Qué análisis realizaste?",
        "anclas": {
          "inferior": "No identifica variaciones relevantes.",
          "cumple": "Detecta diferencias y las reporta.",
          "supera": "Analiza impactos y propone alternativas para optimizar costos."
        }
      },
      {
        "key": "optimizacion-de-procesos",
        "categoria": "Mejora Continua",
        "parametro": "Optimización de procesos",
        "preguntaStar": "Cuéntame de una mejora que implementaste en inventarios, compras o abastecimiento. ¿Qué cambió y cuáles fueron los resultados?",
        "anclas": {
          "inferior": "No participa en mejoras.",
          "cumple": "Propone mejoras operativas sencillas.",
          "supera": "Implementa mejoras con impacto medible en costos, tiempos o inventario."
        }
      },
      {
        "key": "control-de-entregas",
        "categoria": "Seguimiento",
        "parametro": "Control de entregas",
        "preguntaStar": "Háblame de una ocasión donde una entrega importante se retrasó. ¿Cómo le diste seguimiento?",
        "anclas": {
          "inferior": "No da seguimiento efectivo.",
          "cumple": "Monitorea entregas hasta su cumplimiento.",
          "supera": "Anticipa riesgos y coordina acciones para evitar afectaciones."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y qué aprendizaje obtuviste.",
        "anclas": {
          "inferior": "Cambios frecuentes sin justificación.",
          "cumple": "Explica razonablemente sus cambios.",
          "supera": "Muestra estabilidad y crecimiento profesional continuo."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto requiere análisis, control de inventarios, planeación, seguimiento a proveedores y dominio de sistemas. Cuéntame una experiencia similar y cómo contribuiste a mejorar el abastecimiento.",
        "anclas": {
          "inferior": "Tiene poca experiencia relacionada.",
          "cumple": "Cuenta con experiencia compatible.",
          "supera": "Demuestra dominio integral del proceso de abastecimiento y control de inventarios."
        }
      }
    ],
    "preguntasCierre": [
      "¿Qué sistemas ERP o administrativos has utilizado para controlar inventarios, compras o entradas de mercancía?",
      "¿Qué indicadores utilizabas para medir el desempeño del inventario? (Rotación, Fill Rate, Días de Inventario, Máximos y Mínimos, Nivel de Servicio, etc.)",
      "¿Cómo determinabas los máximos y mínimos de inventario en temporadas altas y bajas?",
      "¿Cuál ha sido el inventario más grande que has administrado (número de SKU o valor aproximado)?",
      "¿Cómo actuabas cuando un proveedor incumplía una fecha de entrega?",
      "Cuéntame una mejora que implementaste y que haya generado ahorro de costos, disminución de faltantes o reducción de inventario.",
      "¿Qué herramientas utilizas para analizar información? (Excel, tablas dinámicas, Power BI, ERP, SQL, etc.)",
      "¿Qué tendría que ofrecer una empresa para que permanezcas y desarrolles tu carrera profesional?"
    ]
  },
  "auxiliar-de-chofer": {
    "key": "auxiliar-de-chofer",
    "nombre": "AUXILIAR DE CHOFER",
    "competencias": [
      {
        "key": "carga-y-descarga-de-mercancia",
        "categoria": "Operación",
        "parametro": "Carga y descarga de mercancía",
        "preguntaStar": "Cuéntame de una ocasión en la que tuviste que cargar y descargar mercancía de manera constante durante una jornada laboral. ¿Cómo te organizaste y cuál fue el resultado?",
        "anclas": {
          "inferior": "Presenta dificultades para realizar trabajo físico o genera daños en la mercancía.",
          "cumple": "Realiza correctamente la carga y descarga siguiendo los procedimientos establecidos.",
          "supera": "Mantiene un alto rendimiento físico, cuida la mercancía y optimiza los tiempos de carga y descarga."
        }
      },
      {
        "key": "manejo-y-cuidado-de-mercancia",
        "categoria": "Operación",
        "parametro": "Manejo y cuidado de mercancía",
        "preguntaStar": "Háblame de una ocasión en la que detectaste que un producto podía dañarse durante el traslado. ¿Qué hiciste?",
        "anclas": {
          "inferior": "No identifica riesgos o manipula incorrectamente la mercancía.",
          "cumple": "Manipula adecuadamente la mercancía evitando daños.",
          "supera": "Previene daños mediante técnicas de acomodo y protección de mercancía."
        }
      },
      {
        "key": "preparacion-de-pedidos",
        "categoria": "Organización",
        "parametro": "Preparación de pedidos",
        "preguntaStar": "Cuéntame de una ocasión donde participaste en la preparación o revisión de un pedido antes de salir a ruta. ¿Cómo verificaste que estuviera completo?",
        "anclas": {
          "inferior": "No verifica mercancía o presenta errores frecuentes.",
          "cumple": "Revisa y valida correctamente los pedidos.",
          "supera": "Detecta diferencias antes de la salida y evita devoluciones o faltantes."
        }
      },
      {
        "key": "apoyo-al-chofer",
        "categoria": "Colaboración",
        "parametro": "Apoyo al chofer",
        "preguntaStar": "Describe una ocasión donde apoyaste al chofer para resolver un problema durante una ruta de reparto. ¿Qué hiciste y cuál fue el resultado?",
        "anclas": {
          "inferior": "Espera instrucciones constantemente.",
          "cumple": "Colabora cuando el chofer requiere apoyo.",
          "supera": "Se anticipa a las necesidades del chofer y facilita la operación."
        }
      },
      {
        "key": "atencion-al-cliente",
        "categoria": "Servicio",
        "parametro": "Atención al cliente",
        "preguntaStar": "Cuéntame de una ocasión donde entregaste mercancía a un cliente y surgió una inconformidad. ¿Cómo actuaste?",
        "anclas": {
          "inferior": "Tiene dificultades para atender clientes.",
          "cumple": "Atiende adecuadamente la situación y mantiene una actitud de servicio.",
          "supera": "Resuelve la situación con profesionalismo y fortalece la relación con el cliente."
        }
      },
      {
        "key": "cuidado-de-la-unidad",
        "categoria": "Responsabilidad",
        "parametro": "Cuidado de la unidad",
        "preguntaStar": "Háblame de una ocasión donde detectaste una anomalía en la unidad de reparto. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Ignora fallas o no las reporta.",
          "cumple": "Reporta oportunamente cualquier anomalía.",
          "supera": "Previene fallas mediante inspecciones y seguimiento constante."
        }
      },
      {
        "key": "limpieza-y-mantenimiento-de-la-unidad",
        "categoria": "Procesos",
        "parametro": "Limpieza y mantenimiento de la unidad",
        "preguntaStar": "Cuéntame cómo contribuías al cuidado y limpieza de la unidad asignada.",
        "anclas": {
          "inferior": "No participa en el mantenimiento básico.",
          "cumple": "Mantiene limpia la unidad y cumple con las actividades asignadas.",
          "supera": "Mantiene la unidad en excelentes condiciones y promueve una cultura de cuidado."
        }
      },
      {
        "key": "prevencion-de-riesgos",
        "categoria": "Seguridad",
        "parametro": "Prevención de riesgos",
        "preguntaStar": "Describe una ocasión donde identificaste un riesgo durante la carga, descarga o traslado de mercancía. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Ignora riesgos o incumple medidas de seguridad.",
          "cumple": "Sigue las medidas de seguridad establecidas.",
          "supera": "Identifica riesgos y actúa preventivamente evitando accidentes."
        }
      },
      {
        "key": "manejo-de-incidencias",
        "categoria": "Solución de problemas",
        "parametro": "Manejo de incidencias",
        "preguntaStar": "Háblame de un problema que surgió durante una entrega o ruta. ¿Cómo contribuiste a resolverlo?",
        "anclas": {
          "inferior": "Tiene dificultades para resolver problemas.",
          "cumple": "Colabora en la solución de incidencias comunes.",
          "supera": "Propone soluciones efectivas minimizando el impacto operativo."
        }
      },
      {
        "key": "trabajo-bajo-presion",
        "categoria": "Adaptabilidad",
        "parametro": "Trabajo bajo presión",
        "preguntaStar": "Cuéntame de una ocasión donde tuvieron muchas entregas o una carga de trabajo elevada. ¿Cómo respondiste?",
        "anclas": {
          "inferior": "Disminuye su desempeño bajo presión.",
          "cumple": "Mantiene un desempeño adecuado.",
          "supera": "Conserva productividad y actitud positiva en jornadas exigentes."
        }
      },
      {
        "key": "cumplimiento-de-tiempos",
        "categoria": "Productividad",
        "parametro": "Cumplimiento de tiempos",
        "preguntaStar": "Describe una ocasión donde tuviste que acelerar el proceso de carga o entrega para cumplir con el horario. ¿Qué hiciste?",
        "anclas": {
          "inferior": "No cumple los tiempos establecidos.",
          "cumple": "Cumple los tiempos asignados.",
          "supera": "Optimiza tiempos sin afectar la calidad del trabajo."
        }
      },
      {
        "key": "honestidad",
        "categoria": "Integridad",
        "parametro": "Honestidad",
        "preguntaStar": "Cuéntame de una ocasión donde detectaste una diferencia de mercancía o documentación. ¿Qué hiciste?",
        "anclas": {
          "inferior": "Omite reportar incidencias.",
          "cumple": "Reporta oportunamente cualquier diferencia.",
          "supera": "Actúa con transparencia y protege los intereses de la empresa."
        }
      },
      {
        "key": "trabajo-en-equipo",
        "categoria": "Colaboración",
        "parametro": "Trabajo en equipo",
        "preguntaStar": "Háblame de una ocasión donde apoyaste a almacén, chofer o ventas para cumplir un objetivo común.",
        "anclas": {
          "inferior": "Muestra poca disposición para colaborar.",
          "cumple": "Coopera cuando es necesario.",
          "supera": "Contribuye activamente al éxito del equipo."
        }
      },
      {
        "key": "historial-laboral",
        "categoria": "Estabilidad",
        "parametro": "Historial laboral",
        "preguntaStar": "Cuéntame sobre un cambio laboral importante y qué aprendizaje obtuviste de esa experiencia.",
        "anclas": {
          "inferior": "Cambios frecuentes sin justificación clara.",
          "cumple": "Explica razonablemente sus cambios laborales.",
          "supera": "Muestra estabilidad y crecimiento profesional."
        }
      },
      {
        "key": "ajuste-al-puesto",
        "categoria": "Compatibilidad",
        "parametro": "Ajuste al puesto",
        "preguntaStar": "Este puesto requiere trabajo físico constante, apoyo al chofer, atención al cliente, carga y descarga de mercancía y cumplimiento de rutas. Cuéntame una experiencia similar y cómo te desempeñaste.",
        "anclas": {
          "inferior": "Tiene poca experiencia relacionada con el puesto.",
          "cumple": "Cuenta con experiencia compatible.",
          "supera": "Demuestra experiencia sólida y excelente adaptación al puesto."
        }
      }
    ],
    "preguntasCierre": [
      "¿Has trabajado anteriormente realizando carga y descarga de mercancía? ¿Qué tipo de productos manejabas?",
      "¿Este puesto requiere esfuerzo físico durante toda la jornada. ¿Tienes alguna limitación física, condición de salud o lesión que pudiera dificultarte realizar estas actividades de forma constante?"
    ]
  }
};

/** Lista para poblar el dropdown de "hoja oficial" en el editor de vacantes. */
export const HOJAS_COMPETENCIAS: { key: string; nombre: string; total: number }[] =
  Object.values(CATALOGO_COMPETENCIAS).map(h => ({ key: h.key, nombre: h.nombre, total: h.competencias.length }));

// Abreviaturas comunes de puestos \u2192 forma larga (para el match autom\u00e1tico).
const ABREV_PUESTO: Record<string, string> = { aux: 'auxiliar', axu: 'auxiliar', vend: 'vendedor' };

/**
 * Normaliza un nombre para COMPARAR puesto \u2194 hoja: quita acentos, marcas de
 * g\u00e9nero entre par\u00e9ntesis "(a)"/"(o)", expande abreviaturas y pliega la
 * terminaci\u00f3n de g\u00e9nero (o/a) de cada palabra. As\u00ed "Cajero(a)" \u2248 "CAJERA" y
 * "Aux de chofer" \u2248 "AUXILIAR DE CHOFER" sin necesidad de asignaci\u00f3n manual.
 */
function normMatch(s: string): string {
  let t = (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/\((?:a|o|as|os)\)/g, ' ');          // marcas de g\u00e9nero (a)/(o)/(as)/(os)
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  return t.split(/\s+/).filter(Boolean)
    .map(w => ABREV_PUESTO[w] || w)                   // expande abreviaturas (aux\u2192auxiliar)
    .map(w => w.replace(/([a-z]{3,})[oa]$/, '$1~'))   // pliega g\u00e9nero final (cajero\u2248cajera)
    .join(' ');
}

/** Hoja oficial por su key de cat\u00e1logo (la que RH eligi\u00f3 en el puesto). */
export function hojaPorKey(key: string | undefined): HojaCompetencias | undefined {
  return key ? CATALOGO_COMPETENCIAS[key] : undefined;
}

/** Encuentra la hoja oficial cuyo nombre coincide con el nombre del puesto. */
export function hojaPorNombrePuesto(nombrePuesto: string | undefined): HojaCompetencias | undefined {
  const n = normMatch(nombrePuesto || '');
  if (!n) return undefined;
  const vals = Object.values(CATALOGO_COMPETENCIAS);
  // match exacto normalizado, luego "empieza con" en cualquier sentido
  return vals.find(h => normMatch(h.nombre) === n)
    || vals.find(h => { const hn = normMatch(h.nombre); return hn.startsWith(n) || n.startsWith(hn); });
}
