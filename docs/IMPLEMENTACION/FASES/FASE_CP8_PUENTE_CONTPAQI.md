# FASE CP.8 — El puente Suite ↔ ContPAQi

> **Estado:** 🔨 PLAN · CP.8.1–8.3 en código (sin aplicar) · **ADR:** ADR-040 (hereda) ·
> **Pedido de Edgar (2026-10-08):** *"quiero que de aquí salga la póliza y se haga
> automáticamente en ContPAQi y viceversa"* → *"debemos generar una **sincronía o puente** entre
> las dos"*.
> **Decode y mediciones que lo sostienen:** [`FASE_CP_CONTPAQI.md`](FASE_CP_CONTPAQI.md) §7 (SDK)
> y §9 (los tres flujos, el mapa derivado).

---

## 0. Qué es un puente — y por qué dos tubos no lo son

**Un puente son TRES cosas, no dos:**

| | Qué es | Estado hoy |
|---|---|---|
| **Vuelta** | ContPAQi → Suite | 🟢 **Construida y corriendo** (5 carriles, el principal **@1 min**) |
| **Ida** | Suite → ContPAQi | 🔴 Nada automático; sólo el TXT mensual del libro de compras, a mano |
| **⭐ Cuadre** | *Lo que la Suite cree* vs *lo que ContPAQi tiene* | 🔴 **No existe en ninguna parte** |

⭐ **El cuadre es lo que vuelve "sincronía" a lo que si no son dos tubos paralelos.** Sin él,
mandamos una póliza y nunca sabemos si entró, si entró dos veces o si entró cambiada — que es
exactamente el estado actual del libro de compras: se entrega un TXT y nadie verifica nada.

> **La definición operativa que usa este plan:** *un evento está **sincronizado** cuando la Suite
> puede señalar, para ese evento, el asiento concreto que ContPAQi tiene, y los dos importes
> coinciden al centavo.* Todo lo demás es `no verificado` — **que no es lo mismo que `difiere`**
> (ADR-056: las dos ausencias se declaran distinto).

---

## 1. El hallazgo que define la arquitectura

⭐⭐ **El puente cierra SIN el SDK.** Medido el 2026-10-08:

- `analytics.gl_poliza_lines.concepto` **existe**, con índice de expresión sobre
  `upper(concepto)` (migración `20260903140000`, Fase LC.15).
- El carril `contpaqi` de [`ops/vl/crontab.feeds`](../../../ops/vl/crontab.feeds) corre
  **cada minuto** y escribe esa columna.
- El layout del TXT **sí transporta `concepto` del movimiento** (100 caracteres, `LAYOUT_M` en
  `poliza-txt.ts`) y hoy va **vacío en el 100%** de las patas de compras.

→ Si la Suite escribe un **token de correlación** en el concepto, el carril de la vuelta lo trae
de regreso en menos de un minuto y el cuadre se cierra solo. **El SDK no es requisito del
puente: es requisito de que la IDA sea automática.** Son dos cosas distintas y conviene no
confundirlas, porque el SDK depende de una máquina y una licencia, y el puente no.

```text
       ┌──────────────────────── SUITE ────────────────────────┐
       │  evento (CB/CC/LC)                                    │
       │        │                                              │
       │        ▼  reglas (contpaqi.account_rules)             │
       │   armador ──► asiento + TOKEN en el concepto          │
       │        │                                              │
       │        ▼                                              │
       │   poliza_exports  (armada)                            │
       └────────┬──────────────────────────────▲───────────────┘
                │ IDA                          │ CUADRE
       sink ────┤  TXT (hoy, humano importa)   │  busca el token en
                └► SDK (después, automático)   │  gl_poliza_lines.concepto
                            │                  │
                            ▼                  │
       ┌──────────────── CONTPAQi ─────────────┴───────────────┐
       │  Polizas / MovimientosPoliza                          │
       │        │                                              │
       │        └─► VUELTA: carril `contpaqi` @1 min  ─────────┘
       └───────────────────────────────────────────────────────┘
```

⚠️ **Lo que NO está probado de esto:** el camino de lectura del concepto se construyó en LC.15
**pero nunca se ejerció de punta a punta**, porque **ningún TXT nuestro ha sido importado jamás**
— el separador del layout sigue sin verificarse contra un archivo real (`SEP` en
`poliza-txt.ts`). El token volviendo es una **hipótesis con mecanismo construido**, no un hecho
medido. Se convierte en hecho con el primer TXT aceptado, y eso es `[CP.8.4]`.

---

## 2. La unidad de sincronía: el evento

**El puente no sincroniza "pólizas": sincroniza EVENTOS.** Un evento es un hecho de la Suite que
debe quedar asentado: un movimiento bancario clasificado (CB), un pago a proveedor (CC), el
libro de compras del mes (LC).

| | Lado Suite | Lado ContPAQi |
|---|---|---|
| Identidad | `(evento_tipo, evento_id)` — **UNIQUE**, ya en la migración `[CP.8.1]` | `(Ejercicio, Periodo, TipoPol, Folio)` + `Guid` |
| Quién la asigna | nosotros | **ContPAQi** (el folio no lo controlamos) |
| Puente | **token de correlación** en `Concepto`, leído de vuelta por el carril @1 min | |

⭐ **Por eso la identidad del evento vive del lado de la Suite y el token la transporta.** Pedirle
a ContPAQi que respete un folio nuestro sería pelearnos con su numeración; el token no le pide
nada: viaja en un campo que hoy va vacío.

**Ciclo de vida** (`contpaqi.poliza_exports.estado`, ya creado):

```text
armada ──► entregada ──► aplicada
   │           │             ▲
   │           └─────────────┘  el cuadre la asciende, nadie la declara "aplicada" a mano
   └──► rechazada (con motivo)
```

Y `verificada` es **ternario a propósito**: `NULL` = nadie lo comprobó · `true` = el token
apareció y los importes cuadran · `false` = apareció y **no** cuadra, o no apareció pasado el
plazo. `NULL` no es `false`.

---

## 3. Las etapas

### E0 — Cimientos ✅ EN CÓDIGO 2026-10-08 (sin aplicar)

| | Qué | Estado |
|---|---|---|
| `[CP.8.1]` | `contpaqi.account_rules` + `contpaqi.poliza_exports` (RLS, `tenant_id`, idempotencia por evento) | ✅ migración escrita, **sin aplicar** |
| `[CP.8.2]` | `poliza-egreso.ts` — el armador. Puro, sin DI | ✅ |
| `[CP.8.3]` | Candado: 33 ✓ / 0 ✗, reproduce 3 pólizas REALES, probado por mutación | ✅ en `run-all-tests` |

### E1 — La ida por archivo (sin dependencias externas) ⬜

| | Qué | Por qué |
|---|---|---|
| `[CP.8.4]` ⛔ | **Conseguir un TXT real ya aceptado** y cerrar el `SEP` | **Ruta crítica de TODO.** Cuesta cero código. Mientras no esté, cada póliza que generemos es una apuesta sobre un formato sin verificar |
| `[CP.8.5]` ✅ | `CONTPAQI_POLIZA_SINK_PORT` + `ContpaqiTxtSinkAdapter` | **EN CÓDIGO 2026-10-08.** Ver nota abajo |
| `[CP.8.6]` ✅ | **El token de correlación** (`token.ts`) | **EN CÓDIGO 2026-10-09.** `MD:`+12 hex, determinista por evento. Ver nota abajo |
| `[CP.8.32]` | Bandeja `/finanzas/contpaqi`: armar → revisar → entregar | HITL. El motor arma, la persona entrega (ADR-028 intacto) |

#### `[CP.8.5]` — qué se hizo y qué costó (2026-10-08)

**Hallazgo al abrirlo:** `construirTxt` estaba **clavado a Diario (`'3'`) y descartaba el
segmento de negocio** — se escribió para el libro de compras y nada más. Un egreso es
`TipoPol=2`, y medido sobre pólizas reales **sí lleva segmento** (`IdSegNeg=8` en el renglón del
gasto de traslado de efectivo).

⛔ **Se rechazó escribir un segundo serializador.** El propio `poliza-txt.ts` documenta que
escritor y lector no se pueden separar: los anchos viven una sola vez y los leen los dos. Dos
serializadores son dos verdades sobre el mismo formato, y el síntoma aparecería el día que
alguien corrija un ancho. En su lugar `construirTxt` se **generalizó compatible hacia atrás**:
`tipoPol` con default `'3'` y `seg_negocio` opcional. LC llama igual que siempre y sale idéntico
al byte — **verificado: su smoke da 38 ok · 0 fallidas antes y después**.

| Archivo | Qué |
|---|---|
| `libs/contracts/src/ports/contpaqi-poliza-sink.port.ts` | El puerto. `txt` y `sdk` detrás del mismo token |
| `libs/finance/src/lib/contpaqi/txt-sink.adapter.ts` | El sink de archivo |
| `database/tests/test-newdb-contpaqi-txt-sink.js` | **26 ✓ / 0 ✗**, en `run-all-tests` |

**Tres decisiones que vale la pena no re-litigar:**

1. ⭐ El sink devuelve **`entregada`, nunca `aplicada`**. Generar un archivo no es asentar una
   póliza: en medio hay una persona que lo importa. Quien puede afirmar que ContPAQi lo tiene es
   el cuadre (`[CP.8.8]`). Confundirlas es el problema que este puente existe para resolver.
2. **Folio `0`** — que ContPAQi asigne el suyo. No controlamos su numeración; para eso está el
   token.
3. **Un token que no entra en los 100 chars del concepto se RECHAZA, no se recorta.** Un token
   cortado no casa con nada y el evento quedaría entregado y para siempre sin verificar — que se
   ve igual que uno que todavía no llega.

**Probado por mutación (un candado que nunca se puso rojo no está probado):**

| Mutación | Qué pasó |
|---|---|
| `construirTxt` ignora `tipoPol` | ✗ *el encabezado dice TipoPol 2, no 3* — **25 ✓ / 1 ✗** |
| `construirTxt` descarta `seg_negocio` | ✗ *el segmento 8 sobrevive el viaje* — **25 ✓ / 1 ✗** |
| el adaptador declara `sink = 'xyz'` | `tsc` TS2416 — el puerto ata de verdad |

### E2 — ⭐ El cuadre (lo que lo vuelve puente) ⬜

| | Qué |
|---|---|
| `[CP.8.8]` ✅ | **EN CÓDIGO 2026-10-08** — el motor de cuadre. Ver nota abajo |
| `[CP.8.9]` ✅ | Importes al centavo + motivo escrito siempre — **entró con `[CP.8.8]`**, es la misma regla |
| `[CP.8.10]` | Latido en `CRON_JOBS` que mide **ENTREGA** (eventos sincronizados), no "el proceso corrió" (ADR-053) |
| `[CP.8.11]` | Bandeja de divergencias + el **plazo**: un evento `armada` que lleva N días sin aparecer es un hallazgo, no un pendiente |

> ⛔ **E2 no es opcional y no se pospone.** Sin E2 esto es un exportador. Y es barato: la lectura
> ya existe y corre cada minuto.

#### `[CP.8.8]` — qué se hizo y qué se midió (2026-10-08)

`libs/finance/src/lib/contpaqi/cuadre.engine.ts` — puro, sin DI ni base: el servicio hará la I/O
y le pasa los candidatos ya leídos. Candado `test-newdb-contpaqi-cuadre.js`: **35 ✓ / 0 ✗**.

**Corrección al plan original:** §E2 decía buscar el token en `gl_poliza_lines.concepto`. Medido,
va en **`analytics.gl_polizas.concepto`** — el token viaja en el concepto del **encabezado**, y
esa tabla además trae `guid`, `cargos`, `abonos` y `folio`, o sea todo lo que el cuadre necesita
en una sola fila (128,478 pólizas).

⛔ **Y el índice de LC.15 NO le sirve al puente:** es parcial con `WHERE length(concepto) = 36`,
o sea que sólo indexa conceptos que son un UUID pelado. Un concepto con token + texto nunca lo
usa.

**Dos llaves, y no son intercambiables** — la lección de `[LC.14]`, donde se midió que ninguna
es superconjunto de la otra:

| Llave | Qué significa | Qué hace |
|---|---|---|
| `token` | **certeza** — volvió lo que nosotros escribimos | asciende solo a `aplicada` |
| `importe` | **sospecha** — misma fecha, tipo y total | queda `probable`; **NO asciende** |

⛔ Tratar una coincidencia por importe como certeza es cómo se cuela un duplicado: dos pagos del
mismo monto el mismo día son comunes (medido: `PAGO COMBUSTIBLE` aparece 326 veces en un año).

**Seis veredictos, porque cuatro mienten.** `esperando` y `no_aparecio` se ven igual en una tabla
y se arreglan distinto — una se espera, la otra se investiga. Por eso `verificada` es ternario y
`esperando` devuelve `null`, nunca `false` (ADR-056).

**Probado por mutación:**

| Mutación | Resultado |
|---|---|
| el match por importe asciende a `aplicada` | **31 ✓ / 4 ✗** |
| `esperando` devuelve `false` en vez de `null` | **34 ✓ / 1 ✗** |
| tolerancia de 1 ¢ en el cuadre de importes | **30 ✓ / 5 ✗** |

⚠️ **Una aserción mía nació mal y la atrapó la primera corrida**: decía *"2026 bisiesto"* y pedía
2 días entre el 28-feb y el 1-mar. 2026 **no** es bisiesto; el motor tenía razón. Quedó con los
dos casos (2026 y 2024) para que el bisiesto se pruebe de verdad.

**Decisión medida — NO se agrega índice todavía.** La consulta del cuadre contra prod da
**24–32 ms** en caliente (seq scan paralelo, 4,229 buffers), muy por debajo del gate de 500 ms.
Un índice parcial `WHERE concepto LIKE 'MD:%'` sería lo correcto más adelante, pero agregarlo hoy
—con CONCURRENTLY y ventana fuera de horario— es infraestructura contra un problema que no
existe. **Disparador para agregarlo:** que esa consulta pase de 200 ms, o que `gl_polizas` supere
~500 mil filas.

### E3 — El mapa firmado (dependencia humana: el contador) ⬜

| | Qué |
|---|---|
| `[CP.8.33]` | UI de reglas con su **confianza medida** + aprobación (`derivada` → `aprobada`) |
| ~~`[CP.8.13]`~~ | ✅ **HECHO como `[CP.8.20]`** — y no por RFC sino por el **UUID del CFDI**: 99.8 % del importe |
| ~~`[CP.8.14]`~~ | ✅ **HECHO en `[CP.8.2]`**: `iva` es parámetro OBLIGATORIO y el armador se niega a derivarlo |
| ~~`[CP.8.15]`~~ | ✅ **MEDIDAS Y DECLARADAS** en `[CP.8.22]`/`[CP.8.27]`: no son derivables, y 3 **no pueden tener UNA cuenta** |

### E4 — La ida automática (dependencia: terminal + SDK) ⬜

