# Runbook — El primer folio de inventario que se cierra · Padre Hidalgo

> **Para quién:** el equipo que va a correr la prueba en Padre Hidalgo (Edgar, las encargadas de
> PH, el almacenista y quien supervise). No es documentación técnica: es el guion del día.
>
> **Qué es:** `[IC.14]`, el primer paso de [`FASE_IC_RITMOS_Y_ABC`](../FASES/FASE_IC_RITMOS_Y_ABC.md).
> Fecha de redacción: 2026-10-06 · todo lo numérico se midió contra producción ese día.

---

## 1. Por qué esta prueba existe

En producción hay **6 folios de inventario y los 6 están cancelados**. Entre todos abrieron 18,845
renglones y se contaron **7**. Nunca se cerró ninguno.

Eso tiene tres consecuencias que no se arreglan con código:

- **El reloj de la cadencia nunca arrancó.** El sistema decide qué toca contar mirando cuándo se
  contó por última vez, y «la última vez» se registra sólo cuando un folio se **reconcilia**. Con
  cero reconciliados, todo figura como vencido para siempre y la prioridad no ordena nada.
- **Nadie sabe cuánto tarda contar.** No hay un solo dato de SKUs por hora por persona. Cualquier
  cifra de «cuántos productos al día» que yo proponga hoy es una suposición.
- **El archivo que avisa a Kepler nunca se emitió.** Mientras no se capture allá, el ERP conserva
  su saldo viejo y el conteo siguiente vuelve a encontrar la misma diferencia.

⭐ **Por eso esta prueba va antes que automatizar nada.** Si el folio no cierra a mano, un proceso
automático sólo va a producir folios cancelados más rápido.

---

## 2. La configuración, y por qué cada opción

| Campo | Valor | Por qué |
|---|---|---|
| Almacén | **01 · Padre Hidalgo** | el único con pasillos definidos y el de historial más rico |
| Tipo de conteo | **Cíclico (por clase ABC)** | es el mismo motor del futuro ritmo diario, abierto a mano |
| Clase ABC | **A** | lo que más valor mueve |
| Tope de SKUs | **25** | nacen **23** — ver §3 |
| Congelar movimientos | ⛔ **APAGADO** | se cuenta sin parar la tienda. Es el default del cíclico |
| Doble conteo ciego | ⛔ **APAGADO** | ver el recuadro de abajo |
| Umbral de recuento | ⚠️ **10 %** | la red de seguridad que reemplaza al ciego |

### ⛔ Por qué el doble conteo ciego va apagado, y qué se pone en su lugar

Con el ciego encendido, **cada SKU lo tienen que contar dos personas distintas** — el sistema
rechaza expresamente que la misma persona haga el segundo conteo. Y en Padre Hidalgo **sólo una
persona tiene permiso de contar** (Luis Espino). Con el ciego encendido, este folio **no podría
cerrarse nunca**: los renglones se quedan sin valor final y la reconciliación los rechaza.

**Lo que se pone en su lugar es el umbral de 10 %.** Cualquier producto cuya diferencia pase ese
10 % **no se ajusta solo**: queda marcado y obliga a que una persona lo mire y le ponga el motivo.
O sea que el riesgo de ajustar el saldo con un solo conteo queda acotado a diferencias chicas.

⚠️ **Esto es para esta prueba.** El ritmo mensual —el de los productos con mayor diferencia— sí
debería llevar el ciego encendido: ahí es donde se resuelve dinero.

---

## 3. Qué va a tener el folio

**23 productos**, todos clase A de Padre Hidalgo y todos escaneables (se verificó uno por uno que
su código de barras resuelve en el sistema).

```
17067  ALTOS ROLLO ALTA 30X40 1KG              70001  LA ROSA MAZAPAN /30
17081  ALTOS CAM MINI COLOR 1KG CLASICA        70028  LA ROSA NUGS GRANDE 12P
17083  ALTOS CAM CHICA COLOR 1KG CLASICA       70031  CHOC EST SUIZO /16 LA ROSA
17084  ALTOS CAM MEDIANA COLOR 1KG CLASICA     70056  LA ROSA MAZAPAN GIGANTE 50G /20
17085  ALTOS CAM GRANDE COLOR 1KG CLASICA      70068  LA ROSA JAPONES TUBO 60G 12P
18022  CAJETA ENVINADA 25KGS CABADAS           70079  PAL JUMBO CEREZA /50 LA ROSA
42029  KINDER DELICE 10P 39G                   70100  LA ROSA JAPONES TUBO 42G 14P
51017  CUERITO RAYADO 700GR LUPITA             70101  LA ROSA JAPONES CHICO 28G 20P
57009  COBERTURA 20K LUSSEL CUBETA             70103  LA ROSA JAPONES 800GR GRANEL
59108  AGUA MEMBERS MARK (500ML) / 1           83769  PASTA B. MINI CUADRO GUSTINOS NO. 2 /20K
94157  LEVI CHAROLA 855/ 50                    83770  PASTA B. MINI RUEDA GUSTINOS /15KG
95717  CIMARRON PISTACHOS 1KG
```

