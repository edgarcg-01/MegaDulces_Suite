<!--
  ⛔ DOCUMENTO AJENO — NO EDITAR EL CUERPO.

  Ésta es la especificación funcional que entregó DIRECCIÓN (no la escribió Desarrollo), copiada
  al repo VERBATIM el 2026-09-21. Es el insumo de la Fase CDRP.

  Por qué está versionada: los commits `[CDRP.0]`, `[CDRP.1]` y `[CDRP.2]` citan §1.1, §3, §4,
  §9, §12 y §13 de este documento, y mientras vivió sólo en la carpeta de descargas de una
  máquina **cada una de esas citas era inverificable**. Un acuerdo con Dirección que no está en
  el repo no es un acuerdo: es un recuerdo.

  Qué SÍ se puede hacer acá: nada, salvo reemplazar el archivo entero por una versión nueva que
  Dirección haya emitido, cambiándole la fecha al nombre. Los desacuerdos con lo que dice el
  documento —y hay varios medidos— van en `FASE_CDRP_CUADRO_RESULTADOS.md`, no acá. Mezclar la
  spec con la respuesta borra la diferencia entre lo que pidieron y lo que se pudo hacer.

  Lecturas críticas ya registradas en el doc de fase (resumen, el detalle está allá):
    · §12 define TRES estados (green|yellow|red) y con tres un KPI sin meta sale verde.
    · §13 propone el umbral como PORCENTAJE de la meta, que se rompe con meta 0 — y «cartera
      vencida, meta 0» es un objetivo real de este negocio.
    · §14 ordena construir el motor de semáforos (paso 4) antes que las metas (paso 5); sin metas
      el motor sólo puede devolver «sin meta».
    · §2 y §3 asignan KPIs a dos puestos que en `identity.positions` tienen CERO personas.
-->

# CDRP - Especificacion funcional del Dashboard Inicial por Puesto
## Mega Dulces de los Altos

**Documento para:** Equipo de Desarrollo de Software y Transformacion Digital  
**Objetivo:** definir el contenido de la pantalla inicial que debe responder, en menos de 30 segundos, cuatro preguntas para cada puesto directivo:

1. **Mi trabajo se llama...** - cual es el resultado central que debo producir.
2. **Como voy...** - cuales son mis KPIs y su estado contra meta.
3. **Que debo lograr...** - metas de corto y mediano plazo.
4. **Donde debo poner foco hoy...** - excepciones, desviaciones, riesgos y decisiones pendientes.

> Principio de diseno: el dashboard no debe ser un repositorio de reportes. Debe ser un sistema de direccion por excepcion. Primero muestra desviaciones que requieren accion; despues permite profundizar hasta zona, sucursal, canal, proveedor, cliente, colaborador, producto o proceso.

---

# 1. Estructura comun de la pantalla de apertura

## 1.1 Encabezado: "Mi trabajo se llama"

Mostrar una frase de una linea que traduzca la descripcion del puesto a un resultado empresarial. Debajo:

- Puesto.
- Periodo activo.
- Fecha/hora de ultima actualizacion.
- Unidad organizacional o zona.
- Estado general: `EN META`, `ATENCION`, `CRITICO`.

## 1.2 Tarjetas KPI

Mostrar inicialmente entre **5 y 8 KPIs primarios**. Cada tarjeta debe contener:

- Nombre del KPI.
- Resultado actual.
- Meta.
- Variacion absoluta y porcentual.
- Tendencia vs periodo anterior.
- Semaforo.
- Frecuencia de actualizacion.
- Responsable del dato.
- Accion de drill-down.

No llenar la apertura con 20 indicadores. Los secundarios deben vivir en el segundo nivel.

## 1.3 Metas

Dos horizontes:

### Corto plazo
Objetivos del mes/trimestre en curso.

### Mediano plazo
Objetivos de 6 a 12 meses y OKRs estrategicos.

Cada meta debe mostrar:

- valor inicial;
- valor objetivo;
- avance porcentual;
- fecha compromiso;
- responsable;
- estado;
- ultimo comentario de seguimiento.

## 1.4 "Mi foco hoy"

Lista priorizada automaticamente. No es una lista manual de pendientes. Debe construirse con reglas de excepcion.

Cada foco debe indicar:

`severidad | indicador | desviacion | impacto | responsable | fecha limite | accion requerida`

Ejemplos:

- venta bajo presupuesto;
- margen bajo piso;
- inventario agotado/sobreinventariado;
- gasto fuera de presupuesto;
- cartera vencida;
- proveedor con bajo fill rate;
- hallazgo de auditoria vencido;
- vacante critica;
- proyecto estrategico atrasado.

