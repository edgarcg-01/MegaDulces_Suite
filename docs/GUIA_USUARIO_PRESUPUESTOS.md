# Guía de usuario — Presupuestos

> **Para quién es esto:** la persona que arma y opera el presupuesto (Finanzas / Dirección).
> No hace falta saber nada técnico.
>
> **Dónde está:** menú **Administración y Finanzas › Presupuestos › Presupuesto**, ruta
> **`/presupuesto`**. El enlace viejo `/finanzas/presupuesto` redirige ahí.
>
> **La idea del módulo en tres frases:**
> 1. **El sistema arma** el borrador solo, cada mañana, con las ventas y los gastos reales de Kepler.
> 2. **Tú revisas** lo que propuso y **decides la política** (qué familias de gasto se presupuestan,
>    si va por sucursal y qué tan estricto es el control de sobregiro).
> 3. **Dirección firma.** Desde la firma, el presupuesto controla: cada obligación autorizada
>    compromete su partida y, al pagarla en el Calendario de Pagos, la consume.
>
> *Al día con la pantalla el 2026-11-20 (`[PU.16]`).*

---

## Antes de empezar

### Los tres permisos

| Permiso | Qué deja hacer |
|---|---|
| **Presupuestos · ver** | Abrir todas las pestañas y consultar. |
| **Presupuestos · gestionar** | Preparar: guardar la política, proponer planes, generar y **autorizar obligaciones**, mandar a firma. |
| **Presupuestos · aprobar** | Firmar el ejercicio. Nadie puede aprobar un ejercicio que preparó él mismo. |

> 💡 **Los botones se ven aunque no tengas el permiso.** «Guardar política», «Proponer…» y «Enviar a
> autorización» aparecen según el estado del ejercicio; si al pulsarlos el sistema responde que no
> tienes permiso, te falta el de **gestionar**. Se asigna en Administración › Roles; pídelo a quien
> administra los roles.

### Cómo está organizada la pantalla

Arriba de todo, la franja **«esperan tu firma»** resume lo que está pendiente de autorizar
(ejercicios y obligaciones). La flecha de la derecha abre el detalle.

Debajo del título hay dos grupos:

- **Armar el presupuesto:** `Dirección` · `Ejercicio` · `Ventas` · `Gastos` · `Campañas`
- **¿Alcanza el dinero?:** `Diagnóstico` · `Ingresos` (abren como páginas aparte) ·
  `Flujo / Resultado` · `Capacidad de pago` · `Obligaciones`

Casi todo ocurre **sobre un ejercicio seleccionado**: los ejercicios aparecen como botones en la
pestaña **Ejercicio** (folio, nombre, año y estado). Si una pestaña te pide un ejercicio, elígelo ahí.

> ⚠️ **El ejercicio marcado PRUEBA** es una copia para ensayar: sus cifras no son presupuesto, el
> motor de la mañana no lo rearma y no cuenta como el ejercicio del año. No lo uses ni lo sumes.
> (La pasada de obligaciones sí le genera las suyas: por eso Dirección las muestra aparte.)

### El motor: qué hace solo y cuándo

| Cuándo | Qué hace |
|---|---|
| **Cada mañana, 07:30** | Crea el ejercicio del año siguiente si falta, recalcula los supuestos desde la historia, propone los planes de ventas y de gastos y materializa las partidas. Respeta lo capturado a mano. **Sólo en ejercicios abiertos** (*borrador* o *en revisión*) que no sean de prueba. |
| **Cada madrugada, 03:50** | Genera las obligaciones recurrentes desde el plan de gastos, en estado *propuesta*, en **todo ejercicio que no esté cerrado** (también pendiente, aprobado y el de prueba). |

⭐ **Al mandarlo a autorización, el motor de la mañana deja de rearmar el plan:** lo que se firma es
lo que viste. Si quieres ver el efecto de un cambio sin esperar a mañana, el ícono **Re-armar ahora**
(junto a «Enviar a autorización») corre esa misma pasada en ese momento.

### El ciclo de vida de un ejercicio

| Estado | Qué significa | Qué puedes hacer |
|---|---|---|
| **borrador** | Lo arma el motor | Revisar · guardar la política · proponer · **Enviar a autorización** |
| **en_revision** | En ajuste | Igual que borrador |
| **pendiente** | Enviado, esperando firma | **Aprobar** (quien tenga el permiso de aprobar) |
| **aprobado** | Firmado y en operación | Mover partidas · **Re-materializar** · **Cerrar** |
| **cerrado** | Terminado | Sólo consulta |

