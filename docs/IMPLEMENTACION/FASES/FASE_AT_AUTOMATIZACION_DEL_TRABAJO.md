# FASE AT — Automatización del trabajo: qué dejar de hacer a mano

> Pedido de Edgar (2026-10-12): *"ya no sólo dejarlo al análisis, sino a la automatización de
> trabajo. Documentos que ya no tienen que subir, procesos que hoy son complicados o quitan
> tiempo."*
>
> **Todo lo de abajo está medido contra PROD** (`system_identifier 7688376744939610156`) el
> **2026-10-12**, en lectura. Los cruces por importe llevan **control de placebo**: sin eso, un
> porcentaje alto no significa nada.

---

## 1. ⛔ La primera idea, refutada de entrada

**"El PDF de la factura ya lo tenemos, que no lo suban."** Medido: `fiscal.cfdis` tiene
**428,846 CFDIs**, de los cuales **1,015 traen el XML** y **CERO traen el PDF**.

Tenemos los **datos** del comprobante (emisor, totales, impuestos, UUID), no el **archivo**. Los
archivos viven en el ADD de ContPAQi, del que `[CP.9]` midió que **leemos 1 de sus 4
repositorios**. Traerlos es una ola de esa fase, no un atajo disponible hoy.

---

## 2. Dónde se va el tiempo hoy, medido

| Proceso | Volumen medido | Qué hace la persona |
|---|---|---|
| Comprobantes de **pago a proveedor** | **1,350** (ago–oct) | elige el pago, sube el archivo, corre OCR, valida |
| Comprobantes de **órdenes de entrada** | **797** (ago–oct) | ídem |
| Comprobantes de **cobranza** | **0** | nadie lo usa |
| **Estados de cuenta** bancarios (XLSX) | 88 ago · 56 sep · 18 oct | exporta de cada banco y sube |
| **Asociación de CFDI** en ContPAQi | ~**1,100–1,250/mes** | atar factura ↔ póliza, a mano |

---

## 3. ⛔⛔ El hallazgo que manda: **se sube y nadie lo mira**

No es que falten documentos. Es que **el 92 % de lo que se sube se queda parado**.

| | ago-2026 | sep-2026 | oct-2026 | Última validación humana |
|---|---:|---:|---:|---|
| Pagos — subidos | 1,202 | 0 | 148 | |
| Pagos — validados | **7** | — | 83 | de los 83, **82 los hizo el sistema** |
| Entradas — subidos | 150 | 324 | 323 | |
| Entradas — validados | 8 | **0** | **0** | **2026-09-01** |

⭐⭐ **La validación humana de órdenes de entrada lleva seis semanas detenida: 647 documentos
subidos desde el 1-sep que nadie abrió.** Y en pagos, de 1,350 comprobantes, las validaciones
*humanas* de toda la historia son **nueve** (`superoot` 4, `superuser` 5); las otras 82 las firmó
`Sistema · 4 coincidencias`.

> Subir un documento que nadie mira es trabajo **puro** perdido: cuesta en el extremo de la
> captura y no produce nada en el otro. Es el mismo patrón que `finance.findings`, con 157,184
> hallazgos en `nuevo` y 172 descartados.

---

## 4. ⭐ Y el auto-validador YA EXISTE — está casi apagado

El sistema calcula un cruce de **cuatro señales** (banco, fecha, monto, proveedor) y auto-valida
cuando las cuatro dan `ok`. Funciona: firmó **82 de las 83** validaciones de octubre. Repartido
sobre los 1,350 comprobantes de pago:

| Estado del cruce | Total | **Pendientes** | Qué toca |
|---|---:|---:|---|
| ⛔ **sin cruce calculado** | 746 | **737** | *el sistema no sabe nada de ellos* — falta correr el cruce |
| ✅ **4/4 `ok`** | 271 | **189** | parados — ver §4bis, no es lo que yo dije |
| ⚠️ `monto` difiere | 201 | 201 | sí necesita a una persona |
| ⚠️ parcial | 132 | 132 | sí necesita a una persona |

