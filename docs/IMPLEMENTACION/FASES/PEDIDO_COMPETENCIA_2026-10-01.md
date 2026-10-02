# Pedido del 2026-10-01 — La competencia, y lo que ISCAM mide de nosotros

> **Qué es este documento.** El registro de lo que Edgar pidió el 2026-10-01, con mi lectura de
> cada pedido, qué quedó entregado y qué falta. El detalle técnico vive en
> [`FASE_PR_ESTRUCTURA_SENALES.md`](FASE_PR_ESTRUCTURA_SENALES.md) §25–§28; esto es el **pedido**,
> para que la próxima sesión no tenga que reconstruirlo del historial.
>
> ⚠️ Las citas son textuales, con sus erratas. Se dejan así a propósito: reescribirlas es
> interpretarlas dos veces.

---

## 1 · Los cinco pedidos, en orden

### P1 · «C:\ISCAMPRECIOS … ANALIZALA PARA VER QUE ENCUENTRAS INTERESNTE Y NUTRITIVO PARA ESTE MODULO»

Seguido de **«RASCALE MAS»** y **«SI ES UNA MEDICION QUE NOS ENTREGAN MES A MES, Y NOS AYUDA A
ESTE DESARROLLO PARA MEJORA DEL MARGEN O MARCKUP»**.

**Lo que entendí:** la entrega mensual de ISCAM es un activo pagado que nadie está leyendo, y
tiene que entrar al motor de margen.

**Entregado:** `analytics.iscam_market` + `analytics.iscam_taxonomy` + `v_iscam_share`, con la
advertencia de los traspasos en una columna. **Batches 660 y 661.**

---

### P2 · «necesito que vayas mas allana, necesito que consigas informacion de competidores principales, ver cual es la comptenecia y ganar observabilidad bajo eso»

**Lo que entendí:** no alcanza con el total del mercado. Hace falta saber **quién** nos gana y
**cuánto**, y poder verlo.

⭐ Lo primero que salió al medir: **la competencia son DOS cosas distintas, de dos fuentes que no
se pueden empatar.**

| | qué responde | fuente |
|---|---|---|
| **cuánto vende** la competencia, por marca | ISCAM, agregado | `v_iscam_competencia` |
| **quién es** y dónde está | INEGI DENUE, con nombre | `v_competidores` |

⛔ **El hueco, declarado y no rellenado:** ISCAM **anonimiza** a los 116 participantes de su
panel; DENUE no dice cuánto vende nadie. **No hay llave entre las dos y no se inventó una.**

**Entregado:**

- ISCAM baja al grano de **fabricante × submarca** — 406,799 filas contra 13,483. El archivo ya
  traía esas dos dimensiones; la carga anterior las agregaba y las tiraba.
- **1,156 competidores mayoristas con nombre**, domicilio y rango de personal
  (SCIAN **431180** dulces al por mayor + 431110 abarrotes + 431199), en Michoacán, Guanajuato y
  Jalisco. ⭐ Las tres clases que el módulo de prospección ya usaba son de **menudeo**: eso son
  clientes, no competencia.
- `prospect_stores.rol` (`prospecto` · `competidor` · `propio`), **que es requisito de corrección,
  no adorno**: `dedup()` purga lo que cae fuera de la geocerca de 100 km y corre en cron nocturno,
  así que sin el filtro la primera pasada se llevaba a los rivales de Guadalajara y León.

---

### P3 · «necesito que esto qie caza iscam, lo casemos nostros. toda data es muy valisoa»

**Lo que entendí:** lo que ISCAM mide de nosotros, medirlo nosotros — y dejar de tirar lo que la
entrega trae.

⛔ Tenías razón en las dos mitades: yo había descartado **1,094,081 registros** del SURF (RY y
YTD) y **no había cargado los dos Cubos**, que describí como «nuestro dato devuelto».

**Son 445,310 registros · 31 meses (ene-2024 → jul-2026) · 11 sucursales · 8,207 presentaciones**,
con `Vol` y `Val` por celda, taxonomía de siete niveles, gramaje y el empaque escrito en el nombre.

⭐⭐ **$1,281.30M — el 68 % del Cubo — es venta NUESTRA que `analytics.sales_daily` no tiene.**

