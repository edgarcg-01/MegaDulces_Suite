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
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TagModule } from 'primeng/tag';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TooltipModule } from 'primeng/tooltip';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import { AdminPlanogramaService } from './admin-planograma.service';
import { PermissionsService } from '../../../core/services/permissions.service';

interface Product {
  id: string;
  nombre: string;
  brand_id: string;
  activo?: boolean;
}

interface Brand {
  id: string;
  nombre: string;
  activo?: boolean;
  productos?: Product[];
  _highlight?: boolean;
}

@Component({
  selector: 'app-admin-planograma',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    DialogModule,
    ToastModule,
    TagModule,
    ConfirmDialogModule,
    IconFieldModule,
    InputIconModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-planograma.component.html',
  styleUrls: ['./admin-planograma.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPlanogramaComponent implements OnInit {
  private planogramaService = inject(AdminPlanogramaService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private perms = inject(PermissionsService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  brands = signal<Brand[]>([]);
  loading = signal<boolean>(false);
  saving = signal<boolean>(false);
  searchText = signal<string>('');
  showInactive = signal<boolean>(false);
  expandedRows = signal<Record<string, boolean>>({});

  // Diálogos como signals para integración con OnPush.
  showAddBrandDialog = signal<boolean>(false);
  showEditBrandDialog = signal<boolean>(false);
  showAddProductDialog = signal<boolean>(false);
  showEditProductDialog = signal<boolean>(false);

  // Forms (campos simples — los `ngModel` apuntan a propiedades regulares).
  selectedBrand: Brand | null = null;
  selectedProduct: Product | null = null;
  newBrandName = '';
  editBrandName = '';
  newProductName = '';
  editProductName = '';

  readonly canManage = this.perms.can$('manage', 'planograms');

  // Búsqueda debounceada — recomputar `filteredBrands` con un padrón grande
  // (muchas marcas × muchos productos) en cada keystroke es costoso.
  private debouncedSearch = toSignal(
    toObservable(this.searchText).pipe(
      debounceTime(250),
      distinctUntilChanged(),
    ),
    { initialValue: '' },
  );

  filteredBrands = computed(() => {
    const query = this.debouncedSearch().toLowerCase().trim();
    const list = this.brands();
    if (!query) return list;

    return list
      .map((brand) => {
        const matchBrand = (brand.nombre ?? '').toLowerCase().includes(query);
        const filteredProducts = (brand.productos || []).filter((p) =>
          (p.nombre ?? '').toLowerCase().includes(query),
        );

        if (matchBrand || filteredProducts.length > 0) {
          return {
            ...brand,
            productos: matchBrand ? brand.productos : filteredProducts,
            _highlight: matchBrand,
          } as Brand;
        }
        return null;
      })
      .filter((b): b is Brand => b !== null);
  });

  ngOnInit(): void {
    if (!this.perms.can('read', 'planograms')) {
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

    this.loadBrands();
  }

  onSearchChange(value: string): void {
    this.searchText.set(value);
  }

  toggleShowInactive(value: boolean): void {
    this.showInactive.set(value);
    this.loadBrands();
  }

  isRowExpanded(brandId: string): boolean {
    return this.expandedRows()[brandId] || false;
  }

  toggleRowExpansion(brand: Brand): void {
    this.expandedRows.update((current) => ({
      ...current,
      [brand.id]: !current[brand.id],
    }));
  }

  loadBrands(): void {
    this.loading.set(true);
    this.planogramaService
      .getBrands(this.showInactive())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data: Brand[]) => {
          // Orden alfabético: marcas, y productos dentro de cada marca.
          const sorted = [...data].sort((a, b) =>
            (a.nombre ?? '').localeCompare(b.nombre ?? ''),
          );
          sorted.forEach((brand) => {
            if (Array.isArray(brand.productos)) {
              brand.productos = [...brand.productos].sort((a, b) =>
                (a.nombre ?? '').localeCompare(b.nombre ?? ''),
              );
            }
          });
          this.brands.set(sorted);
          this.loading.set(false);
        },
        error: () => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar las marcas.',
          });
          this.loading.set(false);
        },
      });
  }

  // --- Brand Actions ---

  openAddBrand(): void {
    this.newBrandName = '';
    this.showAddBrandDialog.set(true);
  }

  closeAddBrand(): void {
    this.showAddBrandDialog.set(false);
  }

  createBrand(): void {
    if (this.saving() || !this.newBrandName.trim()) return;
    this.saving.set(true);

    this.planogramaService
      .createBrand({ nombre: this.newBrandName.trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail: 'Marca creada correctamente.',
          });
          this.loadBrands();
          this.showAddBrandDialog.set(false);
          this.newBrandName = '';
        },
        error: (err: any) => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo crear la marca.',
          });
        },
      });
  }

  openEditBrand(brand: Brand): void {
    this.selectedBrand = brand;
    this.editBrandName = brand.nombre;
    this.showEditBrandDialog.set(true);
  }

  closeEditBrand(): void {
    this.showEditBrandDialog.set(false);
  }

  updateBrand(): void {
    if (this.saving() || !this.editBrandName.trim() || !this.selectedBrand)
      return;
    this.saving.set(true);

    this.planogramaService
      .updateBrand(this.selectedBrand.id, { nombre: this.editBrandName.trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail: 'Marca actualizada.',
          });
          this.loadBrands();
          this.showEditBrandDialog.set(false);
        },
        error: (err: any) => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo actualizar la marca.',
          });
        },
      });
  }

  deleteBrand(id: string): void {
    this.confirmationService.confirm({
      message:
        '¿Estás seguro de eliminar esta marca? Se borrarán también sus productos. Si la marca o sus productos están en capturas, se marcará como inactiva en su lugar.',
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.executeDeleteBrand(id),
    });
  }

  private executeDeleteBrand(id: string): void {
    this.planogramaService
      .deleteBrand(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response: any) => {
          if (response?.soft_deleted) {
            this.messageService.add({
              severity: 'info',
              summary: 'Marcada como inactiva',
              detail:
                response.message ||
                'La marca quedó inactiva para preservar el historial.',
              life: 6000,
            });
          } else {
            this.messageService.add({
              severity: 'success',
              summary: 'Eliminada',
              detail: 'Marca eliminada correctamente.',
            });
          }
          this.loadBrands();
        },
        error: (err: any) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo eliminar la marca.',
          });
        },
      });
  }

  reactivateBrand(brand: Brand): void {
    this.planogramaService
      .updateBrand(brand.id, { activo: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.messageService.add({
            severity: 'success',
            summary: 'Reactivada',
            detail: `Marca "${brand.nombre}" volvió a estar activa.`,
          });
          this.loadBrands();
        },
        error: (err: any) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo reactivar la marca.',
          });
        },
      });
  }

  // --- Product Actions ---

  openAddProduct(brand: Brand): void {
    this.selectedBrand = brand;
    this.newProductName = '';
    this.showAddProductDialog.set(true);
  }

  closeAddProduct(): void {
    this.showAddProductDialog.set(false);
  }

  addProduct(): void {
    if (this.saving() || !this.newProductName.trim() || !this.selectedBrand)
      return;
    this.saving.set(true);

    this.planogramaService
      .addProduct(this.selectedBrand.id, { nombre: this.newProductName.trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail: 'Producto agregado.',
          });
          this.loadBrands();
          this.showAddProductDialog.set(false);
        },
        error: (err: any) => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo agregar el producto.',
          });
        },
      });
  }

  openEditProduct(product: Product): void {
    this.selectedProduct = product;
    this.editProductName = product.nombre;
    this.showEditProductDialog.set(true);
  }

  closeEditProduct(): void {
    this.showEditProductDialog.set(false);
  }

  updateProduct(): void {
    if (this.saving() || !this.editProductName.trim() || !this.selectedProduct)
      return;
    this.saving.set(true);

    this.planogramaService
      .updateProduct(this.selectedProduct.id, {
        nombre: this.editProductName.trim(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'success',
            summary: 'Éxito',
            detail: 'Producto actualizado.',
          });
          this.loadBrands();
          this.showEditProductDialog.set(false);
        },
        error: (err: any) => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo actualizar el producto.',
          });
        },
      });
  }

  deleteProduct(id: string): void {
    this.confirmationService.confirm({
      message:
        '¿Estás seguro de eliminar este producto? Si está en capturas, se marcará como inactivo en su lugar.',
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.executeDeleteProduct(id),
    });
  }

  private executeDeleteProduct(id: string): void {
    this.planogramaService
      .deleteProduct(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response: any) => {
          if (response?.soft_deleted) {
            this.messageService.add({
              severity: 'info',
              summary: 'Marcado como inactivo',
              detail:
                response.message ||
                'El producto quedó inactivo para preservar el historial.',
              life: 6000,
            });
          } else {
            this.messageService.add({
              severity: 'success',
              summary: 'Eliminado',
              detail: 'Producto eliminado.',
            });
          }
          this.loadBrands();
        },
        error: (err: any) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err?.error?.message || 'No se pudo eliminar el producto.',
          });
        },
      });
  }

  reactivateProduct(product: Product): void {
    this.planogramaService
      .updateProduct(product.id, { activo: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.messageService.add({
            severity: 'success',
            summary: 'Reactivado',
            detail: `Producto "${product.nombre}" volvió a estar activo.`,
          });
          this.loadBrands();
        },
        error: (err: any) => {
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail:
              err?.error?.message || 'No se pudo reactivar el producto.',
          });
        },
      });
  }
}
