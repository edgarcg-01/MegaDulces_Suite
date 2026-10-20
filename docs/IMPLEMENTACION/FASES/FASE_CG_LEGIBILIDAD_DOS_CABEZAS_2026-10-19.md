# Caja General — legibilidad para dos cabezas

**2026-10-19 · objetivos dentro de `CGA` (🔨), no fase nueva** — la Fase 0 de aterrizaje está en
curso y §7 del método prohíbe abrir una fase más. Esto se aterriza como items de `CGA`.

> La pantalla pone **428 palabras, 28 montos distintos y 25 controles** frente a una persona que
> está contando efectivo, y «Tu jornada» le agrega **661 palabras y 36 montos** bajo **un solo
> encabezado**. El problema no es que falte información: es que la pantalla la publica toda con
> el mismo peso, para dos personas distintas, al mismo tiempo.

---

## 1. Lo medido, hoy, en la pantalla corriendo

Medido el 2026-10-19 en `http://localhost:4200/finanzas/caja-general` contra datos de producción,
viewport 1660×918.

| | Pantalla principal | «Tu jornada» |
|---|---:|---:|
| Palabras en pantalla | **428** | **661** |
| Montos distintos | **28** | 36 |
| Números sueltos (conteos) | 17 | — |
| Controles visibles | 25 | — |
| Encabezados (`h1`–`h4`) | 4 | **1** |
| Combinaciones tamaño/peso de letra | **12+** | — |
| Textos de ≤ 11.5 px | **23** | — |
| Textos bajo el mínimo AA (4.5) | **2** | — |

**Entre las dos vistas: 1,089 palabras y 64 cifras de dinero.**

### Los tres hallazgos que no son de volumen

**⛔ La instrucción es lo menos legible de la pantalla.** Los únicos dos textos bajo AA —contraste
medido **2.33**— son exactamente los que dicen qué hacer:

- «el resto necesita su cuenta declarada»
- «se corrigen en Kepler, no acá»

O sea: lo que explica el trabajo está escrito más tenue que el trabajo. Quien no sabe qué hacer es
precisamente quien no puede leer la línea que se lo dice.

**⛔ El folio va en 10 px.** `U-A-5 0000185`, `X-D-26 0023373`. Es **la llave contra la que se
identifica el papel que la persona tiene en la mano**, y es de los textos más chicos de la
pantalla. La cifra de dinero está en 24.8 px; su identificador, en 10.

**⛔ Doce escalas tipográficas no son jerarquía: son ruido.** 14/400, 10/400, 12/500, 10/600,
16/600, 12/600, 12/400, 24.8/600, 13/600, 13/400, 12/700, 10.88/600… Cuando todo es «un poco
distinto», nada se lee como más importante. La jerarquía la da el contraste entre pocos niveles,
no la cantidad de niveles.

---

## 2. Las dos cabezas

La pantalla sirve hoy a dos personas con una sola superficie, y las dos pierden.

| | **Quien mueve el dinero** | **Quien supervisa** |
|---|---|---|
| Qué pregunta | «¿qué cuento ahora, y cuadró?» | «¿vamos al día, y qué está trabado?» |
| Cada cuánto | decenas de veces al día | una o dos veces al día |
| Cuántas cifras necesita a la vez | **1** — lo contado contra el documento | varias, pero comparables entre sí |
| Qué le estorba | el rezago, la salud del catálogo, los totales del día | la cola fila por fila |
| Con qué compara | el efectivo en la mano y el papel | el día de ayer y lo que falta autorizar |
| Qué lo bloquea | un movimiento sin cuenta declarada | que alguien no cerró su jornada |

**El conflicto medido:** la pantalla abre con 28 montos. Quien cuenta necesita **uno**. Los otros
27 son de la otra cabeza — y están pintados con el mismo peso.

⚠️ Esto **no** es «hacer dos pantallas». Las dos cabezas miran el mismo dinero y la supervisión
pierde sentido si mira otra cosa que lo que se capturó. Es decidir **qué se lee primero** en cada
caso, no partir el dato.

---

