# Requerimientos — Etiquetas de caja en la TSC TE200

> Para Edgar · actualizado 2026-11-17 · Plan técnico: [`FASE_ETQ_GR_ETIQUETAS_GRANEL.md`](FASE_ETQ_GR_ETIQUETAS_GRANEL.md)

El almacén va a imprimir desde la Suite la etiqueta de caja que hoy sale de Kepler (Operación ›
Compras › **Órdenes de entrada** › «Imprimir Etiquetas»): sin teclear nada, con un código que el
handheld sí lea y con registro de lo impreso. **Las seis decisiones están respondidas** (§1).

> **Estado al 2026-11-19:** construido y probado en local: los datos, las reglas de la etiqueta, la API con su
> bitácora y la pantalla `/almacen/etiquetas`, en 4 commits sin subir. Faltan:
> - verla en un navegador;
> - aplicar el permiso en producción (Sistemas lo confirmó el 2026-11-19: almacenista, encargado de tienda, encargado de bodega y supervisor, 21 personas, y quien entre después con esos puestos);
> - medir la impresora de Suc 08;
> - la prueba física con el handheld;
> - subirlo a producción.
>
> Las direcciones técnicas quedaron como `commercial/receiving/box-labels/*` (dentro de Recepción).

---

## 1. Decisiones

| # | Pregunta | Respuesta (2026-11-17) |
|---|---|---|
| D1 | ¿Fase propia o dentro de Recepción? | **Dentro de Recepción (RE)**, como items `RE.ETQ.*` |
| D2 | ¿De dónde sale cuántas etiquetas? | **De la orden de entrada**. Nada se teclea |
| D3 | ¿Controlador de Windows o comandos directos (TSPL)? | **Las dos** |
| D4 | ¿Bitácora de impresiones? | **Sí** |
| D5 | ¿`70106` o `C70106`? | **`C` cuando sea caja** |
| D6 | ¿Fecha del vale o de la orden? | **El día en que se imprime la etiqueta**: el vale o la orden pueden quedar pendientes |
| — | Medir el rollo en Suc 08 | **Al implementar** |

**Cómo se aplica D6:**
- Es el día de la **primera** impresión, con la hora de la Ciudad de México que da el servidor. El
  reloj de la PC no cuenta. Una etiqueta impresa a las 23:30 del 17-nov dice `320-26`.
- Una **reimpresión repite la fecha** de la primera. Si no, la etiqueta de reemplazo no coincidiría
  con las demás cajas, que es justo lo que hoy hace mal Kepler.
- La bitácora guarda **también** las fechas del vale y de la orden, aunque no se impriman. Con eso se
  mide cuánto tarda la mercancía en quedar etiquetada desde que llegó. El 12 % de las órdenes se
  captura de 1 a 20 días después del vale.

---

## 2. Cómo se trabaja hoy

1. Llega el camión y se captura el **vale de entrada** en Kepler.
2. Se captura la **orden de entrada**: el mismo día en el 88 % de los casos, hasta 20 días después
   en el resto.
3. Al capturarla se oprime «Imprimir Etiquetas»: salen **todas las cajas de todos los renglones de
   una vez**.
4. Se pegan en las cajas. **El código no se puede escanear**, así que nadie escanea la caja.
5. Si una etiqueta se daña, se reimprime **la orden entera** desde Consulta, y sale con **UXC 1**
   y la fecha del documento.
6. **No queda registro** de qué se imprimió ni de si se etiquetó todo lo recibido.

**Volumen (30 días):** 86,155 cajas en 6,353 renglones. Suc 00 etiqueta 1,897 cajas al día en
promedio y llegó a **4,417** en un día; Suc 08, 675 al día (máximo 1,801).

**La Suite ya tiene un Andén de Entrada, pero no se usa:** 38 sesiones en total, la última el
7-oct. Por eso este módulo trabaja sobre la orden de entrada que el almacén ya captura en Kepler, y
no sobre el Andén.

---

## 3. Qué hace mal Kepler, y qué hace la Suite