⛔ **Acá no va la cantidad que el sistema espera, a propósito.** El conteo se juzga contra el
teórico y publicarlo de antemano lo invalida. Esta lista trae lo mismo que ve el contador en su
pantalla: código, nombre y ubicación — nada más.

**Dos productos quedan fuera** y es correcto: `78210` (Bubbulubu Ice) y `78229` (Gansito Mini) son
clase A pero hoy tienen existencia cero, y el folio sólo siembra lo que tiene saldo.

⚠️ **La ubicación de los 23 dice `Z000`**, o sea que el catálogo no tiene ubicación real para
ninguno. El contador va a tener que buscarlos a ojo. No frena la prueba, pero **es trabajo extra que
hay que contar aparte** cuando se mida el tiempo: ese tiempo es de buscar, no de contar.

---

## 4. Quién hace qué

Medido contra producción — en Padre Hidalgo no hay nadie más con estos permisos:

| Paso | Quién | Por qué esa persona |
|---|---|---|
| **Abre el folio** | **Claudia Martínez Mata** (`claudia_mata`, supervisor) | abrir exige `SUPERVISAR`, y ella además puede reconciliar — cierra el ciclo sin depender de Compras |
| **Asigna quién cuenta** | **Cynthia López** o **Mónica Mejía** (encargadas de PH) | ⭐ es el estreno de `[IC.23]`: entran con `ASIGNAR`, sin ver el teórico |
| **Cuenta** | **Luis Espino** (`luis_espino`, almacenista) | **el único en Padre Hidalgo con permiso de contar** |
| **Resuelve y reconcilia** | **Claudia Martínez Mata** | `RECONCILIAR` — nadie más en PH lo tiene |

⚠️ **Antes de empezar, las encargadas tienen que cerrar sesión y volver a entrar.** El permiso nuevo
viaja dentro de su credencial y la que tienen abierta no lo trae.

⚠️ `rodrigo_ortiz` (Marketing) también aparece con permiso de contar, asignar y supervisar sobre
inventario. **No se usa en esta prueba** — que Marketing tenga esos permisos parece un arrastre que
hay que revisar aparte.

---

## 5. El guion

### Paso 1 — Abrir el folio · *Claudia*

`/almacen/inventory/sessions` → botón **Abrir folio**:

- Almacén: **01 · Padre Hidalgo**
- Tipo de conteo: **Cíclico (por clase ABC)**
- Clase: **A** (la pantalla muestra cuántos SKUs tiene)
- Tope de SKUs: **25**
- Congelar movimientos: **apagado** (se apaga solo al elegir cíclico)
- Doble conteo ciego: **apagarlo a mano**
- Umbral de recuento: **10**

**Qué se espera ver:** el aviso de confirmación debe decir **23 SKUs · cíclico clase A**, y **no**
debe decir «almacén congelado». Si dijera un número muy distinto de 23 o mencionara el congelado,
parar y avisar.

### Paso 2 — Asignar a quien cuenta · *Cynthia o Mónica* ⭐

En la lista de folios, en la fila del folio nuevo → botón **Asignar**:

- Contadores: **Luis Espino**
- Supervisores responsables: **Claudia Martínez Mata**

**Qué se espera ver:** la pantalla abre con lo que ya esté asignado (debería estar vacío la primera
vez) y guarda sin error. Las encargadas **no van a ver** la cantidad que el sistema espera de cada
producto: eso es a propósito.

### Paso 3 — Contar · *Luis*

`/almacen/inventory/count` (le aparece como su pantalla de entrada).

1. ⭐ **Apretar «empezar jornada» antes del primer escaneo.** De acá sale la medición de productos
   por hora. **Si se salta este paso, la prueba cuenta el inventario pero no mide nada**, que es la
   mitad del motivo por el que se hace.
2. Escanear cada producto y capturar la cantidad física.
3. Al terminar, **«terminar jornada»**.

