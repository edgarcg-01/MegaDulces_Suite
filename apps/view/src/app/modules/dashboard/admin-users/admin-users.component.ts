import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
  FormBuilder,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { InputSwitchModule } from 'primeng/inputswitch';
import { ToastModule } from 'primeng/toast';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import {
  UsersService,
  User,
  UserCreatePayload,
  UserUpdatePayload,
  SupervisorOption as SupervisorRow,
  ZoneOption as ZoneRow,
} from './users.service';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

interface RoleOption {
  label: string;
  value: string;
}

interface SupervisorOption {
  label: string;
  value: string;
}

interface ZoneOption {
  label: string;
  value: string;
  id: string;
}

@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TableModule,
    ButtonModule,
    TagModule,
    DialogModule,
    InputTextModule,
    SelectModule,
    InputSwitchModule,
    ToastModule,
    ConfirmDialogModule,
    IconFieldModule,
    InputIconModule,
    FormsModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-users.component.html',
  styleUrls: ['./admin-users.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUsersComponent implements OnInit {
  private usersService = inject(UsersService);
  private catalogsService = inject(AdminCatalogsService);
  private fb = inject(FormBuilder);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  users = signal<User[]>([]);
  loading = signal<boolean>(true);
  displayDialog = signal<boolean>(false);
  isEditing = signal<boolean>(false);
  currentUserId = signal<string | null>(null);
  searchText = signal<string>('');
  saving = signal<boolean>(false);

  // Permisos para gating de botones de write
  readonly canManageUsers = this.perms.can$('manage', 'users');

  // Búsqueda debounceada (250 ms) para no recomputar `filteredUsers` en cada
  // keystroke cuando el padrón crece.
  private debouncedSearch = toSignal(
    toObservable(this.searchText).pipe(
      debounceTime(250),
      distinctUntilChanged(),
    ),
    { initialValue: '' },
  );

  filteredUsers = computed(() => {
    const query = this.debouncedSearch().toLowerCase().trim();
    if (!query) return this.users();

    return this.users().filter((user) => {
      const username = (user.username ?? '').toLowerCase();
      const nombre = (user.nombre ?? '').toLowerCase();
      const role = (user.role_name ?? '').toLowerCase();
      const zona = (user.zona ?? '').toLowerCase();
      return (
        username.includes(query) ||
        nombre.includes(query) ||
        role.includes(query) ||
        zona.includes(query)
      );
    });
  });

  userForm: FormGroup;

  roles = signal<RoleOption[]>([]);
  supervisors = signal<SupervisorOption[]>([]);
  zones = signal<ZoneOption[]>([]);

  // Roles que el usuario actual puede asignar (oculta superadmin si no lo es).
  readonly assignableRoles = computed(() => {
    const isSuperadmin = this.authService.user()?.role_name === 'superadmin';
    return this.roles().filter(
      (r) => isSuperadmin || r.value.toLowerCase() !== 'superadmin',
    );
  });

  constructor() {
    this.userForm = this.fb.group({
      username: ['', Validators.required],
      password: [''],
      nombre: [''],
      zona: [''],
      zona_id: [''],
      role_name: ['', Validators.required],
      supervisor_id: [null],
      activo: [true],
    });

    this.userForm
      .get('role_name')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((role) => {
        const supervisorControl = this.userForm.get('supervisor_id');
        if (role === 'colaborador') {
          supervisorControl?.setValidators([Validators.required]);
        } else {
          supervisorControl?.clearValidators();
          supervisorControl?.setValue(null);
        }
        supervisorControl?.updateValueAndValidity();
      });

    // Al cambiar la zona por nombre, resolver y guardar zona_id.
    this.userForm
      .get('zona')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((zonaName) => {
        if (zonaName) {
          const selectedZone = this.zones().find((z) => z.value === zonaName);
          this.userForm
            .get('zona_id')
            ?.setValue(selectedZone ? selectedZone.id : null);
        } else {
          this.userForm.get('zona_id')?.setValue(null);
        }
      });
  }

  ngOnInit(): void {
    if (!this.perms.can('read', 'users')) {
      if (
        this.perms.can('read', 'reports_team') ||
        this.perms.can('read', 'reports_global')
      ) {
        this.router.navigate(['/dashboard']);
      } else {
        this.router.navigate(['/dashboard/captures']);
      }
      return;
    }

    this.loadRoles();
    this.loadUsers();
    this.loadSupervisors();
    this.loadZones();
  }

  onSearchChange(value: string): void {
    this.searchText.set(value);
  }

  loadZones(): void {
    this.usersService
      .getZones()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data: ZoneRow[]) => {
          this.zones.set(
            data.map((z) => ({ label: z.value, value: z.value, id: z.id })),
          );
        },
        error: () => this.zones.set([]),
      });
  }

  loadRoles(): void {
    this.catalogsService
      .getCatalog('roles')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data: { value: string }[]) => {
          this.roles.set(
            data.map((item) => ({
              label: item.value.charAt(0).toUpperCase() + item.value.slice(1),
              value: item.value,
            })),
          );
        },
        error: () => this.roles.set([]),
      });
  }

  loadSupervisors(): void {
    this.usersService
      .getSupervisors()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data: SupervisorRow[]) => {
          this.supervisors.set(
            data.map((s) => ({
              label: s.nombre || s.username,
              value: s.id,
            })),
          );
        },
        error: () => this.supervisors.set([]),
      });
  }

  loadUsers(): void {
    this.loading.set(true);
    this.usersService
      .findAll()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          this.users.set(data);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudo cargar el padrón.',
          });
        },
      });
  }

  openNewDialog(): void {
    this.isEditing.set(false);
    this.currentUserId.set(null);
    this.userForm.reset({ activo: true, role_name: '' });
    this.userForm.get('username')?.enable();
    this.userForm
      .get('password')
      ?.setValidators([Validators.required, Validators.minLength(6)]);
    this.userForm.get('password')?.updateValueAndValidity();
    this.displayDialog.set(true);
  }

  openEditDialog(user: User): void {
    this.isEditing.set(true);
    this.currentUserId.set(user.id);
    this.userForm.get('username')?.enable();
    this.userForm.get('password')?.clearValidators();
    this.userForm.get('password')?.setValidators([Validators.minLength(6)]);
    this.userForm.get('password')?.updateValueAndValidity();

    this.userForm.patchValue({
      username: user.username,
      password: '',
      nombre: user.nombre,
      zona: user.zona,
      zona_id: user.zona_id,
      role_name: user.role_name,
      supervisor_id: user.supervisor_id,
      activo: user.activo,
    });

    this.displayDialog.set(true);
  }

  closeDialog(): void {
    this.displayDialog.set(false);
  }

  saveUser(): void {
    if (this.userForm.invalid || this.saving()) return;
    const formData = this.userForm.getRawValue();

    if (formData.role_name) {
      formData.role_name = formData.role_name.toLowerCase();
    }

    this.saving.set(true);

    if (this.isEditing() && this.currentUserId()) {
      const updateData: UserUpdatePayload = { ...formData };
      if (!updateData.password || updateData.password.trim() === '') {
        delete updateData.password;
      }
      this.usersService
        .update(this.currentUserId()!, updateData)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            this.saving.set(false);
            this.displayDialog.set(false);
            this.loadUsers();
            this.messageService.add({
              severity: 'success',
              summary: 'Éxito',
              detail: 'Usuario actualizado correctamente.',
            });
          },
          error: (err: { error?: { message?: string } }) => {
            this.saving.set(false);
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: err?.error?.message || 'Error al actualizar usuario.',
            });
          },
        });
    } else {
      const createData: UserCreatePayload = { ...formData };
      this.usersService
        .create(createData)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            this.saving.set(false);
            this.displayDialog.set(false);
            this.loadUsers();
            this.messageService.add({
              severity: 'success',
              summary: 'Éxito',
              detail: 'Usuario creado correctamente.',
            });
          },
          error: (err: { error?: { message?: string } }) => {
            this.saving.set(false);
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: err?.error?.message || 'Error al crear usuario.',
            });
          },
        });
    }
  }

  deleteUser(user: User): void {
    if (!user.id) return;

    const userName = user.nombre || user.username;
    this.confirmationService.confirm({
      message: `¿Estás seguro de eliminar el usuario "${userName}"? Esta acción desactivará el usuario.`,
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.executeDelete(user.id),
    });
  }

  private executeDelete(id: string): void {
    this.usersService
      .remove(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.loadUsers();
          this.messageService.add({
            severity: 'success',
            summary: 'Eliminado',
            detail: 'Usuario desactivado correctamente.',
          });
        },
        error: (err: { error?: { message?: string } }) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo eliminar el usuario.',
          });
        },
      });
  }

  getSupervisorName(id: string | undefined): string {
    if (!id) return 'N/A';
    const s = this.supervisors().find((x) => x.value === id);
    return s ? s.label : 'N/A';
  }
}
