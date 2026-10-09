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
| `[CP.8.7]` | Bandeja `/finanzas/contpaqi`: armar → revisar → entregar | HITL. El motor arma, la persona entrega (ADR-028 intacto) |

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
| `[CP.8.12]` | UI de reglas con su **confianza medida** + aprobación (`derivada` → `aprobada`) |
| `[CP.8.13]` | **Proveedor → su subcuenta** por RFC contra `analytics.contpaqi_suppliers` (3,411, 99.6% con RFC) |
| `[CP.8.14]` | La regla del **IVA desde `fiscal.cfdis`** — nunca calculado (medido: difiere 1–2 ¢) |
| `[CP.8.15]` | Las categorías que no concentran (`imss_sua`, 10.2%): medirlas mejor **o declararlas** |

### E4 — La ida automática (dependencia: terminal + SDK) ⬜

| | Qué |
|---|---|
| `[CP.8.16]` | Correr [`01-probe-sdk.ps1`](../../../database/importers/contpaqi/01-probe-sdk.ps1) en una terminal ContPAQi |
| `[CP.8.17]` | El agente (`.exe`/servicio C#), **un endpoint**, sin lógica de negocio |
| `[CP.8.18]` | `SdkSinkAdapter` + **reversa automática a TXT** si el agente no responde |
| `[CP.8.19]` | Asociación formal de UUID (`AsocCFDIs`) — cierra el **0% en 5 años** medido en §7.9 |

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
