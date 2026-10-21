# Caja General: cómo rendir cuentas del día

**Para:** quien cierra la caja (María del Carmen Rodríguez y Mayra Gutiérrez) y quien la supervisa
(María Gutiérrez). Dirección es la suplente de la supervisora.
**Pantallas:** Finanzas › Caja General › **Captura** (`/finanzas/caja-general`) para cerrar el día, y
**Arqueos** (`/finanzas/caja-general/arqueos`) para revisarlo.

> ⭐ **El día de la caja, en una línea:** la cajera cierra su corte **antes de irse**; la supervisora lo
> revisa **a la mañana siguiente, antes de las 12:00**, y lo autoriza o lo observa. Si un corte no se
> cierra, al otro día la caja **no captura** hasta cerrarlo.

> ⚠️ Esta guía describe la pantalla después de los cambios de Caja General (`[CGP]` y la supervisión `[CGS]`), que
> **todavía no se revisaron en pantalla con una cajera**. Si un texto no coincide con lo que ves, avisa:
> se corrige la guía.

---

## Los cinco pasos

Debajo del título **Cierre de la jornada** se ve en qué paso va el corte:

**Abrir → Contar a ciegas → Revisar la diferencia → Cerrar → Autorizar**

El paso marcado con la flecha es el que sigue. Abajo dice, en una frase, qué hacer.

| Paso | Quién | Qué se hace |
|---|---|---|
| Abrir | Cajera | Se abre el corte de la jornada. Lo hace el mismo botón de rendir cuentas. |
| Contar a ciegas | Cajera | Se cuenta el efectivo **sin ver cuánto debería haber**. |
| Revisar la diferencia | Cajera | Al guardar el conteo aparece si cuadra, sobra o falta. |
| Cerrar | Cajera | Se cierra el corte con lo contado. |
| Autorizar | **La supervisora** | Lo revisa al día siguiente y lo autoriza, o lo observa con un motivo. Quien abrió, cerró o capturó en el corte no lo puede autorizar. |

---

## 0. Si la caja está bloqueada

Si el día anterior quedó **sin corte cerrado**, al entrar a Captura verás un aviso rojo:
**«La caja está bloqueada.»** Mientras siga así, no se pueden registrar ni confirmar movimientos.

- **Lo normal:** toca **«Rendir cuentas de esa jornada»** y cierra ese corte (pasos 1 a 4). Al cerrarlo,
  la caja se desbloquea sola.
- **Si hace falta pagar algo antes de cerrarlo** (un pago urgente), pide a la supervisora una **llave de
  emergencia**. Ella la da desde Arqueos, con tu nombre y el motivo. Sirve **sólo hasta que termine el
  día**, y mientras la uses la pantalla te lo recuerda. La llave **no cierra el corte**: el corte
  pendiente se cierra igual.

> Nadie se da la llave a sí mismo. Si la supervisora no está, la da Dirección.

## 1. Rendir cuentas

Toca el botón del bloque **Cierre de la jornada**. Según el caso dice:

- **«Cerrar jornada y rendir cuentas»**: hoy no hay corte; se abre y sigue directo al conteo.
- **«Rendir cuentas del día»**: ya hay un corte abierto; va directo al conteo.
- **«Rendir cuentas del 12-oct»** (u otra fecha): hay **jornadas atrasadas** sin cerrar. Se cierran
  **en orden, de la más vieja a la más nueva**. El aviso amarillo dice cuáles faltan.

> ⛔ No intentes cerrar el día de hoy si hay jornadas atrasadas: las de atrás ya no se podrían cerrar
> desde la pantalla.

Si el botón está **girando**, la pantalla está midiendo. Espera unos segundos.

## 2. Contar el efectivo

En la ventana del corte:

1. Arriba dice de qué corte y de qué jornada es (por ejemplo, «Corte CC-2026-00009 · jornada del
   13-oct»). Si dice **«Este corte es de una jornada que ya pasó»**, lee el apartado de jornadas
   atrasadas, más abajo.
2. Anota **cuántas piezas** hay de cada billete y moneda. El importe se calcula solo.
3. La **morralla** (monedas de menos de 50 centavos) va en su renglón, en pesos.
4. Toca **«Guardar conteo»**.

**Si no hay efectivo:** con todo en cero, marca **«Conté y no hay efectivo en la caja»** y toca
**«Sellar en $0.00»**. Sin esa marca el botón no se activa, porque «no conté» y «no hay nada» son
cosas distintas.

## 3. Revisar la diferencia

Al guardar, el conteo queda **sellado** y aparece el resultado: **cuadra**, **sobra** o **falta**.
La lista de billetes queda de **sólo lectura**: ya no se puede corregir tecleando.

- **Si cuadra:** sigue al paso 4.
- **Si sobra o falta:** puedes **recontar una sola vez**. Toca **«Recontar»**: la lista se vacía, cuenta
  **todo otra vez desde cero**, escribe **por qué** recuentas (por ejemplo, «faltó contar un billete
  de 50») y toca **«Guardar reconteo»**. El primer conteo queda guardado junto al segundo. Si te
  equivocaste al tocar «Recontar», usa **«Volver al conteo sellado»**.
- Si después del reconteo sigue sin cuadrar, **se cierra igual**: la diferencia se registra, no se
  esconde.

## 4. Cerrar el corte

Toca **«Cerrar corte»**.

Si mientras contabas entró un movimiento de la jornada, el esperado cambió. La ventana lo dice con
las dos cifras y el botón cambia a **«Confirmar $1,800.00 y cerrar»** (con la cifra nueva). Revisa la
cifra y confirma.

## 5. La revisión de la mañana (supervisora)