| | Qué |
|---|---|
| `[CP.8.40]` | Correr [`01-probe-sdk.ps1`](../../../database/importers/contpaqi/01-probe-sdk.ps1) en la terminal ContPAQi — ⭐ ya tiene dirección: **`192.168.0.208`** (`0contabilidadd`) |
| `[CP.8.41]` | El agente (`.exe`/servicio C#), **un endpoint**, sin lógica de negocio |
| `[CP.8.42]` | `SdkSinkAdapter` + **reversa automática a TXT** si el agente no responde |
| ~~`[CP.8.19]`~~ | ⭐⭐ **HECHO SIN SDK** en `[CP.8.29]` (renglones `AD`). ⛔ Era el argumento #2 del SDK y **ya no existe** |

### E5 — Ampliar flujos ⬜

Orden por costo/beneficio medido: **egresos** (crosswalk listo 16/18, 4,735/año tecleados) →
**compras** (LC ya genera) → **ventas** (hay que decidir el grano y cerrar ~$35M/mes de
cobertura: conversación de negocio, no de código).

---

## 4. Ruta crítica

```text
[CP.8.4] TXT real  ──► E1 ──► E2  =  PUENTE AUDITABLE (sin SDK, sin licencia, sin máquina)
                         │
[CP.8.16] sondeo ────────┴────► E4  =  IDA AUTOMÁTICA
[contador] ──────────────┴────► E3  =  COBERTURA REAL
```

⭐ **Las tres ramas son independientes entre sí**: el TXT no espera al contador, el contador no
espera al SDK. Lo único que bloquea a todo es `[CP.8.4]`, y **no cuesta código**.

---

## 5. Definición de TERMINADO (medible, no declarativa)

El puente está terminado cuando, **medido contra prod**:

1. Un evento de egreso recorre `armada → entregada → aplicada` **sin que nadie teclee** el
   resultado: el cuadre lo asciende.
2. `poliza_exports.verificada = true` para ≥95% de los eventos entregados del último mes
   cerrado, y **el resto tiene motivo escrito** — ninguno en `NULL` pasado el plazo.
3. El latido `CRON_JOBS` reporta **eventos sincronizados**, con umbral registrado, y se probó
   **en rojo** (ADR-056: un gate sin prueba negativa es una intención).
4. Reenviar el mismo evento **no duplica** — verificado a propósito, no por construcción.
5. Un asiento descuadrado **es rechazado**, probado mandándolo a propósito.

⛔ **No cuenta como terminado:** "el TXT se generó", "el agente está arriba", "la migración se
aplicó". Son pasos, no entrega.

---

## 6. Riesgos y decisiones abiertas

| | Riesgo | Mitigación |
|---|---|---|
| ⛔ | **El `SEP` del TXT sigue sin verificar.** Todo E1 descansa en un formato supuesto | `[CP.8.4]`, cuesta cero |
| ⛔ | **El token en el concepto nunca se ejerció** (LC.15 se construyó, nunca se importó un TXT nuestro) | Se vuelve hecho con el primer TXT aceptado |
| ⚠️ | El contador **edita el concepto** al revisar → el token se pierde | El cuadre cae a `no verificado` con motivo, no a `aplicada` falsa. Y se mide |
| ⚠️ | Los 100 chars del concepto se comparten con el UUID del CFDI (36) | Token corto. Medir que entren los dos |
| ⚠️ | `contpaqi.poliza_exports` guarda el asiento en `jsonb`: si las reglas cambian, lo ya enviado **no** se recalcula | Es lo correcto — un envío es un hecho histórico. Igual que `[RD.21]` |
| ❓ | ¿`Login` del SDK consume asiento de licencia? | Sólo afecta E4. `01-probe-sdk.ps1` + abrir el sistema |
| ❓ | ¿Qué pasa con las pólizas que **ContPAQi crea y la Suite no conoce**? | **Decisión abierta**: hoy la vuelta las trae pero nadie las reclama. Puede ser correcto (la contabilidad tiene vida propia) o ser un hueco |

---

## 7. Lo que este puente NO es

- ⛔ **No escribe a la base de ContPAQi.** Nunca. Archivo o SDK (regla 3 de `FASE_CP` §6).
- ⛔ **No cierra el libro.** El contador decide; el motor arma.
- ⛔ **No reemplaza a ContPAQi.** Sigue siendo el system of record contable (ADR-040).
- ⛔ **No toca el servidor `.35`** — ver `FASE_CP` §7.6: sin WinRM, sin RDP, y poner código
  nuestro adentro del servidor contable no es necesario.

---

## 8. El plan que viene DESPUÉS

Pedido explícito de Edgar: *"una vez terminado el puente generamos un plan de implementación con
todo lo que se pueda hacer teniendo esta conexión"*. **No se escribe todavía, a propósito** — lo
que el puente habilita depende de qué tan buena resulte la cobertura real (E3) y de si la ida
queda automática (E4). Escribirlo hoy sería planear sobre supuestos.

Lo que ya está medido y seguramente entre: cerrar el **0% de UUID en 5 años**, retirar el
**provisional de octubre** (31 días pre-cargados con 4–5 importes repetidos, §9.3), y los
**~$35M/mes de venta** que hoy no llegan a la contabilidad.

---

## 9. ⛔⛔ `[CP.8.4]` dejó de ser un trámite — el layout está MAL en tres puntos concretos

**Medido el 2026-10-08**, buscando el formato oficial de importación. `[CP.8.4]` venía descrito
como *"conseguir un TXT, cuesta cero código"*. No es eso: **lo que tenemos probablemente no es el
formato que ContPAQi espera**, y cada discrepancia corre todos los campos siguientes de su
renglón — o sea que el archivo no se degrada, se vuelve basura a partir de ahí.

| Campo | Nuestro layout | Las fuentes | Qué rompe |
|---|--:|--:|---|
| `clase` (encabezado) | **1** | **4** | corre **3 chars** todo lo que sigue en el `P` |
| `referencia` (movimiento) | **10** | **30** en versiones recientes | corre **20 chars** todo lo que sigue en el `M` |
| fecha de aplicación (`P`) | no existe | agregada al esquema | un campo entero ausente |

⭐ **Lo único que SÍ se despejó:** dos fuentes independientes coinciden en que los campos van
**separados por un espacio**. `SEP = ' '` es correcto y la hipótesis de concatenación pura queda
**descartada** — era la duda que la cabecera de `poliza-txt.ts` declaraba como la única abierta.

⛔ **No se corrigió ningún ancho.** Cambiar un número sin verificar por otro número sin verificar
mueve el riesgo de lugar; una cifra de un foro no vale más que un decode propio. Se **declara**
el conflicto (ADR-056) y se cierra con el árbitro, no votando.

### 9.1 ⭐⭐ Y la cuarta, que no es de ancho sino de capacidad: el formato SÍ lleva el UUID

Dos fuentes independientes describen renglones **`AD ` + UUID + espacio**, ubicados **después del
`P`**. Ejemplo citado: `AD 0101da01-b0d1-0cee-0101-f0a1c010cb1c `

**Esto refuta una premisa central de `FASE_LC`**, que dice textualmente *"el layout no tiene campo
de UUID"* y de ahí deriva que las patas sin CFDI *"no es descuido de la contadora, el formato no
lo transporta"*. De esa premisa salieron las dos muletas de LC.15 (el UUID metido en `Concepto`
y el CSV para el Asociador).

**Si el renglón `AD` existe, los 0 de 33,303 movimientos sin asociar en cinco años (§7.9 de
`FASE_CP`) no son una limitación del formato: son renglones que nadie emitió.**

⚠️ Y entonces **el valor #2 del SDK se cae**: §7.5 lo justificaba por la asociación formal del
UUID. Si el TXT la puede hacer, al SDK le queda un solo argumento — que nadie tenga que apretar
Importar. Sigue siendo un argumento válido; es mucho más chico que el que estaba escrito.

⚠️⚠️ **No se cambió nada de LC ni se emitieron renglones `AD`.** Es un hallazgo de fuentes
externas sobre una premisa que LC midió de otra forma; se verifica con el árbitro antes de tocar
un flujo que mueve $30–56M al mes.

### 9.2 El árbitro tiene nombre y ruta

**`C:\Compac\Empresas\Esquemas\Contpaq\CT_EST_Poliza_NG.xls`** en `192.168.0.35` — es el esquema
que ContPAQi usa para *leer* el TXT. Zanja las cuatro preguntas de una sola vez.

⛔ **Re-medido hoy: inalcanzable.** SMB (445) responde *no existe* sin credenciales —el mismo
"Acceso denegado" que `FASE_LC` registró el 2026-09-01—, WinRM está cerrado y no hay RDP. **No es
un problema técnico: es de acceso.**

> **Las dos formas de cerrarlo, cualquiera sirve:** copia de ese `.xls` (es un archivo de
> documentación, no datos), **o** un TXT de póliza que ContPAQi ya haya aceptado — con un archivo
> real, `parsearTxt` mide los anchos solo.

### 9.3 Qué se hizo con esto

- `poliza-txt.ts`: la cabecera decía *"`SEP` es lo ÚNICO sin verificar"* — **era falso** y ahora
  lo dice. Nuevas constantes `LAYOUT_SIN_VERIFICAR` y `LAYOUT_ARBITRO`.
- `test-newdb-contpaqi-txt-sink.js`: imprime un bloque **`NO MEDIDO`** con las cuatro, al lado
  del `26 ✓ / 0 ✗`. ⭐ Va **impreso, no en un comentario**: un comentario no avisa cuando deja de
  ser cierto, y las 26 pruebas verdes sólo demuestran que el sink es coherente **consigo mismo**.
- Nada de LC cambió: su smoke sigue en **38 ok · 0 fallidas**.

---

## 10. ⭐⭐⭐ `[CP.8.4]` RESUELTO — apareció el árbitro, y nuestro layout estaba mal

**2026-10-08.** `02-evaluar-esquema.ps1` —escrito para que alguien lo corriera en el servidor—
se probó en la máquina de trabajo y **encontró ahí mismo una exportación real de pólizas de
ContPAQi**. No hizo falta entrar a `.35`: el árbitro llevaba meses en `Documents`.

### 10.1 Por qué es definitivo

Dos verificaciones independientes, y las dos cierran:

1. **Aritmética.** Los anchos derivados reproducen los largos reales **exacto**: P = 185, M = 272.
2. **Cruce contra la base.** Los `Guid` del archivo existen en ContPAQi:

| | Del archivo | Encontrados en la base |
|---|--:|---|
| `P` | 14 | **14/14** en `Polizas` |
| `M1` | 82 | **82/82** en `MovimientosPoliza` |
| `AD` | 62 UUID | **234 filas** de `AsocCFDIs` |

Y campo por campo la primera póliza coincide: `Ejercicio 2026 · Periodo 9 · TipoPol 2 ·
Folio 250 · Clase 1 · Impresa · SistOrig 11 · 20260901 · "PAGO TARJETA DEBITO (PUENTE)"`.

### 10.2 Quién tenía razón

| Campo | Nuestro layout | Fuente externa | **REAL** | |
|---|--:|--:|--:|---|
| `clase` (P) | 1 | 4 | **1** | ⭐ **teníamos razón nosotros** |
| `referencia` (M) | 10 | 30 | **30** | la fuente externa |
| `seg_negocio` (M) | 10 | — | **4** | **se equivocaban los dos** |
| `fecha_aplicacion` | no existe | 8, en el `P` | **8, en el `M`** | existe, pero no donde decían |

⭐ **La lección está en `clase`:** la fuente externa decía 4, nosotros 1, y el real es **1**.
"Corregir" a lo que decía el foro habría roto el único campo que estaba bien. Por eso en §9 se
declaró el conflicto en vez de votarlo — y resultó ser la decisión correcta.

### 10.3 Y tres cosas que NADIE había visto

Son las que de verdad hacían inservible el archivo, y ninguna estaba en disputa porque nadie
sabía que existían:

1. **Cada renglón lleva su `Guid` de 36 al final** — el de `Polizas` / `MovimientosPoliza`.
2. **Toda línea termina en UN ESPACIO.** Verificado en las 232 del archivo. El emisor calcula
   `Σanchos + (n−1)` separadores; el real es `Σanchos + n`.
3. **La etiqueta del movimiento es `M1`**, no `M `.

### 10.4 ⭐⭐ El UUID: confirmado contra la base, ya no contra foros

**62 renglones `AD ` + UUID + espacio (40 chars)** que cruzan a **234 filas de `AsocCFDIs`**.

**`FASE_LC` está refutada en este punto**: dice *"el layout no tiene campo de UUID"* y que las
patas sin CFDI *"no es descuido de la contadora, el formato no lo transporta"*. **El formato sí
lo transporta.** Los **0 de 33,303 movimientos sin asociar en cinco años** son renglones que
nadie emitió — y se cierran **sin SDK, sin licencia y sin máquina nueva**.

### 10.5 ⛔ Lo que sigue sin decodificar, declarado

El archivo trae además **`AM` (170 renglones), `AP` (26), `I` (104), `V` (54) y `W2` (54)**.
Los guids de `AM` **no** son `MovimientosPoliza.Guid` ni `AsocCFDIs.GuidRef` — se cruzaron los
dos y dieron **0**. No se interpretan (ADR-056). Nada de eso hace falta para emitir una póliza,
pero **no se debe asumir que son opcionales** hasta medirlo.

### 10.6 Qué se hizo, y qué NO

- `layout.params.ts`: `LAYOUT_REAL_P` / `LAYOUT_REAL_M` con los anchos medidos. `ESTRATEGIA`
  pasa a **`alinear` / `decidido`** — `propio` perdió su único motivo, que era evitar dudas.
- El candado mide el layout **contra el archivo real** y hace **skip limpio** donde no está.
  41 ✓ / 0 ✗ · 7 NO MEDIDO.
- ⛔ **El archivo NO se commitea.** Trae cuentas, importes, conceptos y UUID de la contabilidad,
  y **este repo es público**. Nueva regla en `.gitignore`: `database/tests/fixtures/*.txt`.
- ⛔ **El emisor NO se cambió todavía, a propósito.** Pasar de 147/211 a 185/272 toca el libro de
  compras, que mueve **$30–56M al mes**. Es un sprint con su propio candado y su propia prueba
  de mutación — no un `sed`. Hasta entonces el smoke lo grita en cada corrida.

---

## 11. `[CP.8.13]` ✅ El emisor escribe el formato REAL — 14/14 byte a byte

**2026-10-08.** `poliza-txt.ts` pasa de P=147/M=211 (nunca verificado) a **P=185/M=272**, el
formato que ContPAQi usa de verdad.

### 11.1 El control que se corrió ANTES de tocar nada

La pregunta que podía tumbar todo el decode: *¿y si el 147/211 sí se importaba, y lo que
decodifiqué es sólo el formato de exportación?* Medido contra prod:

| estado | tipo | n | archivos | **aplicados** |
|---|---|--:|--:|--:|
| borrador | libro | 1 | 0 | 0 |
| generado | complemento | 2 | 1 (P=147/M=211) | **0** |

**Cero corridas `entregado`, cero `aplicado`.** Ningún archivo con el formato viejo llegó jamás
a ContPAQi — no se rompió nada que estuviera funcionando.

### 11.2 ⭐⭐ La prueba: round-trip byte a byte

Desarmar cada póliza real y volver a armarla tiene que dar **el mismo byte**. Todo lo demás
verifica el emisor contra sí mismo; **esto lo verifica contra ContPAQi**. Y encontró dos
defectos que ninguna prueba de coherencia interna podía ver:

1. **`impTxt` escribía `11787.50` donde ContPAQi escribe `11787.5`.** ⭐ El comentario del
   código **siempre** dijo la regla correcta (*"entre 1 y 2 decimales: `6.5` y `6.53` valen"*) y
   el código no la implementaba. 3 de 14 pólizas diferían sólo por esto.
2. **`impresa` estaba clavado en `'0'`** y la póliza real trae `1` (la base lo confirma:
   `Impresa: true`). Un byte, en la posición 144.

**Resultado: 14/14 pólizas reales idénticas.** Fijado como candado, y mutado: con `impTxt`
volviendo a 2 decimales cae a **9/14**.

### 11.3 ⛔ Dos bugs que yo mismo introduje, y los atrapó LC

La autodetección de formato (necesaria para seguir leyendo los archivos ya guardados) salió mal
dos veces, y las dos las encontró el smoke de la Fase LC:

1. **Detectar por largo de línea.** Un editor come los blancos del final; una línea real
   recortada queda más corta que 147 y se lee como legado — **con los anchos equivocados, en
   silencio**. Lo atrapó una aserción que LC ya tenía exactamente para ese caso.
2. **Detectar por la negativa** (*"no hay ninguna `M1`"*). Un archivo con **sólo encabezados** no
   tiene nada que discrimine y caía a legado, rompiendo el parseo de lo que el emisor acababa de
   escribir.

El criterio final va **por la positiva y por la etiqueta**: legado sólo si aparece `M ` explícito.
Es exacto, sobrevive el recorte, y el default es el formato actual.

> ⭐ Las dos veces el error era mío y el que avisó fue el candado de **otra fase**. Es el
> argumento más concreto a favor de no bajarle el alcance a un smoke heredado para que pase.

### 11.4 Qué cambió

| | |
|---|---|
| `armarLinea` | cierra la línea con separador (las 232 líneas reales terminan en espacio) |
| `LAYOUT_P` / `LAYOUT_M` | los reales: +`guid`(36), `referencia` 10→30, `seg_negocio` 10→4, +`fecha_aplicacion`(8) |
| `LAYOUT_*_LEGACY` | se conservan **sólo** para leer los archivos ya guardados |
| `construirTxt` | emite `M1`, y acepta `guid` / `impresa` / `ajuste` |
| `parsearTxt` | autodetecta el formato por archivo y devuelve los campos nuevos |
| `impTxt` | la regla mínima de decimales que el comentario ya describía |

**Candados:** armador 33 ✓ · sink **42 ✓** · cuadre 35 ✓ · **LC 38 ✓ / 0 ✗** (sus 5 aserciones
de layout se actualizaron a los valores reales).

### 11.5 ⚠️ Lo que sigue sin probarse

- **Que ContPAQi ACEPTE lo que emitimos.** El round-trip prueba que escribimos el mismo formato
  que ContPAQi exporta; que su importador lo lea igual es una inferencia razonable —es la misma
  función de su manual, "Exportación e **Importación** de pólizas en formato ASCII"— pero **se
  confirma importando un archivo, no argumentando.**
- **Si ContPAQi respeta el `guid` que mandamos** o genera el suyo. Si lo respeta, es mejor llave
  de correlación que el token en el concepto: estructural y sin gastar los 100 caracteres.
- Los renglones `AD` **todavía no se emiten** (`EMITE_AD_UUID = false`).
- `AM`, `AP`, `I`, `V`, `W2` siguen sin decodificar.

---

## 12. `[CP.8.6]` ✅ El token — y un parámetro mío que estaba mal razonado

**2026-10-09.** `libs/finance/src/lib/contpaqi/token.ts`. Candado **29 ✓ / 0 ✗**.

### 12.1 Determinista, y por qué importa

El token sale de `(evento_tipo, evento_id)` por hash. ⭐ Con uno **aleatorio**, re-emitir un evento
crearía un token nuevo y **la entrega anterior quedaría huérfana para siempre** — se vería perdida
estando asentada. Determinista, re-emitir vuelve a casar con lo que ya está. Y es reproducible a
mano: dado un evento se puede calcular qué buscar sin abrir la base.

El separador `|` no es cosmético: sin él `('a','bc')` y `('ab','c')` darían el mismo hash.

### 12.2 ⛔ El largo pasó de 8 a 12 hex — el respaldo viejo estaba mal de dos maneras

`layout.params.ts` decía *"8 hex = 4,294,967,296 combinaciones; el universo es ~5k eventos/año"*.

1. **El universo medido son 55,369** (`finance.bank_movements`), no 5 mil — 11× lo que supuse.
2. ⭐ **Comparar el tamaño del espacio contra el volumen es el error clásico del cumpleaños.** Lo
   que importa no es si 55 mil entra en 4 mil millones: es `n²/2N`.

| hex | espacio | esperadas con n=55,369 | con n×10 |
|---|--:|--:|--:|
| 8 | 4.29e9 | **0.357** | 35.7 |
| 10 | 1.10e12 | 0.0014 | **0.139** |
| **12** | **2.81e14** | **0.000005** | **0.0005** |