## 2b. La supervisora tiene nombre — y hoy **no puede** autorizar

Edgar designó a **María de la Paz Gutiérrez Guzmán** (`maria_gutierrez`, rol `tesoreria`) como
supervisora de Caja General, 2026-10-19.

⚠️ **Hay dos Gutiérrez en finanzas y se confunden fácil.** `mayra_gutierrez` —Mayra Laura Gutiérrez
Castillo, puesto `aux_caja_general_zona`— **captura 47 movimientos** en esta misma pantalla.
Nombrarla a ella como supervisora la pondría a revisar su propio trabajo. La supervisora es
**María de la Paz**, la de tesorería, que no captura.

### ⛔⛔ La supervisión nunca ocurrió, y no es por desidia

Medido contra prod el 2026-10-19:

```
finance.cash_ledger_cuts:   6 cerrados  ·  0 con autorizador
```

El sistema **ya exige** la segunda firma —la propia pantalla lo dice: *«falta que lo autorice otra
persona, porque quien cierra no autoriza»*— y de **6 cortes cerrados, cero se autorizaron**.

**La causa no es de interfaz. Es un permiso que nunca se repartió:**

| Permiso | Quién lo tiene hoy |
|---|---|
| `FINANCE_CAJA_VER` | 12 roles, incluida `tesoreria` |
| `FINANCE_CAJA_GESTIONAR` | 10 roles, incluida `tesoreria` |
| **`FINANCE_CAJA_AUTORIZAR`** | **`direccion`, `superadmin`, `surtidor`** |

`tesoreria` **no está**. Tampoco `finanzas`, ni `finanzas_operativo`. O sea: **nadie del área de
finanzas puede autorizar un corte**, incluida la supervisora designada — que sí puede *capturar*,
que es justo el acto que debería vigilar.

Verificado que es la llave real y no un nombre suelto:
`@RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)` en `cash-ledger.controller.ts:285`. Lo
aplica el servidor.

⭐ **Esto reordena el trabajo.** Construir el Modo Supervisión primero produciría una pantalla
preciosa donde el botón de autorizar está apagado para la persona a la que está dirigida. El
permiso va **antes** que la vista — C2 antes que C3, que es lo que el método pide.

⚠️ **Y una anomalía para revisar, no para arreglar sin preguntar:** `surtidor` tiene
`FINANCE_CAJA_AUTORIZAR`. Un surtidor de almacén autorizando cortes de caja parece un reparto
accidental, pero no lo mido como error: hay que confirmarlo con quien lo otorgó.

### Dos hallazgos más, del mismo barrido

**La jefa de finanzas es quien más captura.** María del Carmen Rodríguez Vera, puesto
`jefe_finanzas`, lleva **177 capturas** — más que nadie. Quien debería revisar es la que más
teclea. No se arregla con interfaz, pero el diseño tiene que saberlo.

**La jerarquía está casi vacía.** De 18 personas en `cajas` y `tesoreria`, sólo **2** tienen
`supervisor_id` cargado. Las 14 cajeras, ninguno. Mayra —que captura— tampoco. Si el Modo
Supervisión se apoyara en ese campo para saber a quién mira cada quien, hoy no tendría a nadie.

---

## 3. Objetivos

Cada uno lleva su métrica de hoy y su meta. Un objetivo sin cifra medida hoy no se abre (§método).

### O1 · Cinco escalas, no doce

**Hoy:** 12+ combinaciones tamaño/peso. **Meta:** ≤ 5, todas tomadas de `--fs-*` de
`libs/design-tokens/tokens.css`.

Una escala por rol de texto: la cifra que decide · el nombre de la cosa · el dato de apoyo · la
etiqueta · el rótulo de columna. Nada más.

**Cómo se verifica:** el mismo script que midió esto, corrido sobre la pantalla; va como compuerta
si sobrevive a dos pantallas más.

### O2 · Piso de 12 px, y la instrucción nunca en gris

**Hoy:** 23 textos ≤ 11.5 px · 2 bajo AA con contraste 2.33.
**Meta:** ningún texto bajo 12 px · todo lo que **instruye** a ≥ 4.5 de contraste · el **folio a 13
px mono**, que es la llave contra el papel.

