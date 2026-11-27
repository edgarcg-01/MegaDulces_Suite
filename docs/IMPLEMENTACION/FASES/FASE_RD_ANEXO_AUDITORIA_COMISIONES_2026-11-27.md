# Fase RD · Anexo — Auditoría de `/comercial/comisiones` (2026-11-27)

> **Disparador** (Edgar, 2026-11-27): *«este módulo actualmente se lleva en un Excel y ese Excel lo
> usan porque tienen tiempo y ya se acostumbraron; la problemática de esta interfaz es su
> complejidad para mostrar la información y la poca automatización, poca fiabilidad… auditala para
> que el proceso sea lo más simple y entendible posible.»*
>
> Es **la segunda vez** que se pide lo mismo: el 2026-10-08 el disparador fue *«es obsoleta, vieja e
> infuncional»* y produjo [`FASE_RD_COMISIONES_REFUNDACION`](FASE_RD_COMISIONES_REFUNDACION.md).
> Siete semanas después el Excel sigue siendo el que paga. Esa reincidencia es el dato más
> importante de este anexo: **lo que no se resolvió la vez pasada no era la pantalla.**

---

## 0. Nivel de evidencia (§1 de la skill `auditoria-diseno`)

| Nivel | Se usó | Alcance |
|---|---|---|
| **B — base de datos** | ✅ 11 consultas de sólo lectura contra `pg-prod` (`192.168.0.222:5434`, `system_identifier 7688376744939610156`) | corridas, líneas, padrón, contraste libro-motor, permisos por las tres vías, uso real (`analytics.ui_usage`), latencias |
| **C — fuente** | ✅ componente (3,721 líneas), 5 servicios del backend (4,987 líneas), controlador (32 endpoints), `tokens.css` | estructura, carga de la plantilla, contraste calculado, qué pide al abrir |
| **A — pantalla viva** | ✅ **añadido el mismo día, por la tarde** (`chrome-devtools` sobre prod, Chrome 157, 1978 × 962 y 1366 × 768) — ver **§4b** | pliegue y px reales, contraste de lo pintado, jerarquía, recorrido con teclado, objetivos, peticiones y tiempo de carga. ⛔ Siguen NO MEDIDOS: `forced-colors`, zoom 400 %, reflujo a 320 px, lector de pantalla y todo el **retrabajo**, porque exigen pulsar botones que **escriben en producción** |

Instrumentos con su control (§4): la consulta de permisos **falló su primer control** (buscaba una
clave `COMMERCIAL_REPLENISHMENT_*` que no existe) y se rehízo leyendo la resolución real del
`RolesGuard` — rol base + `identity.user_roles` + overrides de `identity.user_permissions` + god-mode.
El resultado por rol solo era **falso**. El calculador de contraste acertó sus dos controles
(21.00 y 4.48).

---

## 1. Lo que se midió, en una tabla

