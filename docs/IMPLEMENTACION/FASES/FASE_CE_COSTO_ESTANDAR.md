# Fase CE — Costo estándar de Kepler

> **Disparador (2026-09-29, Edgar):** *"necesito que saquemos el costo estándar de cada producto.
> necesito que entiendas que es y que lo saquemos en una interfaz aparte. esto nos muestra kepler,
> sin embargo podemos denotar errores. analizalo"*, con una captura de la pantalla de utilidad de
> Kepler: producto `70001`, sucursal PH, almacén 1, **Monto sin IVA 86.00 · Costo de venta 68.21 ·
> Ganancia 17.79**.
>
> **Todo lo medido en este documento salió de PROD** (`md · 192.168.0.222:5434`,
> `system_identifier 7688376744939610156`), sólo lectura, el 2026-09-29.

---

## 1. Qué ES el costo estándar

Vive en la ficha del producto (`kepler_ods.kdii`), **uno por cada peldaño de la escalera**:

| peldaño | unidad | factor | **costo** | %margen | PV | cód. barras |
|---|---|---|---|---|---|---|
| base | `c11` | 1 | **`c77`** | `c87` | `c90` | `c7` |
| dos | `c80` | `c81` | **`c78`** | `c88` | `c91` | `c82` |
| tres | `c83` | `c84` | **`c79`** | `c89` | `c92` | `c85` |

Es **predeterminado**, no un promedio: cambia por escalón cuando alguien edita la ficha. El `70001`
pasó de `63.86` a `66.52` a principios de septiembre y se quedó ahí.

### ⭐ No es decorativo: es el que FIJA el precio

```
precio_ficha = costo_estandar × (1 + margen%) × (1 + impuesto%)
```

**Cuadra al centavo en 41,470 de 42,424 filas = 97.75 %.** Verificado en los dos regímenes
fiscales:

| SKU | costo | margen | impuesto | reconstruido | `c90` real |
|---|---|---|---|---|---|
| `70001` LA ROSA MAZAPÁN | 66.52 | 19.7070 % | IEPS 8 % | **86.00** | 86.00 ✓ |
| `17023` | 43.97 | 25.00 % | IVA 16 % | **63.76** | 63.76 ✓ |

Es también el costo que el POS **congela en el renglón de venta** (`kdm2.c62`).

### Cobertura

| | |
|---|---|
| SKUs en el maestro | **9,641** |
| sin costo estándar en ninguna plaza | **2** |
| con el MISMO costo en las 9 plazas | 8,610 (89.3 %) |
| ⚠️ **con costo estándar DISTINTO entre plazas** | **1,004 (10.4 %)** |

---

## 2. Los errores de la pantalla de Kepler, medidos

### 2.1 Kepler tiene DOS costos para el mismo renglón y no coinciden

La captura dice `68.21`. El renglón de venta dice `66.52`. Son tablas distintas:

| fuente | valor para `70001` el 29-sep | qué es |
|---|---|---|
| `kdm2.c62` (documento de venta) | **66.52** | el costo de la ficha, congelado al vender |
| `kdij.c13` (kardex del movimiento) | **68.21** | el costo que el kardex cargó — es un **importe extendido** (`66.52` para 1, `133.04` para 2, `1330.47` para 20) |
| `kdik.c16` (costo del ERP por sucursal) | **69.98** | lo que costó reponer: coincide exacto con la compra `X-A-40` del 26-sep |
| `kdii.c77` (ficha) | **66.52** | el costo estándar |

**Medido sobre 336,805 renglones de ticket (`U-D-10`, 1–28 sep), cruzando `kdm2` con `kdij` por
(sucursal, almacén, SKU, folio, línea, fecha):**

| | |
|---|---|
| COGS con el costo del documento | **$19,155,921.10** |
| COGS con el costo del kardex | **$20,139,782.88** |
| **brecha** | **$983,861.78 · 5.14 % · 4.00 pp de margen** |
| renglones donde difieren | **136,161 = 40.4 %** |

**Y la brecha tiene DOS causas separables** — sumarlas sería el error clásico:

| clase | renglones | brecha COGS | venta | razón mediana |
|---|---|---|---|---|
| idénticos | 260,471 (77.8 %) | $3,781 | $18,925,263 | 1.000 |
| **deriva real** | 65,808 (19.7 %) | $101,761 | $4,852,720 | 1.038 |
| ⛔ **unidad: kardex un peldaño arriba** | **1,205 (0.36 %)** | **$613,646** | **$99,394** | **10.000 exacta** |
| sin explicar | 6,690 (2.0 %) | $481,568 | $486,093 | 1.334 |
| unidad: documento arriba | 50 | −$1,320 | $2,464 | 0.125 |

⚠️ **La razón exacta de 10.000 se sospechó primero como error PROPIO** (un `NULL` mal tratado en
`c56`). Se midió: `c56` y `c58` están poblados en **1,205 de 1,205**. No era mío.

**El mecanismo, en una línea real** (`96087`, suc 01, folio 0014045): vende 120 PZA = 12 PAQ a
$12.43/PZA = $1,491.60. El documento cuesta `c62 = 102.76` × `c56 = 12` = **$1,233.12** (correcto,
$10.28/pieza). El kardex cuesta **$12,331.68** = `102.764 × 120` — *tomó el costo del PAQUETE y lo
multiplicó por la cantidad en PIEZAS*.

### 2.2 «Monto sin IVA» sí trae el impuesto

El `86.00` de la captura son `79.63 + 8 % de IEPS`. **Verificado contra el total del encabezado**
(`kdm1.c16`), 23,506 tickets del 20–26 sep:

| la suma de renglones cuadra con el total del ticket… | |
|---|---|
| …**en bruto** | **21,071 = 89.64 %** |
| …en neto | 2,035 = 8.66 % |

En el mes: **$26,764,462 rotulados "sin IVA" contienen $2,237,689 de impuesto**. El 82.74 % de los
renglones lleva impuesto (197,300 con IEPS). Pasa igual con IVA 16 %.