Cuestan 4 caracteres de 100. No había razón para arriesgar.

### 12.3 ⭐⭐ Y una fragilidad en mi propio candado, que destapó una mutación

La prueba negativa contaba colisiones de 8 hex sobre el universo real y exigía `> 0`. **Pasaba
porque este hash dio exactamente 1 — pero el valor esperado es 0.357.** Con otras entradas da 0 y
la prueba se pondría roja sin que nada estuviera mal.

⭐ **Una aserción que depende de la suerte del hash no guarda nada.** Se reemplazó por la cota del
cumpleaños, que es determinista y además *dice el razonamiento*. Efecto medido: la mutación a 8 hex
ahora dispara **4 fallas** en vez de 2.

### 12.4 El contrato de recorte, cambiado para mejor

Antes el sink rechazaba cuando token + descripción pasaban de 100. Ahora **se recorta la
DESCRIPCIÓN y el token sobrevive entero** — la descripción es texto para que un humano se ubique;
perder su cola no rompe nada. Se rechaza sólo si el **token** no entra en el campo.

⛔ Y lo que sigue sin admitirse: **un token a medias**. No casa con nada y dejaría el evento
entregado y para siempre sin verificar — que en una tabla se ve igual que uno que todavía no llega.

---

## 13. `[CP.8.10]` 🔨 El servicio del cuadre — escrito, y declarado NO MEDIDO

**2026-10-09.** `libs/finance/src/lib/contpaqi/contpaqi-cuadre.service.ts`.

### 13.1 Qué hace, y qué NO hace

Tres cosas: lee lo que espera confirmación, busca sus candidatos en `analytics.gl_polizas` —que
el carril `contpaqi` refresca **cada minuto**— y escribe el veredicto.

⭐ **Toda la regla vive en el motor puro**, que tiene su propio candado (35 ✓). El servicio no la
reimplementa ni la "ayuda" con atajos: si hiciera falta una excepción, va en el motor y con su
prueba. Es lo que permite que la parte difícil esté verificada aunque la I/O no se haya podido
ejercer.

⛔ **`aplicada` sólo llega por el veredicto homónimo.** `probable`, `difiere`, `ambiguo` y
`esperando` **no mueven el estado**: el evento sigue entregado y su veredicto vive en
`verificada` + `motivo`. Es lo que separa un puente de un exportador optimista.

### 13.2 El latido mide ENTREGA, y su umbral está registrado

`job_key: 'contpaqi_cuadre'`, cada 10 min, con entrada en `CRON_JOBS` de `db-health.service.ts`
(`warnH: 3`, `critH: 12`). ⚠️ **Sin esa fila el sensor cae en `cfg ? classify : 'ok'` y da verde
incondicional** — lo midió la Fase VP sobre 3 matvistas del sell-out.

La nota dice lo accionable: `N/M sincronizados · X esperando · Y difieren · Z por confirmar`. Y
⭐ **cero pendientes no es salud: es silencio**, y la nota lo dice con esas palabras en vez de
reportar un `ok` vacío.

La cadencia sale de medir el otro lado: el carril de vuelta corre cada minuto, así que 10 min
sobra para que una póliza importada aparezca, y no castiga la base con una consulta por minuto
sobre 128 mil filas.

### 13.3 ⛔ Por qué NO está registrado en ningún módulo

A propósito. Registrarlo agendaría su `@Cron` y, con la migración `[CP.8.1]` **sin aplicar**,
fallaría cada 10 minutos en producción contra una tabla que no existe. **El wiring va junto con
la migración, como un solo paso.**

### 13.4 ⚠️ NO MEDIDO, y por qué no se fabricó un candado

El servicio **no se ejerció contra datos reales**: `contpaqi.*` está en 0 tablas.

⛔ Y no se escribió una prueba sustituta, porque las dos disponibles son justamente las que este
repo tiene documentadas como **no-pruebas**:

| Sustituto | Por qué no |
|---|---|
| regex sobre el fuente | *un smoke por REGEX sobre el fuente NO es un test* |
| doble de Knex | *un doble de Knex no ejecuta SQL* |

Lo que sí se verificó: **typecheck limpio** (encontró 2 errores reales — un campo que faltaba en
`ExportPendiente` y un `andWhereNull` inexistente, que además delató una consulta confusa que se
reescribió), y las **cuatro aserciones estáticas** que el candado de observabilidad hace sobre
`CRON_JOBS` (el candado completo se niega a correr contra prod porque escribe y borra — la
compuerta `assert-safe-target` haciendo su trabajo).

> ⭐ Se declara `NO MEDIDO` en vez de inventar un verde. Es la misma regla que el resto de la
> fase aplica a los datos.

---

## 14. 🚀 `[CP.8.1]` EN PROD — batches 856 y 857 (2026-10-09)

Autorizado por Edgar. Aplicadas **una por una** con `apply-one-migration-prod.js` dentro del pod
de `api`, nunca `migrate:latest` (en prod hay **DOS** `knex_migrations` y el `search_path` lleva a
la vacía).

### 14.1 Pre-vuelo

- ⛔ **Desde la máquina de trabajo NO se puede aplicar**: `edgar` da `crea_db: false` y sus roles
  son `dev_ro, edgar`. La conexión de desarrollo es **de sólo lectura por diseño**.
- Candados reales por `pg_stat_activity` **desde dentro del pod de Postgres** (desde `edgar` el
  `query` y el `usename` de otros roles vienen en blanco y se leen como «no hay nada corriendo»):
  **0 locks sin otorgar**, `rollout status` terminado.

### 14.2 ⛔ Dos trampas que el camino documentado no cubría

**1. `{.items[0]}` devolvió un pod `Failed`.** El runbook dice *«hay DOS pods de api, da igual
cuál»*. **No da igual**: había **cuatro** —dos `Failed` de ayer y dos `Running` de hoy— y el
selector por índice eligió uno muerto (`cannot exec into a completed pod`). ⭐ Hay que filtrar por
fase: `--field-selector=status.phase=Running`.

**2. El incidente que `CLAUDE.md` documenta, vivo y bloqueando.** Knex abortó con *«migration
directory is corrupt»* nombrando **3 migraciones de otras sesiones** aplicadas en prod cuyos
archivos no están en la imagen. Dos estaban commiteadas localmente; la tercera
(`20261008174531_budget_budgets_is_test.js`) **no existe en `origin/main`** — vive sólo en el
commit `f5c1f5080` de la rama sin mergear `feat/pu-is-test`.

⛔ **No se creó ningún placeholder**: se extrajeron los **archivos reales** con
`git show <commit>:<ruta>` y se copiaron al pod. Son migraciones ya aplicadas — knex no las vuelve
a correr, sólo necesita verlas.

> ⭐ Es exactamente lo que el modo de trabajo advierte: *«una migración aplicada desde un commit
> que nunca se empujó deja el ledger de prod referenciando algo que la imagen no tiene y frena la
> siguiente migración de cualquiera»*. Frenó la mía.

### 14.3 ⚠️ Un error propio: `dev_ro` quedó fuera

`20261008155000` otorgó a `app_runtime` y **se olvidó de `dev_ro`**. Medido justo después:

```text
analytics | t    commercial | t    finance | t    fiscal | t
contpaqi  | f   <-- el único
```

⭐ **El síntoma engaña**: `information_schema.tables` devuelve **vacío** en vez de dar error,
porque filtra por privilegio. Desde una sesión de desarrollo el schema se ve **inexistente**, no
prohibido — y «no existe» es la conclusión equivocada cuando la migración sí se aplicó.

Corregido con `20261009101500_contpaqi_grants_dev_ro.js` (batch 857), **migración nueva y no
editando la aplicada**: editarla no la volvería a correr, y dejaría el archivo diciendo algo que
esa corrida no hizo.

### 14.4 Verificado en prod

| | |
|---|---|
| Identidad del clúster | `7688376744939610156` (la misma antes y después) |
| Tablas | `account_rules`, `poliza_exports` — **RLS `true` + forzado `true`** |
| Políticas | `tenant_isolation` en ambas |
| Grants | `app_runtime`: SELECT/INSERT/UPDATE/DELETE · `dev_ro`: SELECT |
| Semillas | **6 reglas** — 5 `derivada` con su confianza medida, `imss_sua` `sin_regla` sin cuenta |
| `poliza_exports` | 0 filas (correcto: nada entregado todavía) |

**Prueba negativa del CHECK, corrida en prod dentro de una transacción con `ROLLBACK`:**

- `derivada` **sin** cuenta → `violates check constraint "account_rules_cuenta_chk"` ✓
- `sin_regla` **sin** cuenta → aceptada ✓ (es el caso de `imss_sua`)

⚠️ El primer intento de esta prueba lo corrí como `edgar`, que **sólo tiene SELECT**: el rechazo
habría sido por permiso y no por el CHECK. Casi publico una aserción falsa. Se repitió como
`postgres`, donde el rechazo es el que se buscaba.

### 14.5 ⚠️ Un despliegue ajeno cruzó la corrida

A mitad de la verificación, un `57P03 — the database system is shutting down`. **No lo causé**:
era `auto-deploy` reemplazando los pods con la imagen `de2f53c8`. Se esperó el rollout y se
re-verificó: **misma identidad de clúster, las 2 tablas y las 6 reglas intactas**.

---

## 15. ⛔⛔ `[CP.8.1c]` — Las reglas estaban claveadas a categorías que no existen

**2026-10-09, batch 858.** Un error de diseño propio, encontrado al ir a construir el eslabón que
arma y entrega un evento: **nada podía armarse**, y al medir por qué apareció esto.

### 15.1 Derivé del lado equivocado

La semilla de `20261008155000` nació de medir lo que **ContPAQi asienta**, agrupando por sus
CONCEPTOS (`PAGO COMBUSTIBLE`, `PAGO ARRENDADORA HMS`…). **Esa medición es correcta y sigue
valiendo.** El error fue **bautizar las reglas con esos nombres como si fueran categorías de CB**.

```text
combustible · mant_reparto · renta_muebles   ->  NO EXISTEN en finance.movement_categories
imss_sua · renta · traslado_valores          ->  existen
```

⭐ **La entrada del puente es `movement_categories.code`.** Las reglas tienen que estar claveadas
a eso, no a los conceptos del otro lado. Son **dos taxonomías distintas** y asumí que coincidían
porque tres nombres se parecían.

**Lo que costaba:** las 6 reglas cubrían **17 movimientos de 55,648**, y 12 eran justamente la
categoría sin regla. El volumen real —`compra_mercancia` 4,749/$404M, `compra_tarjeta`,
`comision_bancaria`, `nomina`— **no tenía ninguna**.

### 15.2 Se intentó derivar el mapa correcto. No se puede con estas llaves

Pareo movimiento bancario ↔ póliza por `(fecha, importe)`:

| | |
|---|---|
| **Placebo** (fecha desfasada 37 y 91 días) | 463 y 453 pares contra **3,371** del real |
| Veredicto | hay señal (7.3× el piso) pero el piso es **14%** de los pares |

⚠️ **Y el primer intento estaba peor por un error mío:** `analytics.gl_polizas` mezcla **dos
fuentes** y no filtré `source`.

```text
kepler    110,007 pólizas · plan corto (511, 601-014) ·      0 cuentas de 10 dígitos
contpaqi   19,398 pólizas ·                              249,122 cuentas de 10 dígitos
```

El **85%** de los pareos traía el plan de cuentas ajeno — por eso `nomina` daba *"RENTA BIENES
INMUEBLES"*. ⭐ *El primer veredicto fue correcto por el motivo equivocado*, que es su propia
clase de error.

Filtrado bien **sigue sin servir**: `traspaso_entre_cuentas` → renta al 76% (y un traspaso no
tiene cuenta de resultado), y los importes son una astilla del volumen. Una póliza trae decenas
de renglones de gasto: parear por el total del documento no dice cuál corresponde al pago.

### 15.3 Qué se sembró, y por qué CERO utilizables es el punto

| | antes | ahora |
|---|--:|--:|
| Reglas | 6 | **19** (las de salida reales de CB) |
| Huérfanas | **3** | **0** |
| Cobertura de egresos | 17 / 55,648 (0.03%) | **22,819 / 22,899 (99.7%)** |
| Utilizables | 5 | **0** |

⭐ **Cero utilizables no es un defecto: es la corrección.** El puente ahora conoce el 99.7% de los
egresos y **se niega a asentar cualquiera** hasta que el contador firme. Antes conocía el 0.03% y
creía poder asentar 5.

`cuenta_gasto` y `confianza_pct` quedan **NULL en las 19**: un porcentaje al lado de una cuenta
vacía se lee como *«esta regla ya está confirmada»*. La evidencia viaja en `concepto_medido` como
texto, así que aprobar **exige escribir la cuenta** — que es el acto que se le está pidiendo.

### 15.4 Lo que la evidencia dice, y que el contador va a necesitar

Cuatro categorías **probablemente no deban asentarse por este puente**, y está escrito en cada una:

- `traspaso_entre_cuentas` ($225M) — neto 0, sin P&L.
- `iva_acreditable` — no es gasto; el armador ya pone ese renglón desde el CFDI.
- `gasto_admin` — cajón de sastre (`VIATICOS AARON`, `BONO CAPITAN DE MARCA`): **partir antes de mapear**.
- `compra_mercancia` ($404M) — no es cuenta fija: es **proveedor → su subcuenta**, resoluble por
  RFC contra `analytics.contpaqi_suppliers` (3,411, 99.6% con RFC).

Y las dos propuestas con respaldo, declaradas como **inferencia entre taxonomías**:
`renta` → `5200510001` (97.9%) · `traslado_valores` → `5200680000` (100%).

### 15.5 ⚠️ Séptima vez que un acento grave rompe el build

Escribí `` `renta` `` dentro de un template literal del SQL y cortó la cadena
(`missing ) after argument list`). Lo agarró `node -c` **antes** de llegar a prod.

---

## 16. `[CP.8.7]` La plomería: de un movimiento bancario a una póliza (2026-10-09)

`ContpaqiArmadoService` — el eslabón que faltaba. Sin él `poliza_exports` queda vacía para
siempre y el cuadre no tiene qué cuadrar.

### 16.1 ⭐⭐ El modelo de entrada era otro: el IVA NO viene en el mismo renglón

Lo primero que había que entender, y no lo sabía: **el banco cobra el gasto y su impuesto como
dos movimientos distintos.**

```text
"ADM PAQUETE PYME"  ->  490.00     (categoría del gasto)
"IVA"               ->   78.40     (categoría iva_acreditable)      490 × 0.16 = 78.40
```

Por eso CB tiene 4,632 movimientos en `iva_acreditable`. Medido contra prod:

| | |
|---|--:|
| IVA con hermano exacto (misma cuenta, misma fecha, ×0.16) | **76.8%** |
| ambiguos (más de un candidato) | 1.5% |
| ⭐ **placebo** — fecha corrida 43 días | **0.1%** |

**768× el piso de ruido.** El pareo es real, no una coincidencia aritmética.

⚠️ El 23.2% sin hermano **se declara**: puede ser gasto exento, IVA cobrado otro día, o un cargo
con impuesto adentro. Se arma con IVA 0 — **nunca calculando un 16% que nadie cobró**.

⛔ Y no hay atajo por CFDI: `bank_movements.client_uuid` parece un UUID pero es la llave de
idempotencia del importer (SHA-1); **0 de 55,648 cruzan con `fiscal.cfdis`**.

### 16.2 Ejercitado contra prod, y lo que encontró

Corrido en simulación sobre enero y febrero: **4,166 egresos reales**, cada uno rechazado con
motivo específico.

| Motivo | ene | feb |
|---|--:|--:|
| `sin_regla` — el mapa no está firmado | 1,474 | 1,176 |
| cuenta de banco **`CG`** sin `contpaqi_cuenta` | 864 | 619 |
| cuenta de banco **`FAC`** sin `contpaqi_cuenta` | 12 | 21 |
| categoría sin fila de regla | 2 | 2 |

**Dos hallazgos:**

1. ⚠️ **`CAJA CG` ($81.8M / 10,303 egresos) y `FACTORAJE` ($17.4M) no tienen enlace a ContPAQi** —
   y no es un error: **no son bancos** (`kind` = `cash` y `factoraje`). Las **18 cuentas de banco
   reales sí están enlazadas**. CP.2 enlazó bancos; nadie mapeó caja ni factoraje. Es un hueco del
   crosswalk, declarado, no inventable desde acá.
2. ⛔ **Un hueco propio de `[CP.8.1c]`**: sembré las categorías con `flow` `out`/`both`, y hay **2
   de `flow='in'` que aparecen con salida** — `cobranza` (79) e `ingreso_devolucion` (1). Son
   reversos: un cobro que se devuelve sale por el banco. *El `flow` del catálogo describe la
   intención de la categoría, no lo que cada movimiento termina haciendo.* Cerrado con
   `[CP.8.1d]` (batch 859).

### 16.3 ⭐ Hoy rechaza TODO, y eso es lo correcto

Las 21 reglas están en `sin_regla`. **Cero armables no es una falla a medias: es la única conducta
honesta mientras el mapa no esté firmado** — y el día que se firme una regla, el candado se pone
rojo, que es exactamente cuando hay que volver a mirarlo.

Candado del puente: **39 ✓ / 0 ✗ · 2 NO MEDIDO**, con el armador ejercitado contra prod en
simulación (lee de verdad, no escribe una fila).

⚠️ Una aserción mía dio falso rojo: cortaba el motivo a 40 caracteres y eso partía
`contpaqi_cuenta` por la mitad. **Fallaba por el recorte, no por el dato** — y parecía un
hallazgo.