| # | Qué | Resultado |
|---|---|---|
| 1 | Corridas en prod | **23**: 20 `pagado` y 3 `borrador` |
| 2 | ⛔ Las 20 `pagado` | **todas con `origen = 'libro'`, creadas el mismo día (2026-10-08)**. Son la carga histórica del Excel, no cálculo del motor |
| 3 | ⛔⛔ Corridas **aprobadas** | **0. Nunca, ni una.** `approved_at` nulo en las 23 |
| 4 | Las 3 corridas del motor | Q21, Q22 y Q23 — llevan **35, 22 y 8 días en borrador** |
| 5 | ¿El cálculo es manual? | **No.** `CommissionAutoRunService` (RD.87) las creó solo, 1–2 días después de cada cierre (`created_by` nulo) |
| 6 | ⛔⛔ El motor contra el Excel | 238 ruta-periodo: **112 cuadran (47 %)**, 48 no pagan ninguno, **78 difieren (33 %)** |
| 7 | ⛔⛔ Cuánto difiere | el motor paga **$74,980.66 menos** sobre $937,781.87 del libro = **−8.0 %** |
| 8 | ⛔ Y por qué | **65 filas (−$30,721.89) con causa `sin_explicar`**; 14 por `faltan_dias_en_la_fuente` (−$35,897.25); 2 `cobertura_no_medida` (−$8,361.52) |
| 9 | Cuándo se midió ese contraste | **2026-11-04**. No se volvió a correr (`contrast/run`: 21 hits en 2 días, último el 05-nov) |
| 10 | ⛔ El neto | **22 de 23 corridas con `total_neto` NULL.** Las dos últimas lo declaran: *«sin deducción cargada: ANGEL ALBERTO VAZQUEZ MEJIA · FRANCISCO DE JESUS MARTINEZ RAZO · JOSE MANUEL HERRERA MARTINEZ · PATRICIA CHEVERRIA. El neto queda sin medir»* |
| 11 | El padrón | 16 rutas (11 RD activas, 3 vecinales, 2 bajas). **16 de 16 sin `chofer_user_id` y sin `supervisor_user_id`**: el cobrador es un texto, no una persona del sistema |
| 12 | `commission_beneficiary_config` | **0 filas. Nunca tuvo ninguna** |
| 13 | Líneas calculadas | 343; **95 (27.7 %) con `motivo_no_pago`** — 66 `bajo_umbral`, 18 `fuera_no_es_camion`, 6 `config_inactiva`, 3 `tipo_sin_declarar`, 2 `bajo_piso` |
| 14 | Costo del renglón | de 343 líneas, **32 `sin_costo` y 9 nulas**: 41 líneas donde el markup —del que cuelga el bono del supervisor— no se puede calcular |
| 15 | Permisos (tres vías) | **22 personas** alcanzan VER, 17 GESTIONAR, 17 PAGAR, **14 APROBAR**. ✅ La regla 20 está cumplida: **el permiso NO es el cuello** |
| 16 | Uso real (59 días) | `board` 147 hits en 32 días ≈ **4.6 aperturas/día**; `preview` 35 (último 13-nov); `recalculate-from` **2 en total**; **`approve`, `pay` y `void`: 0 hits** |
| 17 | Velocidad | todas las lecturas **< 25 ms** (universo 15 ms, contraste 18 ms, líneas 4 ms, tablero 4 ms, «lo que faltó» 22 ms). **La pantalla no es lenta** |
| 18 | Lo que pide al abrir | **9 peticiones**, 4 de ellas (padrón, bonos, tabulador, universo) para vistas que el usuario puede no abrir nunca |
| 19 | Tamaño | **3,721 líneas** en un componente · 5 vistas · hasta 5 pestañas internas · 3 diálogos · 32 endpoints |
| 20 | ⛔ Salida | **cero exportación**: ni CSV, ni copiar, ni imprimir, ni PDF. Nada sale de la pantalla hacia nómina |
| 21 | Roadmap | **la fase RD no tiene fila** en `00_ROADMAP_FASES_DETALLE.md` ni en `CLAUDE.md`. El método dice: *sin fila, la fase no existe* |

---

## 2. El diagnóstico: por qué siguen en el Excel

⛔⛔ **La premisa del pedido es sólo un tercio cierta, y conviene decirlo antes de rediseñar nada.**
«Lo usan porque tienen tiempo y ya se acostumbraron» describe una costumbre. Lo que la medición
muestra es que **hoy la Suite no puede reemplazar al Excel aunque alguien quisiera**, por cuatro
razones, en orden de cuánto pesan:

### 2.1 🔴 El número no cuadra — y es el único motivo que basta por sí solo

El motor paga **$74,980.66 menos que el Excel** sobre $937,781.87 (−8.0 %), y **65 renglones de esa
diferencia están clasificados por el propio sistema como `sin_explicar`**. Nadie —ni Comercial, ni
Dirección, ni Finanzas— va a firmar una nómina que le paga 8 % menos a 14 choferes sin poder decir
por qué en dos tercios de los casos. **Ese es el bloqueo, y no es de interfaz.**

Peor: el contraste se calculó **el 4 de noviembre** y ahí quedó. La pantalla muestra una foto de
hace 23 días como si fuera el estado actual.

> *Regla que cobra:* ADR-059 — la cifra se arbitra contra un testigo del mismo ERP y grano;
> `VERDAD_ABSOLUTA.md` §ADR-056 — lo que no se pudo medir se declara. `sin_explicar` **es** una
> declaración honesta; lo que falta es cerrarla, no esconderla.

### 2.2 🔴 El proceso no termina dentro de la Suite

**0 corridas aprobadas en toda la historia del módulo, y 0 llamadas a `approve`/`pay`/`void` en 59
días.** No es que el botón falte —existe desde `[RD.83]` y se ofrece a quien tiene la llave—: es que
antes del botón hay que poder afirmar un neto, y **el neto está NULL en 22 de 23 corridas**. Faltan
cuatro deducciones de supervisor. Cuatro filas de configuración detienen $1.1M de nómina anual.