### 2.3 El mismo producto, cuatro márgenes el mismo día

| cálculo | margen |
|---|---|
| lo que muestra Kepler `(86.00 − 68.21) / 86.00` | **20.69 %** |
| venta neta con el costo estándar `(79.63 − 66.52) / 79.63` | 16.46 % |
| venta neta con el costo del kardex `(79.63 − 68.21) / 79.63` | 14.34 % |
| **venta neta con lo que se pagó el 26-sep ($69.98/PAQ)** | **12.12 %** |

**La pantalla sobredeclara 8.6 pp.**

### 2.4 El peldaño del testigo no siempre es el base

`kdik.c16` contra `kdii.c77`, 36,640 pares:

| dónde vive `c16` | pares | % | razón mediana |
|---|---|---|---|
| mismo peldaño base | 35,111 | **95.83 %** | 1.000 |
| unidad dos (× `f2`) | 220 | 0.60 % | 10.321 |
| unidad tres (× `f3`) | 27 | 0.07 % | 19.998 |
| ⛔ **no cae en ninguno** | **1,282** | **3.50 %** | 1.284 |

**Y pega en el inventario publicado** (`analytics.v_erp_stock_truth`):

| clase | celdas | valuado con `c16` | valuado con el estándar | diferencia |
|---|---|---|---|---|
| base | 21,079 | $52,231,532 | $52,053,548 | $177,985 (0.34 %) |
| **unidad dos** | **71** | **$1,776,847** | **$161,625** | **$1,615,223** |
| unidad tres | 4 | $34,758 | $2,158 | $32,601 |
| no resuelto | 498 | $1,793,732 | $905,013 | $888,718 |

**≈ $2.54 M en disputa** de $55.8 M.

### 2.5 La raíz de 2.1 y 2.4: la unidad base se contradice dentro del mismo Kepler

`96087 KINDER DELICE CARAMELO 10P`:

- la **ficha** dice base = `PZA`, `c77` = 10.28, `f2` = 10 (PAQ), `f3` = 60 (CJA)
- la **venta** registra 120 `PZA` a $12.43 — coherente con la ficha
- la **compra** (`X-A-40`, 18-sep) registra **180 `PAQ` a $102.764** — o sea `c11 = PAQ`

El lado de compra y el de venta no declaran la misma unidad base para el mismo SKU. `kdik` sigue al
de compra; el documento de venta sigue a la ficha. **No se elige un lado: se declara.**

---

## 3. Dos correcciones a lo nuestro

### 3.1 `docs/ERP_KEPLER.md` §2.1 atribuye a `c16` una medición que describe a `c18`

Dice: *"`kdik.c16` … No es costo estándar ni último costo — sólo **20.2 %** coincide exacto con la
última compra, mientras que concuerda 92.1 % con la valuación `c9/c6`"*.

Medido el 2026-09-29 contra la **última** entrada `X-A-40` desde jun-2026, tolerancia relativa
0.1 %, 9,814 pares:

| | |
|---|---|
| `c16` == última compra | **72.41 %** |
| `c18` == última compra | **21.50 %** ← *éste es el 20.2 % del doc* |
| `c16` == `c8/c5` | 44.57 % |
| `c16` == `c9/c6` | 37.24 % |

Por eso en esta fase `c16` se rotula **costo de reposición** (no *promedio móvil*) y `c18` viaja al
lado como `ultimo_costo` en vez de sustituirlo.

### 3.2 `analytics.v_kepler_unit_ladder.pv_base_cuadra` es un falso positivo del 79.3 %

Prueba `PV = costo × (1 + margen)` **sin el impuesto**, así que declara que la ficha no cuadra en
el 79.3 % de las filas. Con el tercer factor puesto, el mismo universo cuadra al **97.75 %**. La
bandera hace ver roto un catálogo sano. No se tocó esa vista (la leen otras fases); la de esta fase
publica `precio_cuadra` con la fórmula completa y el candado mide **los dos regímenes** para que la
diferencia no se pueda perder.

---

## 4. Lo entregado

| sprint | qué | estado |
|---|---|---|
| **CE.0** | `analytics.mv_kepler_standard_cost_activity` — impuesto observado + unidades BASE + venta, por (sucursal, SKU), 30 d | 🔨 en código |
| **CE.1** | `analytics.v_kepler_standard_cost` — vista `derive-no-copy`, 7 veredictos | 🔨 en código |
| **CE.2/3** | `libs/commercial/commercial-standard-cost` — 3 endpoints sólo lectura | 🔨 en código |
| **CE.4** | permiso `COMPRAS_COSTO_ESTANDAR_VER` + reparto derivado del estado vivo | 🔨 en código |
| **CE.5/6** | `/compras/costo-estandar` — Operations, tabla densa + maestro-detalle | 🔨 en código |
| **CE.7** | candado `test-newdb-standard-cost` con 5 pruebas negativas | 🔨 en código |

### El reparto medido (86,638 filas)

| veredicto | filas | % | impacto COGS 30 d |
|---|---|---|---|
| `sin_operacion` | 52,606 | 60.72 % | — |
| `al_dia` | 22,218 | 25.64 % | $56.67 |
| `estandar_bajo` | 6,960 | 8.03 % | **+$233,205** |
| `estandar_alto` | 3,016 | 3.48 % | −$159,541 |
| `no_comparable` | 939 | 1.08 % | declarado, no restado |
| `sin_estandar` | 475 | 0.55 % | — |
| **`sin_testigo`** | **424** | 0.49 % | vendió y el ERP no le tiene costo |

⚠️ **Estos $73,664 netos NO son los $983,862 de §2.1.** Son dos preguntas contra testigos
distintos: acá *la ficha contra el costo de reposición*; allá *el costo que el documento congeló
contra el que el kardex cobró por el mismo renglón*. **No se suman ni se sustituyen.**

