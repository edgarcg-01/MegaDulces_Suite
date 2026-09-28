# Guía de usuario — Presupuestos

> **Para quién es esto:** la persona que arma y opera el presupuesto (Finanzas / Dirección).
> No hace falta saber nada técnico. Ruta en la app: **Finanzas › Presupuesto** (`/finanzas/presupuesto`).
>
> **La idea del módulo en una frase:** el sistema **arma solo** el presupuesto desde la historia de
> ventas (ODS) y los egresos (Kepler); vos solo **ajustás los supuestos del año** y **autorizás**.
> No se captura nada desde cero.

---

## Antes de empezar: cómo está organizada la pantalla

Arriba hay dos grupos de pestañas:

**Armar el presupuesto** (el trabajo de planeación, una vez al año):
`Ejercicio` · `Ventas` · `Gastos` · `Flujo / Resultado` · `Campañas`

**Programación de pagos** (lo que alimenta el Calendario de Pagos):
`Capacidad de pago` · `Obligaciones`

Todo lo que hagas ocurre **sobre un ejercicio seleccionado** (ej. "Presupuesto operativo 2027").
Si una pestaña dice *"Elegí un ejercicio…"*, andá primero a **Ejercicio** y seleccioná uno.

### El ciclo de vida de un ejercicio (importante)

Un ejercicio pasa por estos estados, en orden. **Qué podés hacer depende del estado:**

| Estado | Qué significa | Qué podés hacer |
|---|---|---|
| **borrador** | Recién creado, se está armando | Ajustar supuestos · Proponer plan y gastos · Enviar a autorización |
| **en_revisión** | En ajuste | Igual que borrador |
| **pendiente** | Enviado, esperando visto bueno | **Aprobar** (quien autorice) |
| **aprobado** | Autorizado y en operación | Mover partidas (reservar/ejercer/pagar) · Re-materializar · Cerrar |
| **cerrado** | Terminado | Solo consulta |

> ⚠️ Los **supuestos** y los botones **"Proponer…"** solo funcionan en **borrador / en_revisión**.
> Una vez **aprobado**, el plan queda fijo y el trabajo pasa a operar los pagos.

---

# PARTE 1 — Armar el presupuesto (una vez al año)

Seguí las pestañas de izquierda a derecha. El orden es el flujo.

## Paso 1 — Ejercicio

Acá creás el presupuesto del año y ajustás **lo único que decide un humano**: los supuestos.

### 1.1 Crear el ejercicio

Tenés dos caminos:

- **Nuevo ejercicio** (botón arriba a la derecha): abre un diálogo con Nombre, Año fiscal y
  Escenario (Base / Conservador / Expansión). Llenalo y **Crear**. Nace en *borrador*.
- **Copiar del año anterior** (botón, con el ejercicio seleccionado): clona el ejercicio actual a
  uno nuevo en *borrador*, sin autorizaciones. Es la vía recomendada si ya tuviste presupuesto el
  año pasado — arrancás con todo puesto y solo ajustás lo que cambió.

Los ejercicios aparecen como **chips** (botones) arriba; hacé clic en uno para seleccionarlo.

### 1.2 Ajustar los "Supuestos del año" ⭐ (tu trabajo principal)

Es el panel resaltado, con el subtítulo *"lo único que ajustás; el sistema propone ventas y gastos
con esto"*. Dos columnas:

- **Ventas — crecimiento por canal (%):** cuánto esperás crecer respecto al año pasado, por cada
  canal. Hay un campo **Respaldo** para los canales sin valor propio.
- **Gastos:**
  - **Crecimiento (%):** cuánto suben los gastos respecto al año anterior.
  - **Familias Kepler:** qué tipo de gasto presupuestar. `6` = gasto operativo · `5` = compras ·
    `7` = financieros · `1` = inversión. (Normalmente `6`.)
  - **Presupuestar por sucursal:** marcalo si querés el gasto abierto por sucursal en vez de
    consolidado.

Cuando termines: **Guardar supuestos**.

> 💡 No inventás cifras acá. Solo decís "espero crecer X% en tal canal". El sistema hace el resto.

### 1.3 La tabla de partidas (solo lectura)

Debajo verás la tabla de **partidas** con columnas Vigente / Reservado / Comprometido / Ejercido /
Disponible / Ocupación. **No se captura a mano.** Estará vacía hasta que apruebes el ejercicio: las
partidas se **materializan** automáticamente de los planes de Ventas y Gastos. Más sobre esto en el
Paso 5.

---

## Paso 2 — Ventas

Con los supuestos guardados, generás el plan de ventas del año.

### 2.1 Proponer el plan