---

## 17. ⭐⭐⭐ `[CP.8.17]` El mapa SÍ se deriva — y la derivación dice que el diseño está mal (2026-10-09)

**Pedido de Edgar:** *"dime qué podemos hacer con toda esa información, qué es y cómo la podemos
cablear para automatizar trabajo"*. Antes de contestar se midió. Lo medido cambia el plan.

### 17.1 El cruce que `[CP.8.1c]` declaró imposible, con las llaves correctas, funciona

`[CP.8.1c]` concluyó que el mapa categoría→cuenta **no es derivable**. Esa conclusión se sacó
cruzando `analytics.gl_polizas` contra los *conceptos* de ContPAQi. Con la llave correcta —
**(cuenta de banco, fecha, importe)** contra los **abonos a `102*`** de ContPAQi — sí cruza:

| ene–feb 2026 | |
|---|--:|
| Egresos de CB con cuenta de banco enlazada | 2,650 |
| **Pareo exacto 1:1** | **737 · 27.8 %** |
| Ambiguos (≥2 pólizas con mismo banco/fecha/importe) | 48 · 1.8 % |
| ⭐ **Placebo** (fecha corrida 43 días) | **2 · 0.1 %** |

**278× el piso de ruido.** El cruce es real.

### 17.2 ⛔ Pero el mapa NO tiene la forma de la tabla que construimos

`contpaqi.account_rules` tiene **una fila por categoría con UNA cuenta**. La derivación muestra
que eso sólo sirve para una minoría. Hay **tres tipos de regla distintos**:

| Categoría CB | Pareados | Renglones/póliza | % con IVA | La cuenta la decide… |
|---|--:|--:|--:|---|
| `compra_mercancia` | 361 | 7.3 | 91 % | ⭐ **el PROVEEDOR** (65 % toca `2120*`, cuenta por pagar) |
| `nomina` | 159 | 2.9 | 23 % | ⭐ **la SUCURSAL** (75 % toca `215011*` *SUELDOS X PAGAR \<plaza\>*) |
| `compra_tarjeta` | 126 | 14.6 | 83 % | la **naturaleza** del gasto (74 % `5200600000` GASOLINA) |
| `traspaso_entre_cuentas` | 25 | 16.0 | 4 % | ⛔ **nadie: no es un gasto**, es banco↔banco |
| `comision_bancaria` | 18 | 278.3 | 100 % | la categoría (`5200650000`) — ver ⚠️ abajo |
| `impuestos` | 17 | **2.1** | **6 %** | la categoría (`5201000000` / `5200090000`) |
| `servicios` · `gasto_admin` | 12 · 9 | 3.9 · 4.0 | 67 % · 78 % | dispersas, muestra chica |

⭐ **Por qué el mapa no se podía derivar de un solo lado, ahora medido:** **CB clasifica por
INSTRUMENTO y ContPAQi por NATURALEZA.** `compra_tarjeta` (instrumento) es en 74 % *GASOLINA Y
LUBRICANTES* (naturaleza). Por eso mi derivación original coronó conceptos como `combustible` o
`mant_reparto`, que **sí existen — del lado de ContPAQi**; el error fue nombrarlos como si fueran
categorías de CB. Las dos listas eran ciertas; faltaba el puente, y el puente es este cruce.

### 17.3 ⛔⛔ El hallazgo que manda: la granularidad NO es 1:1

**ContPAQi agrupa.** Una póliza de egreso promedia **7.3 renglones** en compra de mercancía,
**14.6** en tarjeta y **278** en comisiones: un solo asiento cubre muchos movimientos bancarios.
`ContpaqiArmadoService` hace **una póliza por movimiento**.

⭐ Aun con el mapa firmado, el archivo que hoy generaríamos tendría una forma que la contadora
**no reconoce como su trabajo**: 4,727 pólizas donde ella hace ~500. **La unidad de armado no es
el movimiento: es el lote (cuenta de banco × día).**

⚠️ Y de ahí sale una retractación propia: el *94.4 %* de `comision_bancaria` se calculó tomando
**el renglón de cargo mayor** de la póliza pareada — sobre pólizas de **278 renglones** esa
inferencia es débil, no una regla limpia. Se declara como indicio, no como regla.

### 17.4 ⛔ Y `armarAsientoEgreso` asume una forma que casi nunca ocurre

El armador genera **gasto + IVA + banco**. Contrastado contra lo real:

- `impuestos` es el **único** que calza en número de renglones (2.1) — y ahí el armador
  **agregaría IVA donde el 94 % no lo lleva**.
- `compra_mercancia` no lleva cuenta de gasto: lleva **`2120<proveedor>`** (el IVA ya se acreditó
  al registrar la factura, no al pagarla). Meterle un renglón de IVA sería **acreditarlo dos veces**.
- `traspaso_entre_cuentas` **no debe generar póliza de egreso**: hoy el armador lo intentaría.

### 17.5 Qué se hace con esto

1. `contpaqi.account_rules` necesita un **discriminante** (`por_categoria | por_proveedor |
   por_sucursal | no_aplica`), no una cuenta suelta. Migración nueva, no editar la aplicada.
2. `por_proveedor` **ya es derivable**: `analytics.contpaqi_suppliers` (3,411 · 99.6 % RFC) ×
   el RFC del CFDI. No requiere al contador.
3. `por_sucursal` **está bloqueado por el dato de entrada**: CB no trae centro de costo por
   movimiento (es la razón de `seg_negocio: 0`). Se declara.
4. El armador pasa de **1 póliza por movimiento** a **1 póliza por (banco, día)**.
5. `traspaso_entre_cuentas` se marca `no_aplica` — rechazo con motivo, no regla faltante.

⭐ **Lo que esto le ahorra a la media hora con el contador:** deja de ser *"decidí 21 cosas desde
cero"* y pasa a *"confirmá estos renglones, cada uno con su evidencia y su porcentaje medido"*.

---

## 18. 📋 `[CP.8.18]`–`[CP.8.22]` El plan paso a paso (2026-10-09)

**Pedido de Edgar:** *"documentémoslo y hagámoslo paso a paso"*. Cada paso es entregable solo,
cierra con una medición, y **ninguno depende del contador salvo donde se dice**.

### 18.0 Dos sondeos más que acotan el diseño

| Pregunta | Respuesta medida |
|---|---|
| ¿ContPAQi guarda la cuenta de cada proveedor en `Proveedores`? | ⛔ **No.** `IdCuenta`/`CodigoCuenta` poblados en **1 de 3,426**. El campo existe y nadie lo llena |
| ¿El renglón de póliza trae al proveedor? | ⛔ **No.** `MovimientosPoliza` no tiene columna de persona — **la identidad del proveedor ES la cuenta** (`2120<sufijo>`) |
| ¿El sufijo del código de cuenta identifica al proveedor entre rubros? | ⭐ **Sí: 973 de 1,025 sufijos** compartidos entre `2120`/`5010`/`5020` tienen el **mismo nombre** (94.9 %) |
| ¿Se puede empatar cuenta `2120*` con proveedor? | ⭐ Por **nombre exacto**: 771 de 1,015 cuentas · de las **147 usadas en 2026, 106** · **$218.8M de $304.2M (71.9 %)** |
| Ambigüedad | 11 nombres con ≥2 cuentas `2120`, 39 RFC repetidos. Chico y declarable |

⚠️ Las 41 cuentas usadas que no empatan son **casi-empates** (`HERSHEY··MEXICO` con doble espacio,
`SWEETS DIMENSION SA de CV` en minúsculas, nombres truncados). Normalizar sube la cobertura; **lo
que quede se declara, no se adivina**.

### 📍 Paso 1 — `[CP.8.18]` El derivador deja de ser un script tirado

Hoy la evidencia de §17 vive en el scratchpad: **se perdió en cuanto cierre la sesión**. Pasa a
`database/scripts/derivar-reglas-contpaqi.js` — read-only de los dos lados, **placebo obligatorio
en la salida** (sin placebo, un cruce por importe no es evidencia), y produce la tabla
pre-llenada que el contador firma.

**Terminado cuando:** se corre dos veces y da lo mismo · el placebo sale impreso al lado del
número real · hay una fila por categoría con su cuenta candidata, su % y su conteo.

### 📍 Paso 2 — `[CP.8.19]` El discriminante en `account_rules`

Migración nueva (⛔ no editar la aplicada, batch 856). La tabla gana:

- `tipo_regla` — `por_categoria | por_proveedor | por_sucursal | no_aplica`
- `lleva_iva` — `boolean NULL` (**NULL = sin medir**, no `false`)
- `cuenta_pasivo` — para las reglas `por_proveedor`, donde el cargo va a `2120*` y **no hay
  cuenta de gasto**

Y se siembran dos veredictos que **ya están medidos** y no necesitan al contador:
`traspaso_entre_cuentas` → `no_aplica` (4 % lleva IVA: es banco↔banco, no un gasto) ·
`iva_acreditable` → `no_aplica` (es el renglón 2 del asiento de su hermano, no un asiento).

**Terminado cuando:** el CHECK rechaza `por_proveedor` con `cuenta_gasto` y `por_categoria` sin
ella — **probado mandando los dos a propósito**.

### 📍 Paso 3 — `[CP.8.20]` El mapa proveedor → cuenta

Vista `analytics.v_contpaqi_supplier_account`: `contpaqi_suppliers` × catálogo de cuentas `2120*`
por **nombre normalizado**, con **veredicto por fila** (`exacto | normalizado | ambiguo |
sin_cuenta`) y el RFC de arrastre.

⚠️ Requiere traer el catálogo `Cuentas` (8,811), que hoy sólo se usa como join dentro del
importer de pólizas y **no existe como tabla consultable**.

**Terminado cuando:** la cobertura se publica en pesos (hoy 71.9 %) y la ambigüedad aparece como
fila con motivo, nunca colapsada a la primera coincidencia.

### 📍 Paso 4 — `[CP.8.21]` El armador por lote, con forma por tipo de regla

Dos cambios en `ContpaqiArmadoService`:

1. La unidad pasa de **movimiento** a **(cuenta de banco × día)** — porque ContPAQi agrupa
   (7.3 renglones en mercancía, 14.6 en tarjeta).
2. La forma del asiento la decide `tipo_regla`, no una plantilla fija:
   `por_proveedor` → `2120<prov> / 102<banco>` **sin renglón de IVA** (ya se acreditó al
   registrar la factura: ponerlo sería **acreditarlo dos veces**) · `por_categoria` → gasto
   [+ IVA si `lleva_iva`] / banco · `no_aplica` → rechazo con motivo.

**Terminado cuando:** un lote real de enero reproduce el **número de renglones** de la póliza que
la contadora hizo ese día, no sólo el total.

### 📍 Paso 5 — `[CP.8.22]` La bandeja

Recién acá. Antes, una pantalla alrededor de algo que rechaza todo no es entrega.

### ⛔ Lo que sigue dependiendo de un humano

| | Quién | Qué desbloquea |
|---|---|---|
| Importar UN archivo a ContPAQi | la contadora, 1 min | si el formato se acepta · si respeta el `guid` · si los `AD` se prenden |
| Firmar las reglas pre-llenadas | el contador, ~30 min | que el armador deje de rechazar |
| Centro de costo por movimiento en CB | decisión de negocio | ⛔ **`por_sucursal` está bloqueado por el dato de entrada**, no por código |

### ✅ Paso 1 cerrado — `database/scripts/derivar-reglas-contpaqi.js` (2026-10-09)

Corrido contra prod + ContPAQi, ventana ene–feb 2026, **$144,093,601.04 en 2,650 egresos**:

| | exacto | % | ambiguo |
|---|--:|--:|--:|
| real | **737** | 27.8 | 48 |
| placebo +43 d | **2** | 0.1 | 4 |

**369× el piso de ruido.** Dos corridas seguidas dan salida **idéntica**.

**`tipo_regla` derivado — ya no hay que preguntarle esto al contador:**

| Categoría | Pareados | `tipo_regla` | Evidencia |
|---|--:|---|---|
| `compra_mercancia` | 361 | **`por_proveedor`** | 65.1 % toca `2120*` |
| `nomina` | 159 | **`por_sucursal`** | 74.2 % toca `215011*` |
| `compra_tarjeta` | 126 | `por_categoria` | 83.3 % toca `52*` |
| `comision_bancaria` | 18 | `por_categoria` | 100 % toca `52*` → `5200650000` (94.4 %) |
| `impuestos` | 17 | `por_categoria` | 88.2 % toca `52*` |
| `servicios` · `gasto_admin` · `imss_sua` | 12 · 9 · 6 | `por_categoria` | 75–100 % |
| `traspaso_entre_cuentas` | 25 | **`no_aplica`** | 4 % en `52*` |
| `caja_ahorro` | 1 | `no_aplica` | muestra CHICA |

⭐ **El veredicto `no_aplica` de `traspaso_entre_cuentas` se confirmó solo**: sus cuentas
candidatas son **otras cuentas de banco** (`1020020000` BBVA, `1020070000` Bajío). El cargo va a
otro banco — es banco↔banco, no un gasto. Evidencia independiente del umbral que lo clasificó.

⚠️ **SIN MEDIR** (cero pareos en la ventana, se declaran y no se dibujan en cero):
`pago_factoraje`, `renta`, `traslado_valores`, `pago_credito`.

#### ⛔ El bug que encontró este paso, y que casi se publica como hallazgo

La primera corrida salió con **ceros en todas las columnas de forma y en las doce categorías**, y
el script concluyó, con cara seria, *"no toca cuenta de gasto"* para todas. No era el mundo: era
**`MovimientosPoliza.TipoMovto`, que es `bit` en SQL Server y el driver entrega como `boolean`**.
`x.TipoMovto === 0` **nunca empata contra `false`**.

⭐ **Una comparación de tipo equivocado no tira error: dibuja un cero.** Y un cero se publica.
Arreglado con `Number(x.TipoMovto) === 0`, que además sobrevive si la columna cambia a `tinyint`.

De ahí salió un **freno permanente** en el script: si todas las categorías caen en el mismo cubo,
o si ninguna toca una cuenta de gasto, **sale `FATAL` y no publica** — eso no es un hallazgo, es
un clasificador roto. **Probado en rojo** re-introduciendo el bug a propósito.

### 🚀 Paso 2 cerrado — `[CP.8.19]` EN PROD, batch 863 (2026-10-09)

`contpaqi.account_rules` gana `tipo_regla` · `cuenta_prefijo` · `lleva_iva` · `forma_medida`.
Aplicada **una sola** con `apply-one-migration-prod.js` dentro de `prod-api`, 0.1 s.

**Estado sembrado en prod** (21 filas, 17 con evidencia en `forma_medida`):

| `tipo_regla` | n | Categorías |
|---|--:|---|
| `sin_medir` | 11 | caja_ahorro, cobranza, comisiones_venta, compra_factoraje, devolucion_spei, ingreso_devolucion, pago_credito, pago_factoraje, pension_alimenticia, renta, traslado_valores |
| `por_categoria` | 6 | comision_bancaria, compra_tarjeta, gasto_admin, impuestos, imss_sua, servicios |
| `no_aplica` | 2 | iva_acreditable, traspaso_entre_cuentas |
| `por_proveedor` | 1 | compra_mercancia (`cuenta_prefijo = 2120`) |
| `por_sucursal` | 1 | nomina (`cuenta_prefijo = 215011`) |

⭐ **`lleva_iva`: 2 en `false`, 19 en NULL.** El NULL es el punto. La medición de IVA es **a nivel
de póliza** y ContPAQi agrupa 7–278 movimientos por póliza: que el 90.9 % de las pólizas de
`compra_mercancia` traigan un renglón de IVA **no dice** que el pago a proveedor lo lleve. La
única donde se pudo concluir es `impuestos` — promedia **2.1 renglones** (póliza ~1:1) y el
94.1 % no lleva IVA. *Una medición sobre otro grano es otra afirmación.*

#### Prueba negativa del CHECK — corrida como `postgres`, no como `edgar`

⚠️ Correrla como `edgar` habría fallado por **permisos**, no por el CHECK, y eso se lee igual de
verde (lección ya pagada en `[CP.8.1]`).

| Caso | Resultado |
|---|---|
| `por_proveedor` **con** `cuenta_gasto` | ✗ rechazado (`account_rules_coherencia_chk`) |
| `por_categoria` **con** `cuenta_prefijo` | ✗ rechazado (`account_rules_coherencia_chk`) |
| `tipo_regla` inventado (`por_luna`) | ✗ rechazado (`account_rules_tipo_regla_chk`) |
| `por_proveedor` **sin** `cuenta_gasto` | ✓ `UPDATE 1` |

⭐ Por qué el CHECK y no una convención: una regla `por_proveedor` con `cuenta_gasto` puesta
cargaría **todos** los pagos a proveedor a una sola cuenta de gasto — y eso **cuadra**, así que
ningún cuadre lo atraparía. *Un asiento que cuadra y está mal es peor que uno que no cuadra.*

⚠️ **El hueco de `migration directory is corrupt` volvió a aparecer** y frenó el primer intento:
prod tiene en su ledger las 4 migraciones de esta sesión (856–859) cuyos archivos **no están en
la imagen desplegada**. Se resolvió copiándolas al pod junto con la nueva — **sin crear
marcadores vacíos**. Se va a repetir en cada sesión que migre desde el contenedor hasta que haya
`git push` + redeploy.

⛔ **Esto NO habilita a nadie a asentar.** Las 19 filas que no son `no_aplica` siguen en
`sin_regla`. Lo que cambia es que el armador ya puede distinguir *"falta decidir"* de *"ya se
decidió que no aplica"* — dos estados que hoy se veían iguales (misma lección que `[CP.8.1d]`).