**Cuándo:** cada mañana, **antes de las 12:00**. A las 12:00, los cortes que sigan sin revisar se avisan
también a **Dirección**, que es la suplente.

**Dónde:** abre **Arqueos**, o la bandeja **«Arqueos de caja por autorizar»** de *Mi trabajo*, que lleva
ahí mismo. Arriba dice **«N cortes esperan tu revisión»**, del más viejo al más nuevo. Toca uno.

El panel del día abre con **La revisión**: una lista de lo que se revisa, cada cosa con **Cumple**,
**No cumple** o **Sin medir**, y su explicación con la cifra:

| Qué se revisa | Si no cumple, qué significa |
|---|---|
| Se cerró el mismo día | Se cerró días después. |
| Las piezas suman lo contado | El conteo pieza por pieza no da el total. |
| Abrió con lo que contó el corte anterior | El fondo de arranque no es lo que se contó ayer: la cuenta arrastra esa diferencia. |
| La cuenta tiene respuesta | El «debería haber» salió negativo o sin base: **no se autoriza, se observa**. |
| La diferencia está explicada | Sobra o falta dinero y la caja no escribió por qué. |
| Todo gasto tiene firma, documento o motivo | Hay un gasto sin respaldo. |
| Lo capturado a mano es del día | Hay un movimiento a mano con la fecha de otro día. |
| Nada se capturó después de cerrar | Se registró algo de ese día después del cierre y quedó fuera del corte. |
| Nada se editó después de cerrar | Un movimiento del corte cambió después de cerrarlo. |
| Lo de la caja fuerte llegó al libro | **Sin medir** por ahora: todavía no hay regla. |

Debajo de la lista están la cuenta, lo que se contó pieza por pieza y **los movimientos del libro** de
esa jornada (y, como segundo testigo, lo que registró Control).

**Dos decisiones posibles:**

- **Autorizar.** Si todo cumple, se autoriza directo. Si algo no cumple o hay diferencia, la pantalla
  pide una **nota** (10 caracteres o más) que diga por qué lo autorizas así.
- **Observar.** Si algo está mal, escribe **qué encontraste** y toca **Observar**. El corte regresa a la
  caja con tu motivo. **Ninguna cifra cambia.** Cuando la caja responda, el corte vuelve a tu lista.

> ⛔ **Los cortes en los que tú capturaste, los revisa Dirección.** La pantalla te los cuenta aparte
> («los revisa otra persona»). Es la misma regla de las dos llaves: quien hizo algo no lo firma.

**La llave de emergencia** también se da desde Arqueos: cuando la caja está bloqueada aparece la sección
**«La caja está bloqueada por la jornada del…»**. Elige para quién es, escribe por qué hace falta y toca
**«Dar llave hasta el fin del día»**.

## 6. Si te observan un corte (caja)

Al entrar a Captura verás un aviso: **«La supervisora observó un corte»**, con lo que encontró. Toca
**Responder**, explica qué pasó (10 caracteres o más) y envía. El corte vuelve a la supervisora.

> La respuesta **no cambia el corte**. Si un movimiento estaba mal (cuenta, monto o día), regístralo
> como **ajuste en la jornada de hoy**, mencionando el folio original. Lo firmado no se reescribe.

---

## Si algo sale mal

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| **«Corte sin medir»** y el botón **«Reintentar»** | La pantalla no pudo leer si hay un corte abierto. | Toca **Reintentar**. Si sigue, avisa. |
| «No se pudo saber si hay jornadas sin corte antes de hoy» | No pudo leer las jornadas atrasadas, y abrir sin saberlo podría dejarlas sin cerrar. | Toca **Reintentar**. No abras a ciegas. |
| **«Sólo lectura: … necesitan el permiso «Capturar en Caja General»»** | Tu usuario puede ver la caja pero no capturar ni cerrar. | Pide el permiso. |
| En la fila del corte: «Autorizar necesita el permiso…» | Tu usuario no puede autorizar. | Que autorice el supervisor. |
| Un **mensaje en rojo dentro de la ventana** | El servidor no aceptó la acción y dice por qué. | Lee la frase: dice qué pasó y cómo se corrige. El mensaje se queda hasta que vuelvas a intentar. |
| «Quien cerró el corte no puede autorizarlo» | Es la doble llave: dos personas distintas. | Que autorice otra persona. |
| «Capturaste o cancelaste movimientos de este corte» | Quien capturó en un corte no lo firma. | Lo revisa la suplente (Dirección). |
| «No se puede capturar: la jornada del… no tiene corte cerrado» | El candado de la caja (apartado 0). | Cierra ese corte, o pide la llave de emergencia. |
| «No se puede cerrar otro corte: hay 2 cerrados sin revisar» | Hay dos cortes que nadie revisó. | Que la supervisora (o la suplente) los revise primero. |
| «Este movimiento ya está en un corte cerrado: no se edita ni se borra» | Lo firmado no se toca. | Registra un ajuste en la jornada de hoy. |
| «Marcaste que no hay efectivo, pero la reja trae piezas» | Se marcó «no hay efectivo» con billetes anotados (la «reja» es la lista de billetes y monedas). | O se cuenta lo que hay, o se marca que no hay nada; no las dos. |

## Jornadas atrasadas

Cuando una jornada quedó sin cerrar, la pantalla lo avisa y el botón la nombra. Se cierran **en
orden**.

> ⛔ **Pendiente de decidir (Edgar y Contabilidad):** qué efectivo se cuenta para cerrar una jornada
> que ya pasó, porque el cajón de hoy no es el de ese día. Hasta que se decida, **pregunta antes de
> contar** una jornada atrasada.

## A quién llamar

> ⬜ **Por definir:** el contacto de soporte de Caja General (lo define Edgar).