⭐⭐ **La cola humana no son 1,196: son ~333.** Las otras 926 o se auto-validan o ni siquiera se
han clasificado. Eso cambia el problema de *"falta gente"* a *"falta correr dos cosas"*.

---

## 4bis. ⛔⛔ Lo que yo dije en §7 era FALSO: **ninguno de los 189 se podía auto-validar**

El renglón 2 de mi lista decía *«Encender la auto-validación para los 4/4 → **189 revisiones
hoy**»*, como si hubiera un interruptor apagado. Al ir a prenderlo, la medición lo desarmó.

`[PC.6]` tiene **cinco** guardas, no una. La segunda exige que **la lectura sea verificada** — que
la haya producido el servidor y no venga en el request, para que nadie pueda teclear los números
que Kepler espera y cobrar una validación automática. Y la verificación vive en
`OcrReadingsService`: **un mapa en memoria** indexado por el hash del archivo, con 8 h de TTL,
que el endpoint de OCR escribe y `attach` recupera segundos después.

Ese recuerdo no sobrevive a un reinicio, ni al día siguiente, ni a una carga masiva. Medido:

| De los 189 en 4/4, qué los frena | |
|---|---:|
| ⛔ `lectura_verificada` no es `true` (guarda 2) | **187** |
| ⛔ el pago ya tiene OTRO comprobante validado (guarda 5) | **2** |
| ✅ se auto-validarían hoy | **0** |

**Cero.** Y no es un defecto de la regla: la regla está bien. El botón «Volver a comparar»
recalcula las señales contra Kepler y **no puede desbloquear nada**, por más veces que se apriete.
Su propio mensaje lo venía diciendo sin que nadie lo leyera así: *«0 de 500 ya coinciden y
quedaron validados; 500 siguen con diferencias»* — que se lee como *«500 documentos están mal»*
cuando 189 estaban perfectos.

⭐⭐ **Y el rezago no se fue acumulando: nació de golpe.** 920 de los 926 comprobantes sin resolver
—736 de los 737 sin clasificar y 183 de los 189 en 4/4— entraron el **2026-08-05**, por
`superoot`, en **una sola carga**. De los 1,259 archivos adjuntos, sólo **65** traen `sha256`: los
demás nunca pudieron anclarse a una lectura del servidor.

### La salida estaba construida y nadie la había cableado acá

`ObjectStorageService.getDataUri()` existe en el repo —con este comentario literal— *«para
re-correr OCR/Vision en el servidor sobre un archivo ya subido (validación autoritativa, sin
confiar en lo que reporta el cliente)»*. Lo usan Gastos y Comprobaciones. Y **1,199 de 1,199**
comprobantes sin verificar tienen su archivo en el bucket (`finance/<uuid>.pdf`, todos PDF).

Releer desde ahí **no afloja la guarda: la cumple mejor** que el recuerdo en memoria, porque el
servidor baja los bytes que están guardados *como evidencia* y los lee él. Eso es `[AT.1]`.

---

## 4ter. `[AT.1]` — lo construido

| Pieza | Qué hace |
|---|---|
| `relectura.engine.ts` | Reglas puras: qué hoja se relee · qué tipo se le manda al modelo · **qué lectura NO se persiste** · qué cambió · el veredicto del latido |
| `SupplierPaymentProofsService.relectura()` | Baja el archivo, el servidor corre el OCR, persiste la lectura con `lectura_verificada = true` y deja decidir a `decidirAutomatico()` (las 5 guardas intactas) |
| `PagosAutopilotService` | `@Cron` cada 20 min, lote de 25, latido `pagos_relectura` en `analytics.cron_runs` |
| `CRON_JOBS` | Umbral `warn 3 h / crit 12 h` — **sin esa fila `db-health` da verde incondicional** |
| `POST /finance/supplier-payments/relectura` | El botón, acotado a 10: adelanta la próxima pasada |

