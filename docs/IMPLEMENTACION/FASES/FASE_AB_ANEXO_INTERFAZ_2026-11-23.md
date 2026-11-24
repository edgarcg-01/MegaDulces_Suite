# FASE AB · Anexo — La interfaz de Autoabasto, rediseñada (2026-11-23)

> **Qué documenta este anexo:** **sólo la interfaz nueva** de `/almacen/autoabasto`. El motor, el
> modelo de datos, los permisos y el flujo a Kepler viven en
> [`FASE_AB_AUTOABASTO.md`](FASE_AB_AUTOABASTO.md) y no se repiten aquí.
>
> **Pedido de Edgar (2026-11-23):** rediseñar la interfaz basándose casi al 100 % en
> `/telemarketing/cotizaciones`, con tres condiciones suyas, textuales:
> «no podemos engañar al usuario con información falsa» · «el proceso tiene que ser casi 100 %
> automático» · «darle al usuario sólo la información que necesita validar o revisar rápidamente,
> dejando la posibilidad de un agregado manual».
>
> **Maqueta:** artefacto privado de Edgar, dos tableros — *lo que ve al entrar* y *el pedido abierto*.

---

## 1. Qué cambia, en una frase

La pantalla dejaba a la vista **596 renglones para que alguien los revisara**, y nadie revisa 596.
Ahora el pedido ya está hecho y la pantalla muestra **sólo lo que pide una decisión**; el detalle
está a un clic y se abre **ya partido en las órdenes en que se va a armar**.

---

## 2. Las cinco preguntas, por escrito

Obligatorias antes de generar una interfaz ([`diseno` §0b](../../../.claude/skills/diseno/SKILL.md)).

**2.1 ¿Qué debe ver el usuario, y en qué orden?**

1. **Lo que impide o condiciona mandar** — hoy son cuatro cosas, cada una con su acción al lado.
2. **Lo que sale** — a quién, cuánto, en qué unidades y en cuántas órdenes. Resumen, no lista.
3. **Lo que puede agregar a mano** — el buscador, con el porqué escrito.
4. **De dónde salen los números y qué no se midió** — en el pie, siempre.

El orden es el de la decisión: primero lo que frena, después lo que sale, al final lo que el
usuario quiera sumar. La frase que la pantalla tiene que contestar en dos segundos es
**«¿qué tengo que revisar antes de que salga mi pedido?»**.

**2.2 ¿Qué NO debe ver?**

Fuera, medido contra la pantalla que se reemplaza: los **7 indicadores** de la cabecera, las
**4 casillas** de «¿hasta dónde pides?», las **6 pestañas**, los **2 filtros**, el buscador de la
tabla y **la tabla completa de renglones en la vista de entrada**.

Ninguno ayudaba a decidir. La tabla era el peor: afirmaba una revisión que no ocurre.

**2.3 ¿Qué accesibilidad necesita la información?**

Operations, densidad compact++. Objetivos táctiles de 44 px en toda acción; 36 px sólo en las
acciones secundarias dentro de una fila de excepción, que nunca son la única salida. Texto
mínimo 12 px y sólo para notas al pie. La tabla del detalle lleva `scope`, encabezado fijo y
bandas de grupo como filas con `colspan`, no como `<div>` flotantes. Los números en `tabular-nums`.
Nada depende sólo del color: cada excepción lleva **icono + rótulo + acción**.

**2.4 ¿Está ligada a otro proceso?**

Sí, a tres: el **traspaso** queda hecho en el almacén de la matriz al mandarlo (no pasa por
Compras); la **requisición a proveedor** entra al calendario de compras; y el **pedido atorado**
pertenece a la cola de reclamación. La pantalla lo dice con palabras en cada bloque en vez de
suponer que el usuario lo sabe.

**2.5 ¿Este proceso la debe ver?**

Sí. El almacenista de sucursal es quien decide qué sale de su mesa, y es el único que puede
contestar las excepciones. Compras ve el otro lado en `/compras/pedido`.

---

## 3. Lo medido, con su número

Todo contra **prod, sólo lectura, 2026-11-23**, sobre la requisición **`RQ-2026-03239`**
(Morelia Madero → Morelia Abastos, **294 renglones**, **$158,502.59**), cruzada con
`analytics.v_erp_product_lines` (PQ.144) y `analytics.v_product_unit_ladder`.