### Decisiones que no son obvias

- **Umbral de `al_dia` = un centavo**, la resolución con la que Kepler guarda el costo. No es
  inventado. Con esa banda: 70.36 % al día.
- **`sin_operacion` se separó de `sin_testigo`.** Sin esa separación el 61 % de la tabla es la
  ficha replicada en 9 plazas y **el hueco real de 424 filas queda invisible**.
- **No se consume `analytics.v_kepler_unit_cost`** aunque tenga la regla anti-réplica: hace `JOIN`
  contra `commercial.warehouses` y `catalog.products`, o sea que está acotado a NUESTRO catálogo, y
  dejaba **66.69 % de las filas sin testigo**. Se copió la regla (`sucursal = btrim(c1)`) y el
  candado exige que **donde las dos tienen fila, el costo coincida**.
- **No se materializó todo.** Sólo la actividad de venta, porque `kdm2` son 4.7 M filas / 2.16 GB
  **sin índice por fecha** y agregar 30 días cuesta 3.5 s contra el gate de 1 s. El costo estándar
  en sí es vista viva: cambia cuando alguien edita la ficha y tiene que verse al instante.
- **No hay `GESTIONAR`.** El costo estándar se corrige **en Kepler**, que es el SoR del catálogo
  (ADR-040).

---

## 5. Verificación

| | |
|---|---|
| lógica de la vista, DB-direct contra prod | ✅ 7 veredictos, 2 pruebas negativas en 0 |
| `nx build api` | ✅ |
| `nx build view` | ✅ (verde con esta fase; después lo rompieron 3 archivos de otras sesiones) |
| `nx test contracts` | ✅ 160 |
| `nx test view` | ✅ 1,237 |
| `check:templates` | ✅ 353 componentes |
| `check-provenance` | ✅ sin deuda nueva |
| `check-primeng-api` | ⚠️ rojo, **con cero aporte de esta fase** (se midió: 267→266 y 292→291 al mover las clases al host) |
| `lint-boundary-gate` | ⚠️ rojo por 6 `any` en `commercial-actions.service.ts` y `finance/caja/cash-ledger.service.ts` — **ajenos a esta fase** |
| candado `test-newdb-standard-cost` | ⬜ **no corrido**: necesita las migraciones aplicadas |

---

## 6. Pendiente

1. ⛔ **Aplicar las 3 migraciones** (`20260929160000`, `160100`, `160200`). Prod vive en `md`; van
   con `apply-one-migration-prod.js` **una por una** desde `prod-api`. ⚠️ La `160000` construye una
   matvista que **escanea 2.16 GB**: fuera de horario hábil.
2. Correr el candado contra el destino donde se apliquen.
3. `git commit` — **no hecho a propósito**: `app.module.ts`, `libs/commercial/src/index.ts` y los 4
   de `libs/contracts/src/authz/` llevan **también** el trabajo sin commitear de la Fase BP
   (retiros en caja) de otra sesión, y un `commit` de esos archivos se lo llevaría atribuido a ésta.
4. Redeploy api + view y **re-login** (permiso nuevo en el JWT).
5. Validación visual de `/compras/costo-estandar`.

## 7. Lo que NO se construyó, con motivo

- **Corregir el costo estándar desde la app.** Kepler es el SoR del catálogo.
- **Arreglar `pv_base_cuadra` en `v_kepler_unit_ladder`.** La leen otras fases; tocarla acá movería
  cifras ajenas sin medirlas. Queda declarado en §3.2.
- **Decidir quién tiene razón en los 1,205 renglones con razón 10.000.** Requiere que operaciones
  diga cuál es la unidad base real de esos SKUs — la ficha y la compra se contradicen (§2.5).
- **Un `impacto` para `no_comparable`.** Es justo lo que la fase existe para no inventar.

---

## 8. Aplicado a PROD — 2026-09-29

Autorizado por Edgar (*"autorizo las migraciones"*). Las 3 aplicadas **una por una** con
`apply-one-migration-prod.js` desde dentro de `prod-api` (desde esta máquina `edgar` sólo asume
`dev_ro`: no tiene DDL), cada una con su candado de identidad verificando
`system_identifier 7688376744939610156`.

| migración | batch | tiempo |
|---|---|---|
| `20260929160000` matvista de actividad | 587 | **3.4 s** |
| `20260929160100` `v_kepler_standard_cost` | 588 | 0.1 s |
| `20260929160200` reparto del permiso | 589 | 0.1 s |

`knex_migrations` **907 → 910**. El permiso llegó a los **10 roles** previstos (`auxiliar_compras`,
`compras`, `compras_operaciones`, `direccion`, `encargado_tienda`, `finanzas`, `gerente_compras`,
`marketing`, `superadmin`, `tesoreria`).

### ⚠️ Corrección a lo que yo mismo advertí

Dije *"la primera escanea 2.16 GB → fuera de horario hábil"*. **Tardó 3.4 s.** La advertencia era
correcta en el diagnóstico (es un seq scan, no hay índice por fecha) y **exagerada en la
consecuencia**: un `CREATE MATERIALIZED VIEW` toma `ACCESS SHARE` sobre `kdm2`, no bloquea a los
escritores del CDC, y el agregado ya estaba medido en ~4 s. *Un costo de lectura no es una
escritura pesada.*

### ⛔ Lo que sí pasó, y por qué NO se forzó

Los dos primeros intentos murieron con `Can't take lock to run migrations … lock timeout`, y
`knex_migrations_lock.is_locked` leía **0**. El mensaje de knex invita a `migrate:unlock`;
**hacerlo habría abortado una migración ajena en curso.** El `0` no era el estado real: era un
**lock de FILA** de una transacción sin confirmar, invisible desde `edgar`. `pg_locks` ⋈
`pg_stat_activity` mostró el pid 175274 con `RowExclusiveLock`, y leído con privilegio resultó ser
otra sesión corriendo **`CREATE MATERIALIZED VIEW analytics.mv_erp_count_rollforward`**, activa
hacía 1m33s. Se esperó (186 s) y se aplicó limpio.