⚠️ Esto choca con `--text-faint`, que falla AA en las 4 superficies × 2 temas y se usa en 112
archivos. Es deuda conocida y es decisión de Edgar: acá sólo se exige que **el texto que instruye**
no la use.

### O3 · La pantalla abre con una cifra, no con veintiocho

**Hoy:** 28 montos al abrir. **Meta:** ≤ 3 cifras por encima del pliegue para quien cuenta —
«cuántos me faltan», «cuál sigue» y, al arquear, «lo contado contra el documento».

El resto no se borra: baja de nivel. Lo que hoy compite por la atención pasa a estar **a un
gesto**, no a la vista.

### O4 · «Tu jornada» deja de ser un muro

**Hoy:** 661 palabras, 36 montos, **1 encabezado**, y abre con *«2,850 conceptos de 3,020 · 114 sin
subcuenta»* — que es salud del catálogo, no el día de nadie.
**Meta:** secciones con encabezado propio, y la **primera línea es el veredicto del día**
(«cerrada / abierta / falta autorizar»), con la salud del catálogo al final o fuera.

### O5 · Dos modos de lectura sobre el mismo dato

Lo creativo, y lo que contesta el pedido de fondo.

**Modo Caja** — el default de quien captura: la cola y el arqueo, nada más. Una cifra grande.
**Modo Supervisión** — el día completo: cuánto se capturó, cuánto falta, **el rezago real**
(los 88 desde el 12-oct, ver el documento del rezago), qué está trabado y por quién, qué espera
autorización.

Es **un cambio de qué se destaca**, no dos pantallas con dos verdades: las dos leen
`finance.cash_ledger` y la misma cola. El modo se recuerda por persona.

⚠️ Antes de construirlo hay que contestar la pregunta abierta de abajo sobre el permiso: si el modo
se elige a mano o lo propone el puesto.

### O7 · El Modo Supervisión abre con lo que espera una firma

**Hoy:** 6 cortes cerrados, **0 autorizados**, y en ninguna parte de la pantalla se dice que hay
algo esperando. **Meta:** la primera cifra del Modo Supervisión es *«N cortes esperan tu
autorización»*, y desde ahí se autoriza.

⛔ **Bloqueado por C2, y no se empieza al revés.** Hoy `FINANCE_CAJA_AUTORIZAR` lo tienen
`direccion`, `superadmin` y `surtidor` — **nadie de finanzas**, ni la supervisora designada.
Construir la vista primero entrega una pantalla donde el botón está apagado justo para quien la
pediría. El orden es:

1. **C2 ·** repartir `FINANCE_CAJA_AUTORIZAR` al rol de la supervisora (`tesoreria`), y revisar por
   qué lo tiene `surtidor`.
2. **C2 ·** verificar en prod que la autorización **funciona** ejerciéndola: un endpoint que
   escribe no está probado hasta que una prueba lo ejerció con el payload de la pantalla. Van 6
   cortes y cero autorizaciones, así que ese camino **nunca corrió en producción**.
3. **C3 ·** recién entonces, la cifra en la vista.

⚠️ El paso 2 no es trámite: es exactamente la forma del defecto que dejó el arqueo 8 días en cero
—build verde, pruebas verdes, y el único camino que la pantalla usaba, roto—. Cero autorizaciones
por falta de permiso y cero por un 500 **se ven igual desde afuera**.

### O6 · El teclado también es legibilidad

**Hoy:** la pantalla tiene atajos reales (flechas en la reja, Enter, Esc) y **sólo dos se anuncian**
(`↑ ↓` en el arqueo). **Meta:** los atajos que existen, escritos donde se usan.

D.5 ya lo dice: un atajo que nadie sabe que existe no existe. Y para quien cuenta con las manos
ocupadas, el atajo *es* la interfaz.

---

## 4. Lo que NO hay que hacer

**No esconder información para que «se vea limpio».** El problema es de jerarquía, no de volumen.
Una bandeja acotada que no dice dónde cortó es indistinguible de una vacía — ya está escrito en el
documento del rezago y vale igual acá.