Y aunque se aprobara, **no hay con qué entregarlo**: cero exportación. El Excel, además de calcular,
es el formato de entrega. Reemplazar la calculadora sin reemplazar el entregable deja el trabajo a
la mitad.

> *Regla que cobra:* `auditoria-diseno` §5 paso 7 — *comparar los endpoints del controlador contra
> los que la pantalla llama; el proceso no se puede terminar*. Aquí el endpoint existe, lo ofrece la
> pantalla, y aun así el proceso no termina: el obstáculo está **antes**, en el dato.

### 2.3 🟠 El cobrador no es una persona del sistema

**16 de 16 rutas con `chofer_user_id` y `supervisor_user_id` nulos**, y `commission_beneficiary_config`
con **0 filas desde siempre**. El beneficiario es un texto escrito a mano. Eso impide ligar la
comisión con el padrón de nómina, con RH y con el pago; e impide que el chofer vea lo suyo.

> *Cifra que lo vuelve urgente:* 24 de 105 líneas en borrador ni siquiera tienen
> `beneficiario_nombre`.
> *Memoria aplicable:* «cero filas por defecto es indistinguible de cero por desuso» — aquí está
> medido que es lo primero.

### 2.4 🟠 Y sí: la pantalla pide demasiado de una sola vez

Lo que Edgar llama complejidad, contado (§3c abajo): **5 vistas × hasta 5 pestañas internas**, 3
diálogos, ~150 cifras y ~40 controles en la primera pantalla, con el **85 % del texto en 13 px u 11
px**. Es real, y se arregla. Pero **es la cuarta causa, no la primera**: simplificar la pantalla sin
cerrar 2.1 y 2.2 produce una pantalla más bonita que nadie usará tampoco.

---

## 3. Los seis cruces (§3 de la skill)

| Cruce | Veredicto | Evidencia |
|---|---|---|
| **1 · toda cifra se puede recorrer** | ✅ pasa | ninguna lista del módulo tiene tope: el servicio no usa `limit` salvo un `LIMIT 1` de última quincena. El pie de la tira publica 27 y la tira pinta 27 |
| **2 · el rótulo dice lo que la celda muestra** | ✅ pasa, con historia | esta pantalla ya pagó ese error dos veces y lo corrigió: `[RD.64]` («Bruto» sobre `total_a_pagar`, ~$36,000 de diferencia) y `[AUD-CM.8]` (la tira sumaba supervisores sin decirlo). Hoy cada KPI lleva su `sub` explicando la resta |
| **3 · el contenedor cubre lo que contiene** | ❌ **no pasa** | la pantalla se llama «Comisiones» y contiene la nómina quincenal, el bono mensual por objetivo, el padrón editable, el catálogo de bonos y el tabulador con su simulador. Tres de esas cinco no son «la comisión de esta quincena»: son **su configuración** |
| **4 · lo que se ve ≠ la plantilla** | ⚠️ parcial | los tres plegables (`desgloseAbierto`, `padronAbierto`, `bonoAbierto`) nacen cerrados, así que la plantilla **no** infla el conteo por diálogos. Pero las 5 vistas y las 5 pestañas comparten el mismo archivo: de 3,721 líneas, la vista de entrada usa ~700 |
| **5 · dos vistas, el mismo universo** | ✅ pasa | el contraste y la tabla de líneas salen de la misma corrida persistida; la proyección en curso se declara «no es una corrida» |
| **6 · lo que viaja vs lo que se pinta** | ❌ **no pasa** | al abrir se piden **9 cosas**; 4 (padrón, bonos, tabulador, universo) alimentan vistas que el usuario puede no abrir. Es barato en ms (todo < 25 ms) y caro en atención: `bonos`, `escalas` y `universo` se pidieron ~106–135 veces en 22–23 días, casi siempre sin que nadie los mirara |

---

## 4. La ficha que se salta (§3c)

### 4.1 Carga visual — contada sobre la fuente (nivel C; los px reales piden nivel A)