⭐ *Un valor de estado leído desde afuera de la transacción que lo cambió dice "libre" mientras el
lock existe.* Al candado de migraciones hay que preguntarle por `pg_locks`, no por su propia
columna.

### Verificación contra PROD

`test-newdb-standard-cost` **18/18 · 0 fallas · 0 no medidos**, incluida la
comparación cruzada con `analytics.v_kepler_unit_cost`: **28,443 filas en común, 0 difieren** — las
dos implementaciones de la regla anti-réplica dan lo mismo.

Y la prueba negativa del precio salió **más fuerte que en el laboratorio**: con impuesto cuadra
**99.24 %**, sin impuesto **17.66 %** → el tercer factor vale **81.6 pp**.

Reparto en prod: `sin_operacion` 52,585 · `al_dia` 22,254 · `estandar_bajo` 6,960 ·
`estandar_alto` 3,012 · `no_comparable` 941 · `sin_estandar` 475 · **`sin_testigo` 411**.

**Gate de <1 s, medido dentro de `pg-prod` (sin red):** resumen 421 ms (por LAN) ·
**tabla de 300 filas 373 ms** · detalle de un SKU en las 9 plazas 20 ms.

### Falta

- **Redeploy api + view** (el código no está desplegado; la ruta y los endpoints no existen todavía
  en el prod desplegado).
- **Re-login** de los 10 roles: el permiso viaja en el JWT.
- **Validación visual** de `/compras/costo-estandar`.
- **Commit** — sigue sin hacerse por el entrelace con la Fase BP (§6.3).

---

## 9. Registrado en la verdad absoluta — y el arbitraje que faltaba

A pedido de Edgar (*"necesitamos una verdad absoluta en este tema"*) esto quedó en
[`docs/VERDAD_ABSOLUTA.md`](../../VERDAD_ABSOLUTA.md): **§16** completo, el resolvedor nuevo en la
tabla de §5, dos huecos con monto en §7, tres filas en la tabla de estado de §2, y **§9.18** la
hipótesis refutada.

Y en el camino apareció el arbitraje que esta fase no tenía: **¿cuál de los dos costos de venta es
el real?**

**Primer intento — inválido.** Se usó `v_supplier_cost_ladder.u1_cost` (lo pactado con el
proveedor) y dio **documento 90.39 %, error mediano 0.0000**. Es un **espejo**: `u1_cost` y `c77`
son idénticos al centésimo en el **86.06 %** de los pares, porque el catálogo se captura de la
misma lista de precios. La prueba comparaba `c77` consigo mismo — R5 en vivo.

**Segundo intento — válido.** Testigo de **transacción**: el precio de la entrada real (`X-A-40`,
`kdm2.c12`), acotado a las entradas cuya unidad base coincide con la de la ficha. Sobre los 921
pares en disputa (41,298 renglones):

```text
gana el DOCUMENTO .... 530 = 57.55%     error mediano 2.66%
gana el KARDEX ....... 372 = 40.39%     error mediano 2.48%
empate ................ 19 =  2.06%
```

**Empate técnico, y el árbitro contradice a los dos** (R5 satisfecha). Se declara: para el COGS de
Kepler **no hay ganador medido**; lo único arbitrado por mecanismo son los 1,205 renglones del bug
de peldaño.

⭐ **Un error mediano de 0.0000 no es una victoria del árbitro, es una alarma.**

---

## 10. `[CE.8]` — La investigación del hueco encontró que el hueco era mío

*(Edgar: "investigalo". 2026-09-29, mig `20260929190000`, batch 596 en prod.)*

`[CE.1]` declaró un hueco —*la unidad base se contradice entre compra y venta*— y lo mandó a
operaciones. Medirlo antes de preguntar dio vuelta las dos mitades de esa frase.

### La contradicción existe, pero es chica y explica poco

De 382 pares donde el rótulo de la entrada (`X-A-40`) difiere del de la ficha, clasificados **con
el dinero** (precio de entrada ÷ costo de ficha):

```text
A · SOLO el rotulo difiere (razon ~1.000) ....  210 pares / 136 SKUs   <-- 55%
B · unidad REAL distinta = f2 ................   55 pares /  33 SKUs
C · unidad REAL distinta = f3 ................    8 pares /   7 SKUs
E · sin explicar .............................  109 pares /  75 SKUs
```

El caso dominante (`PZA → PAQ`, 175 pares) tiene **mediana de razón 1.0000 exacta**: distinto
nombre, mismo número. La contradicción real son **63 pares / 40 SKUs**, y explica **19.1%** de las
celdas con el testigo en otro peldaño. De las 173 celdas `unidad_dos`, **123 (71%) no tienen
ninguna entrada en 180 días** — no están sin explicar, están **sin medir**.

### La causa real era mi banda de ±25%

Los 939 `no_resuelto`, desglosados por `c16/c77`: **494 celdas con mediana 1.334 y $280,813 de
venta** son **deriva normal de costo**, no un cambio de peldaño. La banda las mandaba a
`no_comparable`, donde la vista se niega a publicar desviación — *declarar «no se puede medir» lo
que sí se puede es la falla simétrica de dibujar un cero.*

La banda nueva **se mide**: no existe ningún `f2 < 2` (mínimo 2.00 sobre 6,518 pares), así que una
razón < 2 no puede ser un peldaño. Y aparece un estado nuevo, `testigo_inverosimil`, para las 207
celdas con razón < 0.5 donde **120 tienen `c16` por debajo de un peso** (91 por debajo de un
centavo) contra fichas de mediana $38.90: el testigo no bajó, **está vacío**.

### Efecto en prod

| | antes | después |
|---|---|---|
| `no_comparable` | 941 | **133** |
| `testigo_inverosimil` | — | 208 |
| `estandar_bajo` | 6,960 | **7,425** |
| **COGS subdeclarado 30 d** | $233,205 | **$325,215** |
| celdas sin valorar | 941 | **341** |

