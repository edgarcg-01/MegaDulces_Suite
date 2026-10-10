# Sprint 2 · Drivers de ingreso — **bloqueado por ausencia de dato**

> **Carril:** Ingresos (`trade-marketing-06`). **Verifica:** el carril que arma el plan.
> **Mediciones: 2026-10-10, contra `pg-prod`, sólo lectura.**
>
> ⛔ **Esto no es una entrega parcial ni una pausa: es el resultado.** El driver de los canales sin
> cliente —el **58.46 %** del plan— **no se puede construir hoy**, y por ADR-056 lo que no se puede
> medir se declara. Aproximarlo sería publicar el número que la junta usa para decidir qué palanca
> mover, con los dos factores mal.

---

## 1 · Qué pedía el sprint

`tickets × ticket promedio` para los canales **sin cliente** (Mostrador), y
`clientes × frecuencia × ticket` para los que **sí** lo tienen. El renglón contable se deriva de
los drivers; nadie lo captura.

Para el primero hacen falta **dos cosas a la vez**: un conteo de **tickets** y un **canal canónico**.
**Ninguna fuente tiene las dos.**

---

## 2 · Las cinco fuentes, y por qué cae cada una

| fuente | qué tiene | por qué no sirve |
|---|---|---|
| `analytics.erp_sales_invoices` | cliente, vendedor, canal | **cubre 4.85 %** del dinero; 77 % de eso es TELEMARK |
| `analytics.sales_daily` | columna `tickets` **poblada** | ⛔ **está al grano de PRODUCTO: sobrecuenta 2.19×–10.40×** |
| `analytics.v_sellout_daily` | canal canónico limpio, `source` | **no tiene `tickets`** |
| `analytics.pos_ticket_sales` | tickets **reales** (468,452) | sólo `source = kepler` (**17.5 %** del dinero) y **sin canal** |
| `analytics.v_kepler_ticket_count` | canal y tickets | Kepler-only, grano de producto, y cobertura que arranca en fechas distintas por canal |

Cinco fuentes, **cinco razones distintas**. No es la misma objeción repetida.

---

## 3 · ⛔ El hallazgo central: `sales_daily.tickets` no cuenta tickets

Cruzado contra el conteo real de caja (`analytics.pos_ticket_sales`), septiembre 2026, día por día
y almacén por almacén:

```
alm   dias    sum(tickets) / tickets de caja
08     12              8.81x
06     30              6.90x
01     30              4.87x
07     23              4.69x
03     30              3.92x
02     30              3.29x
05     30              3.18x
04     30              2.60x
       215 pares   min 2.19x   max 10.40x   promedio 4.45x   desv 1.747
```

La columna cuenta **en cuántos tickets apareció este producto**. Sumarla da apariciones de producto
en ticket, no tickets.

⭐ **Y la variación prueba el diagnóstico, no sólo lo acompaña.** Un error de escala sería
constante. Éste va de **2.60×** en el almacén `04` a **8.81×** en el `08`, monótono por almacén:
**es el tamaño de la canasta**, o sea exactamente lo que el grano de producto introduce.

### Por qué es grave: el defecto se concilia solo

`tickets × ticket_promedio` armado sumando esa columna publicaría **tickets ~4.5× de más**,
**ticket promedio ~4.5× de menos**, y **el producto seguiría dando la venta exacta**.

⛔ **Ningún cuadre lo atraparía.** Es la familia de defecto que esta fase existe para cerrar —una
cifra que concilia en el total con los dos factores mal— metida justo en el número que decide la
acción comercial.

### ⚠️ Y lo que esta medición **no** autoriza

El árbitro cubre **sólo `source = kepler`** (82,399 tickets en septiembre, 215 pares). Alcanza para
**establecer el defecto**. **No** alcanza para derivar un factor de corrección, y menos para
Wincaja — que es el **40.6 %** de la venta.

⛔ **«Dividamos entre 4.45» sería cambiar un error medido por uno inventado.**

---

## 4 · ⛔ Y el fallback tampoco alcanza

La salida intermedia obvia es construir sólo los canales **con** cliente. Medido, no sirve:

```
el plan tiene CUATRO canales   mostrador 58.46 % · mayoreo 28.10 % · ruta 8.84 % · preventa 4.60 %
telemarketing                  NO es un canal del plan
```

⇒ La única fuente con cliente (`erp_sales_invoices`) es **77 % telemarketing**, que el plan no
tiene; y el canal con cliente que el plan **sí** tiene, `preventa`, pesa **4.60 %**.

Construir el fallback entregaría un driver para el **4.60 %** del plan y otro para un canal
inexistente. **No es media entrega: es otra pantalla sobre un universo sin declarar.**

---

## 5 · Lo que haría falta, y no lo decide un carril

**Un conteo DISTINTO de tickets, al grano día × almacén × canal canónico, con cobertura Kepler y
Wincaja.** Hoy no existe.

Las tres salidas, en orden de costo, y **ninguna es técnica**:

1. **Que el POS lo capture** — decisión de operación, no de código.
2. **Derivarlo del ticket crudo** si la réplica lo conserva al grano de documento; hay que medir si
   existe y con qué cobertura **antes** de prometerlo. ⚠️ Esa medición es justamente lo que este
   documento recomienda **no** arrancar sin la decisión de arriba.
3. **Cambiar el driver**: si no hay tickets confiables, el driver de Mostrador tiene que ser otro
   (por ejemplo, venta por metro de anaquel o por día-tienda) — y eso **cambia la conversación de
   la junta**, que es lo que el método de drivers vino a mejorar.

---

## 6 · Cómo se llegó acá, porque el método importa

Las tres fuentes cayeron **antes** de escribir código, y cada una por una medición que nadie pidió:

| | |
|---|---|
| `erp_sales_invoices` | se midió la **cobertura** antes de construir → 4.85 % |
| `v_sellout_daily` | se preguntó si estaba limpio **por clasificar bien o por faltarle dato** → clasifica bien |
| `sales_daily.tickets` | se verificó **qué cuenta**, no sólo que estuviera poblada → 2.19×–10.40× |

⚠️ **La tercera llegó tarde y es la lección.** Este carril reportó «`tickets` POBLADO, 6,422,871»
como argumento de que la fuente servía, y lo usó para recomendar una opción que el carril auditor
**aprobó**. Existir y estar poblada son dos preguntas; **qué cuenta** es una tercera, y es la única
que decidía.

⇒ Queda como séptima regla del plan, y acá con su contraparte: *la fuente se mide antes de
nombrarla en un sprint* — **y medir una columna es medir qué cuenta, no que tenga valores.**