| Variable | Medida | Veredicto |
|---|---|---|
| Controles accionables en la vista de entrada | **≈ 40**: 27 botones de quincena + 5 del conmutador de vistas + hasta 5 pestañas + 1–2 actos | ⚠️ Hick: 27 decisiones simultáneas sólo para elegir periodo |
| Controles en toda la plantilla | 25 `<button>` + 18 `<input>` + 5 `<select>` + 5 segmentados = **53** | — |
| Cifras a la vista | **≈ 150**: 1 monto grande + 4 del pie de la tira + 6 KPIs con sus `sub` (≈ 12) + 3 de «Lo que faltó» + una tabla de 12 columnas × 11 filas (132) | 🔴 muchas más de las que hacen falta para decidir «¿apruebo o no?» |
| El mismo dato repetido | el **neto** aparece en la tarjeta grande, otra vez como KPI «Neto» y otra en el pie «tras nómina − deducciones»; el **origen** de la corrida, en la tarjeta y en la línea `cm-proc` (el código ya lo detecta: `netoYaArriba()`, `[AUD-CM.10]`) | 🟠 2–3 repeticiones de los dos hechos principales |
| Avisos al mismo tiempo | hasta 4 competiendo: bloqueantes (rojo), reglas sin definir, «Lo que faltó», error de carga | 🟠 |
| Papeles del color | `--action` en 15 lugares (enlace, pestaña activa, borde de quincena, ciclo, botón), `--bad-fg` en 10 (texto negativo, error, gate, botón Anular, botón Baja) | 🟠 el naranja de acción no distingue «el botón principal» de «lo seleccionado» |
| Niveles tipográficos reales | 47 declaraciones: **24 en `--fs-sm` (13 px) y 16 en `--fs-micro` (11 px) = 85 %**; 1 sola en `--fs-h2` | 🔴 lo primario y lo terciario casi no se distinguen por tamaño |
| Marco contra trabajo | **NO MEDIDO** (pide nivel A): migas + tabs del sub-módulo + conmutador de 5 + tarjeta + tira de 27 antes de la primera fila de trabajo | ⛔ declarado |

### 4.2 Comprensión

- **La prueba de la frase** — 🔴 **no pasa**. La pantalla contesta **cinco** preguntas: *¿cuánto se
  le paga a cada chofer esta quincena?* · *¿quién alcanzó el bono mensual?* · *¿quién cobra y con
  qué tabulador?* · *¿qué bonos existen?* · *¿cuál es el tabulador vigente y qué pasaría si lo
  cambio?* Las últimas tres son **configuración**, no la quincena.
- **Rótulos** — ✅ el vocabulario está traducido con cuidado (`etiquetaProblema()` convierte
  `cobra_sin_fuente` en «Cobra y su fuente no da señal»). Es de lo mejor de la pantalla.
- **Términos sin definir** — 🟠 quedan en pantalla sin explicación al alcance: *markup*,
  *escalón*, *acantilado*, *traslape*, *multifuente*, *headroom*, *libro vs motor*, *arbitrado*.
- **Lo que vive sólo en un `title`** — 🔴 **el monto de cada una de las 27 quincenas está sólo en el
  `[title]` del botón** (la barra es `aria-hidden`). Sin mouse, ese dato no existe: la tira publica
  la forma del año y esconde sus cifras.

### 4.3 Accesibilidad — contraste calculado (controles: 21.00 y 4.48 ✅)

| Token · uso | Claro | Oscuro | Veredicto |
|---|---:|---:|---|
| `--warn-fg` en `.cm-corta` (texto) | **2.15:1** | 10.61:1 | 🔴 **falla AA** (piso 4.5). Para texto va `--warn-soft-fg` |
| `--bad-fg` en `.cm-neg`, `.cm-err`, botón «Anular» | 4.83:1 | 6.40:1 | ✅ pasa |
| `--action` en `.cm-reglas-link` (13 px) | 5.00:1 | 5.23:1 | ✅ pasa |
| `--c-text-3` / `--text-faint` | 5.28:1 | 5.25:1 | ✅ pasa |

- `aria-live`: **0 regiones propias**. Recalcular, aprobar o anular sólo se anuncian por el toast de
  PrimeNG. 🟠
- El color no va solo: ✅ los estados llevan `p-tag` con palabra.
- Teclado: la tira es un `radiogroup` con roving tabindex bien hecho ✅ (recorrerlo de verdad es
  nivel A: **NO MEDIDO**).
- `forced-colors`, zoom, reflujo a 320 px, lector de pantalla: ⛔ **NO MEDIDO**.
- Objetivos táctiles ≥ 44 px: ⛔ **NO MEDIDO** (la tira mide 53 px de alto total para 27 celdas).

### 4.4 Retrabajo