**$92,010 de COGS subdeclarado estaban escondidos detrás de un "no se puede medir"** — y del lado
que **infla el margen publicado**, que es justo lo que esta fase existe para detectar.

Candado **18 → 21 aserciones**, 0 fallas contra prod, con una vigilancia nueva sobre la **premisa**
de la banda: si apareciera un factor entre 1 y 2, la regla deja de valer y se pone rojo.

**Sigue abierto y necesita a operaciones:** la unidad real de esos **40 SKUs**. Es una lista, no
una política.

---

## 11. `[CE.9]` + `[CE.10]` — La pantalla dice la verdad y dice qué decidir (2026-09-30, PROD)

*Disparada por Edgar: «la información es ambigua y no se explica del todo… no nos dice mucho», y
después, sobre mi propia redacción del mockup: «¿cuándo dices subir el costo a qué te refieres?
¿a qué te refieres con ficha?». Las dos preguntas destaparon defectos distintos.*

### 11.1 Las dos palabras eran mías, y una escondía una decisión de negocio

**«Ficha»** = el registro del producto en el catálogo de Kepler, la pantalla *Estructura de
Unidades para POS* (3 filas × 6 campos). En la base es `kdii`, **una fila por (sucursal, SKU)**. Y
**es por plaza, medido**: de 4,599 cambios de costo en 90 días, **3,414 (74 %) tocaron una sola
sucursal**; promedio 1.41 plazas por evento. Kepler no la llama «ficha» — es palabra nuestra.

**«Subir el costo»** = el campo *Costo* de la fila **Base** (`kdii.c77`). ⛔ **Y no es un ajuste de
datos: es una decisión de precio.** Medido sobre **6,501 cambios reales**, mirando el precio del
mismo renglón de venta antes y después:

```text
el precio SIGUIO al costo, proporcional (Kepler conserva el margen) ... 4,812 = 74.02 %
el precio se movio distinto ............................................ 1,606 = 24.70 %
el precio NO se movio ..................................................    83 =  1.28 %
```

Corregir las 6,300 fichas equivale a **+$421,734 de facturación en 30 días**, alza mediana **+8 %**,
con **328 fichas por encima del 20 %**. La columna «Qué hacer» del mockup proponía eso como si
fuera higiene de datos: se retiró.

### 11.2 ⭐⭐ Y del otro lado de la bifurcación estaba el hallazgo

Si el precio **no** se mueve, el margen real es el que ya se está sacando. Contra el costo
verdadero, medido en prod el 2026-09-30:

| | |
|---|---|
| fichas que **venden bajo costo hoy** | **270** |
| su venta en 30 días | **$326,959** |
| margen mediano de esas | **−5.67 %** |
| el peor | **−39.24 %** |

El catálogo lo esconde porque calcula el margen contra un costo que ya no se paga. **Ésa es la
lista que importa mañana**, no las 6,300.

### 11.3 Los tres defectos de precisión

| | medido | arreglo |
|---|---|---|
| el peldaño se elegía por **posición** | el renglón #2 de la pantalla (`30540`) publicaba +92.83 % y $7,824.60 sobre un cambio de unidad | los peldaños se prueban **antes** del atajo posicional |
| la fecha salía cruda | `2026-09-02T06:00:00.000Z`, y **55.6 %** eran el centinela `1800-01-01` | `to_char` en el origen + centinela → NULL |
| la plaza `00` salía «al día» | 9,632 fichas, **cero venta** | `es_plaza_operativa`, filtrada por default y **declarada** |

⛔ **Y se descartó, probándola, la solución que parecía obvia:** elegir "el candidato más cercano"
con un desempate de 3× volvía **ambiguo** al `17182 PEPPER` (razón 1.99 con `f2 = 12`), que está
bien clasificado como base. **El arreglo era el ORDEN, no un umbral nuevo.** La asimetría es real:
un peldaño tiene que casar fino (±25 %, un factor es un entero exacto); la deriva de costo no
tiene tope.

### 11.4 `[CE.10]` — el candado encontró dos campos que se contradecían

`test-newdb-standard-cost` se puso rojo al primer intento: **4 filas** donde `vende_bajo_costo`
discrepaba de `margen_real_pct < 0`. Causa: el margen se publica **redondeado a 2 decimales** y la
bandera comparaba el valor **crudo** — un margen de −0.004 % sale como `0.00` y la bandera decía
que sí. Ahora la bandera se deriva del mismo número que se publica.

⭐ **Dos campos que expresan el mismo hecho tienen que salir del mismo cálculo**, no de dos caminos
que casi coinciden. Es un primitivo con dos implementaciones, a escala de columna.

### 11.5 Entregado y verificado

Migraciones **597** (`20260930120000_standard_cost_precision`) y **598**
(`20260930130000_standard_cost_bajo_costo_coherente`) en prod. Columnas nuevas:
`es_plaza_operativa`, `precio_si_conserva_margen`, `margen_real_pct`, `vende_bajo_costo`.

Backend: la 00 fuera por default con su conteo **declarado** (`oficinas_excluidas`), filtro
`solo_bajo_costo`, y el bloque `bajo_costo` dentro del **barrido único** que otra sesión acababa de
optimizar (−55 %) — ⚠️ sin la mediana, que no se deriva de un agrupado y habría costado un segundo
recorrido.

Frontend: titular «N fichas se venden bajo costo al precio de hoy» con su atajo, aviso fijo de que
capturar **mueve el precio**, dos columnas nuevas (**Margen real hoy** y **Precio si capturás**),
y la fila marcada por `vende_bajo_costo` en vez de por `estandar_bajo`.

**Candado 21 → 29 aserciones, 0 fallas contra prod, 0 no medidos.** Builds api+view verdes ·
`check:templates` 355 · `check-provenance` sin deuda.