### 🚀 Paso 3 cerrado — `[CP.8.20]` EN PROD, batch 864 (2026-10-09)

`analytics.contpaqi_accounts` (8,811 cuentas — el catálogo que sólo existía como JOIN dentro de
otro importer) + `contpaqi.supplier_accounts` (1,015 cuentas `2120*` con veredicto).
Las llena `import-contpaqi-account-map.js`, READ-ONLY sobre ContPAQi.

#### ⛔ ContPAQi no guarda la cuenta del proveedor — hubo que derivarla

| | |
|---|---|
| `Proveedores.IdCuenta` / `.CodigoCuenta` | poblados en **1 de 3,426** |
| `Personas.CtaContableGasto` | **0 de 5,676** |
| `MovimientosPoliza` | **no tiene columna de persona** — la identidad del proveedor **ES** la cuenta |

#### Dos derivaciones independientes, cruzadas entre sí

| vía | cuentas (de 147 usadas en 2026) | % del importe |
|---|--:|--:|
| **A** — nombre de cuenta ≈ nombre de proveedor, normalizado | 125 | 89.4 % |
| **B** — ⭐ **UUID del CFDI** que ContPAQi ató al renglón (`AsocCFDIs`) → RFC del emisor | **146** | **100 %** |

⭐ **B domina a A**: no hay **ni una** cuenta que el nombre resuelva y el UUID no. Y es
estructural — ContPAQi mismo hizo esa asociación; no se adivina ninguna grafía.

⛔ **Por qué el nombre no puede ser la llave**, medido: la cuenta
`SOCIEDAD COOPERATIVA TRABAJADORES PASCUAL` sólo tiene candidato en el proveedor
`PASCUAL ALEJANDRO GONZALEZ LOPEZ`, **una persona física distinta**. Normalizar más agresivo sube
la cobertura **y empieza a emparejar cosas distintas** (medido: `exacto` 71.8 % → `sufijos` 87.5 %
del importe, pero las llaves que colapsan dos RFC pasan de 22 a 31). El nombre queda como
**testigo corroborante**, nunca como resolvedor.

#### ⭐⭐ Lo que el cruce encontró, y que ninguna vía sola habría visto

De 125 cuentas donde opinan las dos, **124 coinciden y 1 discrepa**: `2120000366 CANAP BOLSAS`
tiene asociado un CFDI de **ABARROTES LA VIOLETA** por **$44,272.35** — y La Violeta **tiene su
propia cuenta** (`2120000336`). Es un **error de captura**, no un empate dudoso. Va a bandeja
como `en_disputa`; **el motor no elige uno de los dos**.

⚠️ Y la lección de umbral que salió de ahí: esa cuenta tenía **pureza 100 % sobre UN voto**.
*Pureza perfecta sobre n=1 no es certeza.* Medida la distribución, **36 de 183 cuentas (20 %) se
apoyan en una sola asociación** — justo la franja donde vivía el único falso positivo. Por eso el
veredicto pesa **votos**, no sólo pureza, y el CHECK exige `votos >= 3` para `uuid_solido`.

#### Veredictos en prod, y la cobertura que importa — en pesos

| veredicto | cuentas | importe 2026 | % |
|---|--:|--:|--:|
| `confirmado` (los dos testigos) | 155 | $272,741,576.77 | 89.7 |
| `uuid_solido` (n≥3, pureza≥90) | 18 | $30,876,097.56 | 10.1 |
| `uuid_debil` (n<3) | 9 | $449,017.60 | 0.1 |
| `sin_proveedor` | 148 | $96,980.00 | 0.0 |
| `en_disputa` | 1 | $44,272.35 | 0.0 |
| `solo_nombre` (sin actividad de CFDI desde 2025) | 684 | — | — |

⭐ **99.8 % del importe queda con cuenta utilizable.** `compra_mercancia` —el renglón más grande
de egresos— deja de depender del contador.

#### Prueba negativa de los CHECK (como `postgres`)

| Caso | Resultado |
|---|---|
| `confirmado` con `rfc` NULL | ✗ `supplier_accounts_rfc_chk` |
| `uuid_solido` con 1 voto | ✗ `supplier_accounts_solido_chk` |
| veredicto inventado (`mas_o_menos`) | ✗ `supplier_accounts_veredicto_chk` |
| tocar las 155 filas válidas | ✓ `UPDATE 155` |

⚠️ **El importer NO corre desde la máquina de trabajo**: `edgar` es read-only por diseño y el
`INSERT` muere con *"read-only transaction"*. Corre desde el pod `feeds-cron` del namespace
`ingesta` en `md`, que tiene `mssql` y el `DATABASE_URL_NEW` con escritura.

⚠️ Y una corrección de ruta: `feeds-cron` aparece `Exited (137)` en `docker ps` de `md` hace 8
días — **no es una caída**: los feeds se mudaron a k3s igual que prod, y el contenedor de Docker
es el sustrato viejo. *Medir dónde corre hoy, no dónde vivía.*

### ✅ Paso 4 cerrado — `[CP.8.21]` El armador por lote y con forma por tipo de regla (2026-10-09)

#### ⭐⭐ La unidad de armado era la equivocada

| Medido sobre las 4,457 pólizas de egreso de 2026 | |
|---|--:|
| con **exactamente UN** renglón de banco | **4,067 · 91.2 %** |
| con 2 | 202 |
| con 3–5 | 139 |

**ContPAQi agrupa.** Una póliza lleva muchos cargos colgando de un solo abono al banco. Armar una
póliza por movimiento daría **4,727 pólizas donde la contadora hace ~500**: un archivo que cuadra
y que ella no reconoce como su trabajo.

⭐ Y de paso explica el 27.8 % de pareo de `[CP.8.18]`: los que casan 1:1 son justo aquellos donde
la póliza agrupó **un solo** movimiento. **El 72 % restante no era ruido — eran los lotes.**

**Ejercitado contra prod, enero 2026:**

| | |
|---|--:|
| pólizas por movimiento (diseño viejo) | 1,474 |
| **pólizas por lote (banco × día)** | **258** |

**5.7× menos**, y del orden de las ~532 que ContPAQi realmente tiene ese mes.

#### ⭐ Los motivos ahora tienen DUEÑO

Antes todo caía en `sin_regla`. Enero, con el ramificado por `tipo_regla`:

| motivo | movs | quién lo arregla |
|---|--:|---|
| `sin_regla` | 954 | el contador |
| `proveedor_sin_cuenta` | 216 | falta el enlace pago→factura (`kdxf`, Fase ECA) |
| **`no_aplica`** | **148** | ⭐ **nadie: ya se decidió que no genera póliza** |
| `sin_centro_costo` | 135 | negocio: CB no trae centro de costo |
| `sin_medir` | 21 | re-correr el derivador con otra ventana |

**148 movimientos que parecían trabajo pendiente ahora se sabe que no lo son.**

#### ⛔⛔ El pago a proveedor no es un gasto — y el asiento sale incompleto, declarándolo

Pagar una factura reduce la cuenta por pagar; el gasto se reconoció al registrarla. Medido en las
pólizas de egreso de dos renglones: el par es **cargo al tercero / abono al banco**, sin IVA.

Pero ContPAQi, al pagar, hace además el **traspaso del impuesto** (en México el IVA se acredita
sobre lo efectivamente pagado). Medido en 2026 sobre pólizas que tocan `2120*`:

| cuenta | | neto |
|---|---|--:|
| `1060000000` IVA ACREDITABLE | cargo | **+$6,640,268.98** |
| `1470040000` IVA POR ACREDITAR | abono | **−$6,559,315.64** |
| `1470100000` IEPS ACREDITABLE | cargo | **+$17,050,851.50** |
| `1470110000` IEPS POR ACREDITAR | abono | **−$17,428,970.80** |

Los pares **se cancelan entre sí: no tocan el banco**. Pero emitirlos exige saber **qué facturas**
se pagan, y eso no lo tenemos (`client_uuid` no es UUID de CFDI — 0 de 55,648).

⭐ Por eso el asiento sale **cuadrado pero incompleto, y lo dice**: `iva_traspaso: 'no_emitido'`
con su motivo. *Un asiento que cuadra y le falta una pata es justo lo que el contador tiene que
ver declarado, no descubrir revisando.*

⚠️ El camino para cerrarlo existe y es de otra fase: **`kdxf` de Kepler casa pago→factura de forma
estructural** (30,073 de 30,033, Fase ECA), y de la factura sale el UUID con su impuesto.

#### Candado `test-newdb-contpaqi-lote.js` — **38 ✓ / 0 ✗**, mutado a rojo tres veces

| Mutación | Resultado |
|---|---|
| el lote emite un abono por entrada (diseño viejo) | ✗ el cuadre interno lo detiene |
| `no_aplica` cae en el rechazo genérico `sin_regla` | ✗ 37/1 |
| el pago a proveedor no declara el traspaso | ✗ 35/3 |

Los 6 candados de CP.8 + LC, verdes: token 29 · armador 33 · sink 44 · cuadre 35 · **lote 38** ·
LC 38. Registrado en `run-all-tests.js`.

---

## 19. ⛔⛔ `[CP.8.22]` La evidencia estaba inflada por el agrupamiento, y un error mío la escondía

Siguiendo con los bloqueos medidos en `[CP.8.21]` (`sin_regla` 954 · `proveedor_sin_cuenta` 216).
Lo que iba a hacer era **sembrar las cuentas candidatas** de `[CP.8.18]` para que el contador sólo
confirmara. Medir antes de sembrar lo impidió, y encontró dos cosas.

### 19.1 El porcentaje de la cuenta candidata medía otra cosa

La candidata se infería tomando **el cargo mayor** de la póliza pareada. Eso sólo vale si la
póliza es de ese movimiento — y `[CP.8.21]` ya había medido que **ContPAQi agrupa** (7.3
renglones en mercancía, 14.6 en tarjeta, **278 en comisiones**).

Restringiendo el voto a pólizas de **≤3 renglones** (cargo + IVA + banco, la forma 1:1):

| categoría | candidata SIN filtro | con filtro 1:1 |
|---|---|---|
| `comision_bancaria` | `5200650000` COMISIONES · **94.4 %** | ⛔ **desaparece** — era 100 % artefacto del lote |
| `compra_tarjeta` | `5200600000` GASOLINA · 73.8 % | ⛔ **cambia de cuenta**: `2140800000` TARJETA · 36.4 % |
| `impuestos` | `5201000000` NO DEDUCIBLES · 64.7 % | ✅ **68.8 %** — la única que sobrevive, y mejora |

⭐ **Mi retractación de `comision_bancaria` en §17.3 era correcta, y ahora está probada**: el
filtro la borra entera. *Un porcentaje calculado sobre el universo equivocado es peor que no
tenerlo, porque se ve igual de convincente.*

⛔ **Conclusión: la cuenta exacta para `por_categoria` NO es derivable.** Ninguna llega a un
umbral defendible. **No se sembró nada** — sembrar candidatas débiles con un número que parece
alto es justo lo que ADR-056 prohíbe. Esa decisión sigue siendo del contador.

### 19.2 ⭐⭐ Pero el `tipo_regla` sí sobrevive — y comprobarlo destapó un error mío

Si el agrupamiento contaminó la cuenta, había que comprobar que no contaminó el **tipo**. Se
recalculó sólo sobre pólizas 1:1 y se comparó. **`compra_mercancia` cambiaba de `por_proveedor` a
`no_aplica`.**

Investigado: las pólizas 1:1 de esa categoría cargan a **`5010`** (MARAVIMUNDO SA DE CV) y
**`5020`** (MIGUEL ANGEL BRIBIESCA RODRIGUEZ) — **nombres de proveedor**, no de gasto.

⛔ **La cuenta de un proveedor vive en TRES rubros y mi clasificador miraba uno.** `2120` es su
cuenta por pagar; `5010` y `5020` son sus compras. Y `[CP.8.20]` **ya lo había medido**: 973 de
1,025 sufijos compartidos entre esos rubros tienen el mismo nombre (94.9 %). *Lo vi y no lo
incorporé.*

Corregido:

| | antes | después |
|---|--:|--:|
| `compra_mercancia` toca cuenta de proveedor | 65.1 % | **94.7 %** |
| ¿estable bajo el filtro 1:1? | ⛔ no | ✅ **sí** |
| cuentas utilizables en `supplier_accounts` | 173 | **421** |
| filas en el mapa | 1,015 | **3,050** |

⚠️ Y las **4 discrepancias** nombre-vs-UUID tienen **un solo voto las cuatro** — el mismo patrón
que ya había fijado el umbral de `uuid_solido`.

⭐ **Lo destapó comparar DOS universos.** Mirando uno solo, el clasificador se veía consistente —
con un 65.1 % que nadie habría cuestionado.

### 19.3 La cadena por Kepler se midió y NO rinde — se declara

Para resolver `proveedor_sin_cuenta` se probó enganchar el egreso de CB con el pago a proveedor de
Kepler (`analytics.erp_supplier_payments`, que trae `proveedor_rfc`):

| ene–feb 2026, `compra_mercancia` | |
|---|--:|
| enganche exacto (fecha + importe) | **648 / 1,122 · 57.8 %** |
| placebo +43 d | 3 · 0.3 % → **216×** |
| …y de ésos, con cuenta `2120` resuelta | **97 · 8.6 %** |

⛔ **El corte no está en el enganche: está en el RFC de Kepler.** De los 648 enganchados, **481
no traen RFC** y el resto viene sucio: `CCO-820507-BV` (con guiones y truncado contra
`CCO820507BV4`), `DC9181011CK5` (un carácter cambiado contra `DCP181011CK5`), `CIS-030827-AF`.

Es **calidad de dato de Kepler**, no del puente. Se declara y no se persigue: normalizar guiones
recuperaría algunos y **emparejar RFC truncados es adivinar**. El camino bueno sigue siendo
`kdxf` (casamiento estructural pago→factura, Fase ECA), que no depende del RFC capturado.

---

## 20. ⭐⭐ `[CP.8.23]` El armador leía la fuente equivocada para el pago a proveedor

`[CP.8.21]` dejó 216 movimientos de enero en `proveedor_sin_cuenta`. El primer intento fue
enganchar el **movimiento bancario** al pago de Kepler: 57.8 % de enganche (216× el placebo) y
sólo **8.6 %** llegando a una cuenta, porque el RFC de Kepler viene vacío en el 74 % y sucio en el
resto.

⭐ **El replanteo:** *la contadora no adivina el proveedor mirando el estado de cuenta — lo lee
del pago registrado en Kepler.* La fuente del asiento de pago a proveedor **no es el movimiento
bancario**: es `analytics.erp_supplier_payments`, que trae el **nombre** aunque falte el RFC.

Medido ene–feb 2026 (1,030 pagos · $97,729,712.85):

| vía | pagos | % | importe |
|---|--:|--:|--:|
| RFC exacto | 197 | 19.1 | $45,742,440.01 |
| nombre normalizado (un solo tercero) | 138 | 13.4 | $25,353,361.88 |
| **nombre ambiguo** | **0** | 0 | — |
| sin resolver | 695 | 67.5 | $26,633,910.96 |

**32.5 % de los pagos pero 72.7 % del importe** — contra 8.6 % por la vía del banco.

⭐ Y **cero ambigüedad**, al revés que en `[CP.8.20]`: ahí se emparejaban cuentas contra
proveedores **dentro del mismo catálogo** y PASCUAL colapsaba con una persona física; acá son dos
catálogos de la misma cosa y el nombre sí discrimina. *El mismo método vale o no vale según qué
universos une.*

### 20.1 Lo que falta no son datos: son ALIAS, y la lista es chica

```
EFFEM MEXICO INC. Y COMPAÑÍAS EN N.C DE CV  vs  EFFEM MEXICO INC Y COMPAÑIA S EN NC DE CV
TRESMONTES LUCHETTI (NUTRESA)               vs  TRESMONTES LUCCHETTI MEXICO SA DE CV
DIST CABADAS DE LA PIEDAD SA DE CV          vs  DISTRIBUCIONES CABADAS DE LA PIEDAD SA DE CV
ABARROTES LA VIOLETA                        vs  ABARROTES LA VIOLETA SA DE CV
```

⛔ **No se arreglan normalizando más fuerte** — `[CP.8.20]` ya midió que pasado cierto punto la
normalización empieza a emparejar terceros distintos. Se arreglan con un alias que alguien
escribe **una vez**.

⭐ **136 nombres distintos, y los primeros 33 cubren el 80 % del importe que falta.** Treinta y
tres líneas llevan la cobertura de **72.7 % a ~94.5 % del dinero**.

`database/scripts/proveedores-sin-cuenta-contpaqi.js` emite esa lista ordenada por importe, con
la columna `cuenta_contpaqi` **vacía a propósito**: proponer un candidato invitaría a aceptarlo
sin mirar, y ya está medido que el nombre engaña.

⚠️ **Hallazgo colateral — 5 nombres llegan con la Ñ rota** (`CONSERVAS LA COSTE?A`). Es
codificación en la ingesta de Kepler y se arregla **allá**: ningún alias debería escribirse contra
un carácter corrupto.

### 20.2 Qué queda, con dueño

| | quién | qué desbloquea |
|---|---|---|
| importar UN archivo a ContPAQi | la contadora, 1 min | si el formato se acepta · el `guid` · los `AD` |
| las **33 líneas de alias** | compras/contabilidad, ~1 h | `por_proveedor` de 72.7 % → ~94.5 % del importe |
| firmar las reglas `por_categoria` | el contador | ⛔ **no es derivable** — probado en §19.1 |
| centro de costo por movimiento en CB | negocio | `por_sucursal` (135 movs/mes) |
| la Ñ rota en la ingesta de Kepler | Sistemas | 5 nombres, y evita alias contra basura |