**Drenado: 1,199 pendientes ÷ 25 × 3 pasadas/h ≈ 16 h.** Después el carril corre casi siempre en
vacío, que es el estado al que tiende.

### ⛔ Lo que NO es, y el precedente que obliga a decirlo

`[GX.32]` **retiró** del módulo de gastos un cuadre donde **la visión firmaba la validación**
(`validated_by: 'Claude Vision'`): si el monto leído cuadraba, el expediente cerraba solo. Se
quitó por pedido explícito del usuario y no vuelve.

Acá la visión **no decide nada**. Produce una lectura; quien decide es el cruce exacto contra
**Kepler** en cuatro campos — `[PC.6]`, que ya está en prod y firmó 82 validaciones en octubre.
Una relectura puede **descalificar** a uno que hoy aparenta 4/4, y eso es una función, no un
efecto colateral.

### Cómo falla, que es donde estaba el riesgo real

⛔⛔ `extractSupplierPayment` **se traga sus excepciones y devuelve todos los campos en `null`**:
sin API key, con el proveedor caído o con un PDF que no se pudo decodificar, el retorno es
**idéntico al de un documento en blanco**. Persistir eso habría borrado la lectura guardada de
hasta 1,199 comprobantes y dejado sus cuatro señales en `sin_dato` — una caída del proveedor
disfrazada de *«los comprobantes no se entienden»*, **destruyendo evidencia**. Tres frenos:

1. una lectura vacía **no se escribe nunca** (`lecturaSirve`), la fila queda intacta;
2. sin `ANTHROPIC_API_KEY` la pasada **no arranca** (si no, 25 ilegibles por una variable que falta);
3. **5 ilegibles seguidas abortan la pasada** — que es la diferencia entre *«estos documentos no
   se entienden»* (disperso) y *«el lector está caído»* (seguido).

⚠️ La lectura anterior **no se pierde**: queda en `ocr_raw.relectura.anterior` con la fecha y los
campos que se movieron. La huella viaja EN LA FILA, no sólo en un log.

### Candados

**67 aserciones, 0 fallas** (`relectura.engine.spec.ts` 22 · `pagos-autopilot.spec.ts` 10 ·
`validacion-automatica.spec.ts` ampliado · los 3 preexistentes). **Probados por mutación**:
apagar `lecturaSirve`, el freno de entrega del latido, el contexto de tenant o el cerrojo de
solape pone en rojo **6 aserciones**.

⚠️ **Un candado del directorio tenía un agujero que yo mismo abrí.** `validacion-automatica.spec`
recorta el `.ts` del servicio entre `recheck(` y `detail(` y le busca cadenas con `toContain`; al
insertar `relectura()` entre medio, ese recorte pasó a abarcarla, y su aserción *«recheck exige
`lectura_verificada === true`»* **seguía verde** sobre un método que pone `verificada: true`. Se
cerró el recorte y se agregó la aserción negativa (`not.toContain('verificada: true')`). *Es la
debilidad de un candado por texto: crece con el archivo y deja de decir lo que su nombre dice.*

---

## 5. El comprobante de pago: el hecho **ya lo teníamos**

¿El movimiento que la persona está documentando ya está en el sistema por el lado del banco
(Fase CB)?

| | Pega | De | % |
|---|---:|---:|---:|
| **Real** (mismo importe, ±3 días) | **886** | 1,350 | **65.6 %** |
| ⭐ **Placebo** (fecha corrida 6 meses) | 5 | 1,350 | 0.4 % |

**164× el piso de ruido** — el cruce es real, no una coincidencia aritmética. En la ventana de
120 días: **300 de 429 (69.9 %)** contra un placebo de **0.9 %**.

⚠️ **Esto NO dice "no suban el comprobante".** El archivo es evidencia de *quién* ordenó el pago y
con *qué* referencia, y eso el estado de cuenta no lo trae. Lo que sí dice es que **el dato que el
OCR extrae ya lo tiene el sistema en dos de cada tres casos**, así que la pantalla puede
**proponer el pago ya cuadrado** en vez de pedir que alguien lo busque y lo confirme.

