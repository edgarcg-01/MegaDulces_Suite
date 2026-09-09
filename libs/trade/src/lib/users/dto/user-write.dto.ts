import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
// `[CH.1.10]` El techo del TTL vive UNA vez, en el primitivo que firma el token.
import { MAX_TOKEN_TTL_DAYS } from '@megadulces/platform-core';
// `[CH.1.10]` El vocabulario del wire, compartido con el frontend.
import { USER_KINDS, type UserKind } from '@megadulces/contracts';

/**
 * `[ID.7]` — DTO ÚNICO de escritura de usuario (Fase ID / ADR-050).
 *
 * Antes había dos DTOs escritos a mano con **9 campos duplicados literal**
 * (`username`, `password`, `nombre`, `zona`, `zona_id`, `role_name`,
 * `supervisor_id`, `department_code`, `position_code`, `warehouse_code`) y
 * asimetrías que no respondían a ninguna regla de negocio:
 *
 *   - `CreateUserDto` no podía setear `finance_expense_area_ids` (sólo update),
 *     así que un alta con áreas de gasto necesitaba dos requests.
 *   - `UpdateUserDto` no exigía `department_code` aunque el create sí — o sea,
 *     la regla "todo usuario vive en un departamento" se podía saltear editando.
 *
 * Ahora los campos viven acá una sola vez:
 *   - `CreateUserDto extends UserWriteDto` → lo obligatorio sigue obligatorio.
 *   - `UpdateUserDto extends PartialType(UserWriteDto)` → todo opcional.
 *
 * Los que llevan `@IsOptional()` acá son opcionales **en las dos operaciones**;
 * los que no, son obligatorios al crear. `PartialType` los afloja para el
 * update, que es lo que se quiere: un PATCH manda sólo lo que cambia.
 *
 * ── La ZONA: un solo campo, no tres ──────────────────────────────────────────
 * Se manejaba con `zona` (nombre) **y** `zona_id` (uuid) a la vez, y el
 * frontend tenía una suscripción a `valueChanges` traduciendo uno en el otro.
 * Dos entradas para el mismo hecho = dos formas de que queden en desacuerdo.
 *
 * El canónico es **`zone_id`** (English snake_case, como manda CLAUDE.md).
 * `zona_id` y `zona` se siguen aceptando como **alias deprecados** para no
 * romper al frontend actual ni a los deep-links; la precedencia la resuelve
 * `UsersService`: `zone_id` → `zona_id` → resolver(`zona`).
 */
const DEPARTMENT_REQUIRED = 'Hay que asignar un departamento existente.';

export class UserWriteDto {
  @ApiProperty({ description: 'Nombre de usuario único (3-64 caracteres)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-z0-9._-]+$/i, {
    message: 'username solo admite letras, números, ".", "_" y "-"',
  })
  username!: string;