---

## 21. ✅ `[CP.8.24]` Los dos archivos de prueba — y dos bugs que el clic habría descubierto peor

Pedido: *"hagámoslo"* sobre el clic de la contadora. Lo que se puede hacer de este lado es
**dejarle el archivo listo**, y partirlo en dos para que sus tres preguntas no se confundan:

| | contenido | contesta |
|---|---|---|
| **A** `prueba-A-formato.txt` | `P` + 2 × `M1`, $1.00 | ¿acepta el formato? ¿respeta el `Guid`? |
| **B** `prueba-B-con-ad.txt` | lo mismo + un renglón `AD` | ¿se pueden prender los `AD`? |

⭐ *Si A entra y B no, el problema es el `AD` y no el layout. Un solo archivo no distingue.*

### 21.1 ⭐⭐ La forma salió del archivo REAL, y corrige a la fuente externa

La **primera póliza** de la exportación real es exactamente **`P M1 M1 M1 AD`** — sin `AM`, sin
`AP`, sin `I`/`W2`/`V`.

⭐ **Eso contesta lo que §10.5 dejó abierto: esos renglones NO son obligatorios.** Una póliza
mínima válida es encabezado + movimientos + `AD`.

⛔ **Y corrige a §9.1**, que decía (de fuentes externas) que el `AD` va *"después del `P`"*. En el
archivo real **va al final de la póliza**, después de todos los `M1`. Las 14 pólizas lo
confirman; los 62 renglones `AD` miden 40 caracteres exactos.

### 21.2 ⛔ El primer archivo salía con la fecha rota

La primera versión del generador llamaba a `construirTxt` **directo** y emitió
`P  2026-10-` — el campo mide 8 y `YYYY-MM-DD` mide 10, así que se recortó. El real dice
`20260901`.

✅ El sink **sí** convierte (`txt-sink.adapter.ts`: exige `YYYY-MM-DD`, pasa a `yyyyMMdd` por
posición, rechaza con `fecha_invalida`). **El puente estaba bien; el error fue saltármelo.**

⭐ *El archivo de prueba tiene que salir del MISMO camino que usará el puente, o no prueba el
puente.* Reescrito para pasar por `ContpaqiTxtSinkAdapter`.

### 21.3 ⛔ Y el sink no emitía el `Guid` — la pregunta no se podía contestar

Una de las tres preguntas es *"¿ContPAQi respeta el guid que mandamos?"*, y el sink **nunca lo
emitía**: el campo salía en blanco.

Agregado `guidDe(evento_tipo, evento_id)` en `token.ts` — UUID v4 **determinista**, por la misma
razón que `tokenDe`: con uno aleatorio, re-emitir el mismo evento dejaría huérfana la entrega
anterior. El encabezado ahora cierra igual que el real:

```
REAL    | 0 F22291A3-8AE4-477F-9789-A8FAB8415A87 |
NUESTRO | 0 3AD7167D-93E6-46E8-A9D5-1F91B0F1CA17 |
```

⚠️ **Y el candado del sink no lo notó**: siguió en 44 ✓ después de cablear el guid. *Un candado
que no ve lo que guarda no lo guarda.* Se le agregaron 6 aserciones (**44 → 50 ✓**), **mutadas a
rojo** quitando el guid del sink: 46 ✓ / 4 ✗.

### 21.4 Qué queda del lado humano

Los archivos y la hoja de instrucciones están listos:
[`CONTPAQI_PRUEBA_IMPORTACION.md`](../RUNBOOKS/CONTPAQI_PRUEBA_IMPORTACION.md).

⛔ Los `.txt` **no se commitean** — llevan cuentas reales y un UUID de CFDI real, y el repo es
público. Se generan con `database/scripts/generar-prueba-contpaqi.js --out <carpeta>`.

---

## 22. ⛔⛔ `[CP.8.25]` La asociación de CFDI SÍ ocurre — la premisa de los "0 de 33,303" estaba mal aplicada

Edgar mandó una captura de **`XML Recibidos > Facturas`** del ADD en `192.168.0.208`
(`0contabilidadd`) preguntando si conviene XML. La pantalla mostraba
**`Total Registros: 10 · Documentos Asociados: 0`**, y eso obligó a medir.

### 22.1 Lo medido

| año | CFDIs recibidos | asociados | % |
|---|--:|--:|--:|
| 2018 | 19,608 | 17,484 | 89.2 |
| 2021 | 19,893 | 18,636 | 93.7 |
| 2024 | 18,281 | 17,001 | 93.0 |
| 2025 | 18,107 | 16,352 | 90.3 |
| 2026 | 13,504 | 10,704 | 79.3 |
| **histórico** | **169,030** | **152,061** | **90.0** |

Y por mes, el 2026: may **88.8 %** · jun 89.8 · jul 71.1 · ago 71.4 · sep 54.8 · **oct 6.6 %**.

⭐ **El `0` de la pantalla no es una falla: es el rezago del mes en curso.** La rampa
descendente hacia hoy es exactamente la forma que tiene *"la contadora todavía no llegó a eso"*.

### 22.2 ⛔ Qué estaba mal en cómo lo venía contando

`FASE_CP` §7.9 mide **33,303 movimientos de póliza** sin CFDI asociado, y `[CP.8.13]` §10.4
concluyó —correctamente— que el formato **sí** transporta el UUID. Pero al presentarlo yo lo
convertí en *"cerramos un hueco del 0 %"*, **mezclando dos universos**:

| universo | medida |
|---|--:|
| renglones de póliza del **libro de compras** sin UUID | 33,303 en 5 años |
| **CFDIs recibidos** sin asociar | **10 % — y el 90 % sí se asocia** |

⭐ *Los dos números son ciertos y no hablan de lo mismo.* Un CFDI puede estar asociado a su
documento y aun así no aparecer en el renglón de la póliza del libro.

### 22.3 El valor del renglón `AD`, corregido

No es *"cerrar un 0 %"*. Es:

1. **Ahorrar el trabajo manual**: ~1,400 comprobantes al mes que hoy alguien asocia a mano con el
   botón **Asociar** de esa misma pantalla.
2. **Cerrar el 10 % que nunca se asocia**: **2,606 CFDIs de 2026 por $105,399,045.52**.

Sigue valiendo la prueba —y mucho—, pero con el número correcto.

### 22.4 Lo que la captura aporta además

- ⭐ **`192.168.0.208` (`0contabilidadd`) es la máquina donde corre ContPAQi Contabilidad**, no la
  `.35` (que es el SQL Server). Es el candidato para `E4` (el SDK), que hasta ahora no tenía
  dirección.
- La pantalla tiene un botón **`Preliminar`**, que en el ADD suele generar una **póliza preliminar
  desde los XML seleccionados**. ⚠️ **Sin verificar qué hace exactamente acá** — si genera póliza
  desde CFDI, es un camino de automatización alterno que hay que medir antes de descartar.
- ⛔ **Esta pantalla NO es la de importar pólizas.** Es el repositorio de comprobantes. La
  pregunta sobre XML vs TXT sigue abierta y se contesta en *Pólizas → Importar*.

---

## 23. ⭐⭐⭐ `[CP.8.26]` El árbitro apareció — y el `SEP` deja de ser una suposición

`[CP.8.4]` §9.2 identificó **`C:\Compac\Empresas\Esquemas\Contpaq\CT_EST_Poliza_NG.xls`** como el
esquema que ContPAQi usa para *leer* el TXT, y lo declaró **inalcanzable** (SMB denegado).

Resultó que **está escrito en el propio diálogo de `Cargar Pólizas`**, en el campo
`Configuración de datos`. No hacía falta ningún acceso remoto: hacía falta abrir la pantalla.

⚠️ Lo que llegó fue **`CT_EST_Prepoliza_NG.xls`** — el de **Prepóliza**, no el de Póliza. Sus
anchos son otros (`Referencia` 100 vs 30, `Cuenta` 52 vs 30), así que **no sirve para validar
nuestro layout**. Pero sí entrega la **gramática**, y con eso alcanza para cerrar el riesgo mayor.

### 23.1 ⭐⭐ El separador: confirmado por el propio esquema de ContPAQi

El archivo declara el formato como una secuencia de renglones `Tipo | Nombre | Longitud`:

```
E | prepolizas.1   | 2  | R        <- etiqueta del registro (2 chars) + su letra de tipo
S |                | 1             <- SEPARADOR de 1 caracter
A | Codigo         | 20 |  | derecha
S |                | 1
A | Nombre         | 100
S |                | 1
...
A | ClaveBaseISR   | 20
S |                | 1             <- ⭐ TAMBIEN despues del ULTIMO campo
```

⭐⭐ **Hay un `S` de 1 carácter después de CADA campo, incluido el último.** O sea
**`Σanchos + n`**, no `n−1`.

Eso es **exactamente** lo que `[CP.8.13]` §10.3 había medido a mano sobre las 232 líneas del
archivo real (*"toda línea termina en UN ESPACIO"*), y es lo que el emisor implementa hoy:

| | Σanchos | +n | +(n−1) | **real** |
|---|--:|--:|--:|--:|
| `P` (11 campos) | 174 | **185** | 184 | **185** ✓ |
| `M` (11 campos) | 261 | **272** | 271 | **272** ✓ |

**El `SEP` deja de ser una suposición.** `[CP.8.4]` lo tenía como el riesgo ⛔ de toda la fase
(*"todo E1 descansa en un formato supuesto"*) y ahora está confirmado por la especificación del
fabricante, no sólo por nuestra lectura de un archivo.

### 23.2 Lo demás que la gramática confirma

| del esquema | lo que valida |
|---|---|
| `E ... 2 ... R` / `M` | la **etiqueta de registro mide 2** y lleva una letra de tipo — por eso `P ` y `M1` |
| `A` vs `R` | `A` = alfanumérico · **`R` = referencia a catálogo** (Cuenta, Diario, SegNeg) |
| `A \| TipoMovto \| 1 \| 1,0` | confirma `0` = cargo / `1` = abono |
| columna `Alineación: derecha` | existe el concepto — y el emisor ya alinea a la derecha algunos campos |

### 23.3 ⚠️ Una anomalía SIN explicar, declarada

Varios campos traen **longitud `52`**: `TipoPol`, `Folio`, `Diario`, `Cuenta`, `CtaFinal`,
`Importe`, `ImporteME`, `SegNeg`. **Todos son numéricos o referencias a catálogo**; los
alfanuméricos sí traen longitudes creíbles (20, 100, 1, 2, 254, 10, 5).

En el archivo real esos campos miden 4, 9, 10, 30, 20 y 4 — **ninguno 52**.

⛔ **No se interpreta.** La hipótesis cómoda sería *"52 = longitud variable, el importador tolera
y delimita por el separador"* — y si fuera cierta, nuestros anchos exactos importarían menos.
Pero la columna `Alineación` sólo tiene sentido en ancho fijo, así que la hipótesis se contradice
sola. **Se mide con `CT_EST_Poliza_NG.xls`, no se adivina** (ADR-056).

### 23.4 Lo que falta pedir, ahora con nombre exacto

```
C:\Compac\Empresas\Esquemas\Contpaq\CT_EST_Poliza_NG.xls      <- SIN "Pre"
```

Misma carpeta, el archivo de al lado. Con ése se valida nuestro layout **campo por campo antes de
importar**, y la contadora importa una vez en vez de tres.

### 23.5 ⭐ Y el diálogo trae dos cosas que abaratan la prueba

- **`Cargar sin Afectar`** — carga la póliza **sin tocar los saldos**, por el MISMO camino y el
  MISMO formato. Mejor red de seguridad que la prepóliza, que es otro formato (éste).
- **`Archivo de bitácora`** (`Cargar_Pólizas_AAAAMMDD.xls`) — ContPAQi escribe el detalle del
  proceso. ⭐ **No dependemos de que alguien interprete un popup**: se manda el archivo y se lee.

---

## 24. `[CP.8.27]` Nueve meses en vez de dos: los tipos aguantan, las cuentas siguen sin concentrar

`[CP.8.22]` concluyó que la cuenta `por_categoria` **no es derivable**, pero lo midió sobre
**ene–feb** ($144M). Antes de dar esa puerta por cerrada, se amplió la ventana a **ene–sep**:
**11,804 egresos · $624,596,502.83**, 4.3× el universo.

| | exacto | % | placebo |
|---|--:|--:|--:|
| ene–feb | 737 | 27.8 | 2 → 369× |
| **ene–sep** | **3,417** | **28.9** | 25 → **137×** |

### 24.1 ✅ Los `tipo_regla` aguantan, y con más fuerza

| categoría | pareados | tipo | antes | ahora |
|---|--:|---|--:|--:|
| `compra_mercancia` | 1,548 | `por_proveedor` | 94.7 % | **92.7 %** · estable |
| `nomina` | 811 | `por_sucursal` | 74.2 % | 66.2 % · estable |
| `compra_tarjeta` | 647 | `por_categoria` | 83.3 % | 83.6 % · estable |
| `traspaso_entre_cuentas` | 85 | `no_aplica` | 4.0 % | **1.2 %** · estable |
| `gasto_admin` | 32 | `por_categoria` | (9 pareados) | 93.8 % · estable |

⛔ **Dos cambian bajo el filtro 1:1 y se declaran**: `cobranza` y `servicios`. Sus pólizas
promedian **255.6** y 4.9 renglones — con ese agrupamiento el tipo no es confiable.

### 24.2 ⛔ La conclusión de §19.1 se REFUERZA, no se cae

Con 4.3× más datos, **ninguna cuenta `por_categoria` pasa de ~65 %**:

| categoría | mejor candidata | % |
|---|---|--:|
| `impuestos` | `5201000000` NO DEDUCIBLES | 64.7 |
| `gasto_admin` | `5200530000` SEGUROS Y FIANZAS | 63.6 |
| `servicios` | `2140700000` STM FINANCIAL (una SOFOM) | 46.7 |
| `compra_tarjeta` | `5200730000` MANT. EQUIPO DE REPARTO | **24.3** |

⭐ Y confirma la retractación de §19.1 por segunda vía: con 2 meses `compra_tarjeta` daba
**73.8 % GASOLINA**; con 9 meses da **24.3 % de otra cuenta**. *El 73.8 % era el lote, no la regla.*

### 24.3 ⭐⭐ El hallazgo nuevo: tres categorías NO pueden tener UNA cuenta

`compra_tarjeta` (647 pareados, la 3ª más grande) se reparte así:

```
MANT. EQUIPO DE REPARTO 24.3 · TARJETA DE CREDITO 22.9 · PAPELERIA 14.3
VARIOS 10.0 · MANT. LOCAL 7.1 · MANT. EQUIPO DE COMPUTO 7.1
```

⛔ **Eso no es una regla sin firmar: es una categoría que no determina la cuenta.** La tarjeta se
usa para seis cosas distintas. Ninguna firma del contador puede arreglarlo — *la respuesta
correcta no es una cuenta, es un mecanismo distinto* (mirar el concepto del movimiento).

Lo mismo en `nomina`, que mezcla `2150110004` SUELDOS, `2150140002` PENSIÓN ALIMENTICIA y
`5200090000` 2% SOBRE NÓMINA; y en `servicios`, cuya mejor candidata es **una SOFOM** — o sea un
pago de crédito clasificado como servicio.

⭐ **Separar *"falta que lo firmen"* de *"la categoría no alcanza"* es lo que evita mandarle al
contador una decisión que no existe.** Las tres salen de la lista de las 21 y se declaran con su
propio motivo.

### 24.4 Lo que esto cambia para la media hora del contador

De las 21 categorías: **6 ya están resueltas** sin él (2 `no_aplica`, 1 `por_proveedor`,
1 `por_sucursal`, y 2 estables con candidata ≥60 %), **3 no son pregunta para él** (§24.3), y el
resto sigue siendo decisión suya. **La conversación se acorta, pero no desaparece.**

---

## 25. ⭐⭐⭐ `[CP.8.28]` Llegó el árbitro, y encontró un campo mal modelado

**`CT_EST_Poliza_NG.xls`** — el esquema que el importador de ContPAQi usa para *leer* el TXT.
723 filas, transcritas a `database/tests/fixtures/contpaqi-esquema-poliza.json` y convertidas en
candado: **`test-newdb-contpaqi-esquema.js`, 42 ✓ / 0 ✗.**

⭐ **Por qué hacía falta aunque el round-trip ya diera 14/14**: una exportación real prueba que
**leemos bien lo que ContPAQi escribe**, no que **escribamos lo que ContPAQi espera al leer**.
Son dos afirmaciones distintas y hasta hoy sólo teníamos la primera.

### 25.1 ⛔ El defecto que encontró: `SistOrig`

| | esquema | emisor (antes) |
|---|---|---|
| `Concepto` | 41–140 | 41–140 ✓ |
| **`SistOrig`** | **141–143** (ancho **3**) | **142–143** (ancho 2, precedido de separador) ✗ |

⛔ **El esquema NO pone separador entre `Concepto` y `SistOrig`.** Nosotros asumíamos que el
separador es uniforme, y modelábamos un campo de 3 alineado a la derecha como
*"separador + campo de 2"*.

⭐ **Produce los mismos bytes hoy** — `SistOrig` vale `11`, y `" 11"` es lo mismo de las dos
formas. Por eso ningún candado lo había visto, y el total cuadraba en 185 por los dos caminos.
**Con un valor de 3 dígitos el archivo se corría entero.**

*Un total que cuadra no prueba que los campos estén donde van.* Por eso este candado compara
**posición por posición**, no la suma.