**No inventar un tablero con indicadores nuevos.** Lo que falta no es más dato: es que el que hay
se lea. Un indicador nuevo sin alguien que actúe sobre él es ruido con gráfica.

**No usar el color como único portador.** La flota es Windows y `forced-colors` es el tercer modo:
en Alto Contraste el fondo, el texto y las sombras los sustituye el sistema. Ya cobró una vez este
mes — el control segmentado marcaba la opción activa con tres señales que eran la misma, y
desaparecían juntas en las 48 pantallas que lo montan.

**No achicar para que entre.** El piso de 12 px no se negocia contra el no-scroll: si algo no cabe,
baja de nivel o se va a un gesto, no se encoge.

---

## 5. Preguntas abiertas

- **¿El modo lo elige la persona o lo propone el puesto?** Hay `MATRIZ_ACCESOS.md` y permisos por
  clave; un cajero y un supervisor no tienen el mismo. Recomendación: **lo propone el puesto y se
  puede cambiar** — proponerlo sin poder cambiarlo deja fuera a quien hace las dos cosas, que en
  una sucursal chica es la misma persona.
- **¿«Tu jornada» es de las dos cabezas o sólo de supervisión?** Hoy mezcla el cierre del día (que
  hace quien captura) con la salud del catálogo (que no le toca a nadie de caja).
- **¿Por qué `surtidor` tiene `FINANCE_CAJA_AUTORIZAR`?** Un surtidor de almacén autorizando
  cortes de caja parece un reparto accidental. No lo doy por error: hay que confirmarlo con quien
  lo otorgó antes de quitarlo.
- **¿Se carga la jerarquía (`supervisor_id`) o el modo se apoya sólo en el permiso?** Hoy 2 de 18
  personas de cajas/tesorería lo tienen. Si el Modo Supervisión quisiera decir «tus cajeras», hoy
  no tendría a quién nombrar.
- **¿La jefa de finanzas debería seguir capturando?** 177 capturas, más que nadie. Es una pregunta
  de proceso, no de pantalla, pero cambia para quién se diseña el Modo Supervisión.

### ✅ Contestada el 2026-10-19

~~¿Hay alguien hoy que supervise esta pantalla?~~ **No. Cero de seis cortes autorizados**, y la
causa está medida: `FINANCE_CAJA_AUTORIZAR` no lo tiene ningún rol de finanzas. La supervisora
designada es **María de la Paz Gutiérrez Guzmán** (`maria_gutierrez`, `tesoreria`) — ver §2b.

---

## 6. El plan — qué se construye, en qué orden y por qué ése

⭐ **El conmutador de modos NO se construye primero.** Es la conclusión, no el punto de partida:
hoy existe una sola superficie, así que «elegir modo» no tiene entre qué elegir. Primero se
arregla la que hay y se construye la que falta; el modo aparece solo cuando hay dos.

### Tanda 1 · Legibilidad de lo que ya existe — **sin bloqueos, empieza ya**

Objetivos **O1, O2, O3, O6**. Es jerarquía visual y tokens: no toca datos, ni permisos, ni el
servidor. Sirve a quien usa la pantalla **hoy** — Carmen (177 capturas) y Mayra (47).

| Entrega | Métrica de cierre |
|---|---|
| Cinco escalas tipográficas, no doce | el script de §1 cuenta ≤ 5 |
| Piso de 12 px; el folio a 13 mono | 0 textos < 12 px · 0 instrucciones bajo AA |
| Abrir con ≤ 3 cifras, no 28 | conteo de montos sobre el pliegue ≤ 3 |
| Los atajos que existen, escritos | cada atajo activo tiene su `<kbd>` visible |

⚠️ **No espera a nada de lo de abajo, y por eso va primera.** Si las otras tandas se traban —y dos
dependen de decisiones ajenas—, ésta ya mejoró la pantalla para las dos personas que la usan.

### Tanda 2 · Destrabar la autorización — **C2, chica, y bloquea todo lo de supervisión**