## 1.5 Decisiones pendientes

Separar **informacion** de **decisiones**. Mostrar exclusivamente asuntos que requieren autorizacion o criterio del usuario:

- solicitud;
- monto/impacto;
- quien solicita;
- fecha;
- recomendacion o escenarios disponibles;
- SLA para decidir;
- trazabilidad de la resolucion.

## 1.6 Compromisos

Panel de acuerdos provenientes de reuniones y minutas:

- compromiso;
- responsable;
- fecha prometida;
- avance;
- dias de atraso;
- evidencia de cierre.

---

# 2. Direccion General

## Mi trabajo se llama

**Asegurar la operacion y la rentabilidad de Mega Dulces, desarrollar al equipo directivo y construir relaciones sostenibles con clientes y proveedores, convirtiendo la estrategia de largo plazo en resultados medibles.**

## KPIs primarios

1. Ventas consolidadas vs presupuesto.
2. Margen bruto / margen real vs meta.
3. EBITDA o resultado operativo vs presupuesto.
4. Flujo de efectivo y liquidez disponible.
5. Capital de trabajo: clientes + inventario - proveedores.
6. Inventario total y dias de inventario.
7. Cartera de clientes y cartera vencida.
8. Cumplimiento global de OKRs/compromisos de la primera linea.

## KPIs secundarios / drill-down

- Ventas por zona, sucursal y canal.
- Crecimiento vs ano anterior.
- Tickets por sucursal.
- Lineas por ticket.
- Articulos por ticket.
- Precio promedio por articulo.
- Trafico y clientes atendidos.
- Agotados y riesgo de agotado.
- Gasto operativo por sucursal / ventas.
- Gasto logistico / ventas.
- Ingreso por colaborador.
- Plantilla cubierta y ausentismo.
- Riesgos estrategicos abiertos.
- Estado de proveedores estrategicos.

## Metas de corto plazo

- Cumplir presupuesto mensual de ingresos.
- Mantener gasto y compras dentro de presupuesto.
- Corregir desviaciones relevantes de margen, liquidez, inventario y cartera.
- Cerrar acuerdos vencidos de la primera linea.
- Resolver decisiones extraordinarias escaladas por las gerencias.

## Metas de mediano plazo

- Llevar la empresa hacia el margen objetivo definido en planeacion.
- Mejorar capital de trabajo y disminuir dependencia financiera.
- Profesionalizar el modelo de rendicion de cuentas por KPIs/OKRs.
- Consolidar ERP, datos confiables y automatizacion de procesos.
- Desarrollar una estructura directiva menos dependiente de intervencion operativa de DG.

## Mi foco hoy

Priorizar automaticamente:

1. Riesgo de liquidez.
2. Desviacion de ventas/margen.
3. Gasto fuera de presupuesto.
4. Inventario critico o capital atrapado.
5. Cartera vencida relevante.
6. Proveedores estrategicos con riesgo de abasto/credito.
7. Incidencias de personal clave.
8. Acuerdos directivos vencidos.

---

# 3. Direccion Comercial

## Mi trabajo se llama

**Convertir la estrategia comercial en crecimiento rentable, asignando objetivos, recursos y prioridades a zonas, canales y categorias, y asegurando su ejecucion.**

## KPIs primarios

1. Ventas vs presupuesto consolidado comercial.
2. Crecimiento vs mismo periodo del ano anterior.
3. Margen comercial vs meta.
4. Clientes activos / crecimiento de clientes.
5. Ticket promedio.
6. Productos o lineas por ticket/cliente.
7. Cumplimiento por zona, sucursal y canal.
8. Participacion de marcas/categorias estrategicas.

## KPIs secundarios

- Trafico por sucursal.
- Visitas efectivas.
- Clientes nuevos y retenidos.
- Distribucion numerica.
- Precio promedio por pieza.
- Mezcla de producto.
- Agotados de productos estrategicos.
- Inventario disponible para ejecutar estrategia.
- Rentabilidad por canal.
- Nivel de servicio/entregas.
- Ejecucion de promociones.

## Metas de corto plazo

- Cumplir presupuesto mensual por zona/canal.
- Recuperar zonas, sucursales o canales bajo meta.
- Empujar productos y marcas estrategicas.
- Corregir agotados que frenen venta.
- Mejorar clientes, mezcla y valor promedio por operacion.

## Metas de mediano plazo