| Variable | Medida |
|---|---|
| Dato pedido dos veces | 🔴 **el proceso entero está duplicado**: lo que la Suite calcula sola cada quincena se vuelve a calcular a mano en `INDICADORES RD 2026.xlsx` (medido el 2026-10-07: **14,331 celdas tecleadas, 94.5 % manual** en la hoja CONCENTRADO). Ésa es la unidad de costo de este módulo |
| Proceso que no termina | 🔴 `approve`/`pay`/`void` existen, la pantalla los ofrece, **0 usos en 59 días** |
| Perder lo capturado, doble envío, lote parcial, corregir después | ⛔ **NO MEDIDO** (pide nivel A sobre los diálogos de padrón, bono y tabulador) |
| Clics que sólo confirman | ⛔ **NO MEDIDO** |

---

## 4b. Nivel A — la pantalla viva (2026-11-27, tarde)

> Medido con `chrome-devtools` sobre **prod**, Chrome 157, ventana **1978 × 962** CSS px (DPR 1.25),
> sesión `superoot SUPERADMIN`. ⛔ **Sólo lectura**: con una sesión que puede escribir, no se tocó
> ningún botón que escriba — por eso «estado sucio», «doble envío» y «lote parcial» siguen NO
> MEDIDOS. Controles del instrumento: contraste 21.00 y 4.48 ✅.

### 4b.1 ⛔⛔ El hallazgo que sólo se ve con la pantalla abierta: **el trabajo nace debajo del pliegue**

| Ventana | La tabla arranca en | Marco | Filas visibles al abrir | Hay que bajar |
|---|---:|---:|---:|---:|
| **1978 × 962** (el monitor de Edgar) | px **961** | **100 %** | **0 de 14** | 524 px |
| **1366 × 768** (una laptop normal) | px **1055** | **137 %** | **0 de 14** | 1,136 px |

⭐ **Se abre `/comercial/comisiones` y no se ve ni un chofer, ni un peso a pagar.** Lo que se ve es
contexto: 13 bloques antes de la primera fila —pestañas del sub-módulo (46 px), título (52),
conmutador de vistas (21), «LO QUE TOCA PAGAR» (90), la tira de 27 quincenas (55), el panel «Pasa,
con reservas» (98), la tira de KPIs (74), «dato hasta 18 nov» (17), «LO QUE EL CÁLCULO TODAVÍA NO
APLICA» (83), «FALTA APROBARLA» con sus botones (59), «LO QUE FALTÓ» (90) y un **segundo**
conmutador (21)—. El contenido mide **2.36 veces** la altura de una laptop.

⛔ **En laptop, ni siquiera el botón «Aprobar» se ve al abrir** (está en el px 854 de 770). El
único acto que la pantalla existe para permitir —y que lleva **0 usos en 59 días**— pide scroll.
Ésa es una explicación material del 2.2 que no requiere suponer nada sobre las costumbres de nadie.

⚠️ **Y esto se midió dos veces, porque la primera lectura dio otra cosa.** Una lectura intermedia
mostró el panel en `scrollTop: 300` con la tabla a la vista, lo que habría tumbado el hallazgo.
Se recargó y se muestreó **40 veces en 6 segundos sin tocar nada**: `scrollTop` queda en **0** y la
tabla en el px 961, sin un solo cambio. **La pantalla no se acomoda sola**; el 300 era una persona
mirándola. (Aplica [[feedback_reproducibility_is_not_validity]]: un número reproducible de un
estado equivocado no mide la pantalla al abrir.)

### 4b.2 Contraste — sobre lo pintado, no sobre los tokens

De **311 textos** del módulo, **2 quedan bajo el piso**:

| Texto | Clase | px | Ratio | Piso |
|---|---|---:|---:|---:|
| `11 / 12` — los **días trabajados** | `comm-num cm-corta` | 13 | **2.15:1** | 4.5 |
| `Anular` | `cm-btn--ghost` | 13 | **4.39:1** | 4.5 |

⭐ El 2.15 del §4.3 se confirma en pantalla, y es **peor de lo que se leía en el código**: el texto
menos legible de toda la pantalla es justo **el que explica por qué a alguien le pagan menos**.

⚠️ **Nota de instrumento, que vale más que el dato:** la primera pasada sólo midió lo que estaba
**dentro de la ventana** y encontró **1** falla. Midiendo el módulo entero aparecieron **2** — y la
peor era la que estaba debajo del pliegue. Un medidor de contraste que filtra por viewport
**absuelve justamente lo que nadie ve**. Se corrigió antes de publicar.