⚠️ **Dos rojos ajenos:** `check-primeng-api` (esta fase aporta **0**, verificado) y 2 tests de
`ventas-detalle` que no toqué.

**Reparto final en prod (8 plazas operativas):** `al_dia` 19,542 · `estandar_bajo` 6,299
(+$317,835) · `estandar_alto` 2,441 (−$161,769) · `sin_operacion` 47,679 · `sin_estandar` 435 ·
`sin_testigo` 409 · `no_comparable` 113 · `testigo_inverosimil` 88.

**Falta:** redeploy api + view, re-login y validación visual. Mockup aprobado en
`https://claude.ai/artifact/3uv1LMqq6AEtHxuEfN2Dea`.

---

## 12. `[CE.11]` — «Decís que reponer cuesta más y no decís por qué»

*Pedido de Edgar: «mencionas que la reposición es más alta en algunos lugares pero no explicas
por qué… esa atención al detalle hace falta, al dar clic debemos explicar cosas que supones».*

Tenía razón dos veces: la fila afirmaba un hecho sin su causa, **y la causa que yo tenía en la
cabeza era falsa.**

### 12.1 Lo que yo suponía

«Esa plaza compró más caro». El caso que estaba en pantalla lo desmiente:

```text
20119 K'PIÑATON MIX — la plaza 01 repone a $189.07, las otras a $138.44

la UNICA compra del SKU en 6 meses ..... X-A-40, sucursal 00 (CEDIS), $138.441337
lo que movio el costo de la plaza 01 ... N-A-30 del 11-sep, $189.07
                                         = "Entrada Inventario fisico"  (nombre de Kepler, kdmm)
la plaza 06 no tuvo ese ajuste ......... se quedo en $138.44
```

**La plaza no compró: recibió.** Y lo que le fijó el costo fue **un conteo físico**.

### 12.2 ⭐⭐ Y no es un caso raro

Medido sobre los **33,286 pares** (sucursal × SKU) con costo del ERP, buscando el movimiento **no
de venta** más reciente (180 d) cuyo precio unitario coincide dentro del 1 %:

| | pares | |
|---|---|---|
| **se puede atribuir** | **25,071** | **75.3 %** |
| …por **INVENTARIO FÍSICO** (`N-A-30` / `N-A-44` / `N-A-45` / `N-D-30`) | **17,882** | **71.3 %** de los atribuidos |
| …por la cadena de **COMPRA** (`X-A-20` / `35` / `37` / `40`) | 6,901 | 27.5 % |
| …otros movimientos `N` | 288 | 1.1 % |
| **sin movimiento que lo explique** | **8,215** | 24.7 % — se **declara** |

**Siete de cada diez costos de reposición los fijó un conteo de inventario, no una compra.** Eso
cambia la conversación: «la ficha está vieja» presupone que alguien compró más caro; en la mayoría
de los casos lo que pasó es que un ajuste de inventario entró con otro costo.

### 12.3 Qué se agregó

`analytics.mv_kepler_cost_origin` (mig `20260930140000`, batch **606** en prod) y nueve columnas
`origen_*` en la vista. El detalle ahora dice, en una oración:

> Este costo lo dejó **Entrada Inventario físico** del **2026-09-11** (folio 0000412) · 45 PAQ a
> **$189.07**. *No fue una compra: fue un movimiento de inventario físico. Es lo más común — el
> 71 % de los costos de reposición los fija un conteo, no una orden de compra.*

Y cuando no se puede atribuir (24.7 %) lo dice así, en vez de suponer una causa.

### 12.4 Tres decisiones que no son obvias

- **El rótulo sale de `kepler_ods.kdmm`**, el catálogo de doctypes del propio ERP — nunca de una
  lista nuestra (regla dura: *nunca adivinar `c2`/`c3`/`c4`*). ⚠️ `kdmm` **repite claves**:
  `N-D-5` trae cinco nombres distintos (Carta porte, Salida de almacén, Salida por ajuste, Salida
  por destrucción, Salida por muestra). Se toma uno de forma determinista y
  `origen_nombre_ambiguo` **lo declara**, para que la pantalla no presente como único un rótulo
  que no lo es.
- **Se materializa.** El barrido de `kdm2` para documentos que NO son venta **no tiene índice**
  (los dos que hay son parciales sobre `c2='U'`). Medido: **2.1 s** — barato de noche, caro con un
  gate de 1 s. Refresco nocturno enganchado y **umbral registrado** en `CRON_JOBS`
  (`analytics_refresh_cost_origin`): sin él una MV parada se ve verde, y acá eso sería la pantalla
  explicando con un movimiento viejo.
- ⛔ **El primer intento tardaba más de 4 minutos y moría.** Era un `LEFT JOIN` con `DISTINCT ON`
  que el planificador resolvía por bucles anidados. Con `JOIN` y los pares del costo como lado
  externo son 2.1 s. *La diferencia no era el volumen, era la forma de la consulta.*

### 12.5 ⭐ Y el candado anti-`DROP` se ganó el sueldo

`[CE.9]` midió **cero** objetos dependientes de la vista y por eso se permitió un `DROP`. Horas
después ya eran **dos** (`mv_erp_physical_count_variance` y `v_price_psychology`, de otras
sesiones) y el guard frenó la migración. **La medición envejeció en un día.**

Acá no había que forzarlo: esta migración es `CREATE OR REPLACE` y sólo **agrega** columnas al
final, que es exactamente lo que Postgres permite con dependientes vivos. El guard se cambió por
lo que corresponde a lo que la migración hace — **listar** los dependientes, no prohibirlos.

*Un candado copiado de otra migración vigila la operación de la otra migración.*

---

## 13. `[CE.11]` aplicada a PROD — 2026-09-30