- Crecimiento sostenido por las tres palancas: **mas clientes + mas productos por cliente + productos de mayor valor**.
- Homologar ejecucion comercial entre zonas.
- Profesionalizar piso de venta, mayoreo y ruta directa.
- Mejorar margen y participacion de categorias estrategicas.

## Mi foco hoy

- Zonas/canales bajo presupuesto.
- Margen bajo meta.
- Caida de clientes activos.
- Productos estrategicos agotados.
- Categorias con tendencia negativa.
- Promociones sin ejecucion.
- Desviaciones de mezcla/ticket.
- Decisiones comerciales pendientes de autorizacion.

---

# 4. Gerencia de Administracion y Finanzas

## Mi trabajo se llama

**Garantizar liquidez, rentabilidad, disciplina presupuestal e informacion financiera confiable para que Mega Dulces pueda operar y decidir sin comprometer su capital de trabajo.**

## KPIs primarios

1. Liquidez disponible vs flujo presupuestado.
2. Ingresos/cobranza vs ventas.
3. Egresos/pagos vs presupuesto.
4. Capital de trabajo.
5. Cartera de clientes y porcentaje vencido.
6. Saldo y vencimiento de proveedores.
7. Inventario en pesos y dias de inventario.
8. Margen / resultado operativo vs presupuesto.

## KPIs secundarios

- Clientes >21 dias.
- Clientes >60 dias.
- Clientes bloqueados/desbloqueados.
- Flujo diario y semanal.
- Presupuesto de ingresos.
- Presupuesto de gastos.
- Presupuesto de compras.
- Desviacion presupuestal por centro de costo.
- Pasivo circulante / activo circulante.
- Costo financiero.
- Estado de resultados.
- Balance general.
- Riesgos financieros abiertos.

## Metas de corto plazo

- Tener programacion de pagos basada en obligaciones recibidas, no solamente vencidas.
- Mantener liquidez diaria dentro del flujo planeado.
- Corregir desviaciones de ingresos, gastos y compras.
- Reducir cartera vencida y bloquear oportunamente riesgos de credito.
- Entregar cierre financiero completo y oportuno.

## Metas de mediano plazo

- Mejorar la razon de liquidez/capital de trabajo.
- Reducir apalancamiento de forma ordenada.
- Acercar el margen a la meta corporativa.
- Mantener inventario financieramente sano.
- Automatizar cierre, conciliaciones y trazabilidad financiera en ERP.

## Mi foco hoy

- Deficit de liquidez proyectado.
- Cobranza vencida.
- Pagos criticos de proveedores.
- Gasto no presupuestado.
- Compra que comprometa flujo.
- Inventario excesivo que atrape capital.
- Desviaciones de margen.
- Riesgos que requieran decision de DG.

---

# 5. Jefatura de Compras

## Mi trabajo se llama

**Mantener el inventario correcto, en el lugar correcto y al menor costo total posible, negociando cada compra para sostener abasto, rotacion y rentabilidad.**

## KPIs primarios

1. Margen/rentabilidad obtenida por proveedor y compra.
2. Inventario vs presupuesto.
3. Salud del inventario: bajo stock / optimo / sobrestock.
4. Fill rate de proveedores.
5. Cadencia de compra por proveedor.
6. Ordenes colocadas vs entregadas.
7. Dias de inventario / rotacion.
8. Ahorro y beneficios obtenidos por negociacion.

## KPIs secundarios

- Productos bajo 50% del stock objetivo.
- Productos bajo 25%: criticidad alta.
- Productos sobre 100/125%.
- Backorders.
- Tiempo de entrega.
- Dias de credito.
- Compras del mes vs presupuesto.
- Inventario por zona.
- Productos nuevos y evolucion.
- Baja rotacion y caducidades.
- Proveedores 80/20.
- Descuentos logisticos, financieros, promocionales y bonificaciones.

## Metas de corto plazo

- Negociar cada orden colocada.
- Disminuir agotados sin generar sobreinventario.
- Llevar proveedores a una cadencia estable.
- Mejorar fill rate.
- Mantener compras dentro de presupuesto y maximos autorizados.

## Metas de mediano plazo

- Acercar margen de compra/comercializacion al objetivo corporativo.
- Mantener inventarios en rangos definidos por proveedor y frecuencia de entrega.
- Desarrollar una matriz integral de proveedores.
- Disminuir capital atrapado, caducidades y baja rotacion.
- Integrar informacion de mercado a catalogacion y desarrollo de categorias.

## Mi foco hoy