| Qué | Número |
|---|---|
| Renglones | 294 en **102 líneas** |
| Línea más grande | **12 renglones** (DIST DE LA ROSA) |
| Líneas de 1 o 2 renglones | la mayoría |
| Renglones en su unidad de compra entera | 134 |
| Renglones que bajan a unidad menor | 160 |
| Renglones con tránsito abierto | 76 |
| Renglones **sin unidad** en la ficha | **21**, $2,262, en 8 líneas |

**Renglones por la unidad en que salen:**

| Unidad | Renglones | Líneas | Importe |
|---|---:|---:|---:|
| PAQ | 166 | 68 | $86,290 |
| CJA | 51 | 27 | $54,718 |
| PZA | 45 | 26 | $9,295 |
| KG | 8 | 5 | $874 |
| BTO | 2 | 2 | $1,383 |
| CUB | 1 | 1 | $3,681 |
| *(sin unidad)* | **21** | 8 | $2,262 |

---

## 4. Las tres cosas que la medición cambió del diseño

### 4.1 ⛔ El tope de 70 casi nunca corta: junta decenas de líneas

La propuesta de Edgar fue «agrupa las líneas hasta que tope los 70 renglones». La medición dice
que **la línea más grande tiene 12 renglones**, así que una orden no es una familia: son treinta o
cuarenta líneas apiladas. El agrupado sigue sirviendo —el almacenista arma por fabricante y
encuentra la mercancía junta— pero **la pantalla no debe prometer «pedidos por familia»**.

### 4.2 ⛔ Las unidades reales no son tres, son seis

Se diseñó para caja / paquete / pieza. En el pedido real salen **PAQ, CJA, PZA, KG, BTO y CUB**.
Con la regla «una orden no mezcla unidades», eso da **8 órdenes**, y tres de ellas son para
**11 renglones en total** (KG 8, BTO 2, CUB 1).

> **D1 — abierta, es de Edgar.** ¿KG, BTO y CUB se juntan en una orden «otras unidades», o se
> aguantan los tres documentos? Mientras no se decida, el motor arma los tres: la regla escrita
> manda sobre la comodidad.

### 4.3 ⛔ Veintiún renglones no pueden salir, y hasta hoy nadie lo veía

21 renglones no tienen unidad en la ficha de Kepler (`a_pedir.clase === 'sin_unidad'`). El ERP los
rechaza. Es la misma familia del `17178` del 2026-11-23 (producto que la matriz no maneja): **un
renglón malo tiraba el pedido entero**. Ahora se separan antes de mandar, con su motivo y su
acción, y **el resto sí sale**.

---

## 5. La pantalla de entrada

### 5.1 Cabecera

Título, sucursal, y una línea que dice el estado real: **«Tu pedido ya está hecho. Abajo está lo
único que necesita que tú decidas.»** Debajo, cuándo se calculó, la cobertura y *Recalcular*.

Dos botones, separados porque **ocurren en momentos distintos** (Edgar, 2026-11-22: «el pedido a
la sucursal principal y los pedidos a los proveedores van más ligados al calendario de compras,
dividir el botón operacionalmente es necesario»):

| Botón | Qué hace | Jerarquía |
|---|---|---|
| **Pedir a \<matriz\>** | Aprueba y escribe el traspaso en Kepler en el acto | primario |
| **Enviar a Compras** | Deja la requisición en la cola de Compras | secundario |

Cada uno lleva su cuenta. La del primario **descuenta los renglones que no pueden salir**: con los
21 sin unidad, dice **273**, no 294. Un botón que promete 294 y manda 273 es exactamente lo que
este anexo existe para evitar.

> Esto **deroga AB.29** («una sola acción principal», 2026-10-26). El motivo es operativo, no
> estético: los dos actos no ocurren el mismo día.

### 5.2 «Revisa esto antes de mandar»

La única sección obligatoria. Cada renglón: **icono + qué pasa + por qué importa + la acción**.
Nunca un aviso sin salida.

