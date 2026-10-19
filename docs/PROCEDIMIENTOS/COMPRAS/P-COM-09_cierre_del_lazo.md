# P-COM-09 — Cierre del lazo: ¿hasta dónde llegó lo que pedimos?

> Paso 9 de 9 · `/compras/pedido`, pestaña **Flujo** · [índice](README.md)

## 1. Para qué existe este paso

Contesta la única pregunta que ningún otro paso contesta: **«de lo que pedí, ¿qué llegó?»**. Y lo
hace **leyendo el ERP**, no nuestra propia versión de los hechos.

## 2. Quién lo ejecuta

| | |
|---|---|
| Permiso | `COMPRAS_PEDIDO_VER` — 10 roles |
| En la práctica | el comprador, y quien revise el desempeño de compras |

## 3. Disparador y entradas

- **Disparador:** periodo elegido (y opcionalmente una sucursal).
- **Entradas:** nuestras requisiciones + los `X-A-35` y XA2001 de Kepler.

## 4. Qué se hace

1. Elegir periodo y sucursal.
2. Leer el reparto por **etapa**:

| etapa | significa |
|---|---|
| `con_entrada` | la OC ya tiene entradas de mercancía |
| `en_oc` | está en una OC, sin entrada todavía |
| `esperando` | es reciente: se espera la OC dentro de la ventana |
| `sin_oc` | ninguna OC del proveedor en la ventana trae ni la mitad de sus productos |
| `sin_fuente` | ese almacén **no hace sus órdenes en Kepler** (Wincaja): no hay OC que buscar |

3. Abrir una requisición → ver sus renglones y cuáles **no vinieron** en la OC (negados).

## 5. Qué queda registrado

**Nada.** Es verificación. ⚠️ Que nadie registre el resultado significa que **un hallazgo acá no
tiene dónde vivir**: si el comprador ve que un proveedor niega sistemáticamente un SKU, eso se
pierde al cerrar la pestaña.

## 6. ⛔ El control que hay que entender antes de usar esta pantalla

**La liga requisición→OC es SUGERIDA, no un hecho.** Nadie captura qué OC cubrió cada requisición
(ver [P-COM-07](P-COM-07_orden_de_compra.md) §6: `oc_folio` = 0 de 901), así que el servidor busca
la OC del **mismo proveedor y la misma sucursal** en los días siguientes y elige la que trae más
productos. La pantalla muestra la **confianza** (`alta`/`media`) y marca `ambigua` cuando empata.

⚠️ **No se compara la cantidad, a propósito.** El comprador arma su orden y junta varias
requisiciones: medido, **la OC trae de 0.1× a 94×** lo pedido del mismo producto. Por eso
requisición→OC se mide como *«¿el producto entró a la OC?»* y OC→entrada **en dinero**.

## 7. Evidencia medida *(2026-10-16, 121 requisiciones de compra contra 8,885 documentos)*

| | |
|---|---:|
| Con una OC que cubre el **100 %** de sus SKUs | **47 (38.8 %)** |
| …y además con el importe idéntico | **6** |
| Sin **ningún** documento de ese proveedor en la ventana | **62 (51.2 %)** |
| Control **placebo** del cruce por importe (ventana anterior) | **0 (0.0 %)** |

⭐ **El placebo es lo que vuelve creíble al 5 %**: si el cruce por importe fuera casualidad, la
ventana anterior habría dado una cifra parecida. Dio cero.

⛔ **Lo que queda abierto son las 62.** Esta pantalla las llama `sin_oc`; lo medido no dice si se
pidieron fuera de los 15 días, en otra sucursal, o si no se pidieron nunca. **Es la pregunta que el
flujo todavía no sabe contestar.**

## 8. Cuando falla

| síntoma | qué significa | qué hacer |
|---|---|---|
| `sin_fuente` | el almacén opera en Wincaja | no hay nada que buscar en Kepler; no contarlo como «no cuadra» |
| La liga marca `ambigua` | dos OC empatan en productos | no tomarla como hecho; es la razón de que exista [P-COM-07](P-COM-07_orden_de_compra.md) §6 |
| `esperando` con muchos días | la ventana todavía no vence | volver a mirar; si vence sin OC, pasa a `sin_oc` |
| Muchas en `sin_oc` para un proveedor | cadencia mal puesta, o el proveedor no surte | `/compras/proveedores`; si no surte, es hallazgo de negocio |

---

**Documento oficial de este paso:** ninguno. Propuesta **ACT-CIE** (constancia de conciliación del
periodo, con lo que no cuadró y por qué) en [P-COM-00](P-COM-00_ACTAS_POR_PASO.md) §9.