- Productos top en riesgo de agotado.
- Proveedores con fill rate bajo.
- Ordenes atrasadas.
- Sobreinventario.
- Compras que excedan presupuesto o maximos.
- Proveedores cuyo margen no alcanza objetivo.
- Negociaciones/bonificaciones pendientes de documentar.

---

# 6. Gerencia de Mercadotecnia

## Mi trabajo se llama

**Convertir la inversion de proveedores y de Mega Dulces en demanda medible, ejecucion comercial y crecimiento rentable de marcas, categorias y clientes.**

> Nota de implementacion: el levantamiento de Mercadotecnia debe ser la fuente final para fijar formulas, metas y umbrales. En esta primera version, el dashboard debe concentrarse en las variables que cruzan Mercadotecnia con Comercial, Compras y la politica corporativa de proveedores.

## KPIs primarios propuestos para parametrizacion

1. Presupuesto de marketing ejecutado vs autorizado.
2. Inversion/apoyo de proveedores captado vs comprometido.
3. Cumplimiento de promociones/campanas.
4. Venta incremental de productos o marcas intervenidas.
5. Margen/contribucion de promociones.
6. Ejecucion de trade marketing por zona/sucursal/canal.
7. Productos nuevos: adopcion y desempeno.
8. ROI o retorno atribuible de campanas cuando exista trazabilidad suficiente.

## Metas de corto plazo

- Ejecutar calendario promocional.
- Asegurar aplicacion de apoyos negociados con proveedores.
- Dar visibilidad a productos/marcas objetivo.
- Medir resultados de cada activacion.

## Metas de mediano plazo

- Construir medicion de ROI y atribucion.
- Profesionalizar trade marketing con proveedores.
- Integrar marketing con datos de ventas, margen, inventario y cliente.
- Desarrollar categorias y lanzamientos con evidencia de mercado.

## Mi foco hoy

- Campanas activas sin ejecucion.
- Presupuesto comprometido no aplicado.
- Apoyos de proveedor pendientes.
- Promociones con margen insuficiente.
- Productos nuevos sin traccion.
- Inventario promocional en riesgo.

---

# 7. Gerencia de Zona - plantilla comun La Piedad / Zamora / Morelia

## Mi trabajo se llama

**Gerenciar integralmente la zona para cumplir ventas y rentabilidad, controlar gastos y operacion, desarrollar los canales comerciales y asegurar una experiencia consistente al cliente.**

## KPIs primarios

1. Ventas de zona vs presupuesto.
2. Margen/rentabilidad de zona.
3. Gasto operativo vs presupuesto.
4. Clientes activos y clientes nuevos.
5. Ticket promedio.
6. Productos/lineas por cliente.
7. Nivel de servicio y entregas completas/a tiempo.
8. Inventario, agotados y sobreinventario de la zona.

## KPIs secundarios

- Ventas por sucursal.
- Ventas por canal: piso, mayoreo, ruta directa/vecinal segun estructura.
- Visitas efectivas.
- Cobertura territorial.
- Distribucion numerica.
- Marcas estrategicas.
- Cartera/cobranza.
- Costo logistico/ruta.
- Incidencias operativas.
- Quejas y devoluciones.
- Plantilla y ausentismo.
- Cumplimiento de acuerdos.

## Metas de corto plazo

- Cumplir presupuesto mensual.
- Corregir canales/sucursales/rutas bajo meta.
- Mantener gasto dentro de presupuesto.
- Resolver incidencias que afecten servicio.
- Incrementar clientes y profundidad de compra.

## Metas de mediano plazo

- Expandir cobertura rentable.
- Profesionalizar rutas y canales.
- Mejorar mezcla y penetracion de marcas estrategicas.
- Reducir dependencia operativa del gerente mediante lideres y procesos.
- Construir capacidad de rendicion de cuentas mensual y trimestral.

## Mi foco hoy

- Sucursal/canal/ruta bajo presupuesto.
- Cliente relevante perdido o inactivo.
- Agotado que impacta venta.
- Gasto extraordinario.
- Cartera vencida.
- Incidencia de servicio.
- Ruta con baja productividad.
- Compromisos vencidos de encargados/supervisores.

---

# 8. Jefatura de Recursos Humanos / Capital Humano

## Mi trabajo se llama

**Asegurar que Mega Dulces tenga la gente correcta, en los puestos correctos, desarrollando capacidades, liderazgo, cultura y sucesion para sostener el crecimiento del negocio.**

## KPIs primarios a parametrizar con la descripcion definitiva

