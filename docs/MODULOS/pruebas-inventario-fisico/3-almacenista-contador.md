# 3 · Almacenista contador — el que cuenta

> Pruebas **de esta persona**. Lo común vive en
> [`../inventario-fisico-PRUEBAS.md`](../inventario-fisico-PRUEBAS.md).
> **Es el bloque más largo a propósito: esta persona *es* el módulo.**

## Quién es, medido en prod el 2026-11-25

**11 personas con rol `almacenista`** tienen `COMMERCIAL_INVENTORY_CONTAR`. Y además **cuenta
quien esté asignado al folio**, aunque su puesto no lleve la clave: el equipo se arma con gente de
otras plazas y de oficinas (las 90 promotoras activas no tienen sucursal registrada).

⛔⛔ **Dos cosas medidas que tiran abajo el supuesto obvio, y hay que decirlas antes de escribir
una sola prueba:**

| Aparato de los 11 almacenistas | Personas |
|---|---:|
| **Windows** | **6** |
| **nunca ha entrado al sistema** | **4** |
| Android | **1** |

1. ⭐⭐ **El contador NO está en un teléfono: está en Windows.** Uno solo de los once ha entrado
   alguna vez desde Android. Todo el diseño offline-first —cola local, caché del catálogo, banner
   de red— está pensado para un pasillo sin señal, y la gente que lo usaría está en una
   computadora. **Esto no invalida el offline** (una laptop en el almacén también pierde la red),
   pero sí cambia las pruebas: **nada de gestos táctiles, todo con teclado**, y «perder el
   teléfono» se vuelve «contar desde otra computadora».
2. ⭐ **Cuatro de once nunca han entrado.** Esta persona, como usuario del sistema, **todavía
   no existe**. Hay que crearla para probar, y el día del piloto hay que darle de alta y
   enseñarle. Anotarlo como parte del costo del piloto, no como un detalle técnico.

⚠️ Y una que corrige lo que se suele suponer: **el almacenista SÍ puede cancelar un folio**
(`CANCELAR_CONTEO`). El encargado de tienda no. O sea que la persona que puede destrabar un
almacén congelado es la que está contando, no la que manda.

---

## Su jornada

```
entrar → /almacen/inventory/count
       → iniciar jornada (sesión)
       → escanear · teclear cantidad · confirmar   ×N
       → (interrupción: comida, otra tarea)
       → reanudar → ×N
       → terminar jornada
```

⛔ **Nunca, en ningún paso, ve el teórico.** Ése es el control central del módulo y la primera
cosa que se prueba.

---

## `CNT-B` · El conteo ciego — se prueba PRIMERO

Si esto falla, lo demás no importa: el inventario deja de ser una medición.

| ID | Qué se intenta | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `CNT-B1` | Buscar el teórico **en el HTML, en las variables y en la respuesta de red** | No aparece en ninguno de los tres | 🔴 | B |
| `CNT-B2` | Pedir `/counts/:id/items` con este usuario | **403.** Ese endpoint es del supervisor y tiene candado que lo verifica | 🔴 | B |
| `CNT-B3` | Mirar la respuesta de **cada captura** | No trae `expected_qty` ni la varianza | 🔴 | B |
| `CNT-B4` | Capturar en el **segundo pase** | Tampoco ve lo que contó el primero | 🔴 | B |

---

## `CNT-J` · La jornada tiene que funcionar

| ID | Paso | Tiene que pasar | Niv |
|---|---|---|---|
| `CNT-J1` | Iniciar jornada | Queda registrada la sesión | B |
| `CNT-J2` | Escanear un código | Confirma **qué producto** se contó: nombre y SKU. No es captura a ciegas del producto, sólo del teórico | B |
| `CNT-J3` | Capturar cantidad | Se guarda; el avance sube | B |
| `CNT-J4` | Registrar una **interrupción** y reanudar | Queda registrada con su motivo; el reloj la refleja | B |
| `CNT-J5` | Terminar jornada | Queda cerrada | B |
| `CNT-J6` | Ver su avance | Cuántos lleva de cuántos — **lo suyo, no el folio entero** | C |

---

## `CNT-H` · Los errores que **sólo esta persona** comete

Son errores de **mano y de ojo**. Nadie más en el módulo teclea cantidades.

| ID | Qué se hace a propósito | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `CNT-H1` | Escanear **el mismo SKU dos veces** | Anotar si **suma** o **reemplaza**, y si la pantalla lo deja claro. Las dos son defendibles; **lo que no se vale es que no se sepa cuál** | 🔴 | B |
| `CNT-H2` | ⛔ Contar **cajas creyendo piezas** | El folio estampa la unidad al abrir (`unit_label`, `unit_factor`, `unit_source`) desde la misma fila del ODS que la cantidad — **y puede venir vacía, porque no se rellena con 1 a propósito**. Anotar **qué unidad muestra la pantalla al capturar** y qué pasa cuando no hay factor | 🔴 | B |
| `CNT-H3` | Teclear **100 donde iban 10** | Anotar si hay alguna barrera para una cantidad fuera de todo orden de magnitud | 🟠 | B |
| `CNT-H4` | Capturar **0** porque el anaquel está vacío | Se distingue de «no contado». ⛔ Un no-contado **jamás** puede valer cero: ésa es la regla que impide cerrar un folio incompleto | 🔴 | B |
| `CNT-H5` | Escanear un código **que no está en este folio** | Mensaje claro; **no se inventa un renglón** | 🟠 | B |
| `CNT-H6` | Escanear un código **que no existe en el catálogo** | Mensaje **distinto** del anterior: son dos problemas distintos | 🟠 | B |
| `CNT-H7` | Intentar el **tercer conteo del mismo SKU** siendo quien ya contó dos veces | 409 por segregación: el desempate no lo hace quien ya opinó | 🔴 | B |
| `CNT-H8` | **Dos contadores** capturan el mismo SKU a la vez | Cada uno cae en su ranura (`count_1`, `count_2`); nadie pisa al otro | 🔴 | B |
| `CNT-H9` | Teclear la cantidad y **salir sin confirmar** | Anotar si se pierde | 🟠 | C |