| # | Excepción | Acciones |
|---|---|---|
| 1 | La matriz no maneja *n* productos | Quitarlo · Pedírselo a \<otra sucursal que sí lo tiene\> |
| 2 | *n* renglones sin unidad en la ficha | Ver cuáles · Pedir la ficha a Compras |
| 3 | *n* pedidos tuyos llevan más de 7 días sin llegar | Ver cuáles |
| 4 | *n* productos que la matriz no te surtió en 30 días | Ver cuáles |

1 y 2 **impiden** (sunset); 3 y 4 **informan** (neutro). El rótulo de la derecha dice
«*n* cosas · el resto ya está resuelto»: es la frase que vuelve creíble el «casi 100 % automático».

⛔ **Si no hay excepciones, la sección no se pinta.** Una sección vacía con un ✓ verde enseña a
ignorar la sección.

### 5.3 «Lo que sale»

Un bloque por destino, con su total y **la diferencia dicha en palabras**:

- **A \<matriz\> · tu matriz** — «Queda hecho en su almacén al mandarlo. No pasa por Compras.»
- **A Compras · *n* proveedores** — «Va con el calendario de compras. Compras la aprueba o la
  rechaza con motivo.»

Bajo el traspaso, las unidades como fichas (`166 en PAQ`, `51 en CJA`, …) y una ficha punteada:
**«se arma en 8 órdenes: una orden no mezcla unidades»**.

Bajo Compras, el aviso ámbar de mínimos de compra cuando aplica.

A la derecha del encabezado, **«Ver los *n* renglones»** → §6.

### 5.4 «Agregar algo a mano»

El buscador de `/telemarketing/cotizaciones`, sin cambiarle nada: al teclear muestra **la
existencia del que surte y en qué unidad te lo puede dar**. Lleva escrito su porqué —
«el motor pide lo que la venta dice que falta; si sabes algo que no sabe, agrégalo» — porque sin
eso un buscador en una pantalla automática se lee como un error.

Al lado, **«Lo que el motor dejó fuera»**: los renglones que la regla del mínimo en unidad menor
(`MINIMO_MENOR = $200`) no pide solos, con su enlace.

### 5.5 El pie

Siempre tres cosas, nunca en verde:

1. **De dónde sale lo que falta** — venta de 30 días contra existencia de hoy, menos lo que viene.
2. **En qué unidad van las cantidades** — la que la matriz puede surtir.
3. **Lo que NO se midió**, con su número.

---

## 6. El pedido abierto

Se llega desde «Ver los *n* renglones». No es «la tabla de antes con filtros»: es **el pedido ya
partido en las órdenes en que se va a armar**.

### 6.1 Cabecera

*Volver al resumen* · **«Lo que le pides a \<matriz\>»** · `294 renglones · 102 líneas · $158,503 ·
se arma en 8 órdenes`. A la derecha, *Quitar lo marcado* y el primario con su cuenta real.

### 6.2 La tira de «cómo se parte»

Una frase y las fichas por unidad:

> **Una orden no mezcla unidades** — el armado se hace por unidad — y se corta en 70 renglones,
> siempre al terminar una línea.

Al lado, en ámbar, los renglones que **no pueden salir**, con su importe, sus líneas y su enlace.

### 6.3 La tabla

Tres niveles, en este orden exacto (Edgar, 2026-11-22: «primero agrupa por unidad, luego agrupa
por línea, y finalmente ordena los renglones por alfabético»):

```
Orden 1 de 8 · en PAQ                       hasta 70 renglones · se cierra al terminar una línea
    ABARROTES · 1 renglón
      99444   ***DESC. JABON FOCA 1 KG / 1              1 PAQ · de 0.100 cja      $32    ×
    AGROALIMENTOS SANTOYO SPR · 1 renglón
      18025   SANTOYO JAPONES 25G 50P TOKIO             1 PAQ                     $1,157 ×
    ALCARRUZZ S DE RL SA DE CV · 2 renglones
      …
```

| Columna | Qué dice | Por qué está |
|---|---|---|
| ☐ | Marca el renglón | Quitar varios de un golpe |
| Código | SKU | Es como lo buscan en el piso |
| Producto | Nombre de Kepler | — |
| Tránsito | ficha «ya viene» cuando hay tránsito abierto | 76 de 294. **Sin número**: su unidad no está verificada |
| Pide | **cantidad + unidad**, y `· de 0.100 cja` cuando bajó de unidad | Es lo que rompió el push el 2026-11-23 (PQ.147) |
| Importe | Costo del renglón | — |
| × | Quitar | La acción está donde está el problema |