Antes de mandarlo a firma, la pantalla te dice lo que **bloquea** («No puede ir a autorización
todavía: …») y lo que conviene mirar aunque no frene. Lo que se firma se lee antes de firmar.

---

# PARTE 1 — Armar el presupuesto

Sigue las pestañas de izquierda a derecha: el orden es el flujo.

## 1 · Dirección — el punto de partida

La primera pestaña. Contesta qué falta antes de abrir cualquier otra:

- **El motor:** cuántas veces corrió, si la última salió bien y su cadencia.
- **Los ejercicios:** cuáles esperan firma y desde hace cuántos días; quién los creó y quién los
  autorizó.
- **Las obligaciones, en dos universos:** las del ejercicio real y las del ejercicio de prueba,
  **nunca sumadas**.
- **Las cinco etapas del dinero** (vigente, reservado, comprometido, ejercido y pagado) más el
  disponible, **una columna por año**. Los años no se suman entre sí. Cada etapa dice qué la mueve.
- **Lo que no se puede medir hoy**, con su motivo (por ejemplo, familias de gasto sin dueño).

Si un bloque no se pudo medir, lo dice con su motivo en lugar de mostrar un cero.

## 2 · Ejercicio — supuestos y política

### Los ejercicios

El ejercicio del año siguiente **lo crea el motor solo**. Los otros dos botones son para casos
especiales:

- **Duplicar como escenario:** duplica *este* ejercicio como una versión nueva en borrador, del mismo
  año, para armar un escenario alterno (conservador, expansión). **No** copia del año anterior.
  ⚠️ El diálogo que abre todavía se titula «Copiar del año anterior» y dice «Luego ajustas los
  supuestos»: es texto viejo; lo que hace es lo de arriba.
- **Nuevo ejercicio:** para un año o un escenario distinto del que arma el sistema. Si todavía no hay
  ningún ejercicio, aparece como **Crear uno a mano**.

### Supuestos del año — los calcula el sistema

El panel **Supuestos del año** muestra el crecimiento que el sistema calculó desde la historia:

- **Ventas — crecimiento por canal (%):** año contra año del sell-out. Un canal sin par de años con
  qué calcular usa el **Respaldo**, y la pantalla lo marca.
- **Gastos — crecimiento (%):** año contra año de los egresos de Kepler. Si no hay historia
  suficiente se marca **«sin medir»**.

Estos números **no se capturan**. ⭐ **Si un supuesto no cuadra, el arreglo es la fuente, no el
número:** avisa a Sistemas para revisar de dónde sale (un canal mal clasificado, un hueco de datos).

### Política — esto sí lo decides tú

| Perilla | Qué decide |
|---|---|
| **Familias Kepler** | Qué tipo de gasto se presupuesta: `6` gasto operativo · `5` compras · `7` financieros · `1` inversión. Normalmente `6`. |
| **Presupuestar por sucursal** | Gasto abierto por sucursal en lugar de consolidado. |
| **Control de sobregiro** | *Informativo* (no avisa) · *Advertencia* (avisa) · *Bloqueo* (impide autorizar un gasto que exceda la partida). |

Cuando termines: **Guardar política**. Sólo se puede en borrador o en revisión.

### Partidas

La tabla de partidas (vigente, reservado, comprometido, ejercido, disponible, ocupación) **no se
captura a mano**: sale de los planes de Ventas y Gastos.

## 3 · Ventas

Tres vistas: **Plan**, **Indicadores** y **Conciliación**.

- **Proponer plan del año** (borrador o en revisión): arma la meta por canal y periodo con la venta
  real por el crecimiento de los supuestos. El año va en **13 periodos de cuatro semanas (P1 a
  P13)**; el selector de periodo filtra la tabla.
- Cada meta dice su **origen** en la columna Origen: **Histórico** (real del año anterior por el
  crecimiento), **Estacional** (participación y estacionalidad donde no hay base propia), **Proxy
  canal** (repartida con el promedio de su canal), **Sin base** (no había con qué estimar: queda en
  0 y **se declara**, no se inventa), **Manual** o **Mixto** (el renglón junta celdas de orígenes
  distintos).
- **Meta contra real** se carga sola al entrar a Ventas: real, cumplimiento, crecimiento y
  participación desde el sell-out. **Actualizar real** vuelve a consultar.
- **Proyectar a Análisis:** reparte la meta del plan a metas mensuales del «vs objetivo» del
  sub-módulo Análisis.
- **Indicadores:** crecimiento y participación históricos por canal, directo del sell-out.
- **Conciliación:** contrasta el sell-out contra la facturación contable (cuenta 401). Es
  documental: el real del presupuesto sigue siendo el sell-out.