Arreglado con `sinSep` en `CampoFijo`: declara que un campo **no lleva separador después**.
`armarLinea`, `largoLinea` y `partirLinea` lo respetan.

### 25.2 ⭐⭐ Y decodifica lo que `[CP.8.13]` §10.5 declaró sin decodificar

| etiqueta | registro | qué es |
|---|---|---|
| `AM` | `asocmovto.1` | UUID — asociación **a nivel de movimiento** (el `AD` es a nivel de póliza) |
| `AP` | `asocnodopago.1` | `UUIDRep` + nodo de pago: **complemento de pago** |
| `I` | `MovtoImpuesto.1` | ⭐ impuesto por movimiento con `UUID`, `TasaOCuota`, `ImpBase` — **es `MovimientosImpuestos`**, la Ola 1 de `FASE_CP9` |
| `V` | `devolucion.1` | devolución de IVA por proveedor, con `UUID` y `RFC` |
| `W2` | `devolucion.2` | IETU |

⚠️ §10.5 decía *"los guids de `AM` no son `MovimientosPoliza.Guid` ni `AsocCFDIs.GuidRef` — se
cruzaron los dos y dieron 0"*. **Ahora se sabe por qué: no es un Guid, es un UUID de CFDI.** Se
comparó contra lo que no era.

### 25.3 ⭐ Y aparecen registros que nadie había visto

`CH` cheque · `EG` egreso · `IN` ingreso · `DE` depósito · `DI` ingresos no depositados ·
`DP` dispersión de pago · `MC` `movimientocfd.1` · `FE` anexo.

⭐⭐ **`MC` es el más grande de todos** (56 campos): trae `IdCuentaFlujoEfectivo`, `UUID`,
`ImporteIVA` **con su `IdCuentaIVA`**, retenciones con sus cuentas, `IVAAcreditable`,
`IVANoAcreditable`… O sea **el desglose fiscal completo con sus cuentas, en el mismo archivo**.

Y `EG`/`IN`/`DE` son los documentos de **tesorería**: el camino para que el movimiento bancario
entre al módulo de bancos de ContPAQi, no sólo como renglón de póliza.

⛔ **No se emite nada de eso todavía.** Se registra porque cambia el techo de lo que el puente
puede hacer — y porque `FASE_CP9` planeaba **importar** `MovimientosImpuestos` para leerlo,
cuando resulta que también se puede **escribir**.

### 25.4 ⚠️ Dos defectos propios en el camino, los dos del mismo tipo

1. **Un `sed` marcó `sinSep` en los DOS `concepto`** (encabezado y movimiento). En `M1` el
   esquema **sí** tiene separador. Lo atrapó releer el esquema, no el candado.
2. **El candado se puso en rojo por su propio modelo**: su helper `nuestro()` seguía sumando un
   separador por campo — la misma suposición que el candado existe para refutar.
   ⭐ *Un candado que modela el mundo distinto del código no verifica el código: verifica su
   propia copia.*

**Mutado a rojo tres veces**: `sist_orig` a 2 (37/5) · sin `sinSep` (36/6) · `referencia` a 10
(32/10). Y los otros 6 candados **siguen verdes** — incluido el round-trip de LC (38 ✓), que es
la prueba de que los bytes no cambiaron.

---

## 26. ⭐⭐ `[CP.8.29]` El emisor ya escribe los renglones `AD` — `EMITE_AD_UUID` cerrado

`EMITE_AD_UUID` venía pendiente desde el arranque de la fase. Se prende ahora y no antes porque
**hasta `[CP.8.28]` el formato era una suposición de foro**; ahora está en el esquema del
fabricante y el candado lo compara posición por posición.

| | |
|---|---|
| layout | `asocdocto.1`: etiqueta `AD` (2) + sep + `UUID` (36) + sep = **40** |
| ubicación | ⭐ **al FINAL de la póliza**, después de todos los `M1` |
| contrato | `PolizaSinkEntrada.uuids?: string[]` |

⛔ **Las fuentes externas decían que el `AD` va *"después del `P`"*** (§9.1). El archivo real lo
desmiente: su primera póliza es `P M1 M1 M1 AD`. **Ponerlo donde decía el foro habría sido el
primer motivo de rechazo**, y nadie habría sabido por qué.

### 26.1 Lo que el emisor se niega a hacer

Un UUID que no mide 36 **se rechaza**, no se rellena ni se recorta. Rellenarlo produciría un
renglón de 40 que el importador acepta y que asocia **el comprobante equivocado** — o ninguno.
Mismo criterio que `[LC.9]`: *un archivo rechazado es infinitamente preferible a uno aceptado y
mal*.

⭐ **Sin `uuids` el archivo sale idéntico al byte.** Es lo que permite prender esto sin tocar el
libro de compras, que mueve $30–56M al mes — y el candado de LC lo confirma: **sigue en 38 ✓**.

### 26.2 ⚠️ Un hueco que sólo apareció mutando

El candado del sink pasó de **50 a 64 ✓** y se mutó tres veces: `AD` antes de los `M1` (60/4),
UUID rellenado en vez de rechazado (60/4), y `AD` sin separador final (62/2).

⛔ **La tercera puso rojo el sink y dejó VERDE el candado del esquema** — porque ése comparaba
el `AD` de la especificación **contra sí mismo**, sin mirar nuestro `LAYOUT_AD`. Cubría `P` y
`M1` y se había saltado el tercero.

⭐ *Un candado tiene que cubrir todos los registros que el emisor escribe, no los dos grandes:
el que falta es justo donde se cuela el defecto.* Cerrado — **46 ✓**, y la misma mutación ahora
pone rojo a los dos.

### 26.3 El archivo B de la prueba ya sale del camino real

Se armaba **pegando texto** al final del A. Ahora sale del **mismo sink**, pasándole `uuids` —
misma lección que costó la fecha rota de §21.2: *un archivo de prueba que no sale del camino real
no prueba el camino real.* Y cada archivo lleva **su propio `guid`**, así se distinguen al
revisarlos.

| candado | |
|---|--:|
| esquema · **sink** · token · armador · cuadre · lote · LC | 46 · **64** · 29 · 33 · 35 · 38 · 38 |

⛔ **Lo que sigue SIN MEDIR y se declara**: si ContPAQi **honra** los `AD` al importar. El formato
es correcto contra su propia especificación; que su importador actúe sobre él es otra afirmación,
y la contesta el archivo B.

---

## 27. ⛔ `[CP.8.30]` El interruptor que NO se acciona todavía — y por qué está escrito

Con `[CP.8.29]` el emisor ya sabe escribir renglones `AD`. **Lo que más valor tiene de esa
capacidad no es el puente de egresos: es el libro de compras.**

### 27.1 Está a una línea, y eso es precisamente el riesgo

`purchase-book.service.ts` arma la póliza mensual desde las facturas del mes:

```ts
const movs = this.construirMovimientos(dentro, modo, conUuid);
const txt  = this.construirTxt(anioMes, run.folio_poliza ?? FOLIO_LIBRO, concepto, movs);
```

`dentro` es `FacturaMes[]` y **`FacturaMes.uuid` existe**. O sea: `dentro.map((f) => f.uuid)`
pasado como último argumento, y la póliza de compras sale con **todos sus CFDIs asociados**.

⭐ Y retiraría una muleta: `[LC.15]` mete el UUID **dentro del `concepto`**
(`const concepto = conUuid ? f.uuid : ''`) justamente porque `FASE_LC` concluyó que *"el layout no
tiene campo de UUID"*. **Lo tiene.** El `AD` es el lugar correcto; el concepto queda libre para
lo que es.

### 27.2 ⛔ Por qué no se acciona

| | |
|---|--:|
| lo que mueve la póliza del libro de compras | **$30–56M al mes** |
| renglones por póliza | 460–848 |
| ¿ContPAQi **honra** los `AD` al importar? | **SIN MEDIR** |

El formato es correcto **contra la especificación del fabricante**. Que su importador **actúe**
sobre ese renglón —y no lo rechace, ni lo ignore, ni tumbe el archivo entero— **es otra
afirmación**, y no la tenemos.

⛔ **Prenderlo antes de la prueba sería apostar el cierre contable del mes a un comportamiento
que nadie observó.** Si el archivo se rechaza por los `AD`, la póliza de compras no entra — y se
descubre el día del cierre.

### 27.3 El orden correcto

1. La contadora importa el archivo **`B`** (§21). Son dos renglones y un peso.
2. Si ContPAQi lo acepta **y** asocia el CFDI → se prende acá, con su candado y su medición.
3. Si lo acepta y **no** asocia → el `AD` no sirve para esto y `[LC.15]` se queda. Se declara.
4. Si lo rechaza → el motivo sale en la bitácora `.xls` y se corrige el layout.

⭐ **Los cuatro caminos son útiles.** El único que no informa nada es prenderlo a ciegas y que
funcione por casualidad.

---

## 28. ⛔⛔ `[CP.8.31]` El cuadre tenía umbral, `@Cron` y latido — y el módulo no estaba registrado

Revisando qué faltaba del plan apareció lo peor posible: **`FinanceContpaqiModule` no estaba en
ninguna app.** El servicio de cuadre tiene su `@Cron('0 */10 * * * *')` desde `[CP.8.8]` y su
umbral en `CRON_JOBS` desde `[CP.8.10]`… y **nunca arrancó**.

⭐ *Un umbral sin proceso detrás se lee en el tablero exactamente igual que un proceso sano que
no tiene nada que hacer.* Por eso nadie lo notó: `contpaqi_cuadre` no está en rojo — está mudo, y
mudo y tranquilo se ven igual.

Registrado en `app.module.ts` + exportado desde el barrel de `libs/finance`.

### 28.1 ⛔⛔ Y al medir dónde correría, apareció un defecto de PLATAFORMA

Antes de registrarlo había que saber dónde cae el `@Cron`. Medido en prod el 2026-10-09:

```
deploy/api      2 réplicas   DISABLE_CRONS=[]   WORKER=[]
deploy/worker   1 réplica    DISABLE_CRONS=[]   WORKER=[true]
```

`app.module.ts` registra `ScheduleModule.forRoot()` **salvo que `DISABLE_CRONS === 'true'`**, y
esa variable **no está puesta en ningún pod**.

⭐⭐ **Todo `@Cron` de la plataforma corre en TRES procesos a la vez.** Evidencia directa, no
inferida:

| | |
|---|--:|
| `cron_runs` con `host = 'api'` | **36 jobs** |
| líneas de scanner/cron en el log de **un** pod de API (2 h) | **12** |
| `DISABLE_CRONS` leído dentro de los pods | **vacío en los 3** |

⚠️ **Y es invisible**: `analytics.cron_runs` es **UPSERT por `job_key`** — guarda la última
corrida, no un log. Tres ejecuciones simultáneas producen exactamente la misma fila que una.
*La duplicación no se puede ver en el tablero que existe para ver los crons.*

⛔ **No se arregla desde acá.** Poner `DISABLE_CRONS=true` en `deploy/api` es un cambio de
plataforma que toca **todos** los crons, y equivocarse de pod los apaga a todos. Lo que sí
corresponde es **no sumar uno más**: el `@Cron` del cuadre sale por `return` si
`process.env.WORKER !== 'true'` — el marcador que el propio repo ya usa en `QueueService.isWorker()`.

### 28.2 El candado notó los cambios, que es su trabajo

`test-newdb-contpaqi-puente.js` se puso en **35 ✓ / 4 ✗** contra prod. Los cuatro eran el candado
afirmando un mundo que mi propio trabajo cambió a propósito — ninguno una regresión.

⭐ **Y en uno la corrección cómoda era la equivocada.** La aserción decía *"CERO reglas
utilizables"*; `[CP.8.19]` dejó 2 filas en `derivada`. Cambiar el `0` por un `2` habría sido
aflojar el candado: *"hay 2 que no son `sin_regla`"* no afirma nada. Lo que importa es **por qué**
no lo son, y son dos cosas distintas:

- `tipo_regla = 'no_aplica'` → **veredicto derivado**: ya se decidió que no genera póliza.
- cualquier otra con `estado <> 'sin_regla'` → una regla que **asentaría**, y eso sólo pasa cuando
  el contador firme.

Ahora son dos aserciones separadas. Y la lista de tablas reguladas **se nombra** en vez de
contarse: un número no dice *cuál* falta.