Botón **"Proponer plan del año"** (solo en borrador/en_revisión). Un clic: el sistema arma el plan
usando la historia real de ventas × el crecimiento que pusiste en los supuestos. No hay que capturar
metas celda por celda.

Cada meta trae su **Origen**:
- **Histórico** — real del año anterior × crecimiento (lo más confiable).
- **Estacional** — donde no hay base, se usa participación + estacionalidad.
- **Sin señal** — no había con qué estimar: **no se inventa** (queda en blanco).
- **Manual** — ajustada a mano.

La línea de "Última propuesta" te dice cuántas metas salieron de cada origen.

### 2.2 Ver "meta vs real" (opcional, tarda unos segundos)

Botón **"Cargar meta vs real"** (o "Actualizar real"). Consulta el sell-out del ODS y llena las
columnas **Real**, **Cumpl.** (cumplimiento), **CREC** (crecimiento) y **PART** (participación).

> Este cálculo consulta datos en vivo y **tarda unos segundos** — por eso no carga solo, hay que
> pedirlo con el botón. La propuesta del plan **no** lo necesita.

Podés filtrar por **Periodo (P1–P13)** con el selector.

### 2.3 Las otras dos vistas (pestañas dentro de Ventas)

- **Indicadores:** CREC y PART históricos por canal, directo del sell-out. Reemplaza el seguimiento
  manual del Excel.
- **Conciliación:** contrasta el sell-out contra la facturación contable (cuenta 401). Es
  documental — el real del presupuesto sigue siendo el sell-out.

### 2.4 Proyectar a Análisis (opcional)

Botón **"Proyectar a Análisis"**: reparte la meta del plan (13×4) a metas mensuales del "vs objetivo"
del sub-módulo Análisis. Esto también pasa **automáticamente al aprobar** el ejercicio, así que
normalmente no hace falta tocarlo.

---

## Paso 3 — Gastos

Botón **"Proponer gastos del año"** (solo en borrador/en_revisión). Un clic arma el presupuesto de
gastos desde los egresos reales de Kepler (base del año anterior × el crecimiento de los supuestos).

Verás dos bloques:

1. **Partidas de gasto** (arriba) — vacías hasta aprobar; se materializan del propuesto.
2. **Presupuesto propuesto** (abajo) — el detalle por **cuenta mayor × mes**, con su **Origen**
   (mismo criterio que ventas: histórico / estacional / sin señal). Al pie, el **Total propuesto del
   año**.

La línea de "Última propuesta" resume cuántas cuentas salieron de cada origen y cuántas quedaron
"sin señal" (que **no se inventan**).

---

## Paso 4 — Flujo / Resultado

Pantalla de revisión, para ver si el presupuesto cierra bien.

### 4.1 Resultado presupuestado (carga solo)

Arriba: **Ingresos (plan) − Egresos (plan) = Resultado**, con el **Margen %**, y el desglose mes a
mes. Sale directo de los dos planes (ventas y gastos). Si falta un lado, lo **dice** (no lo pone en
cero).

### 4.2 Flujo de caja previsto (opcional, tarda unos segundos)

Elegí un rango de fechas (Desde / Hasta) y **Actualizar**. Muestra por semana: Cobros (cartera por
vencimiento), Pagos (obligaciones), Neto y Saldo proyectado.

> Consulta la cartera en vivo y **tarda unos segundos** — por eso es con botón.
> Si no hay saldo inicial de bancos, el saldo proyectado se **declara** (—); el neto por semana sí
> es real. Si hay semanas con saldo negativo, aparece una **alerta de liquidez**.
> Nota: el flujo es a nivel **empresa**, no por ejercicio.

---

## Paso 5 — Autorizar (el momento clave)

Con Ventas y Gastos propuestos y el Resultado revisado, en la pestaña **Ejercicio**:

1. **Enviar a autorización** → el ejercicio pasa a *pendiente*.
2. Quien autorice pulsa **Aprobar** → pasa a *aprobado*.

**Al aprobar, el sistema hace dos cosas solo:**
- **Materializa las partidas:** convierte los planes de Ventas y Gastos en las partidas del libro de
  5 estados (las tablas que estaban vacías se llenan).
- **Proyecta las metas** de ventas al sub-módulo Análisis.

Si después cambiás un plan, usá **Re-materializar** (botón con el ejercicio aprobado) para
re-sincronizar las partidas sin perder los movimientos ya hechos.

---

## Paso 6 — Campañas (durante el año, opcional)

Definición manual legítima (una campaña la decide una persona) + evaluación automática.