**Si un código no pasa:** anotar cuál y seguir. Hay **2,735 códigos** en el sistema que resuelven en
una tabla y no en la otra — ninguno de estos 23 debería fallar, pero si alguno falla es un dato
importante, no un estorbo.

### Paso 4 — Calcular diferencias · *Claudia*

En el detalle del folio → **Calcular discrepancias**. El folio pasa a Revisión.

- Lo que esté dentro del 10 % se resuelve solo.
- Lo que se pase queda marcado y **hay que abrirlo y ponerle motivo** (merma, caducado, dañado,
  error de conteo previo, error de captura, devolución, transferencia, encontrado…).
- ⚠️ **Sin motivo no se puede cerrar el folio.** Es a propósito: ese motivo es lo que alimenta el
  indicador de merma por causa.

### Paso 5 — Reconciliar · *Claudia*

Botón **Reconciliar**. Esto **ajusta el saldo al físico contado**.

⚠️ Si el botón está apagado, la pantalla dice exactamente qué falta (productos sin contar,
diferencias sin resolver, diferencias sin motivo). No hay que adivinar.

### Paso 6 — Avisarle a Kepler · *Claudia*

1. **Exportar el archivo de ajuste** desde el folio ya reconciliado.
2. Capturarlo en Kepler.
3. ⭐ **Volver al folio y marcar el acuse**, con el folio que Kepler haya dado.

⛔ **Este paso es el que casi siempre se olvida, y sin él el trabajo no sirve de nada**: el ERP
conserva su saldo viejo y el próximo conteo vuelve a encontrar la misma diferencia. Nunca se ha
ejercido en producción.

---

## 6. Qué anotar (es el entregable de la prueba)

| Dato | De dónde sale |
|---|---|
| **Productos por hora por persona** | del propio sistema, si se usó «empezar / terminar jornada» |
| Tiempo de **buscar** vs tiempo de **contar** | a ojo, porque los 23 no tienen ubicación real |
| Cuántos cayeron fuera del 10 % | la pantalla de revisión |
| Cuánto tardó resolverlos y ponerles motivo | reloj |
| Códigos que no pasaron al escanear | anotados por Luis |
| ¿Se capturó en Kepler y se marcó el acuse? | sí / no |

⭐ **El número que más falta es el primero.** De ahí sale cuántos productos al día puede contar la
tienda — hoy la propuesta de «25 diarios» es una suposición mía, no una medición.

---

## 7. Si algo sale mal

| Síntoma | Qué es | Qué hacer |
|---|---|---|
| «Ya existe un folio abierto para este almacén» | sólo puede haber un folio vivo por almacén | cerrarlo o cancelarlo primero |
| Las encargadas no ven el botón **Asignar** | su credencial es vieja | cerrar sesión y volver a entrar |
| «Este almacén no tiene clasificación ABC» | no debería pasar en PH | avisar — se recalcula desde la pestaña Cíclico (ABC) |
| «Sin producto para el código …» | el código está en una tabla y no en la otra | anotar el código y seguir con el resto |
| El folio quedó a medias y se abandona | pasa | **cancelarlo**, que no ajusta nada; no dejarlo vivo bloqueando el almacén |

⛔ **Cancelar no es reconciliar.** Cancelar abandona el conteo y **no toca el inventario**.
Reconciliar **sí ajusta el saldo**. Son dos botones distintos a propósito.

---

## 8. Lo que esta prueba deja listo para después

- **El reloj de la cadencia arranca** — por primera vez va a existir un «última vez que se contó».
- **Se estrena el teórico que sale del ERP** (`[IC.1]`, en producción desde septiembre y nunca
  ejercido: los 6 folios viejos usaron la fuente anterior).
- **Se estrena el acuse de Kepler** (`[IC.7]`).
- **Sale el dato de productividad** que hace falta para fijar el cupo del ritmo diario (`[IC.18]`).

⛔ **Lo que esta prueba NO resuelve, y queda anotado:**

- **Yurécuaro (04) y Morelia Abastos (08) no tienen encargado de tienda** — ahí no hay quién asigne.
- **En Padre Hidalgo sólo una persona puede contar.** Para el ritmo diario, y sobre todo para
  cualquier conteo con doble verificación, hacen falta al menos dos.
- **Abrir un folio todavía exige el permiso que además deja ver el teórico**, así que por ahora lo
  abre Supervisión y no la tienda. Separarlo es parte de `[IC.18]`.
- **Los 23 productos no tienen ubicación real en el catálogo.**