### El mismo cruce en órdenes de entrada, y por qué rinde menos

| | Pega | De | % |
|---|---:|---:|---:|
| Real (mismo RFC, mismo total, ±30 días) | 150 | 462 | 32.5 % |
| ⭐ Placebo (mismo RFC, importe inventado) | **0** | 462 | **0 %** |

Placebo impecable, cobertura baja — y tiene explicación: **la remisión no es la factura**. Se
firma al recibir, antes de facturar, y los totales difieren por entregas parciales. Es el mismo
41 % de desajuste que la Fase RE midió en el Excel de recepción.

---

## 6. ⚠️ Dos lecturas mías que la medición corrigió

1. **"El OCR acierta el 100 %, la validación humana no aporta."** Medido: `monto_match` es `true`
   en 1,350 de 1,350 — pero porque la tolerancia es **$1**, y las diferencias reales van de
   **$0.00 a $1.00** (73 valores distintos). El OCR **sí** lee el documento y **sí** se desvía;
   simplemente nunca más de un peso. La afirmación correcta es más acotada: *el OCR nunca se
   equivoca por más de $1 en 1,350 lecturas*.
2. **"`monto_match` no discrimina."** No discrimina **en esta población**, que no es lo mismo que
   estar roto. ⚠️ Pero sí implica que, como gate, **hoy no puede atrapar una lectura mala**: el
   que de verdad separa es `coincidencias` (§4), que mira cuatro señales y no una.

---

## 7. Qué hacer, por rendimiento

| # | Acción | Elimina | Estado |
|---|---|---|---|
| 1+2 | **`[AT.1]` Relectura desde el archivo + carril que corre solo** | hasta ~**450** revisiones (ver abajo) + todas las futuras | 🧪 **en código**, 67 aserciones |
| 3 | ⛔ **Entradas: dueño o apagar el requisito** | 647 documentos sin mirar desde el 1-sep | decisión, no código — y ver §7bis |
| 4 | **El renglón `AD` del TXT** (`[CP.8.29]`, ya escrito) | ~**263 asociaciones/mes** | espera el clic de `[CPA.3]` |
| 5 | **Proponer el pago ya cuadrado** desde el banco | la búsqueda manual en 2 de cada 3 casos | ⬜ pantalla |

⚠️ **Los renglones 1 y 2 eran el mismo problema**, y mi separación los describía mal: el cruce
sobre los 737 no sirve de nada sin una lectura que el servidor pueda firmar, y la auto-validación
no se podía «encender» porque no había interruptor. Ver §4bis.

### ⚠️ El ~450 es una PROYECCIÓN, no una medición

Se arma con dos piezas y cada una puede moverse:

- **187** de los 189 en 4/4 están frenados **sólo** por la guarda 2 (medido). Se auto-validan **si
  la relectura confirma su lectura actual** — y puede no confirmarla: por eso el motor cuenta
  `cambiaron`, que es la única manera de saber si la carga del 5-ago era confiable.
- **~265** más, si de los 737 sin clasificar sale la misma proporción de 4/4 que en los ya
  clasificados (189 de 522 = **36 %**). Es una regla de tres sobre otra población: puede fallar.

⛔ La cifra honesta hoy es **0 validados**, y la primera pasada en prod da la real. No se publica
como logro hasta que el latido lo diga.

---

## 7bis. ⛔ Entradas: en el renglón 3 yo dije «apagar el requisito» como si hubiera algo prendido

Medido: `finance.goods_receipt_proofs` **no tiene auto-validador**. Ni `coincidencias`, ni
`lectura_verificada`, ni `auto_validado` — ninguna de las columnas existe. El mecanismo de `[PC.6]`
**no se le puede soltar: habría que construirlo**.