| Kepler hoy | Evidencia | La Suite |
|---|---|---|
| El código no se lee | Code 39 en un cuadro de ~2 cm: menos de 2 puntos de impresora por barra | Code 128 con el ancho calculado |
| El código no dice que es caja | lleva `70106`, que se lee como 1 pieza | `C70106` (D5) |
| Reimprimir pone UXC 1 y otra fecha | vista previa del 5-nov: «UXC 1 306-26» contra «UXC 18 308-26» | la reimpresión repite los datos guardados la primera vez |
| Todo o nada | para una etiqueta dañada se reimprime la orden completa | se elige el renglón y la etiqueta (p. ej. sólo la 7:20) |
| La caja incompleta se queda sin etiqueta | 7 renglones de media caja en 30 días: 0 etiquetas | la última etiqueta dice sus piezas sueltas |
| Nombre cortado a 24 letras | **226 productos quedan con el mismo texto que otro** (p. ej. «CAJETA ENVINADA TOPPER 1» = 1 KG y 1/2 KG) | nombre completo en dos renglones |
| El pie sale cortado en 2 de cada 3 etiquetas | muestra del 70106 | las tres iguales |
| No hay registro | ninguna tabla | bitácora (D4) |

---

## 4. Lo que corregimos de nuestro propio plan

| El plan del 5-nov decía | Lo medido | Ahora |
|---|---|---|
| UXC del catálogo de Kepler | **39 % de los renglones en caja tienen factor 0 en el catálogo**, y 42 traen otro número | UXC del renglón de la orden, que es con lo que entró esa caja |
| Código de caja del catálogo de Kepler | **43 % de los productos recibidos en caja no lo tienen** | `C` + clave para todos (D5); la Suite ya lo reconoce |
| Sin código de caja no se imprime barra | dejaba sin barra al 43 % | se imprime y se avisa que **Kepler** no lo reconoce |
| Nombre a 24 letras, como Kepler | 226 productos indistinguibles | nombre completo |
| Modo manual tecleado | D2: todo sale de la orden | reimpresión desde la orden |
| Un solo trabajo de impresión | 4,417 etiquetas en un día en Suc 00 | por orden; el volumen grande va por TSPL (D3) |

---

## 5. Valor agregado y automatización

Automatizar bien significa que **el sistema prepara y controla, y la persona aprieta un botón**.
No se imprime solo: la impresora puede estar sin rollo y las cajas pueden no estar ahí.

- **Cola automática:** cada orden de entrada aparece sola en minutos (medido: una orden capturada
  a las 18:23 ya estaba en la Suite a las 18:26), marcada *por etiquetar*.
- **Un clic por orden:** cajas, UXC, fecha y código ya calculados.
- **Control:** aviso de órdenes sin etiquetar después de N horas, y la cifra diaria «cajas
  etiquetadas / cajas recibidas» por sucursal. Hoy no se sabe.
- **El código se vuelve útil:** con `C`+clave legible se puede escanear la caja en el checado de
  pedidos, en los conteos de inventario y en el surtido.
- **Calidad del catálogo:** la pantalla le da a Compras la lista de productos con factor de caja
  en 0 y sin código de caja en Kepler, para que los corrija allá (la Suite no escribe en Kepler).
- **Volumen:** por TSPL la impresora numera sola (1:20 … 20:20), así que aguanta los días de
  4,000 etiquetas.

---

## 6. Requerimientos funcionales

| ID | Requerimiento | Criterio de aceptación | Prioridad |
|---|---|---|---|
| RF-01 | Cola de órdenes de entrada (`X-A-40`) de la sucursal del usuario, con sus renglones, cajas y estado (por etiquetar · impresa · reimpresa) | La orden `0000474` de Suc 08 muestra el 70106 con 20 cajas; la suma del mes cuadra con 86,155 | Alta |
| RF-02 | Imprimir una orden o un renglón con un clic, sin teclear nada | 20 etiquetas, 1:20 a 20:20, en 7 filas de 3 | Alta |
| RF-03 | Reimprimir eligiendo renglón y etiquetas | Reimprimir la 7:20 sale idéntica a la primera (UXC 18, misma fecha) | Alta |
| RF-04 | Código en Code 128: `C`+clave cuando la unidad es caja; el de la unidad en los demás casos | 20 de 20 lecturas con el handheld, por las dos vías | Alta |
| RF-05 | UXC del renglón de la orden, no del catálogo | Un producto con factor 0 en el catálogo imprime el factor del renglón | Alta |
| RF-06 | Fecha con la cuenta de Kepler (1-ene = 0) sobre el día de la primera impresión (D6), hora de la Ciudad de México; la reimpresión repite la guardada | Impresa el 17-nov sale `320-26`, también a las 23:30; reimpresa el 20-nov sigue `320-26` | Alta |
| RF-07 | Nombre completo en dos renglones | «CAJETA ENVINADA TOPPER 1KG» y «… 1/2 KG» se distinguen | Alta |
| RF-08 | Caja incompleta con su etiqueta, que dice las piezas sueltas | La orden `0000685` de Suc 01 imprime sus 4 medias cajas | Media |
| RF-09 | Bitácora de cada impresión: quién, qué, cuántas, por qué vía, si fue reimpresión, la fecha impresa y las fechas del vale y de la orden | Probada contra base real con el envío de la pantalla | Alta |
| RF-10 | Aviso de órdenes sin etiquetar después de N horas | Una orden de prueba sin imprimir aparece en el aviso | Media |
| RF-11 | Avisos por renglón: «Kepler no reconoce este código», «factor 0 en Kepler», «caja incompleta» | Se ven en la vista previa | Media |
| RF-12 | Lista para Compras de productos con factor 0 o sin código de caja en Kepler | Coincide con la medición (896 productos sin código, 1,672 renglones con factor 0) | Media |
| RF-13 | Vista previa a tamaño real | Lo que se ve es lo que sale en el rollo | Media |