Objetivo **O7**, pasos 1 y 2. Sin esto, cualquier vista de supervisión nace con el botón apagado.

1. Repartir `FINANCE_CAJA_AUTORIZAR` al rol `tesoreria` (la supervisora designada).
2. **Ejercer la autorización contra prod** con el payload de la pantalla. Van 6 cortes y cero
   autorizaciones: ese camino **nunca corrió**.
3. Resolver la anomalía de `surtidor` (pregunta abierta, no se toca sin confirmar).

**Métrica de cierre:** un corte real pasa de `cerrado` a autorizado, firmado por alguien que no lo
cerró. Hoy: **0 de 6**.

### Tanda 3 · El dato del rezago — **C0/C1, independiente de la 2**

El campo que parte `fuera_de_ventana` en **rezago real** (desde el 12-oct, cuando arrancó el
sistema) e **histórico anterior al sistema**. Hoy viaja como un solo bloque de ~13,400.

Medido el 2026-10-19, toda la caja: con el corte en 12-oct son **88 movimientos por $1,236,469.70**
de rezago real, contra 13,319 anteriores.

⚠️ **El ancla es el arranque del sistema, no una declaración.** Verificado contra el propio dato:
las capturas saltan de 2–3 sueltas a 24 el 12-oct y se sostienen en 14–52 diarias. Por eso es una
constante con nombre y no una fecha configurable: un hecho histórico no se mueve.

⚠️ **Y la etiqueta sigue la evidencia:** lo que sabemos de esos 13,319 es que son **anteriores al
sistema**, no que alguien los haya conciliado. Decir «conciliado» afirma un acto de Dirección que
no está medido.

**Métrica de cierre:** el endpoint devuelve los tres cubos por separado y la suma cuadra con el
bloque único de hoy.

### Tanda 4 · Modo Supervisión — **depende de 2 y 3**

La segunda superficie. Abre con tres cifras, en este orden:

1. **N cortes esperan tu firma** (de la tanda 2) — es lo único que sólo ella puede destrabar.
2. **El rezago real** (de la tanda 3) — cuánto se viene arrastrando.
3. **Qué está trabado y por quién** — sin cuenta declarada, mal fechados, jornadas sin cerrar.

Y **O4**: «Tu jornada» deja de ser un muro de 661 palabras bajo un solo encabezado; su primera
línea pasa a ser el veredicto del día, no la salud del catálogo.

**Métrica de cierre:** desde abrir la pantalla, la supervisora llega a autorizar un corte **sin
pasar por la cola** ni cambiar un filtro a mano.

### Tanda 5 · El conmutador — **lo último, y sale casi gratis**

Con dos superficies vivas, el modo es sólo cuál se abre primero. Lo propone el puesto y se puede
cambiar; se recuerda por persona.

---

### El camino crítico, dicho en una línea

```
Tanda 1  (UI, sin bloqueos)  ──────────────────────────────▶  entrega sola
Tanda 2  (permiso + ejercerlo)  ──┐
Tanda 3  (campo del rezago)     ──┴──▶  Tanda 4 (vista)  ──▶  Tanda 5 (modo)
```

**Lo que puede frenar el plan no es técnico:** la tanda 2 necesita que alguien reparta un permiso y
que se confirme lo de `surtidor`; la 3 necesita que nadie mueva el ancla del 12-oct. La tanda 1 no
necesita a nadie — por eso arranca.

---

## 7. Cómo se mide que mejoró

Sin esto son intenciones. Las tres se pueden correr hoy:

1. **El conteo de la pantalla** — palabras, montos, controles, escalas, textos bajo 12 px y bajo
   AA. Es el script de §1; se guarda y se vuelve a correr.
2. **Tiempo al primer campo.** Hoy, desde abrir la pantalla: elegir fila → el foco cae en el
   conteo (`[CG.117]`, arreglado hoy). Se mide en pasos de teclado, no en segundos.
3. **Qué lee primero una persona real.** Ninguna métrica reemplaza sentarse al lado de quien
   captura y preguntarle qué está mirando. Lo demás son indicios.