Y sería más difícil, no más fácil: el cruce contra el CFDI del mismo proveedor da **32.5 %** de
cobertura (placebo impecable, 0 %), contra el **65.6 %** del pago contra el banco. La causa está
en §5 — **la remisión no es la factura**: se firma al recibir, antes de facturar, y los totales
difieren por entregas parciales. Un auto-validador de 4 señales sobre esa base dejaría fuera a dos
de cada tres.

⭐ Así que el renglón 3 **sigue siendo una decisión**, y ahora con el motivo medido: no hay nada
que encender, y lo que habría que construir rinde la mitad. Antes de construirlo conviene saber
por qué nadie valida desde el 1-sep (§8).

⛔ **Lo que NO se propone, con motivo:** eliminar la subida del comprobante (es evidencia que sólo
tiene la persona), ni la del estado de cuenta (ContPAQi guarda la *contabilización*, no lo que
dice el banco), ni traer los PDFs del ADD sin antes medir qué hay en sus otros 3 repositorios.

---

## 8. Lo que NO se pudo medir, declarado

- **Cuánto tiempo cuesta cada subida.** No hay telemetría de la pantalla; todo lo de arriba es
  volumen, no minutos. Un documento puede ser 20 segundos o 3 minutos, y eso cambia el orden.
- **Por qué se detuvo la validación de entradas.** El dato dice *cuándo* (1-sep), no *por qué*.
  Puede ser falta de tiempo, de dueño, o que el paso no sirva para nada — y las tres se arreglan
  distinto.
- ~~**Si los 737 sin cruce son del backfill de agosto**~~ — **RESUELTO**: los 737 son del
  `2026-08-05`, `superoot`, una sola carga (§4bis). No fue un fallo del cálculo: el cálculo no
  existía todavía (`coincidencias` nació con la migración `20261004120000`, el 4-oct).
- **Si la relectura confirma la lectura de la carga del 5-ago.** El motor lo cuenta (`cambiaron`),
  pero hasta la primera pasada en prod no hay número. Si cambia mucho, lo que está guardado hoy
  **no describe a los documentos**, y eso es un hallazgo mayor que la cola.
- **Cuánto cuesta la relectura.** 1,199 lecturas de visión. El orden de magnitud es trivial contra
  1,199 revisiones humanas, pero no está medido y conviene mirarlo tras la primera pasada.

---

## 9. Lo que falta para que esto sirva (nada de esto está hecho)

| | |
|---|---|
| ⛔ **`git push`** | el código no está en `origin/main`; sin eso no hay despliegue (pendiente de autorización) |
| ⛔ **redeploy api + worker** | el `@Cron` vive en el **worker** (`replicas: 1`, `Recreate`); el `api` corre con `DISABLE_CRONS=true` |
| ✅ **`ANTHROPIC_API_KEY` y `S3_*`** | **verificado por evidencia en prod**, ver §9bis |
| ⬜ **Mirar el latido `pagos_relectura`** | la primera pasada es la que convierte la proyección de §7 en una medición |
| ⬜ **Validación visual** del botón «Ponerse al día» | |

Sin migraciones ni permisos nuevos → **no hace falta re-login**.

---

## 10. ⛔⛔ La primera pasada real en prod: **falló, y tenía razón**

`[AT.1]` se desplegó y el `@Cron` del worker corrió a las **11:20 del 2026-10-12**:

```
status: error · host: worker · rows_affected: 0 · 3,521 ms
note: 0/25 releidos · 0 clasificados · 0 validados · 0 cambiaron
      sin releer: sin_archivo 25
```

Y en el log del worker, 25 veces: **`GET finance/<tenant>/supplier-payments/uyil38hglpnz7zarmv8g
(getDataUri): Key not found`**.

### ⛔ Dos afirmaciones mías de este documento eran FALSAS

**1. §4bis decía «1,199 de 1,199 tienen su archivo en el bucket».** Lo que medí fue
*«`public_id` no está vacío y no empieza con `http`»* — un **proxy**— y lo publiqué como *«el
objeto existe en nuestro bucket»*, que sólo lo contesta un GET. Medido de verdad:

