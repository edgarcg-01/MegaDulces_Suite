import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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
}