### 4b.3 Jerarquía, teclado y objetivos — lo demás del nivel A

| Variable | Medido en vivo | Veredicto |
|---|---|---|
| Niveles de tamaño | **8** (13 px ×188 · 11 ×75 · 12 ×35 · 24.8 ×5 · 16 ×3 · 24 ×2 · 14 ×2 · 20 ×1) | 🔴 contra los **3** declarados (§Q.5) |
| Texto en 13 px o menos | **298 de 311 = 96 %** | 🔴 el nivel C estimaba 85 % de las *declaraciones*; lo pintado es peor |
| Pesos fuera de escala | `600` (38 usos), que no está en 400/500/700/800 | 🟠 |
| Tabs hasta «Aprobar» | **65** | 🔴 el acto principal es el penúltimo destino del teclado |
| Tabs hasta la tabla | **72** | 🔴 |
| Filas operables con teclado | **14 de 14** con `tabindex` | ✅ la compuerta `check:teclado` cumple |
| Anillo de foco en «Aprobar» | `outline: auto 0.8px` — **el del navegador**, no el del sistema de diseño | 🟠 |
| Objetivos bajo 24 × 24 (AA 2.5.8) | **3**: «Ayuda» 30 × 22 · «Ver las preguntas» 101 × 17 · «6 ruta(s) con margen» 266 × 21 | 🟠 |
| Objetivos ≥ 44 px (táctil) | el equipo reporta puntero `fine` (mouse) | ⛔ **NO MEDIDO** — pide un equipo táctil |
| `lang`, un solo `<h1>` | `es` ✅, 1 `<h1>` ✅ (hay un `<h2>` vacío) | ✅ |
| `aria-live` | **1** región `polite` («Los datos pueden estar atrasados»), sin repetición medida | 🟠 |
| El mismo hecho repetido | «costo de una fuente» ×8 · «14» ×7 · «quincena» ×4 | 🟠 |
| Tabla cortada a lo ancho | en laptop, **8 px ocultos** a la derecha de 12 columnas | 🟠 límite, no hallazgo |

### 4b.4 ⚠️ Corrección al §5: «Rendimiento ✅» era una afirmación de nivel B

El §5 daba **✅ Pasa** porque las consultas rinden **< 25 ms**. Eso sigue siendo cierto y sigue
siendo de la base. Lo que la persona espera es otra cosa, y ahora está medido:

- **16 peticiones** al abrir (el §4 decía 9): **10 de comisiones** —`contrast`, `headroom`,
  `universe`, `routes`, `supervisors`, `bonuses`, `scales`, `board`, `definitions`, `runs/:id`—
  más 6 del marco de la app.
- La **última respuesta llega a los 2,726 ms**. Las más lentas: `users/me/scope` 1,336 ms ·
  `scales` 1,095 · `definitions` 1,073 · `bonuses` 1,058 · `board` 930.

⭐ La base contesta en milisegundos y **la pantalla tarda casi tres segundos**, porque pide diez
cosas a la vez —varias para vistas que nadie abrió todavía—. El veredicto de Rendimiento baja a
🟠 y el defecto es de **orquestación**, no de SQL.

---

## 5. Veredicto por capa (§3d) — nunca un promedio