| hoja `comprobante` sin lectura firmable | |
|---|---:|
| ⛔ `public_id` de **Cloudinary** (sin extensión) | **1,194** — todos del 2026-08-04/05 |
| ✅ llave real del bucket (`.pdf`) | **5** — de octubre |

Un `public_id` de Cloudinary se ve **idéntico** a una llave nuestra
(`finance/<tenant>/supplier-payments/uyil38hglpnz7zarmv8g`); lo único que los separa es la
**extensión**, porque todo lo que escribe `ObjectStorageService` sale como `<carpeta>/<uuid>.<ext>`.

**2. §9bis decía «verificado por evidencia en prod».** El **mecanismo** sí: `[GX.33]` tiene 188
lecturas reales. Pero sus archivos están en el bucket (**702 contra 2**) y los míos en Cloudinary.
⭐⭐ *Verifiqué el mecanismo en un módulo y supuse la población en el otro — una medición sobre
otro universo es otra afirmación.*

### ⭐⭐ Y el hallazgo que vale más que la cola: **la evidencia de 1,200 pagos no se puede abrir hoy**

| módulo | filas | ⛔ en Cloudinary | ✅ en bucket |
|---|---:|---:|---:|
| `supplier_payment_proofs` | 1,350 | **1,200 (88.9 %)** | 150 |
| `goods_receipt_proofs` | 798 | 6 | **792** |
| `expense_proofs` | 513 | 0 | **513** |

El propio `migrate-cloudinary-to-bucket.js` (`[RE.6]`) lo documenta: *«Cloudinary bloquea el
delivery de PDF por default → un GET al secure_url da **401**»*. Comprobado: **6 de 6 → 401**.

⛔ O sea que **1,200 comprobantes de pago tienen su evidencia inalcanzable** — no sólo para mi
carril: para la persona que abre la pantalla. Eso explica mejor que nada lo que §3 llamó *«se sube
y nadie lo mira»*.

### ⛔ Y refuta mi hipótesis sobre entradas, que iba a extender sin medir

Las **789** órdenes de entrada sin validar están **en el bucket** (sólo 6 en Cloudinary), y sep y
oct son **100 % bucket con 0 validaciones**. El documento **sí se puede abrir**: el congelamiento
de entradas no tiene nada que ver con esto. La decisión de §7bis queda **sin contaminar**.

### ⭐ Lo que el diseño hizo bien, medido

1. **Cero filas escritas, cero evidencia pisada.** La guarda de lectura vacía ni llegó a probarse:
   el fallo ocurrió antes, al bajar.
2. **El latido dijo `error`**, no `ok` — el freno *«revisó 25 y releyó 0 es error»* (probado por
   mutación) disparó en producción.
3. ⭐⭐ **El desglose por motivo diagnosticó la falla en una consulta.** `[GX.33]` mete los cuatro
   casos en un solo `AVISO_ILEGIBLE`; con esa etiqueta esto se habría leído como *«los
   comprobantes no se entienden»* — culpando al documento por un archivo que está en otro
   proveedor.

### `[AT.1.1]` — lo corregido

- `esLlaveDeBucket()` + motivo nuevo **`en_cloudinary`**: el archivo **existe**, está en el
  proveedor anterior, y se arregla **migrando**, no volviéndolo a pedir.
- El lote **excluye** los de Cloudinary. ⛔ No es cosmético: el orden es determinista, así que
  entrando ellos **las 25 filas serían siempre las mismas** y la cola no avanzaría nunca.
- `bloqueados_en_cloudinary` se publica en **cada** latido aunque el carril esté sano: un rezago
  bloqueado por una acción humana se vuelve invisible justo cuando el carril se pone verde.

⚠️ **Y un segundo bug que sólo apareció al probar el arreglo contra prod.** El predicado nuevo
usaba `~ '\.[a-zA-Z0-9]{1,8}$'` y **no filtraba nada**: la barra invertida se pierde entre JS y
Postgres, así que el motor recibía `.[a-zA-Z0-9]{1,8}$` — «cualquier carácter seguido de
alfanuméricos» — que matchea todo.

