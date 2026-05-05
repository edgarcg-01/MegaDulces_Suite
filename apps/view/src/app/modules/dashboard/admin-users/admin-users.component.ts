import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
  FormBuilder,
  FormGroup,
  Validators,
  ReactiveFormsModule,
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
import { UsersService, User } from './users.service';
import { AdminCatalogsService } from '../admin-catalogs/admin-catalogs.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

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
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-users.component.html',
  styleUrls: ['./admin-users.component.css'],
})
export class AdminUsersComponent implements OnInit {
  private usersService = inject(UsersService);
  private catalogsService = inject(AdminCatalogsService);
  private fb = inject(FormBuilder);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private authService = inject(AuthService);
  private router = inject(Router);

  users = signal<User[]>([]);
  loading = signal<boolean>(true);
  displayDialog = signal<boolean>(false);
  isEditing = signal<boolean>(false);
  currentUserId = signal<string | null>(null);

  userForm: FormGroup;

  roles = signal<{ label: string; value: string }[]>([]);
  supervisors = signal<{ label: string; value: string }[]>([]);
  zones = signal<{ label: string; value: string; id: string }[]>([]);

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

    this.userForm.get('role_name')?.valueChanges.subscribe((role) => {
      const supervisorControl = this.userForm.get('supervisor_id');
      if (role === 'colaborador') {
        supervisorControl?.setValidators([Validators.required]);
      } else {
        supervisorControl?.clearValidators();
        supervisorControl?.setValue(null);
      }
      supervisorControl?.updateValueAndValidity();
    });

    // Listen to zona changes to update zona_id automatically
    this.userForm.get('zona')?.valueChanges.subscribe((zonaName) => {
      if (zonaName) {
        const selectedZone = this.zones().find(z => z.value === zonaName);
        if (selectedZone) {
          console.log('[AdminUsers] Zone selected:', selectedZone);
          this.userForm.get('zona_id')?.setValue(selectedZone.id);
        }
      } else {
        this.userForm.get('zona_id')?.setValue(null);
      }
    });
  }

  ngOnInit(): void {
    // Verificar permisos antes de cargar datos
    if (!this.authService.hasPermission(Permission.USUARIOS_GESTIONAR)) {
      // Redirigir según el rol
      const user = this.authService.user();
      if (user?.role_name === 'colaborador') {
        this.router.navigate(['/dashboard/captures']);
      } else {
        this.router.navigate(['/dashboard']);
      }
      return;
    }
    
    this.loadRoles();
    this.loadUsers();
    this.loadSupervisors();
    this.loadZones();
  }

  loadZones(): void {
    this.usersService.getZones().subscribe({
      next: (data: any[]) => {
        console.log('[loadZones] Zonas recibidas del backend:', data);
        const mappedZones = data.map((z) => ({
          label: z.value,
          value: z.value,
          id: z.id, // Include zone ID
        }));
        console.log('[loadZones] Zonas mapeadas:', mappedZones);
        this.zones.set(mappedZones);
      },
      error: (err) => console.error('Error al cargar zonas', err),
    });
  }

  loadRoles(): void {
    this.catalogsService.getCatalog('roles').subscribe({
      next: (data: any[]) => {
        const mappedRoles = data.map((item) => ({
          label: item.value.charAt(0).toUpperCase() + item.value.slice(1),
          value: item.value,
        }));
        this.roles.set(mappedRoles);
      },
      error: (err) => console.error('Error al cargar roles', err),
    });
  }

  loadSupervisors(): void {
    this.usersService.getSupervisors().subscribe({
      next: (data: any[]) => {
        const mappedSupers = data.map((s) => ({
          label: s.nombre || s.username,
          value: s.id
        }));
        this.supervisors.set(mappedSupers);
      },
      error: (err) => console.error('Error al cargar supervisores', err),
    });
  }

  loadUsers(): void {
    this.loading.set(true);
    this.usersService.findAll().subscribe({
      next: (data) => {
        this.users.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Error al cargar usuarios', err);
        this.loading.set(false);
      },
    });
  }

  openNewDialog(): void {
    this.isEditing.set(false);
    this.currentUserId.set(null);
    this.userForm.reset({ activo: true, role_name: '' });
    this.userForm.get('username')?.enable();
    this.userForm.get('password')?.setValidators([Validators.required, Validators.minLength(6)]);
    this.userForm.get('password')?.updateValueAndValidity();
    this.displayDialog.set(true);
  }

  openEditDialog(user: User): void {
    this.isEditing.set(true);
    this.currentUserId.set(user.id);
    this.userForm.get('username')?.disable();
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
    
    console.log('[AdminUsers] Editing user with zona_id:', user.zona_id);

    this.displayDialog.set(true);
  }

  saveUser(): void {
    if (this.userForm.invalid) return;
    const formData = this.userForm.getRawValue();

    // Normalize role_name to lowercase to match role_permissions
    if (formData.role_name) {
      formData.role_name = formData.role_name.toLowerCase();
    }
    
    console.log('[AdminUsers] Saving user with data:', formData);
    console.log('[AdminUsers] zona_id being sent:', formData.zona_id);

    if (this.isEditing() && this.currentUserId()) {
      const { username, ...updateData } = formData;
      if (!updateData.password || updateData.password.trim() === '') {
        delete updateData.password;
      }
      this.usersService.update(this.currentUserId()!, updateData).subscribe({
        next: () => {
          this.displayDialog.set(false);
          this.loadUsers();
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail: 'Usuario actualizado correctamente',
          });
        },
        error: (err) => {
          console.error('Error actualizando', err);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'Error al actualizar usuario',
          });
        },
      });
    } else {
      this.usersService.create(formData).subscribe({
        next: () => {
          this.displayDialog.set(false);
          this.loadUsers();
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail: 'Usuario creado correctamente',
          });
        },
        error: (err) => {
          console.error('Error creando', err);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'Error al crear usuario',
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
      accept: () => {
        this.executeDelete(user.id);
      },
      reject: () => {
        this.messageService.add({
          severity: 'info',
          summary: 'Cancelado',
          detail: 'Eliminación cancelada.',
        });
      }
    });
  }

  private executeDelete(id: string): void {
    this.usersService.remove(id).subscribe({
      next: () => {
        this.loadUsers();
        this.messageService.add({
          severity: 'success',
          summary: 'Eliminado',
          detail: 'Usuario desactivado correctamente',
        });
      },
      error: (err: any) => {
        const errorMsg = err?.error?.message || 'No se pudo eliminar el usuario.';
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: errorMsg,
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