### Corregir una meta a mano

Si una meta no cuadra con lo que sabes del negocio (una apertura, un cliente que se fue, una
temporada que el motor no vio), corrígela:

1. En **Plan**, elige un **periodo** (P1 a P13). En «Todos (anual)» no hay lápiz, porque la meta se
   guarda por periodo; la pantalla te lo recuerda.
2. En el renglón de la sucursal o canal, pulsa el **lápiz**. Los subtotales y el total no tienen.
3. Escribe la **meta nueva en pesos** y **Guardar meta** (o Enter).

La meta queda con origen **Manual** y **el motor la respeta** cada mañana al rearmar el plan: no
la vuelve a pisar. Sólo se puede con el ejercicio en *borrador* o *en revisión*.

## 4 · Gastos

- **Proponer gastos del año** (borrador o en revisión): arma el gasto desde los egresos reales de
  Kepler (base del año anterior por el crecimiento de los supuestos).
- Arriba, el resumen: presupuesto de gasto, comprometido + ejercido, disponible y ocupación.
- Después, **la concentración**: cuántas partidas se llevan la mayor parte del gasto. Es la respuesta
  a «¿dónde puedo recortar?».
- Abajo, **Presupuesto propuesto**: el detalle por cuenta de mayor, familia y sucursal, con su
  origen, los meses que cubre y el presupuesto anual. Lo que no tiene base no se inventa.

> ⚠️ A diferencia de Ventas, **en Gastos hoy no hay corrección a mano de un renglón** desde la
> pantalla. Si uno no cuadra, anótalo y avisa a Sistemas antes de mandar el ejercicio a firma.

## 5 · Flujo / Resultado

- **Estado de resultados — plan contra real, renglón por renglón:** venta, costo de ventas, margen
  bruto, gasto operativo, gastos financieros e impuestos y resultado, con plan, real y cumplimiento.
  Si falta un lado, lo dice en lugar de ponerlo en cero.
- **Flujo de caja previsto:** se carga solo al entrar; para otro rango cambia Desde / Hasta y
  **Actualizar**. Muestra por semana
  los cobros (cartera de clientes por vencimiento), los pagos (obligaciones), el neto y el saldo
  proyectado. Si no hay saldo inicial de bancos, el saldo se declara (—); si una semana queda en
  negativo, aparece una alerta de liquidez. ⚠️ El flujo es de **toda la empresa**, no del ejercicio.

## 6 · Campañas (opcional, durante el año)

Una campaña la decide una persona; el sistema la evalúa.

- **Nueva campaña:** nombre, tipo, objetivo, canales, fechas, inversión y la **regla de atribución**
  (cómo se medirá el resultado). Sin regla explícita, las ventas vinculadas no prueban efecto.
- **Aportación de proveedor:** sólo la *confirmada* o *aplicada* reduce el gasto neto; la
  *incierta* no.
- **Retorno:** si no hay base para calcularlo, puedes capturar el margen incremental y calcular.

## 7 · Mandar a firma y aprobar

En **Ejercicio**:

1. Revisa los bloqueos y avisos de arriba.
2. **Enviar a autorización** → el ejercicio pasa a *pendiente* y el motor de la mañana deja de
   rearmarlo.
3. Quien tenga el permiso de aprobar pulsa **Aprobar** → pasa a *aprobado*.

**Al aprobar** se materializan las partidas del libro desde los planes, y la pantalla además
proyecta las metas de ventas a Análisis. ⚠️ Si esa proyección falla no avisa: revisa Análisis y, si
no llegaron, usa **Proyectar a Análisis** en Ventas. Si después cambia un plan, **Re-materializar**
re-sincroniza las partidas sin perder los movimientos ya hechos.

---

# PARTE 2 — ¿Alcanza el dinero? (cada semana y cada día)

## 8 · Diagnóstico (`/presupuesto/tesoreria`)

**¿Alcanza?** — si el dinero alcanza para pagar lo que se debe — y el **ciclo de conversión de
efectivo**: cuántos días tardamos en cobrar y en pagar.

⚠️ Mide **la operación completa** (ERP y bancos), no el ejercicio que tengas seleccionado: no cambia
al cambiar de año. Se mira una vez por semana.

## 9 · Ingresos (`/presupuesto/ingresos`)

Cuánto va a entrar **cada día** a bancos y a caja general, y cuánto entró de verdad, por mes,
semana y día. Dos etiquetas dicen hasta qué día están cargados bancos y caja general. Es la base con
la que se propone la capacidad de pago.

## 10 · Capacidad de pago