  @ApiProperty({ description: 'Contraseña en texto plano (mínimo 6 caracteres)' })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ description: 'Rol del sistema (define QUÉ ACCIONES puede; el alcance va aparte — ADR-050)' })
  @IsString()
  @IsNotEmpty()
  role_name!: string;

  /**
   * OBLIGATORIO: un usuario tiene que vivir en un departamento que exista. Sin
   * esto las cuentas caían en el cajón "Sin departamento" del admin y el padrón
   * se desordenaba solo (pasó con las 22 altas de `[UN.10.1]`). La existencia
   * del code la valida `UsersService.assertCatalogCodes` contra
   * `identity.departments` del tenant → 400, no 500 por la FK.
   */
  @ApiProperty({ description: 'Departamento del organigrama (identity.departments.code). Obligatorio al crear.' })
  // Mismo mensaje en los 3 decoradores: `ValidationPipe` devuelve un ARRAY con
  // todos los que fallan, y si cada uno dice algo distinto el toast del admin
  // muestra el menos útil ("department_code must be a string").
  @IsString({ message: DEPARTMENT_REQUIRED })
  @IsNotEmpty({ message: DEPARTMENT_REQUIRED })
  @MaxLength(50, { message: DEPARTMENT_REQUIRED })
  department_code!: string;

  @ApiProperty({ description: 'Nombre completo', required: false })
  @IsOptional()
  // `[ID.27]` Recorta bordes y colapsa espacios internos. No es cosmético: el
  // nombre es la ÚNICA llave con la que hoy se cruza una credencial contra una
  // persona (`analytics.vendor_identity` liga por nombre, sin `user_id`), así
  // que un espacio de sobra parte a alguien en dos identidades. Medido en prod:
  // 2 de 125 cuentas traían espacio al final —`diana_cortes` y
  // `veronica_magana`— y **las dos** son justamente casos de persona con dos
  // cuentas, o sea las filas que el backfill de la Etapa 3 tiene que aparear.
  // Va en el DTO y no en el service porque hay 3 caminos de escritura.
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsString()
  @MaxLength(255)
  nombre?: string;

  @ApiProperty({ description: 'Zona (uuid). CANÓNICO — reemplaza a `zona_id`/`zona`.', required: false })
  @IsOptional()
  @IsUUID()
  zone_id?: string;

  /** @deprecated usar `zone_id`. Se acepta para no romper al frontend actual. */
  @ApiProperty({ description: 'DEPRECADO — usar `zone_id`.', required: false, deprecated: true })
  @IsOptional()
  @IsUUID()
  zona_id?: string;

  /** @deprecated usar `zone_id`. El nombre de zona se resuelve a uuid en el service. */
  @ApiProperty({ description: 'DEPRECADO — usar `zone_id`. Nombre de zona; se resuelve a uuid.', required: false, deprecated: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  zona?: string;

  @ApiProperty({ description: 'Puesto del organigrama (identity.positions.code)', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  position_code?: string | null;

  /**
   * Sucursal base. NO se valida con regex: se valida **contra el catálogo**.
   * El `@Matches(/^[0-9]{2}$/)` de antes aceptaba `'99'` (forma correcta,
   * sucursal inexistente) y su texto decía `'00'..'05'` cuando ya hay 7.
   * Además, desde `[ID.3]` el default del rol es `own`, así que una sucursal
   * mal escrita no es un detalle cosmético: deja al usuario sin ver nada.
   */
  @ApiProperty({ description: "Sucursal base (commercial.warehouses.code de 2 dígitos). Se valida contra el catálogo.", required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  warehouse_code?: string;

  /**
   * `[ID.24.1]` Ruta de la persona (`trade.catalogs`, `catalog_id='rutas'`).
   *
   * Es el eje de las 31 personas de ruta, que hasta acá no tenían dónde
   * guardarlo: se les adivinaba por la zona, y `LA PIEDAD RD` tiene 6 rutas.
   * La zona **se deriva de acá** (ninguna ruta cruza de zona, verificado sobre
   * las 15 con tiendas cargadas), así que no hace falta preguntar las dos.
   */
  @ApiProperty({ description: 'Ruta de la persona (uuid de trade.catalogs, catalog_id=rutas). La zona se deriva de ella.', required: false })
  @IsOptional()
  @IsUUID()
  route_id?: string;

  @ApiProperty({ description: 'ID del supervisor (UUID)', required: false })
  @IsOptional()
  @IsUUID()
  supervisor_id?: string;

  /**
   * Áreas de gasto visibles. Estaba SOLO en el update sin razón: un alta que
   * necesitaba áreas requería crear y después editar.
   *
   * Nota de rumbo: esto es alcance de datos, o sea que su lugar definitivo es
   * `identity.user_scopes` dimensión `expense_area` (ADR-050). Sigue acá porque
   * `expense-proofs` todavía lee la columna; migra cuando ese dominio pase al
   * `ScopeService`.
   */
  @ApiProperty({
    description: 'IDs de áreas de gasto que el usuario puede ver (finance.expense_areas). Vacío = ninguna salvo FINANCE_EXPENSES_VER_ALL.',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  finance_expense_area_ids?: string[];

  // ── `[CH.1.10]` La cuenta de DISPOSITIVO ───────────────────────────────────
  // Estos tres campos existían en la base y NO en este DTO, así que
  // `ValidationPipe({ whitelist: true })` (`users.controller.ts:53`) los tiraba
  // sin error: el cliente mandaba un TTL, recibía 200 y el valor se perdía. Por
  // eso la única forma de poner un token largo era un INSERT por fuera de la app.

  /**
   * Vida del JWT de ESTA cuenta, en días. `null`/ausente = el default global
   * (`JWT_EXPIRES_IN`, hoy 12 h).
   *
   * Es para pantallas desatendidas (checador de asistencia, etiquetera,
   * verificador de precios de mostrador): se prenden una vez y se quedan
   * prendidas, y con 12 h alguien tiene que ir a teclear la contraseña cada
   * mañana. Lo que hace defendible la vida larga es que **no la hace
   * irrevocable**: `activo = false` mata el token en ≤30 s (`[AUTHZ-HARD.2]`) y
   * los permisos se releen de DB por request.
   *
   * El techo se **importa** de `platform-core`, no se re-declara: ya hay tres
   * copias del 3650 (el CHECK `users_token_ttl_days_rango`, el helper y esto), y
   * una cuarta escrita a mano sería la que divergiría, porque nada las compara.
   *
   * `@Type` es obligatorio: `transform: true` está pero `enableImplicitConversion`
   * no, así que sin esto un `"365"` de un cliente reventaría `@IsInt`.
   */
  @ApiProperty({
    description: `Vida del JWT de esta cuenta en días (1..${MAX_TOKEN_TTL_DAYS}). Omitir o null = default global (12h). Sólo para cuentas de dispositivo/kiosco.`,
    required: false,
    minimum: 1,
    maximum: MAX_TOKEN_TTL_DAYS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TOKEN_TTL_DAYS)
  token_ttl_days?: number | null;

  /**
   * Tipo de cuenta. Espejo del CHECK `users_kind_valido`; el vocabulario vive en
   * `@megadulces/contracts` para que el front y el back no lo escriban dos veces.
   *
   * `@ValidateIf` y NO `@IsOptional()` pelado: class-validator ignora todos los
   * validadores cuando el valor es `null`, y la columna es `NOT NULL` — un
   * `kind: null` pasaría el DTO y reventaría en la DB con un 23502, o sea un 500
   * en vez de un 400 legible.
   */
  @ApiProperty({
    description: `Tipo de cuenta: ${USER_KINDS.join(' | ')}. Los kioscos son 'interno' (servicio no tiene acceso interactivo).`,
    required: false,
    enum: USER_KINDS as unknown as string[],
  })
  @ValidateIf((o) => o.kind !== undefined)
  @IsIn(USER_KINDS as unknown as string[])
  kind?: UserKind;

  /**
   * `[ID.8]` — Fuerza cambio de contraseña en el próximo login.
   *
   * Vivía sólo en `UpdateUserDto`, y el alta lo tenía **hardcodeado en `true`**
   * (`users.service.ts`). Ése era el motivo real por el que dar de alta un kiosco
   * no se podía hacer por el endpoint: una pantalla compartida no puede exigir
   * cambio de contraseña — la primera persona la cambia y el kiosco queda afuera
   * (pasó: `20260908150000_etiqueteras_no_forzar_cambio.js`).
   *
   * Sube acá para que el alta lo pueda declarar, y el default sigue siendo `true`.
   * `false` está gateado por `assertDeviceCredential()`: sin `token_ttl_days` es 400.
   */
  @ApiProperty({
    description: 'Fuerza al usuario a cambiar su contraseña en el próximo login. Default true. Sólo se acepta false en cuentas de dispositivo (con token_ttl_days).',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;
}