| | monto |
|---|--:|
| comparable (ISCAM y libros, misma celda) | $604.14M |
| sólo en ISCAM, sucursal mapeable | **$489.23M** |
| 2024 y ene-2025, plaza agregada sin almacén mapeable | $792.07M |

De los $489.23M, **$368.84M son Morelia Abastos entera**.

---

### P4 · «apliquemoslo de una vez»

**Lo que entendí:** aplicar a prod ahora, pese a que advertí que eran las 16:14 de un jueves y la
regla del proyecto prohíbe escrituras pesadas en horario hábil.

Lo tomé como tu decisión y procedí. **Ver §2.**

---

### P5 · «no me muestra nada e precios de productos de comptenecia»

**Lo que entendí:** el reclamo es correcto y el hueco era de criterio mío.

Yo había descartado la columna `PcioDisp` del archivo porque su fórmula es `Val/Vol/24` — un
divisor **fijo** para todo el catálogo. Eso sigue siendo cierto. Pero de ahí concluí *«ISCAM no
trae precio»*, y lo que no trae es un precio **absoluto**. El relativo sí se deriva, **y el divisor
fijo se cancela en la razón**:

```
precio nuestro      = valor_nuestro / volumen_nuestro
precio competencia  = (valor_mercado − valor_nuestro) / (volumen_mercado − volumen_nuestro)
```

La resta es lo que lo vuelve *competencia* y no *mercado*: saca nuestra venta del denominador.

**Medido, julio-2026, Región III · Mayoreo Puro · DULCES:**

| | submarcas | venta nuestra |
|---|--:|--:|
| **arriba del precio de la competencia** | **202** | **$10.23M** |
| al mercado (±10 %) | 695 | $38.92M |
| **abajo** | **131** | **$5.01M** |

⭐ El control que lo valida: la razón **tiene dispersión** (mediana 1.0005, desviación 0.4747, de
0.107 a 12.172). Si diera 1.000 en todas partes estaría midiendo una tautología algebraica.

⚠️ La confianza sale de **nuestro** share en volumen, que es donde está el ruido: con share ≥10 %
la desviación es 0.17 (608 celdas) y por debajo sube a 0.71 (420).

---

## 2 · Lo que quedó en PROD

| batch | qué |
|---|---|
| 664 | `iscam_market` a grano **fabricante × submarca** |
| 665 | `prospect_stores.rol` + `v_competidores` |
| 666 | `iscam_sales` + `v_iscam_vs_libros` + **la advertencia corregida** |
| 668 | H4 repetía la causa refutada con otras palabras |

| dato | filas |
|---|--:|
| mercado × marca | **406,799** |
| nuestra venta, 31 meses | **444,615** |
| puente código de barras | 3,895 |
| competidores DENUE | **1,156** |
| prospectos (sin contaminar) | 1,646 |

**Candados contra prod: `iscam-mercado` 31/0 · `iscam-cubo` 13/0 · `denue-competidores` 13/0.**

---

## 3 · ⛔ Lo que publiqué MAL y corregí hoy

Va primero porque es lo que más caro sale si la próxima sesión lo reconstruye.

### 3.1 · La causa de la brecha contra ISCAM

Publiqué en prod que *«el numerador viene inflado por traspasos; la brecha contra `sales_daily` es
de $19.5M a $21.6M por mes»*. **La brecha existe. La causa no.**

| comparación | razón ISCAM / nosotros |
|---|---|
| todo contra todo | 1.54 |
| ⭐ sólo sucursales que nuestro fact SÍ tiene ese mes | **1.105 – 1.371** |

La diferencia era que **`analytics.sales_daily` no tenía esas sucursales**:

| almacén | nuestro fact arranca |
|---|---|
| 01 PH · 02 LPA · 06 CAN | 2025-01 |
| 03 8ES · 04 YU · 05 DAMASO | 2026-01 |
| **07 MM · 08 MA** | **2026-09** |
| 2024 entero | **no existe** |

Queda un residuo real de **~10 %**, y *ése* sí podría ser traspaso.

### 3.2 · Mi cifra de «4,674 filas sin respaldo»

Estaba inflada por polvo de coma flotante: **son 285**. La bandera pasó a columna **generada por
la base**, para que no pueda contradecir a su propia fila.

### 3.3 · `competencia` recortada a cero

