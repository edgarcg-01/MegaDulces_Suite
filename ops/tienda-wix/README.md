# Tienda de marca (Wix) ← nuestro dato

Lleva la tienda `megadulces.mx` a lo que dicen el mostrador de Kepler y la existencia
arbitrada. Contexto, decisiones y cifras: **`[CV.29]` y `[CV.30]`** en
[`01_TRACKER_PROGRESO.md`](../../docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md).

> ⛔ **La llave de la API NO vive acá, ni en ningún `.env` versionado: el repo es público.**
> Se pasa por variable de entorno de la sesión y se borra al terminar.

## Los tres archivos

| Archivo | Qué es |
|---|---|
| `resolver.js` | **La regla.** Dado un renglón de la tienda, qué debe decir según nosotros. No habla con nadie |
| `control.js` | Su **control negativo**: 18 respuestas que ya conocemos. Corre primero, siempre |
| `aplicar.js` | Lee la tienda viva, calcula el plan, y **sólo con `--aplicar`** escribe |

## Cómo se corre

```bash
node ops/tienda-wix/control.js                                   # 1. el gate, primero
WIXK=<llave> LIVE=<siteId> node ops/tienda-wix/aplicar.js        # 2. ensayo en seco
WIXK=<llave> LIVE=<siteId> node ops/tienda-wix/aplicar.js --aplicar --limite 5   # 3. una probada
WIXK=<llave> LIVE=<siteId> node ops/tienda-wix/aplicar.js --aplicar              # 4. todo
```

`--tope N` cambia el tope por presentación (hoy 50, criterio pendiente de ratificar: `[CV.30]` D2).
Necesita `PROD_DB_URL` en el entorno para leer la existencia **en sólo lectura**.

## Qué decide el resolvedor

1. **SKU sin precio de mostrador → RETIRAR.** No se le inventa precio.
2. **"Pieza" que Kepler no vende por pieza → OCULTAR.** Es un precio que la caja no honra.
3. **La unidad**, en tres reglas y en este orden: el nombre conocido (`Caja`→`CJA`…); el **código de
   unidad** de Kepler guardado como nombre (`500`, `Cub`); y **SKU de unidad única → esa unidad**.
   Si ninguna aplica, **se DECLARA**, no se adivina.
4. **La cantidad se reparte en cascada**, de mayor a menor factor, **descontando** lo ya ofrecido.
   Cierra por construcción: `Σ qty_i × f_i ≤ existencia`.

## Las trampas, ya pagadas

- ⛔⛔ **Un `PATCH` con `variantsInfo` parcial REEMPLAZA, no actualiza.** Colapsó un producto de 3
  variantes a 1, le borró el SKU y se llevó 2 de sus 3 items de inventario. Va **`options` + la
  lista COMPLETA** de variantes; sin `options`, `428 MISSING_OPTIONS_ON_UPDATE_VARIANTS`.
- ⛔ **`inventory-items/search` tarda en indexar.** Justo después de escribir devuelve lo viejo.
- ⛔ **El sitio gratis de la cuenta corre Catálogo V1 y la tienda viva V3**: no sirve de banco de
  pruebas. Se valida contra la tienda viva, con canario reversible.
- ⚠️ **Verificar la estructura no verifica el cambio.** Se verifica releyendo **y** cruzando global.
- ⚠️ **El precio es un blanco móvil:** ~9 precios por hora se mueven en el mostrador, ~1 de los
  publicados (medido el 2026-11-25 sobre 2.09 h). Esto se vuelve a desfasar solo.