| Capa | Veredicto | Por qué |
|---|---|---|
| **1 · Veracidad** | 🔴 **No pasa** | no por lo que la pantalla dibuja —que declara sus huecos con un cuidado poco común: `total_neto` NULL se publica como «—· sin medir», `sin calcular` se distingue de `en curso`— sino porque **publica como estado actual un contraste de hace 23 días** y porque el número de fondo difiere 8 % del que de verdad se paga, con 65 renglones sin explicación |
| **2 · Alcance** | 🔴 **No pasa** | el proceso no se puede terminar (0 aprobadas, 0 exportaciones), **el monto de 27 quincenas sólo se alcanza con el mouse** y —medido en vivo, §4b.1— **el trabajo nace debajo del pliegue en las dos ventanas probadas**: 0 de 14 rutas visibles al abrir, y en laptop ni el botón «Aprobar» |
| **3 · Comprensión** | 🟠 Pasa con deuda | la prueba de la frase falla (5 preguntas en una pantalla); el vocabulario traducido es bueno; 8 términos del oficio sin definir en pantalla |
| **4 · Sencillez** | 🔴 **No pasa** *(era 🟠; lo baja el nivel A)* | **13 bloques de antesala** antes de la primera fila y 2.36 pantallas de alto en laptop; ~40 controles y ~150 cifras; **16 peticiones** al abrir, varias para vistas que nadie pidió |
| **5 · Respeto** | ⛔ **NO MEDIDO** | estado sucio, doble envío y lote parcial exigen pulsar botones que **escriben en prod**: no se hizo a propósito. Pide un entorno de pruebas |
| *(transversal)* Contraste | 🟠 | **medido sobre lo pintado**: 2 de 311 textos bajo el piso. El peor, a **2.15:1**, son los **días trabajados** — el dato que explica un pago menor |
| *(transversal)* Jerarquía | 🔴 *(era 🟠)* | **8 niveles** de tamaño contra los 3 declarados, y **96 % del texto (298 de 311) en 13 px o menos** |
| *(transversal)* Rendimiento | 🟠 *(era ✅; ver §4b.4)* | la base contesta **< 25 ms**, pero la pantalla termina de cargar a los **2,726 ms** con 16 peticiones. El defecto es de orquestación, no de SQL |

⛔ **Con una 🔴 en Veracidad y otra en Alcance, el módulo no pasa.** Y nada de eso se arregla
cambiando la pantalla.

---

## 6. La propuesta: qué hacer, en orden

> Las cinco preguntas de [`diseno` §0b](../../../.claude/skills/diseno/SKILL.md), contestadas por
> escrito, van en §6.2. Primero lo que no es de diseño, porque es lo que manda.

### 6.1 Antes de tocar un pixel — tres cosas que cierran el proceso

| # | Qué | Costo | Qué desbloquea |
|---|---|---|---|
| **RD-A1** | **Cargar las 4 deducciones de supervisor** que faltan (ANGEL ALBERTO VAZQUEZ MEJIA, FRANCISCO DE JESUS MARTINEZ RAZO, JOSE MANUEL HERRERA MARTINEZ, PATRICIA CHEVERRIA) | 4 filas | el **neto** deja de ser NULL y Q22/Q23 se vuelven aprobables. Es lo más barato del documento |
| **RD-A2** | **Cerrar las 65 filas `sin_explicar`** del contraste: por cada una, o se explica la diferencia o se corrige el motor. Y volver a correr el contraste, que está congelado desde el 04-nov | lo más caro, y lo único que de verdad decide | que alguien pueda firmar el número de la Suite en vez del del Excel |
| **RD-A3** | **Dar salida al resultado**: la corrida aprobada produce el entregable que hoy produce el Excel (el formato que Finanzas/RH recibe) | un endpoint y un botón | que aprobar sirva de algo |

⚠️ **RD-A2 es la condición de todo.** Mientras el motor pague 8 % menos sin explicarlo, el Excel es
la decisión correcta de Comercial, no una costumbre.

### 6.2 Las cinco preguntas, y el corte que proponen

1. **¿Qué debe ver el usuario, y en qué orden?** Para la persona que autoriza la quincena:
   (a) **cuánto se paga en total y a quién**, (b) **qué impide aprobarla**, (c) **en qué difiere del
   Excel y por qué**, (d) el botón de aprobar. Nada más.
2. **¿Qué NO debe ver?** El padrón editable, el catálogo de bonos, el tabulador y su simulador. Son
   configuración: se tocan cuando cambia una regla, no cada quincena.
3. **¿Qué accesibilidad necesita la información?** El monto de cada quincena **no puede vivir en un
   `title`**; la tira necesita que el dato se lea sin mouse. Y `.cm-corta` sale de `--warn-fg`.
4. **¿Está ligada a otro proceso?** Sí, a tres: nómina (RH), pago (Finanzas) y el padrón de
   personas. Hoy los tres eslabones están cortados — por eso 2.3 y RD-A3.
5. **¿Este proceso la debe ver?** El chofer debería ver lo suyo y hoy no lo alcanza. Fuera de
   alcance de este anexo; vale como item aparte.

**El corte, en una línea:** `/comercial/comisiones` se queda con **la quincena** y nada más; padrón,
bonos y tabulador se van a una pantalla hermana de **configuración** (`/comercial/comisiones/reglas`,
mismo permiso `GESTIONAR`). El bono por objetivo ya tiene ruta propia viva
(`/comercial/comisiones/objetivo`) y puede volver a ser su propia vista.

