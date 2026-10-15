# Caja General: cómo rendir cuentas del día

**Para:** la cajera que cierra la caja y el supervisor que autoriza.
**Pantalla:** Finanzas › Caja General (`/finanzas/caja-general`), bloque **Cierre de la jornada**.

> ⚠️ Esta guía describe la pantalla después de los cambios del plan de Caja General (`[CGP]`), que
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
| Autorizar | **Otra persona** | El supervisor autoriza. Quien cerró no puede autorizar. |

---

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

## 5. Autorizar (supervisor)

En la lista **Cortes**, el corte cerrado muestra **«Autorizar»**. Lo autoriza **otra persona**: si
quien lo cerró intenta autorizarlo, la fila dice «Quien cerró el corte no puede autorizarlo».

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
| «Marcaste que no hay efectivo, pero la reja trae piezas» | Se marcó «no hay efectivo» con billetes anotados (la «reja» es la lista de billetes y monedas). | O se cuenta lo que hay, o se marca que no hay nada; no las dos. |

## Jornadas atrasadas

Cuando una jornada quedó sin cerrar, la pantalla lo avisa y el botón la nombra. Se cierran **en
orden**.

> ⛔ **Pendiente de decidir (Edgar y Contabilidad):** qué efectivo se cuenta para cerrar una jornada
> que ya pasó, porque el cajón de hoy no es el de ese día. Hasta que se decida, **pregunta antes de
> contar** una jornada atrasada.

## A quién llamar

> ⬜ **Por definir:** el contacto de soporte de Caja General (lo define Edgar).