1. Plantilla cubierta vs autorizada.
2. Vacantes criticas abiertas y dias de cobertura.
3. Rotacion total y rotacion de puestos clave.
4. Ausentismo.
5. Costo de nomina vs presupuesto.
6. Cumplimiento de capacitacion/desarrollo.
7. Avance de planes de vida y carrera/sucesion.
8. Incidencias laborales relevantes abiertas/cerradas.

## Metas de corto plazo

- Cubrir vacantes criticas.
- Reducir ausentismo y rotacion evitable.
- Mantener costo de plantilla dentro de presupuesto.
- Ejecutar planes de capacitacion prioritarios.
- Formalizar descripciones, evaluaciones y seguimiento de puestos clave.

## Metas de mediano plazo

- Construir planes de vida y carrera.
- Crear sucesores para puestos criticos.
- Fortalecer liderazgo y rendicion de cuentas.
- Digitalizar expedientes, indicadores y procesos de Capital Humano.
- Consolidar identidad y cultura organizacional.

## Mi foco hoy

- Vacante critica.
- Riesgo de fuga de talento clave.
- Ausentismo fuera de rango.
- Rotacion anormal por area.
- Incidencia laboral de alto impacto.
- Puesto sin sucesor o sin plan de desarrollo.

---

# 9. Coordinacion de Auditoria y Prevencion

## Mi trabajo se llama

**Proteger los activos de Mega Dulces asegurando que la operacion fisica coincida con el sistema, investigando diferencias hasta su causa y evitando que los errores o perdidas se repitan.**

## KPIs primarios

1. Exactitud de inventario.
2. Diferencia de inventario sobre ventas.
3. Cumplimiento del programa de auditorias.
4. Hallazgos cerrados / hallazgos detectados.
5. Tiempo promedio de resolucion.
6. Reincidencia de hallazgos.
7. Conciliacion de traspasos.
8. Perdidas identificadas y recuperadas.

## KPIs secundarios

- Diferencias por ruta.
- Diferencias por sucursal.
- Compras/recepciones pendientes detectadas.
- Ajustes sin evidencia rechazados.
- Investigaciones abiertas.
- Hallazgos vencidos.
- Rutas/sucursales de alto riesgo.

## Metas de corto plazo

- Ejecutar el programa de auditorias.
- Cerrar diferencias pendientes.
- Conciliar traspasos oportunamente.
- Disminuir hallazgos vencidos.

## Metas de mediano plazo

- Reducir sistematicamente diferencias y perdidas.
- Disminuir reincidencia.
- Automatizar deteccion de excepciones.
- Evolucionar de auditoria reactiva a control preventivo.

## Mi foco hoy

- Diferencia monetaria relevante.
- Ruta/sucursal reincidente.
- Traspaso sin conciliacion.
- Ajuste solicitado sin evidencia.
- Hallazgo vencido.
- Patron que sugiera riesgo patrimonial.

---

# 10. Jefatura de Desarrollo de Sistemas y Transformacion Digital

## Mi trabajo se llama

**Transformar necesidades del negocio en software confiable y medible, priorizando el desarrollo por impacto empresarial, cercania al ingreso/cliente y esfuerzo requerido.**

## KPIs primarios para la CDRP

1. Horas de desarrollo entregadas vs capacidad disponible.
2. Tickets terminados vs comprometidos.
3. Lead time / cycle time por ticket.
4. Tickets con impacto directo en ingresos o cliente.
5. Valor/impacto entregado por hora invertida.
6. Bugs/retrabajo posterior a liberacion.
7. Cumplimiento de fecha/SLA.
8. Disponibilidad/adopcion de soluciones liberadas.

## Regla de prioridad

La cola de desarrollo debe ponderar como minimo:

- impacto en ingresos;
- cercania/interaccion con cliente;
- ahorro o reduccion de riesgo;
- urgencia operativa;
- esfuerzo estimado en horas;
- dependencias;
- riesgo tecnico.

Principio: **alto impacto + bajo esfuerzo = prioridad superior; bajo impacto + alto esfuerzo = prioridad inferior**, salvo riesgos criticos, cumplimiento o continuidad operativa.

## Metas de corto plazo

- Formalizar backlog y priorizacion.
- Estandarizar inicio, supervision y cierre de tickets.
- Reducir tickets envejecidos.
- Entregar las primeras pantallas CDRP con datos confiables.

## Metas de mediano plazo