---

## `CNT-C` · Causalidad — luz, red y aparato

⭐ **Reescritas para Windows**, que es donde de verdad está esta persona.

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `CNT-C1` | **Cortar la red** (`context.setOffline(true)`) y contar 20 SKUs | Se captura igual: el escaneo se guarda **antes** de intentar la red. El banner dice «sin conexión» y **cuántos van pendientes** | 🔴 | C |
| `CNT-C2` | Volver la red | La cola sube sola; el pendiente baja a 0 | 🔴 | C |
| `CNT-C3` | Volver la red y **reenviar dos veces** | El servidor responde `duplicate` y **no cuenta doble**: cada escaneo lleva un UUID generado en el cliente y el servidor lo registra en `inventory_count_scan_log` | 🔴 | B |
| `CNT-C4` | **Recargar la página** con 20 pendientes | Siguen ahí: la cola vive en el navegador, no en memoria | 🔴 | C |
| `CNT-C5` | **Cerrar el navegador** y volver horas después | Igual | 🔴 | C |
| `CNT-C6` | ⚡ **Apagón**: matar el proceso del navegador sin cerrar | Igual: lo capturado estaba en disco antes de la red | 🔴 | C |
| `CNT-C7` | Contar **toda la jornada sin red** (200+ escaneos) | Anotar si hay tope, si avisa, y **cuánto tarda** al subir todo junto | 🟠 | C·M |
| `CNT-C8` | ⛔ **Contar desde otra computadora** a media jornada | La cola **se quedó en la primera**. Anotar qué ve: ¿su avance real o cero? Y si lo pendiente de la otra máquina se puede recuperar | 🔴 | B |
| `CNT-C9` | ⛔⛔ **Se formatea / se rompe la computadora** con escaneos sin subir | **Hoy el servidor nunca supo que existían**: no aparecen como faltantes en ningún lado. Anotar si hay **alguna** forma de preguntar «¿cuántos escaneos hay sin subir, y en qué máquinas?». Si no la hay, es un hueco de diseño, no un bug | 🔴 | B |
| `CNT-C10` | **Cierran el folio** mientras tiene cola pendiente | Los pendientes se marcan **descartados con su motivo**, el contador **los ve listados**, y no se reintentan en vano | 🔴 | B |
| `CNT-C11` | El servidor responde **500** al subir un escaneo | Se reintenta después; **no** se descarta | 🟠 | C |
| `CNT-C12` | **Caduca la sesión** (12 h) a media captura | Lo capturado sigue en la cola local y sube al volver a entrar | 🟠 | B |
| `CNT-C13` | **Reloj de la máquina mal puesto** | Anotar si alguna fecha del conteo sale del futuro o del pasado | 🟡 | B |

---

## `CNT-N` · Sus negativas

| ID | Qué intenta | Tiene que pasar | Niv |
|---|---|---|---|
| `CNT-N1` | Entrar a la **lista de folios** (`/sessions`) | 403: no es suya | B |
| `CNT-N2` | Ver el **teórico** | 403 (ver `CNT-B2`) | B |
| `CNT-N3` | **Reconciliar** | 403 | B |
| `CNT-N4` | Capturar en un folio **al que no está asignado** y sin tener la clave | 403 | B |
| `CNT-N5` | Capturar **después** de que el folio cerró | 409, y el escaneo queda descartado con motivo | B |
| `CNT-N6` | ⭐ **Cancelar** el folio | **Sí puede** (`almacenista` tiene `CANCELAR_CONTEO`). Anotar que la persona que está contando puede abandonar el conteo, y si eso se quiere | 🔴 B |

---

## `CNT-D` · Lo que la pantalla le debe — **todo con teclado, en Windows**

| ID | Qué se mira | Sev | Niv |
|---|---|---|---|
| `CNT-D1` | ⭐ Capturar **20 SKUs sin tocar el mouse**: escanear, teclear, confirmar, siguiente | 🔴 | C |
| `CNT-D2` | ¿El foco vuelve al campo de escaneo después de confirmar? Si no, cada captura cuesta un clic | 🔴 | C |
| `CNT-D3` | Las **flechas del teclado** sobre el campo numérico: ¿cambian el valor sin querer? *(Medido en Caja General: en Chrome `ArrowDown` sobre `input[type=number]` con 34 lo baja a 33, y jsdom no lo ve — por eso esto va en navegador real)* | 🔴 | C |
| `CNT-D4` | El banner de red: ¿se distingue «sin conexión» de «subiendo»? | 🟠 | C |
| `CNT-D5` | **Modo oscuro** y **Alto Contraste de Windows** (la flota es Windows) | 🟠 | C |
| `CNT-D6` | La pantalla a **1366×768**, que es el piso razonable de una máquina de oficina | 🟠 | C |
| `CNT-D7` | El único con Android: la pantalla a **390 px** y objetivos de **≥44 px** | 🟡 | C |

---

## Lo que esta persona enseña del módulo

Si `CNT-C9` no tiene respuesta —y hoy no la tiene—, entonces **el sistema no sabe cuánto conteo
anda suelto**. Eso no se arregla con una prueba: se arregla con un endpoint que diga qué hay sin
subir y en qué máquinas. Anotarlo como hallazgo de diseño, no como prueba fallida.

Y si al crear los usuarios aparece que **cuatro de once no existen todavía**, ésa es la primera
tarea del piloto, antes que cualquier software.