**40 ✓ / 0 ✗**, mutado a rojo tres veces — incluida la mutación *"aflojar a `estado !==
'sin_regla'`"*, que es exactamente el atajo que estuve por tomar.

---

## 29. 🗺️ `[CP.8.32]`+ El mapa de códigos — qué quedó dónde, y qué códigos chocaron

El plan de §3 reservó `[CP.8.1]`–`[CP.8.19]` antes de construir. Al construir, **tres códigos
quedaron usados dos veces**, con significados distintos:

| código | en el PLAN (§3) | en los COMMITS |
|---|---|---|
| `[CP.8.7]` | bandeja `/finanzas/contpaqi` | **la plomería** (movimiento bancario → póliza) |
| `[CP.8.13]` | proveedor → subcuenta por RFC | **el round-trip byte a byte** |
| `[CP.8.18]` | `SdkSinkAdapter` | **el derivador del mapa** |

⛔ **El historial manda**: un código que ya vive en un mensaje de commit **no se renumera** — el
mensaje es inmutable y renombrarlo rompe la trazabilidad. Lo que se renumera es el **placeholder
del plan**, que no está construido y no lo referencia nadie.

| era | ahora | qué es |
|---|---|---|
| `[CP.8.7]` | **`[CP.8.32]`** | bandeja de armado: armar → revisar → entregar |
| `[CP.8.12]` | **`[CP.8.33]`** | UI de reglas con confianza + aprobación |
| `[CP.8.16]` | **`[CP.8.40]`** | correr el probe del SDK en `192.168.0.208` |
| `[CP.8.17]` | **`[CP.8.41]`** | el agente C# |
| `[CP.8.18]` | **`[CP.8.42]`** | `SdkSinkAdapter` + reversa a TXT |

### 29.1 Y cuatro del plan ya estaban hechos sin que el plan lo dijera

| | |
|---|---|
| `[CP.8.13]` proveedor → subcuenta | ✅ es `[CP.8.20]` — y **no por RFC sino por el UUID del CFDI**: 99.8 % del importe |
| `[CP.8.14]` IVA desde `fiscal.cfdis` | ✅ es `[CP.8.2]`: `iva` es parámetro OBLIGATORIO y el armador **se niega a derivarlo** |
| `[CP.8.15]` categorías que no concentran | ✅ `[CP.8.22]`/`[CP.8.27]`: **no son derivables**, y 3 **no pueden tener UNA cuenta** |
| `[CP.8.19]` asociación formal de UUID | ⭐⭐ ✅ `[CP.8.29]`, **y sin SDK** |

### 29.2 ⛔ Lo que esto le hace a E4 (el SDK)

`[CP.8.19]` era **el argumento #2 del SDK**: la asociación formal del UUID. §9.1 ya había avisado
que si el TXT podía hacerla, *"al SDK le queda un solo argumento"*. **Ahora está hecho por TXT.**

Al SDK le queda **uno**: que nadie tenga que apretar Importar. Sigue siendo válido —
`[CP.8.40]`–`[CP.8.42]`— pero es mucho más chico de lo que el plan asumía, y **E4 deja de estar
en la ruta crítica de nada**.

### 29.3 Lo que de verdad falta

| | quién | |
|---|---|---|
| **el clic** | contabilidad | desbloquea **3 de los 5** criterios de §5; `poliza_exports` está **vacía: nada se entregó nunca** |
| `[CP.8.32]` bandeja de armado | código | |
| `[CP.8.11]` bandeja de divergencias + plazo | código | |
| `[CP.8.33]` UI de aprobación de reglas | código | tras firmar |
| los **33 alias** | compras | `por_proveedor` 72.7 % → ~94.5 % |
| `DISABLE_CRONS` en `deploy/api` | plataforma | ⛔ **no es de esta fase**, pero afecta a todos los crons |

---

## 30. ✅ `[CP.8.32]` La bandeja del puente — el backend, y el permiso REPARTIDO (prod batch 871)

Elegida sobre `[CP.8.11]` (divergencias) por una razón medible: **la de divergencias estaría
vacía por construcción** —`poliza_exports` no tiene una sola fila— mientras que ésta **ya tiene
qué mostrar hoy**.

### 30.1 Lo que la bandeja entrega, y por qué es eso

El puente rechaza todo. Una bandeja que listara *lo entregado* mostraría una pantalla en blanco.
⭐ **Lo que vale hoy es el rechazo con DUEÑO.** Enero, medido en vivo:

| motivo | movs | quién lo arregla |
|---|--:|---|
| `sin_regla` | 954 | el contador |
| `proveedor_sin_cuenta` | 216 | compras — los 33 alias |
| **`no_aplica`** | **148** | ⭐ **nadie: ya se midió y NO genera póliza** |
| `sin_centro_costo` | 135 | negocio — CB no trae centro de costo |
| `sin_medir` | 21 | sistemas |

**Esa tabla ES la entrega.** Antes todo caía en un rechazo genérico y la pantalla habría dicho
*"1,474 pendientes"* — un número que no le dice a nadie qué hacer. Y **148 de ellos no son trabajo
pendiente de nadie**: mezclarlos haría que la bandeja pida trabajo que no existe.

⛔ **No hay `POST /entregar`, a propósito.** Nunca se importó un archivo a ContPAQi: un botón de
entregar sería ofrecer un camino que nadie recorrió.

### 30.2 ⛔ El permiso NO se calcó del módulo hermano

Lo natural era copiar `FISCAL_PURCHASE_BOOK_*`. Leído en vivo, su `VER` lo tienen **8 roles**,
entre ellos `marketing`, `credito_cobranza` y `gerente_compras`.

Esta pantalla muestra **movimientos de banco con su cuenta contable**, y ninguno de esos tres
opera egresos bancarios. ⭐ *Copiar una distribución hereda también sus errores.*

| rol | VER | GESTIONAR | personas |
|---|:-:|:-:|--:|
| `contabilidad` · `finanzas` · `superadmin` | ✓ | ✓ | 4 · 1 · 8 |
| `direccion` · `auditor_externo` | ✓ | — | 2 · 0 |

⭐ *Entre quedarse corto y pasarse, corto es el lado barato*: si a alguien le falta, lo pide y se
ve; si le sobra, nadie se entera.

⚠️ **`GESTIONAR` se repartió aunque no haya nada que entregar.** El día que se firme una regla, la
puerta ya está separada — repartir permisos con el botón vivo es cuando se cometen los errores.

### 30.3 Dos defectos propios, atrapados antes de llegar a ninguna pantalla

1. **Inventé `cuadre.resumen()`**, que no existe. Lo que existe es `cuadrarPendientes()`, que
   devuelve justo ese resumen **y escribe** (asciende estados, mueve el latido).
   ⛔ Un `GET` que lo llamara convertiría **cada visita en una ejecución**, y el latido dejaría de
   medir la cadencia real para medir cuánta gente abrió la pantalla. Se agregó `estado()`, de
   solo lectura — y el candado comprueba que **no escribió ni una fila**.
2. El candado cargaba un servicio de Nest con `skipProject: true`, que deja fuera los alias
   `@megadulces/*`. Los smokes anteriores no lo sufrían porque cargaban **archivos puros**.

### 30.4 El candado — **22 ✓ / 0 ✗**, mutado a rojo dos veces

Existe por `[LC.6.2]`: ahí el par de permisos nació con la fase, vivió **sólo en el enum**, y el
módulo estuvo en prod con **cero roles** pudiendo abrirlo. Este candado mira **el reparto**, no la
declaración — y además que el permiso **cuelgue de un nodo con ruta**, porque uno huérfano no se
alcanza desde la navegación.

| mutación | |
|---|---|
| copiar la distribución del Libro de Compras | ✗ 18/2 |
| mezclar `no_aplica` con los pendientes | ✗ 21/1 |

🚀 **Migración `20261009182612` aplicada a prod — batch 871.** ⚠️ Volvió a aparecer el
`migration directory is corrupt`, esta vez por una migración **de otra sesión**
(`cg76_kdm1_indice_captura`) que está en el ledger y no en la imagen: se copió al pod, no se
inventó un marcador.

---

## §31 `[CP.8.33]` + `[CP.8.34]` — La pantalla de la bandeja, y el universo que la bandeja omitía

🧪 **EN CÓDIGO 2026-10-09.** Sin migraciones ni permisos nuevos (el reparto es el batch 871 de
§30) → **no hace falta re-login**. Falta `git push` + redeploy api+view + validación visual.

### 31.1 ⛔ La ruta que `[CP.8.32]` declaró ya estaba ocupada

El nodo `contpaqi-puente` del árbol apuntaba a **`/contabilidad/contpaqi`**, y esa página
**existe desde CP.1–CP.4**: es el *otro sentido* del conector (leer balanza, bancos, EFOS y
libros-vs-operación de ContPAQi), gateada por `FISCAL_CONTAB_VER`.

El efecto no era un error visible sino el patrón de **gates mal partidos** de `[IC.13]`: alguien
con sólo `FISCAL_CONTPAQI_BRIDGE_VER` veía el renglón en la navegación y **el guard de la ruta lo
rebotaba**, porque pide otro permiso. Y al revés, el árbol rotulaba la página de los libros con el
nombre del puente.

El puente queda en **`/contabilidad/contpaqi-puente`**, con su propio guard. ⛔ No se resolvió
como pestaña de la página existente: eso lo habría escondido detrás de `FISCAL_CONTAB_VER`, que
**lo tienen 8 roles** contra los 5 del puente — incluidos los tres que §30 recortó con motivo.

⚠️ El candado viejo decía `json.includes('/contabilidad/contpaqi')` y **daba verde con el nodo
apuntando a la página equivocada**, porque es prefijo de la ruta correcta. Ahora busca el nodo y
compara la ruta **exacta**.

### 31.2 ⭐⭐ El hallazgo: la bandeja publicaba un denominador recortado en 37.3 %

Al sacar los lotes reales para la maqueta, el servicio escribió esto en el log:

```
876 egresos sin contpaqi_cuenta (crosswalk CP.2): no agrupan
```

**No estaban en los 1,474.** El universo de enero es **2,350**, y la bandeja publicaba 1,474 como
si fuera el mes entero — el mismo defecto que esta fase le corrigió al `0 %` del cuadre, esta vez
del otro lado del cociente.

⛔ **Y la causa no era la que el `warn` sugería.** «Sin `contpaqi_cuenta`» se lee como *falta un
mapeo*, y es falso. Medido:

| cuenta | movs | importe |
|---|--:|--:|
| `CAJA CG` | 864 | $10,193,960 |
| `FACTORAJE FAC` | 12 | $876,417 |

**Tienen cuenta; no son bancos.** No existe una cuenta `102*` que ponerles porque son otro
circuito. El propio mapa `DUENO` de `[CP.8.32]` ya lo decía —
`contpaqi_cuenta: 'sistemas — el crosswalk de CP.2 (CAJA CG y FACTORAJE no son bancos)'` — y el
`warn` de al lado afirmaba lo contrario. *Dos líneas del mismo módulo decían cosas distintas del
mismo hecho, y la que se leía era la del log.*

`simularLotes` pasa a devolver `{ lotes, fuera_de_lote }` con el desglose **por cuenta, con
nombre e importe**, y el endpoint agrega `resumen.universo`. ⭐ *Un hueco que sólo existe en el log
no lo ve quien mira la pantalla, que es justo quien necesita saber que el denominador no es el mes.*

### 31.3 La pantalla

`/contabilidad/contpaqi-puente`, superficie Operations. Answer-first: el veredicto (**0 de 1,474**)
antes de cualquier tabla, el hueco declarado **arriba** del número que lo omite, la tira de KPIs
sin caja, el rechazo con dueño, el maestro-detalle de lotes y el cuadre vacío.

- **`no_aplica` no se suma a los pendientes.** 148 de 1,474 (10.0 %) ya se midieron y no generan
  póliza; el pie dice **1,326 de alguien · 148 de nadie**.
- **`Fuera de lote` y `Entregas` usan `state: 'no_medido'`** de `MetricStrip`, no un cero con tono
  neutro: *«este puente no lo cubre»* y *«nunca se importó un archivo»* no son la cifra 0.
- ⛔ **La tabla de motivos NO es un control.** El filtro vive en botones de verdad abajo: una fila
  clicable sin equivalente de teclado deja afuera a quien no usa mouse, y tener el filtro en dos
  lugares son dos sitios donde se desincroniza.
- **No hay botón de entregar**, igual que en el backend.

### 31.4 Los candados

| candado | |
|---|---|
| `test-newdb-contpaqi-bandeja.js` | **28 ✓ / 0 ✗** (eran 22) |
| `contpaqi-puente.spec.ts` | **12 ✓** — cableado ruta↔guard↔árbol↔sidebar + la clasificación |

Mutaciones verificadas en rojo:

| mutación | |
|---|---|
| `fuera_de_lote.movimientos` vuelve a 0 (el hueco invisible) | ✗ 25/2 |
| el nodo del árbol vuelve a apuntar a `/contabilidad/contpaqi` | ✗ 11/1 |

⚠️ Tres defectos míos los atrapó el propio candado mientras se escribía: el barrel
`@megadulces/contracts` **no re-exporta `authz` a propósito** (`[ID.28]`) y el import dejaba
`AUTHZ_TREE` en `undefined`, con lo que el candado habría dicho *«el nodo no existe»* en vez de
*«el import está mal»* — ahora lo comprueba primero; una ventana de N caracteres sobre
`app.routes.ts` **se comía la ruta vecina** (`polizas`, que sí usa `FISCAL_CONTAB_VER`) y la
prueba negativa fallaba por el vecino; y `check:estilos` frenó un breakpoint en **px** (§R los
pide en `rem`).

---

## §32 `[CP.8.30]` — El renglón `AD` en el libro de compras, **apagado y con número corregido**

🧪 **EN CÓDIGO 2026-10-10.** Migración `20261010093324` **sin aplicar**. Falta `git push` + aplicar
+ redeploy.

### 32.1 ⛔ Dos cifras que circulaban eran falsas, y la fase se apoyaba en ellas

Antes de escribir una línea se midió el universo que un `AD` puede alcanzar — los comprobantes que
**viajan dentro del archivo**, ni uno más:

| cifra | de dónde salía | veredicto |
|---|---|---|
| «~4,200 al mes» | todos los CFDI asociados del mes | ⛔ **16× de más**: incluye los que ContPAQi asocia solo al capturarlos |
| «~1,400 al mes» (§22.3) | sin derivación escrita | ⛔ **5× de más** |
| **~263 al mes** | `finance.v_purchase_book_uuids`, 1,838 en 7 meses | ✅ y **cuadra** con los 256 abonos a `212` de enero |

⭐ *Eso degrada la fase*: 263 asociaciones al mes son una o dos horas, no el premio mayor. El premio
mayor sigue siendo el libro en sí (460–848 renglones tecleados). Lo que sí queda grande es el
**atraso del complemento: 1,772 comprobantes de 2026**, que se asocian en una sola carga.

### 32.2 Dos banderas, no una

`[LC.15]` ya escribe el UUID en el **concepto** del renglón `M1`, y eso sólo sirve para **leerlo de
vuelta**. ⛔ No asocia: la asociación vive en `AsocCFDIs` y el único registro que la crea es `AD`.

Por eso `asocia_cfdi` es una columna **nueva** y no se cuelga de `incluye_uuid`, que viene en `true`
por omisión — colgarla ahí habría prendido el `AD` **en todas las corridas de golpe**. Y en el
servicio es `opts.asociar === true`, no `!== false`: la forma permisiva es para una bandera probada,
no para una que emite un registro que ningún import verificó.

Con la bandera apagada **el archivo sale idéntico al byte**, y eso es ahora una aserción del candado.

### 32.3 ⛔ El defecto que atrapó el invariante, no el compilador

`construirTxt` tiene **nueve** parámetros posicionales. Entre `guid` y `uuids` están `impresa` y
`ajuste`, así que el primer intento pasó el arreglo de UUID **en la posición de `impresa`**: el
array se serializaba **dentro del encabezado** y el archivo salía corrupto, sin error de tipos.

Lo detectó la aserción *«apagado y lista vacía dan el mismo archivo»*. ⭐ *Una función con nueve
argumentos posicionales no se prueba leyéndola; se prueba con un invariante que compare su salida
contra sí misma.*

### 32.4 ⛔ Y un candado con la fecha escrita adentro, que caducó

`test-newdb-libro-compras-caratula.js` afirmaba que **ago-2026 no tiene póliza**. Era cierto al
escribirlo; al 2026-10-10 **agosto ya está posteado** (293 abonos a `212` por $40.9M) y el candado se
puso rojo **sin que nadie rompiera nada**.

Medido: **enero a agosto tienen las ocho pólizas** (un folio cada mes, $30–45M); **septiembre y
octubre están en cero**. El candado ahora **deriva** el mes sin póliza en vez de nombrarlo — misma
lección que `[CDRP.2.1]`.

⚠️ Esto corrige también el plan que se le presentó al área: el mes candidato es **septiembre**, no
agosto. Mandar a contabilidad a rehacer un mes ya posteado es justo el duplicado que `[LC.14]`
existe para impedir.

### 32.5 Candados

| | |
|---|---|
| `test-newdb-libro-compras-txt.js` | **38 → 48 ✓** (10 nuevas, 2 de ellas negativas) |
| `test-newdb-libro-compras-caratula.js` | **66 ✓** (derivando, antes 64 ✓ / 2 ✗ por caducidad) |
| esquema 46 · lote 38 · bandeja 28 | sin regresión |

---

## §33 `[CP.8.35]` — El resolvedor de proveedor: **el puente emite su primera póliza**

🧪 **EN CÓDIGO 2026-10-10.** Sin migración. Falta `git push` + redeploy.

### 33.1 ⛔ El paso que faltaba, y por qué nadie lo había visto

`armarPagoProveedor` lee `regla.cuenta_gasto`. Para una regla `por_proveedor` esa columna es
**NULL por diseño** — lo exige el CHECK de coherencia de `[CP.8.19]`, porque la cuenta no es de la
categoría sino **del proveedor**. O sea que había que resolverla **por movimiento**, desde el
concepto del banco, y **ese paso simplemente no existía**.

⭐ Y no necesita al contador: `armarAsientoEgreso` devuelve en `por_proveedor` **antes** de mirar
`estado`. *La primera póliza del puente nunca dependió de una firma.*

### 33.2 ⭐⭐ 1.4 % → 70.4 %: no era el nombre, era el rubro

| | pareo contra todo el padrón | honrando `cuenta_prefijo` |
|---|--:|--:|
| resuelto | **1.4 %** (3 de 216) | **70.4 %** (152) |
| ambiguo | 70.8 % (153) | 1.9 % (4) |
| placebo | 0.0 % | 0.0 % |

Las cuentas de proveedor viven en **tres rubros** (`2120`, `5010`, `5020`) y el mismo nombre está
en los tres, así que casi todo salía *ambiguo*. Un **pago** carga a la cuenta por pagar, no a la de
compras — y la propia regla ya lo decía en `cuenta_prefijo = '2120'`.

⛔ **Medido como prueba negativa, no como anécdota: 1,002 nombres del padrón existen en `2120` y
también en `5010`/`5020`, y 141 de los 144 resueltos son de esos.** Sin el rubro se perderían casi
todos.

### 33.3 El efecto en la bandeja

| | antes | después |
|---|--:|--:|
| lotes con asiento | **0** | **88** |
| movimientos incluidos | 0 | **144** (9.8 %) |
| importe | $0 | **$36,718,975** |
| `proveedor_sin_cuenta` | 216 | **72** |

⚠️ 144 y no 152: ocho pareos caen en veredictos **sin RFC** (`solo_nombre` 6, `sin_proveedor` 2) y
el resolvedor **se niega a usarlos**. Es el mismo criterio del CHECK de `supplier_accounts`,
repetido del lado del consumidor a propósito: *un CHECK protege la tabla, no a quien lee una fila
vieja.*

### 33.4 Las tres cosas que se niega a hacer

1. **Elegir entre dos cuentas** del mismo rubro → `ambiguo`, cuenta `null`.
2. **Usar un veredicto sin RFC** → `veredicto_debil`, cuenta `null`.
3. **Parear parecido** — sin subcadenas ni distancia de edición: un `HERSHEYS` que casara con
   `HERSHEYS DISTRIBUIDORA` cargaría a la cuenta equivocada **sin que nada se descuadre**.

### 33.5 Candado

`test-newdb-contpaqi-proveedor.js` — **17 ✓ / 0 ✗**, con placebo y con la prueba negativa del
rubro medida sobre el padrón real. Vecinos sin regresión: lote 38 · esquema 46 · libro-txt 49 ·
bandeja 28.

### 33.6 ⭐⭐ Cruce de dos implementaciones, y lo que queda NO es derivable

**El cruce.** `[CP.8.23]` ya había llegado al proveedor por otro camino: *«la contadora no adivina
el proveedor mirando el estado de cuenta — lo lee del pago registrado en Kepler»*
(`analytics.erp_supplier_payments`). Eso no contradice a este resolvedor: son **dos fuentes
independientes del mismo hecho**, y cruzarlas es como aparecen los bugs acá.

**Coinciden en 66 de 67** donde las dos pueden opinar (**98.5 %**), con **una** contradicción:

```
$69,257.27  banco  "Botanas y Cereales de Zamora"            → 2120000529
            kepler "ALIMENTOS PROCESADOS DE ZAMORA SA DE CV" → 2120000018
```

⚠️ Probablemente el **nombre comercial contra el legal**, o sea el mismo proveedor con dos cuentas
en el catálogo de ContPAQi — y eso se arregla allá, no acá. Por eso el candado tolera ≤ 2 y lo que
vigila es que **no crezcan**. El cruce quedó como aserción permanente, no como script suelto.

**Lo que queda NO es derivable, y el derivador tiene razón en negarse.** Corrido sobre ene–mar
(razón real/placebo **369×**):

| categoría | movs enero | qué dice la evidencia | candidato |
|---|--:|---|---|
| `comision_bancaria` | 500 | `100 %` toca `52*` | ⛔ **ninguno** |
| `compra_tarjeta` | 407 | `83.3 %` toca `52*` | `2140800000` con **4 votos / 36.4 %** |

⭐ `comision_bancaria` parea **18 de 500**, y contra pólizas de **278 renglones promedio**: ahí
cualquier cuenta parece la contraparte, y el filtro 1:1 las descarta con razón. *Una regla sin
candidato defendible se declara; no se rellena con el más votado de una póliza de 278 líneas.*

⚠️ Y el dinero no está ahí: los 954 `sin_regla` son **$0.7M** del mes. Lo grande que queda son los
**72 proveedores sin resolver, $6.8M** — 60 sin pareo, 4 ambiguos, 8 con veredicto sin RFC. Ésa es
la lista acotada para compras, y **todavía no tiene dónde guardarse**: no existe tabla de alias de
proveedor (hay tres para productos, ninguna para esto). Declarado como deuda con nombre.