> ⚠️ Esto **revierte en parte a `[AUD-A6]`**, que fusionó todo en una pantalla por pedido de Edgar
> («todo lo que es comisión de Ruta Directa en una sola interfaz»). La fusión resolvió un problema
> real —tres pantallas hermanas que no se encontraban— y lo hizo bien. Lo que la medición agrega
> hoy es que **una sola interfaz por flujo no es una sola interfaz para cinco flujos**: operar la
> quincena y configurar las reglas son dos trabajos, con distinta frecuencia (24 veces al año contra
> unas pocas) y distinta gente. **La decisión es de Edgar**, no de esta auditoría.

### 6.3 Lo que simplifica la vista que queda

| # | Sev | Observación | Criterio de aceptación |
|---|---|---|---|
| RD.UI.1 | 🔴 | El monto de las 27 quincenas sólo está en el `title` del botón | la cifra del periodo elegido se lee como texto, sin mouse; la barra sigue siendo decoración |
| RD.UI.2 | 🔴 | El contraste libro-motor se publica sin decir de cuándo es (congelado el 04-nov) | junto al bloque va `computed_at` con píldora de frescura; si tiene más de una quincena, se declara añejo |
| RD.UI.3 | 🟠 | 6 KPIs con `sub` ≈ 12 cifras, cuando la decisión es una sola: *¿apruebo?* | la tira baja a **3**: Bruto · Tras nómina · **Neto** (el que decide, el más grande); subtotal y comisión se abren en el desglose |
| RD.UI.4 | 🟠 | `.cm-corta` usa `--warn-fg` como color de texto: 2.15:1 | pasa a `--warn-soft-fg`; se verifica con el script de contraste y su control |
| RD.UI.5 | 🟠 | 9 peticiones al abrir; 4 para vistas que puede no abrir | padrón, bonos, tabulador y universo se piden al entrar a su vista |
| RD.UI.6 | 🟠 | 85 % del texto en 13 px u 11 px: el veredicto compite con los encabezados | tres niveles declarados — primario (el neto), secundario (KPIs y tabla), terciario (procedencia) |
| RD.UI.7 | 🟠 | 8 términos del oficio sin definir en pantalla (markup, escalón, acantilado, traslape, multifuente, headroom, arbitrado, libro vs motor) | cada uno con su `app-context-help`, no con un `title` |
| RD.UI.8 | 🟡 | `--action` cumple 5 papeles (enlace, pestaña activa, selección, ciclo, botón) | el naranja queda para el botón principal y la selección; el resto, neutro |
| RD.UI.9 | 🟡 | El neto se repite 3 veces en la primera pantalla | se dice una vez, en grande, con su resta al lado |

### 6.4 Proceso

- **RD-P1** — la fase RD **no tiene fila en el roadmap**. Sin fila no existe (método §2). Hay que
  agregarla con su estado real: el motor está en prod y el módulo **no está adoptado**.
- **RD-P2** — `FASE_RD_CICLO_QUINCENAL` y `FASE_RD_COMISIONES_REFUNDACION` siguen diciendo
  «PLANEADA, sin código» mientras prod sirve 3,721 líneas y 23 corridas. Los docs están rancios.

---

## 7. Lo que esta auditoría NO midió, y hay que medir

⛔ Se declara, no se dibuja como verde (ADR-056):

1. ~~Todo el nivel A~~ → **medido el mismo día, §4b**. Queda fuera lo que no se puede ver sin otro
   equipo o sin escribir: **`forced-colors`, zoom 400 %, reflujo a 320 px, lector de pantalla** y
   **objetivos táctiles** (el equipo de la medición tiene puntero `fine`).
2. **Retrabajo en los diálogos**: estado sucio al salir del alta de padrón, doble clic en «Estrenar
   esta versión» del tabulador, lote parcial en «recalcular desde». ⛔ **No se midió a propósito**:
   con una sesión `SUPERADMIN` contra prod, ejercerlos **escribe**. Pide un entorno de pruebas
   (es la regla 13 del proyecto, mirada desde el otro lado).
3. **El proceso real de Comercial con el Excel**: cuántas personas, cuántas horas por quincena,
   quién entrega a quién. Sin eso, «lo usan porque ya se acostumbraron» sigue siendo una hipótesis.
4. **Las 65 filas `sin_explicar`** una por una: están contadas, no diagnosticadas.