Cuánto se **autoriza** pagar por día. El sistema lo propone, tú confirmas.

1. Al entrar, la pestaña ya trae la propuesta de hoy a 30 días. Para otro rango, cambia Desde /
   Hasta y **Proponer capacidad**. Por default, la capacidad de cada día hábil es el ingreso
   estimado de ese día más lo que entró en los días inhábiles anteriores (fin de semana, feriados).
   Si no hay estimado para el rango, cae a la cartera y lo dice. Un día sin estimado no se propone
   en cero: se declara.
2. Revisa la tabla y **Confirmar capacidad propuesta**.

**Ajuste manual del día (antes de pasar a Pagos):** arranca en mañana; eliges la fecha, el importe
autorizado y el motivo. Queda en el historial (antes, después, motivo, quién). ⛔ Un día que ya pasó
a Pagos no se puede cambiar.

⭐ **El Calendario de Pagos obedece este techo:** no autoriza un pago que no quepa en la capacidad
del día, y un día sin capacidad no se puede autorizar.

## 11 · Obligaciones

Los pagos recurrentes del plan de gastos (sueldos, renta, luz, comisiones…). El motor las genera
cada madrugada en *propuesta*; también puedes pulsar **Generar del plan**.

1. Marca las que correspondan con la casilla.
2. **Autorizar seleccionadas**.

> ⭐ **Sólo las obligaciones autorizadas entran al Calendario de Pagos.** Las que quedan en
> *propuesta* no se pagan. Autorizar es un acto humano a propósito, y **compromete** el dinero de su
> partida.

Las obligaciones críticas salen marcadas con bandera y su motivo.

---

# PARTE 3 — Durante el año: el dinero de cada partida

Con el ejercicio **aprobado**, cada partida avanza por cinco etapas, más el disponible. Esto es lo
que las mueve hoy:

| Etapa | Qué la mueve |
|---|---|
| **Vigente** | La firma del ejercicio, Re-materializar y las adecuaciones (ampliar, reducir). |
| **Reservado** | Sólo a mano: botón de **movimiento de partida** (⚡) en Ejercicio o Gastos. |
| **Comprometido** | **Autorizar** la obligación en la pestaña Obligaciones, o a mano con ⚡. |
| **Ejercido** y **Pagado** | **Pagar** esa obligación en el Calendario de Pagos, o a mano con ⚡. |
| **Disponible** | Nadie: se calcula. |

El movimiento manual (⚡) también permite **cancelar** una reserva o un compromiso, y **ampliar** o
**reducir** el vigente (adecuaciones).

> ⚠️ **El disponible manda.** Si reservas o comprometes más de lo disponible, el sistema avisa o
> bloquea según el control de sobregiro que elegiste en la política.

### Lo que todavía NO descuenta del presupuesto

Las **órdenes de compra a proveedor**, la **recepción de mercancía** y los **pagos a proveedor**
que ya pasan por el Calendario de Pagos viven en Compras y en Pagos y **no tocan ninguna partida**.
Sólo las obligaciones del presupuesto la mueven.

---

# Resumen del flujo (chuleta)

**Para tener el año firmado:**
1. **Dirección** → ver qué falta.
2. **Ejercicio** → revisar los supuestos que calculó el sistema → **Guardar política**.
3. **Ventas** y **Gastos** → revisar lo propuesto (el motor lo rearma cada mañana).
4. **Flujo / Resultado** → revisar que el año cierre.
5. **Ejercicio** → **Enviar a autorización** → Dirección **Aprueba**.
6. **Obligaciones** → **Autorizar** las que van → entran al Calendario de Pagos.

**Cada semana:** Dirección · Diagnóstico · Ventas «meta vs real».
**Cada día (Tesorería):** Ingresos → Capacidad de pago → Calendario de Pagos.

---

## Reglas que conviene tener claras

- **«Sin datos» no es cero.** Cuando el sistema no puede estimar algo, lo deja en blanco (—) y lo
  explica. Nunca dibuja un cero falso.
- **Lo que tarda, carga solo al entrar.** Meta contra real, el flujo de caja y la propuesta de
  capacidad consultan datos en vivo y tardan unos segundos; el botón de cada una sólo vuelve a
  consultar.
- **Autorizar es humano.** El sistema propone todo; aprobar el ejercicio y autorizar obligaciones lo
  hace una persona.
- **Un supuesto que no cuadra se arregla en la fuente**, no tecleando otro número.
- **Si ves una pantalla vacía**, casi siempre falta que el motor corra (Re-armar ahora), que alguien
  apruebe o que se elija un ejercicio. No hace falta llenarla a mano.