Un `GREATEST(…, 0)` rompía la identidad `nuestro + competencia = mercado` en 21 de 40 categorías y
publicaba *«la competencia no vendió nada»* sobre $0.84M de venta nuestra. Ahora es **NULL** donde
los insumos se contradicen.

### 3.4 · Un `ELSE` que pintaba de verde lo no medido

El veredicto del precio terminaba en `ELSE 'al_mercado'`. Medido: **11,709 celdas del archivo
traen sólo volumen, sin valor** — caían por ese ELSE con el precio en NULL. Ahora lo no calculable
se nombra **antes** de comparar.

### 3.5 · Dónde corre prod

Dije *«prod-api está caído»*. **Falso:** prod corre en **K3s**, no en Docker Compose; el contenedor
`prod-api` es un residuo. Prod estaba sano. ⚠️ Las migraciones se aplicaron desde ese contenedor y
**sí llegaron a la base correcta** (identidad de clúster verificada), pero el camino para la
próxima vez es `kubectl exec` en un pod `api-*` del namespace `prod`.

---

## 4 · Lo que FALTA, y de quién depende

| # | qué | de quién |
|---|---|---|
| 1 | **Aplicar la vista de precios a prod** (`20261001250000`). El intento quedó bloqueado por el clasificador de permisos al escribir en el host remoto | **tuyo**: autorizar el `kubectl cp` + `exec`, o aplicarla vos |
| 2 | **`git push`** — nunca autorizado. `main` local arrastra commits de otras fases | **tuyo** |
| 3 | **Redeploy** para que respondan `/margin-engine/competencia` y `/prospects/competidores` | sale solo con el push (auto-deploy cada 5 min) |
| 4 | **La pantalla.** Hoy todo esto sólo se ve por API y por SQL | **mío**, cuando lo pidas |
| 5 | Cosechar DENUE de forma recurrente por el endpoint, en vez del script de carga inicial | mío |

---

## 5 · Las decisiones abiertas que son TUYAS

1. ⛔ **Qué share se publica.** `5.36 %` en Mayoreo Puro (nuestro canal) o `3.80 %` en el mayoreo
   total. **Las dos son ciertas**; la diferencia son $426.8M de mercado en subcanales donde no
   vendemos nada. Cablear `H3`/`H4` al motor obliga a elegir una.
2. ⚠️ **Los 11 «prospectos» con SCIAN de mayoreo.** Entre ellos `DULCERIA RIOS` —competidora
   directa— y ~10 tiendas de cadena, **tres con score 69–72, o sea arriba de la lista de
   oportunidades**. No las reclasifiqué: si un abarrotero mayorista es cliente o rival es criterio
   comercial, no de un candado. Quedó medido con banda.
3. ⚠️ **El residuo de ~10 %** entre ISCAM y nuestros libros sobre sucursales comunes. Sigue sin
   explicar.
4. ⚠️ **`commercial.warehouses` tiene `latitude`/`longitude` NULL en las 22 filas.** Por eso la
   cercanía de un competidor se mide contra **clientes**, no contra sucursales, y el resultado es
   un **piso**: los 438 de 937 clientes con coordenadas (46.7 %) más 1,604 PdV auditados.

---

## 6 · Lo que NO se hizo, con su motivo

- ⛔ **No se inventó una llave entre ISCAM y DENUE.** No existe.
- ⛔ **No se usó el empaque `[32 D/100 P]`** como factor de caja, aunque parsea en el **100 %** de
  las 8,207 presentaciones y sería un tercer testigo. Que `D` y `P` signifiquen *display* y *pieza*
  es **lo que parece, no lo verificado**: el candado exige que ninguna vista lo consuma hasta
  probarlo contra el dinero.
- ⛔ **No se importó `PcioDisp`.** Su divisor es fijo; el precio relativo se deriva sin él.
- ⛔ **No se reclasificó ningún prospecto.** Ver §5.2.

---

## 7 · Commits del día

| commit | qué |
|---|---|
| `c6e7250f5` | ISCAM entra al motor de margen |
| `a299ee66a` | la competencia deja de ser un total — ISCAM a marca + DENUE |
| `b4df66e0a` | el Cubo: 31 meses de nuestra venta + la corrección de la advertencia |
| `cc04eb63b` | aplicado a prod: batches 664-666 y 668 |
| `f015f88c0` | el precio de la competencia |