## 7. Requerimientos no funcionales

| ID | Requerimiento |
|---|---|
| RNF-01 | Todo dato sale del ODS de Kepler por vista; sin importer ni tabla copiada |
| RNF-02 | Dos vías de impresión (D3): navegador con el controlador de Windows, y TSPL con contador de la impresora. El transporte del TSPL se decide al medir la impresora |
| RNF-03 | El código se lee al primer intento (20 de 20 en la prueba física) |
| RNF-04 | Fecha en hora de la Ciudad de México |
| RNF-05 | Permiso `ALMACEN_ETIQUETAS_CAJA`, asignado en prod al puesto de recepción; cada quien ve su sucursal |
| RNF-06 | La pantalla responde en menos de 500 ms y dice la hora del último dato de Kepler |
| RNF-07 | Lo que no se pudo medir se dice; nunca se imprime como cero |
| RNF-08 | Una sola pieza de impresión en `libs/`, compartida con el checado de pedidos (GP.4) |

---

## 8. Plan por capas

1. **Datos** — ✅ formas de Kepler leídas · ⬜ vista de órdenes de entrada con cajas, UXC del
   renglón, fecha y código de caja · ⬜ medir rollo e impresora (al implementar).
2. **Dominio** — pieza de impresión en `libs/`, plantilla de caja, fecha, código por unidad, caja
   incompleta, TSPL.
3. **API** — cola de órdenes con estado, lista de defectos del catálogo, bitácora, permiso.
4. **Pantalla** — `/almacen/etiquetas`: cola, imprimir, reimprimir, avisos, vía A/B. Cierra con
   la prueba física en Suc 08: el 70106 × 20 leído con el handheld por las dos vías.

**Meta de cierre:** Suc 08 etiqueta desde la Suite el 100 % de sus cajas durante 2 semanas, sin
etiquetas ilegibles, medido con la bitácora.

---

## 9. Pendientes y riesgos

- [x] Leer las formas de etiquetas de Kepler
- [x] Responder D1 a D6
- [ ] Medir el rollo y la impresora (USB o red) — al implementar, Suc 08
- [ ] Avisar al almacén que las etiquetas **reimpresas** en Kepler traen UXC 1 y otra fecha

| Riesgo | Mitigación |
|---|---|
| La impresión de la Suite nunca se probó en la TSC real | prueba física por las dos vías antes de soltar |
| Si la TE200 sólo tiene USB, el TSPL necesita un programa en la PC o cambiar el controlador | se mide primero; la vía del navegador sigue disponible |
| El 43 % de los productos no tiene código de caja en Kepler: sus pantallas no leerán `C`+clave | aviso + lista para Compras |
| Si la ingesta de Kepler se atrasa, la orden tarda en aparecer | la pantalla dice la hora del último dato |
| La etiqueta dice cuándo se etiquetó, no cuándo llegó (D6) | la bitácora guarda la fecha del vale; al escanear la caja se puede ver |
| Si la orden queda pendiente, la caja espera sin etiqueta, como hoy (D2) | la bitácora mide ese atraso; si resulta grande, se decide si se etiqueta desde el vale |