**La banda de orden es fija (`sticky`)**: al desplazarse, el almacenista siempre sabe qué orden
está mirando y en qué unidad.

### 6.4 La existencia — lo que se muestra y lo que se declara

El plan vivo **sí** trae la existencia (`AutoabastoPedidoLinea.existencia`), así que la columna se
puede pintar **antes de mandar**.

⛔ **Lo que no se puede pintar es la existencia de un pedido ya guardado.** Medido el 2026-11-23:
`commercial.purchase_requisition_lines.on_hand` viene en cero en **0 de 11,020** renglones de
requisiciones `branch` de los últimos 60 días (43 de 12,078 en 180 días, 0.36 %), mientras que en
las `supplier` viene lleno en el **66.5 %**. No es que las sucursales tengan cero de todo: **ese
camino no escribe la columna**.

Por eso, en la ficha de un pedido ya enviado, la existencia se **declara**, no se dibuja como cero.

> **Deuda con nombre — `[AB.NI.6]`:** que el camino `branch` guarde `on_hand` como lo guarda
> `supplier`. Sin eso, ningún pedido enviado puede explicar por qué pidió lo que pidió.

---

## 7. Capas y entregables

Cuatro capas, [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md). **Una capa no sube sin la de
abajo verificada.**

| Item | Capa | Qué entrega | Estado |
|---|---|---|---|
| `[AB.NI.1]` | C0 | `linea` (fabricante) en la línea del pedido, derivada de `analytics.v_erp_product_lines`. **Sin tabla nueva.** | ⬜ |
| `[AB.NI.2]` | C1 | `armarOrdenes()` — primitivo puro: agrupa por unidad → línea → alfabético, corta en 70 al terminar línea, y separa lo que no puede salir | ⬜ |
| `[AB.NI.3]` | C2 | `GET /autoabasto/pedido` devuelve `linea` y el resumen de órdenes | ⬜ |
| `[AB.NI.4]` | C3 | La pantalla de entrada (§5) | ⬜ |
| `[AB.NI.5]` | C3 | El pedido abierto (§6) | ⬜ |
| `[AB.NI.6]` | C1 | Deuda: `on_hand` en el camino `branch` | ⬜ |

### 7.1 Criterios de aceptación verificables

1. `armarOrdenes()` sobre los **294 renglones reales** de `RQ-2026-03239` devuelve **8 órdenes** y
   **21 renglones** en «no puede salir».
2. Ninguna orden mezcla unidades. **Prueba negativa:** una orden con dos unidades es un fallo.
3. Ninguna orden pasa de 70 renglones. **Prueba negativa:** tope 70 con una línea de 71 renglones
   la deja sola en su orden y **no la parte**.
4. Dentro de una orden, las líneas van alfabéticas y los renglones alfabéticos por nombre.
   **Prueba negativa:** entrada desordenada que salga desordenada es un fallo.
5. La cuenta del botón primario **es** la de los renglones que pueden salir, nunca el total.
6. Con cero excepciones, la sección «Revisa esto antes de mandar» **no existe en el DOM**.

---

## 8. Lo que este anexo NO incluye

- El motor y sus reglas (cobertura, mínimo en unidad menor, tope de 45 días): §15 y §16 del doc madre.
- La captura manual como módulo (Edgar, 2026-11-22): es otro frente.
- La nivelación de inventarios.
- El reparto del sobrante de red.
- La decisión **D1** de §4.2, que es de Edgar.

---

## 9. Lo que se declara abierto

| # | Qué | Quién |
|---|---|---|
| D1 | KG, BTO y CUB: ¿una orden «otras unidades» o tres documentos? | Edgar |
| D2 | Los 21 sin unidad: ¿se pide la ficha a Compras desde aquí, o sólo se listan? | Edgar |
| — | `on_hand` en `branch` (`[AB.NI.6]`) | equipo |
| — | Los rótulos de línea llegan sucios del ERP (`CANEL?S S.A. DE C.V.`, truncados a 30 caracteres). Se muestran **tal cual**: corregirlos aquí sería inventar un catálogo | equipo |