- **Nueva campaña:** nombre, tipo, objetivo, canales, fechas, inversión y — importante — la
  **regla de atribución** (cómo se medirá el resultado). Sin regla explícita, las ventas vinculadas
  no prueban efecto real.
- **Activar / Cerrar** la campaña con los botones del detalle.
- **Aportación:** registrá lo que aporta un proveedor. Solo la **confirmada/aplicada** reduce el
  gasto neto; la **incierta** no. Confirmás una aportación con el ✓.
- **Retorno (ROI):** si no hay base para calcularlo, podés meter el margen incremental a mano y
  **Calcular**.

---

# PARTE 2 — Programación de pagos (alimenta el Calendario)

Estas dos pestañas convierten el presupuesto aprobado en lo que el **Calendario de Pagos** va a usar.

## Paso 7 — Capacidad de pago

Cuánto se puede pagar por día. El sistema la **propone**, vos **confirmás**.

1. Elegí un rango (Desde / Hasta) y **Proponer capacidad**. El sistema deriva una capacidad diaria
   desde la cobranza esperada (flujo).
2. Revisá la tabla (Día · Capacidad propuesta · Cobranza de la semana) y **Confirmar capacidad
   propuesta**.

> Si no hay cartera para estimar, lo **dice** (no inventa un número).

**Ajuste manual de un día** (abajo): si necesitás cambiar un día puntual, elegí la fecha, poné el
importe autorizado y un **motivo del cambio**, y **Guardar**. Queda registrado en el historial (antes
/ después / motivo / quién).

## Paso 8 — Obligaciones

Los pagos recurrentes (luz, renta, sueldos, comisiones…). Se **auto-generan**, vos **autorizás**.

1. **Generar del plan:** crea las obligaciones recurrentes del plan de gastos aprobado, en estado
   **propuesta** (aún no cuentan).
2. Marcá las que correspondan con el checkbox y **Autorizar seleccionadas**.

> ⭐ **Solo las obligaciones autorizadas entran al Calendario de Pagos.** Las que quedan en
> *propuesta* no se pagan. Autorizar es un acto humano a propósito.

Las obligaciones **críticas** salen marcadas con una banderita 🚩 (con su motivo).

---

# PARTE 3 — Durante el año: operar el presupuesto

Con el ejercicio **aprobado**, cada partida se maneja con **movimientos**. En las pestañas
**Ejercicio** o **Gastos**, en la fila de una partida activa, el botón ⚡ (rayo) abre el diálogo de
movimiento.

El presupuesto se consume en 5 estados, en este orden:

1. **Reservar** — aparto dinero (todavía no comprometido con nadie).
2. **Comprometer** — hay un compromiso firme (ej. una orden). Puede venir *desde una reserva*.
3. **Ejercer** — el gasto ya ocurrió.
4. **Pagar** — ya se pagó.
5. **Cancelar** — libero una reserva o un compromiso.

También existen **Ampliar** y **Reducir** (adecuaciones del vigente).

> ⚠️ **El disponible manda.** Si intentás reservar/comprometer más de lo disponible, el sistema
> **bloquea o avisa** según el nivel de control de esa partida. Esto es a propósito: es el control
> antes de gastar.

---

# Resumen del flujo (chuleta)

**Una vez al año:**
1. **Ejercicio** → Crear o Copiar → **Guardar supuestos del año**
2. **Ventas** → Proponer plan del año
3. **Gastos** → Proponer gastos del año
4. **Flujo / Resultado** → revisar que cierre
5. **Ejercicio** → Enviar a autorización → **Aprobar** (materializa partidas + proyecta metas)
6. **Capacidad de pago** → Proponer → Confirmar
7. **Obligaciones** → Generar del plan → **Autorizar** → entran al Calendario de Pagos

**Durante el año:**
- Operar partidas con ⚡ (reservar → comprometer → ejercer → pagar)
- Campañas (definir + evaluar)
- Ventas → "meta vs real" e Indicadores para seguimiento

---

## Reglas que conviene tener claras

- **"Sin datos" no es cero.** Cuando el sistema no puede estimar algo, lo deja en blanco (—) y lo
  explica. Nunca dibuja un cero falso.
- **Lo que tarda, se pide con botón.** "Cargar meta vs real", el flujo de caja y "Proponer capacidad"
  consultan datos en vivo y tardan unos segundos. El resto de las pantallas abre al instante.
- **Autorizar es humano.** El sistema propone todo; aprobar el ejercicio y autorizar obligaciones lo
  hace una persona.
- **No se captura desde cero.** Si ves una pantalla vacía, casi siempre es porque falta *Proponer* o
  *Aprobar*, no porque tengas que llenarla a mano.