```
'finance/a/b/uyil38hglpnz7zarmv8g' ~ '.[a-zA-Z0-9]{1,8}$'    →  true   ⛔
'finance/a/b/uyil38hglpnz7zarmv8g' ~ '\.[a-zA-Z0-9]{1,8}$'   →  false  ✅
```

Lo atrapó **la prueba negativa** («los 1,200 de Cloudinary NO deben pasar»): pasaban los 1,200.
⭐ El arreglo no fue poner más barras —eso es volver a depender de cuántas sobrevivan— sino **no
usar ninguna**: `split_part(llave, '/', -1) LIKE '%.%'`.

**Verificado contra prod, con el predicado extraído del `.ts`** (no re-tecleado, que es como se
escapó el bug): **5 entran · 1,194 bloqueados · 142/142 con lectura firmable pasan · 0 de 1,200
de Cloudinary pasan.**

**Candados: 73 aserciones, 0 fallas**, con la regla nueva probada por mutación (poner
`esLlaveDeBucket` siempre en `true` pone 3 en rojo).

### Qué falta ahora, en orden

| | |
|---|---|
| ⛔ **Habilitar el delivery de PDF en Cloudinary** (Settings → Security) | acción humana, destraba los 1,200 |
| ⛔ **Correr `migrate-cloudinary-to-bucket.js --apply`** | mueve la evidencia a nuestro bucket |
| ⬜ redeploy con `[AT.1.1]` | hasta entonces el carril sigue en `error` reintentando los mismos 25 |
| ⬜ Mirar la pasada siguiente | con 5 documentos es poco, pero es la primera medición real |

⚠️ **Y la pregunta que nadie se hizo:** ¿por qué la carga del 5-ago fue a Cloudinary si `[RE.6]`
ya había migrado el resto? Si el camino de subida vuelve a Cloudinary alguna vez, esto se repite.

---

### 9bis (corregido). ⭐ El camino de la relectura corre en prod — pero NO sobre esta población

Desde esta máquina **no se alcanza el bucket de prod** (el `S3_BUCKET` del `.env` local apunta a
otro y responde *«The specified bucket does not exist»*), así que la prueba directa no se pudo
hacer. ⚠️ Y había un riesgo concreto que valía la pena descartar: `.env.example` trae **dos juegos
de nombres** para lo mismo (`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` en la línea 142 y
`S3_ACCESS_KEY`/`S3_SECRET_KEY` en la 322), y `ObjectStorageService` **sólo lee el primero**. Con
el juego equivocado, `isConfigured()` es `false`, `getDataUri()` devuelve `null` sin avisar, y los
1,199 comprobantes caerían en `sin_archivo` — un despliegue que no entrega nada y no dice por qué.

Se descartó midiendo al otro consumidor del mismo primitivo, `[GX.33]` en Gastos:

| `finance.expense_proofs` · nota de la visión | |
|---|---:|
| ✅ **leyó de verdad** (*«⚠ El comprobante dice $762.15 y la solicitud $1,462.54…»*) | **188** · la última **hoy, 2026-10-12** |
| ⛔ no se pudo leer | 29 |
| sin nota | 280 |

⭐ Eso prueba, en prod y hoy, las tres cosas que `[AT.1]` necesita: **las variables `S3_*` tienen
los nombres canónicos**, `getDataUri()` baja el archivo del bucket, y el modelo de visión
responde. Es el mismo código, invocado desde otro módulo.

⚠️ **188 contra 29 da un ~13 % de ilegibles como referencia previa** para lo que va a volver vacío
de los 1,199 — y Gastos no distingue *«no se pudo bajar»* de *«el modelo no leyó»* (los dos caen
en el mismo `AVISO_ILEGIBLE`). `[AT.1]` sí los separa (`sin_archivo` ≠ `ilegible` ≠
`tipo_no_leible`), porque no se arreglan igual.