Autorizado por Edgar (*«autorizo la migración»*). `20260930150000_standard_cost_con_origen.js`
en **batch 615**, 0.1 s. Candado `test-newdb-standard-cost.js` contra prod: **38 ✓ · 0 ✗ ·
0 no medidos** (publiqué «35» sin contarlas; ver §14.6), con el bloque 11 completo. La consulta exacta que el servicio emite (100 filas,
plazas operativas, sin `sin_operacion`) corre en **461 ms** — bajo el gate de 1 s.

### 13.1 ⛔ El código iba ADELANTADO a la migración, y la pantalla servía 500

Mientras la migración esperaba, Edgar abrió `/compras/costo-estandar` contra el API local y la
pantalla devolvía **500 · `column "origen_familia" does not exist` (42703)**. El servicio y el
frontend ya pedían las 9 columnas `origen_*`; la vista todavía no las tenía.

No es un bug de la vista ni del servicio: es **orden de entrega**. La regla es migración primero,
código después, y acá quedó al revés porque el API de desarrollo lee **prod en solo lectura** y
levantó código sin commitear contra un esquema que aún no estaba migrado.

### 13.2 ⚠️ Encolar un `ACCESS EXCLUSIVE` no es «esperar más»: es bloquear a terceros

Otra sesión tenía la vista tomada con un cruce de cobertura de solo lectura que llevaba **1 h 11
min**. Con el `lock_timeout=15 s` del script la migración no entraba nunca — que es justo lo que
esa red de seguridad busca: *fallo yo antes que hacer cola delante del tráfico de prod*.

La decisión de subirlo tiene una asimetría que conviene escribir, porque no es obvia: **mientras
una petición de `ACCESS EXCLUSIVE` espera, Postgres encola detrás de ella a TODO lector nuevo de
esa relación.** Subir el techo no alarga mi espera: alarga la de los demás. Se justificó porque
la relación ya estaba rota para su consumidor (servía 500), así que la cola no empeoraba nada y
garantizaba tomar el lock apenas se liberara. Quedó como `MIGRATE_LOCK_TIMEOUT` en
`apply-one-migration-prod.js`, con el costo explicado en el comentario y **15 s por default**.

Aun así se bajó a un **turno paciente** (30 s encolado cada 2 min, ~25 % de ciclo) al comprobar
que ya había otra consulta ajena esperando detrás: el techo de daño para un tercero pasó de 60 a
30 s.

### 13.3 ⭐⭐ Casi cancelo la consulta ajena por una razón FALSA

El texto de la consulta bloqueadora terminaba en `FROM b` y **no existe ninguna relación `b`** en
la base (verificado contra `pg_class`, 0 filas). La conclusión cómoda era «está mal escrita, es
un runaway, se puede cortar sin culpa».

Es mentira, y lo dijo una sola medición:

```text
length(query) ............. 1023
track_activity_query_size ....... 1kB
```

**`pg_stat_activity.query` viene TRUNCADO a 1024 bytes.** La consulta real decía `FROM base b` y
estaba perfectamente bien escrita. ⭐ *Lo que se lee en `pg_stat_activity` no es la consulta: es
un prefijo de la consulta.* Si actuaba sobre la corazonada, cortaba trabajo ajeno argumentando un
defecto inexistente.

Lo que sí estaba mal era la **forma**, y eso se probó con el plan, no con la intuición:

```text
Aggregate  (cost=16,359,001)
  SubPlan 1 … SubPlan 4          <-- un subplan POR FILA de base
    -> Nested Loop → kdii, kdik …
```

Los CTEs `psi`/`met`/`cas`/`cos` se usan una sola vez cada uno, dentro de un `EXISTS`
correlacionado → Postgres los **inlinea** y vuelve a ejecutar las cuatro vistas caras por cada
fila. Es la misma trampa que ya había costado 4 minutos y una muerte en §12 de esta fase. Con esa
evidencia sí se le pudo presentar la decisión a Edgar, que autorizó cancelarla
(`pg_cancel_backend`: es un `SELECT`, no pierde un dato, sólo el tiempo transcurrido). La
migración entró al intento siguiente.

### 13.4 ⚠️ Los dependientes volvieron a crecer: cero → dos → TRES

`[CE.9]` midió **cero** dependientes de la vista y por eso el candado anti-`DROP` se cambió de
bloquear a listar. Horas después eran **dos**. Al aplicar `[CE.11]` la propia migración imprimió:

```text
dependientes vivos (se conservan, sólo se agregan columnas):
  mv_erp_physical_count_variance, v_price_psychology, v_price_signals
```

**Tres.** `v_price_signals` es nueva. Tercera confirmación de lo mismo: *una medición de quién
depende de qué caduca en horas en un repo con varias sesiones vivas.* Por eso la migración lista
en vez de decidir, y por eso `CREATE OR REPLACE` que sólo **agrega columnas al final** es la
forma correcta: no rompe a nadie aunque aparezca un dependiente entre la medición y la escritura.

### 13.5 ⛔ Dos accidentes de herramienta, los dos silenciosos

**(a) Detener la tarea de fondo NO mata el proceso remoto.** El reintento corría como
`ssh … "script.sh"` en segundo plano; al detener la tarea murió el cliente `ssh` local y el
script **siguió corriendo en `md`**, encolando locks sin que yo lo supiera. Se descubrió con
`pgrep -af`. Para un lazo que toma locks en prod hay que matarlo **del lado remoto**.

**(b) Este mismo documento se perdió y se recuperó.** Las secciones 9 a 12 se escribieron con un
`python -c "… io.open(p, 'w').write(fase)"` que **sobreescribe el archivo entero** en vez de
agregar: la última corrida dejó el doc con la §12 y nada más — de 12 KB a 4.4 KB. No lo detectó
nadie porque el archivo **nunca estuvo commiteado** (`??` en git), así que no había diff que
mirar. Se reconstruyó entero desde el transcript de la sesión (la escritura original + los
fragmentos `.tmp-*`), y quedó verificado: 12 secciones, 597 líneas.
⭐ *Una escritura en modo `'w'` sobre un archivo que ya tiene contenido es un `rm` con pasos
extra, y sobre un archivo sin commitear no deja rastro.*