- Integrar ERP, data lake y capa analitica.
- Reducir procesos manuales entre departamentos.
- Implementar codificacion asistida por IA con controles de calidad.
- Crear una arquitectura de indicadores reutilizable para todos los puestos.

## Mi foco hoy

- Incidentes que detienen operacion o venta.
- Tickets de alto ingreso/bajo esfuerzo.
- Bugs productivos.
- Bloqueos/dependencias.
- Tickets sin definicion de aceptacion.
- Datos o integraciones que comprometan los dashboards directivos.

---

# 11. Puestos que deben incorporarse en la siguiente iteracion

La arquitectura debe permitir agregar sin redisenar el producto:

- Jefatura de CEDIS y Logistica.
- Jefatura de Sistemas e Infraestructura.
- Tesoreria.
- Lider de Piso de Venta.
- Lider de Mayoreo.
- Lider de Ruta Directa / Venta Vecinal.
- Supervisores comerciales.
- Encargados de sucursal.

Cada perfil reutilizara el mismo contrato: `proposito -> KPIs -> metas -> focos -> decisiones -> compromisos`.

---

# 12. Contrato de datos sugerido para desarrollo

```yaml
role_dashboard:
  role_id: string
  role_name: string
  purpose_statement: string
  period:
    start: date
    end: date
  overall_status: green|yellow|red
  last_refresh: datetime

  kpis:
    - id: string
      name: string
      value: number
      unit: currency|percent|days|count|ratio
      target: number
      variance: number
      variance_percent: number
      trend: up|flat|down
      status: green|yellow|red
      frequency: realtime|daily|weekly|monthly
      owner: string
      source_system: string
      drilldown_dimensions: []

  goals:
    short_term: []
    medium_term: []

  focus_items:
    - severity: critical|high|medium
      type: string
      description: string
      current_value: number|string
      target_value: number|string
      impact: string
      owner: string
      due_date: date
      action_required: string

  decisions_pending:
    - request_id: string
      subject: string
      requested_by: string
      financial_impact: number|null
      operational_impact: string
      requested_at: datetime
      due_at: datetime
      options: []
      status: pending|approved|rejected|escalated

  commitments:
    - commitment_id: string
      description: string
      owner: string
      due_date: date
      progress_percent: number
      evidence_url: string|null
      status: open|at_risk|overdue|closed
```

---

# 13. Reglas de semaforizacion

No codificar umbrales dentro de la interfaz. Deben ser configurables por KPI, puesto, periodo y eventualmente unidad de negocio.

Ejemplo:

```yaml
thresholds:
  kpi_id: ventas_vs_presupuesto
  green: ">= 100%"
  yellow: ">= 95% and < 100%"
  red: "< 95%"
```

El sistema debe distinguir:

- **Meta:** resultado esperado.
- **Umbral amarillo:** desviacion que exige vigilancia.
- **Umbral rojo:** desviacion que exige accion.
- **Escalamiento:** condicion que debe llegar al superior.

---

# 14. Orden recomendado de construccion del MVP

## Fase 1 - Capa comun

Construir primero:

1. autenticacion y perfil de puesto;
2. encabezado "Mi trabajo se llama";
3. tarjetas KPI;
4. motor de semaforos;
5. metas;
6. foco por excepciones;
7. decisiones pendientes;
8. compromisos/minutas;
9. drill-down;
10. trazabilidad de fuente y ultima actualizacion.

## Fase 2 - Primeros perfiles

Prioridad sugerida por disponibilidad e impacto de informacion:

- Direccion General.
- Gerencia de Administracion y Finanzas.
- Direccion Comercial.
- Jefatura de Compras.
- Gerencias de Zona.

## Fase 3

- Auditoria y Prevencion.
- Recursos Humanos.
- Mercadotecnia.
- Desarrollo de Sistemas.
- CEDIS/Logistica y demas mandos.

---

# 15. Criterio de aceptacion del dashboard

La pantalla inicial esta bien construida si, al abrirla, el usuario puede contestar sin navegar a otro modulo:

1. **Que resultado debo producir?**
2. **Estoy cumpliendo o no?**
3. **Que indicador explica la desviacion?**
4. **Que debo atender primero hoy?**
5. **Que decisiones estan esperando de mi?**
6. **Que compromisos tengo vencidos o en riesgo?**
7. **Que debo lograr al cierre del mes y del horizonte estrategico?**

Si la pantalla solo responde "que paso", es reportería.  
Si responde **que paso + contra que meta + por que importa + donde actuar + quien debe decidir**, entonces ya funciona como una **CDRP de direccion y rendicion de cuentas**.