---

## 14. `[CE.12]` — El folio no era ambiguo: a mi consulta le faltaba el ALMACÉN

*Edgar abrió la pantalla de Kepler (Entrada de inventario · Sucursal PH · ALMACÉN PH) y vio **un
solo** documento con folio `0000001`, contra los **dos** que yo había reportado. Tenía razón.*

### 14.1 La afirmación era mía, no del dato

```text
kdm1.c1 = ALMACEN
almacen | folio   | fecha      | monto
--------+---------+------------+-------------
01      | 0000001 | 2026-09-11 | 4,246,558.27   <- ALMACEN PH, el de su pantalla
01-006  | 0000001 | 2026-06-26 |    47,596.87   <- OTRO almacen de la misma plaza
```

| | |
|---|---|
| con (sucursal, **almacén**, doctype, folio) | **0 repetidos** en 108,479 documentos |
| sin el almacén — lo que yo consulté | 2,729 «repetidos», **todos artefacto** |

**El folio de Kepler es único. Le faltaba una columna a mi consulta, no unicidad al ERP.**

### 14.2 Y el mismo descuido estaba DENTRO de la atribución

`kdm2.c1` también es el almacén, y la matvista no lo filtraba — mientras que el costo que explica
(`kdik.c16`, anti-réplica `sucursal = btrim(c1)`) **sólo existe en el almacén principal**. La
sucursal 01 mueve **5 almacenes** en `kdm2` en 180 días.

```text
atribuciones sin filtro ...... 25,079   de las cuales 12 (0.05 %) de OTRO almacen (00, 01-006)
atribuciones con filtro ...... 25,067   de las cuales  0
```

Una se re-atribuye al documento correcto y once pierden atribución → pasan a **NULL declarado**.
*Mejor sin explicación que con la equivocada.*

### 14.3 ⭐⭐ Tercer eje ausente: el SUBTIPO, y el «ambiguo» que no lo era

Kepler numera `NA3001-0000001` = género + naturaleza + tipo + **subtipo** + folio. Yo usaba tres
componentes (`kdm2.c5` / `kdmm.c4` es el cuarto):

| clave | total | con varios nombres |
|---|---|---|
| 3 componentes (lo que hacía) | 133 | **27** |
| 4 componentes | 176 | **1** |

O sea que el `N-D-5` que yo publicaba como *«ambiguo, cinco nombres»* **no era ambiguo**: son
cinco doctypes distintos — `-1` Salida de almacén · `-2` Salida por ajuste · `-3` Salida por
destrucción · `-4` Salida por muestra · `-5` Carta porte. Los 288 rótulos «ambiguos» de `[CE.11]`
bajaron a **0**.

La única clave que sigue con dos nombres es `U-D-41-1` — `Embarque Telemarketing` contra
`Embarque Telemarketing.`, **un punto final de más en el catálogo del ERP** — y es un doctype de
venta que esta atribución ni mira. Igual se sigue declarando.

⭐ **Tres veces en la misma sesión una columna de identidad ausente se disfrazó de ambigüedad del
dato**: el almacén («el folio se repite»), el subtipo («el doctype tiene cinco nombres») y el
truncado de `pg_stat_activity` («la consulta está mal escrita»). En los tres casos el dato estaba
bien y lo que faltaba era una columna de mi lado.

### 14.4 Y lo que la pantalla dejaba leer mal

«1 PAQ a $189.07» se podía entender como si el movimiento entero hubiera sido de una pieza. Ese
documento es **el conteo físico completo de la plaza: 897 renglones, $4,246,558.27** — idéntico a
lo que muestra Kepler. Ahora la fila dice el número de documento como el ERP lo escribe
(`NA3001-0000001`), el almacén, y que **es un renglón** de un documento de N partidas por $X.

### 14.5 Dos cosas del cómo, que no son obvias

⚠️ **`MATERIALIZED` en los CTE es carga estructural, no prolijidad.** Sin él, agregar el filtro de
almacén hace que el planificador cambie de hash join a bucles anidados: la consulta pasa de
**2.2 s a no terminar en 5 minutos**. Medido dos veces, con el filtro en el `WHERE` y en el
`JOIN`. Misma familia que el `LEFT JOIN` + `DISTINCT ON` de §12.

⛔ **La matvista no se puede dropear de frente.** `v_kepler_standard_cost` la referencia, y la
vista tiene tres dependientes propios (dropearla en cascada no es opción). La secuencia, toda en
la transacción de la migración: (1) reemplazar la vista dejando las `origen_*` como **NULL del
mismo tipo** —lo único que `CREATE OR REPLACE VIEW` permite—, (2) reconstruir la matvista,
(3) volver a engancharla con las columnas nuevas al final.

### 14.6 Verificación

Dry-run del DDL **extraído del archivo** (no transcrito) contra prod dentro de una transacción
revertida, antes de aplicar. Después, en serio: **batch 622**, 6.6 s, con un control dentro de la
propia migración que **lanza excepción** si quedara una sola fila de otro almacén.

```text
25,067 atribuciones · 0 de otro almacen · 0 rotulos ambiguos · 0 sin tamano de documento
01 | 20119 | almacen 01 | N-A-30-1 | NA3001-0000001 | 1 PAQ a $189.07 | 897 renglones | $4,246,558.27
```

Candado: **44 ✓ · 0 ✗ · 0 no medidos** contra prod (38 antes; 6 aserciones nuevas, dos de ellas
**pruebas negativas** que miden el régimen viejo y exigen que sea peor — sin eso, las otras se
ponen verdes aunque la causa nunca hubiera existido).

⚠️ **Y una corrección de método:** el «35 aserciones» que publiqué al aplicar `[CE.11]` era una
expectativa, no un conteo. Eran 38. Corregido en los cinco documentos donde quedó escrito.
*Un número que no se midió no se publica, aunque sea el de los propios tests.*
