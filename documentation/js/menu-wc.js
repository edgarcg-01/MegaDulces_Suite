'use strict';

customElements.define('compodoc-menu', class extends HTMLElement {
    constructor() {
        super();
        this.isNormalMode = this.getAttribute('mode') === 'normal';
    }

    connectedCallback() {
        this.render(this.isNormalMode);
    }

    render(isNormalMode) {
        let tp = lithtml.html(`
        <nav>
            <ul class="list">
                <li class="title">
                    <a href="index.html" data-type="index-link">trade-marketing-monorepo documentation</a>
                </li>

                <li class="divider"></li>
                ${ isNormalMode ? `<div id="book-search-input" role="search"><input type="text" placeholder="Type to search"></div>` : '' }
                <li class="chapter">
                    <a data-type="chapter-link" href="index.html"><span class="icon ion-ios-home"></span>Getting started</a>
                    <ul class="links">
                                <li class="link">
                                    <a href="overview.html" data-type="chapter-link">
                                        <span class="icon ion-ios-keypad"></span>Overview
                                    </a>
                                </li>

                            <li class="link">
                                <a href="index.html" data-type="chapter-link">
                                    <span class="icon ion-ios-paper"></span>
                                        README
                                </a>
                            </li>
                                <li class="link">
                                    <a href="dependencies.html" data-type="chapter-link">
                                        <span class="icon ion-ios-list"></span>Dependencies
                                    </a>
                                </li>
                                <li class="link">
                                    <a href="properties.html" data-type="chapter-link">
                                        <span class="icon ion-ios-apps"></span>Properties
                                    </a>
                                </li>

                    </ul>
                </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#components-links"' :
                            'data-bs-target="#xs-components-links"' }>
                            <span class="icon ion-md-cog"></span>
                            <span>Components</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? 'id="components-links"' : 'id="xs-components-links"' }>
                            <li class="link">
                                <a href="components/AdminCatalogsComponent.html" data-type="entity-link" >AdminCatalogsComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/AdminPlanogramaComponent.html" data-type="entity-link" >AdminPlanogramaComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/AdminRolesPermissionsComponent.html" data-type="entity-link" >AdminRolesPermissionsComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/AdminScoringComponent.html" data-type="entity-link" >AdminScoringComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/AdminUsersComponent.html" data-type="entity-link" >AdminUsersComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/AppComponent.html" data-type="entity-link" >AppComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/CapturesComponent.html" data-type="entity-link" >CapturesComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/DailyAssignmentsComponent.html" data-type="entity-link" >DailyAssignmentsComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/DashboardComponent.html" data-type="entity-link" >DashboardComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/ExhibitionsComponent.html" data-type="entity-link" >ExhibitionsComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/GlobalFiltersComponent.html" data-type="entity-link" >GlobalFiltersComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/HomeComponent.html" data-type="entity-link" >HomeComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/LayoutComponent.html" data-type="entity-link" >LayoutComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/LoginComponent.html" data-type="entity-link" >LoginComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/OfflineStatusComponent.html" data-type="entity-link" >OfflineStatusComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/ProjectsComponent.html" data-type="entity-link" >ProjectsComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/ReportsComponent.html" data-type="entity-link" >ReportsComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/ReportsComponent-1.html" data-type="entity-link" >ReportsComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/StoresComponent.html" data-type="entity-link" >StoresComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/VisitsComponent.html" data-type="entity-link" >VisitsComponent</a>
                            </li>
                        </ul>
                    </li>
                        <li class="chapter">
                            <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#directives-links"' :
                                'data-bs-target="#xs-directives-links"' }>
                                <span class="icon ion-md-code-working"></span>
                                <span>Directives</span>
                                <span class="icon ion-ios-arrow-down"></span>
                            </div>
                            <ul class="links collapse " ${ isNormalMode ? 'id="directives-links"' : 'id="xs-directives-links"' }>
                                <li class="link">
                                    <a href="directives/HlmBadgeDirective.html" data-type="entity-link" >HlmBadgeDirective</a>
                                </li>
                                <li class="link">
                                    <a href="directives/HlmButtonDirective.html" data-type="entity-link" >HlmButtonDirective</a>
                                </li>
                                <li class="link">
                                    <a href="directives/HlmInputDirective.html" data-type="entity-link" >HlmInputDirective</a>
                                </li>
                                <li class="link">
                                    <a href="directives/HlmLabelDirective.html" data-type="entity-link" >HlmLabelDirective</a>
                                </li>
                            </ul>
                        </li>
                        <li class="chapter">
                            <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#injectables-links"' :
                                'data-bs-target="#xs-injectables-links"' }>
                                <span class="icon ion-md-arrow-round-down"></span>
                                <span>Injectables</span>
                                <span class="icon ion-ios-arrow-down"></span>
                            </div>
                            <ul class="links collapse " ${ isNormalMode ? 'id="injectables-links"' : 'id="xs-injectables-links"' }>
                                <li class="link">
                                    <a href="injectables/AdminCatalogsService.html" data-type="entity-link" >AdminCatalogsService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/AdminPlanogramaService.html" data-type="entity-link" >AdminPlanogramaService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/AdminScoringService.html" data-type="entity-link" >AdminScoringService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/AuthService.html" data-type="entity-link" >AuthService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/DailyCaptureService.html" data-type="entity-link" >DailyCaptureService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/DashboardService.html" data-type="entity-link" >DashboardService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/DataUpdateService.html" data-type="entity-link" >DataUpdateService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/FiltersStateService.html" data-type="entity-link" >FiltersStateService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/GeoValidationService.html" data-type="entity-link" >GeoValidationService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/MetasConfigService.html" data-type="entity-link" >MetasConfigService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/OfflineDailyCaptureService.html" data-type="entity-link" >OfflineDailyCaptureService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/OfflineDatabaseService.html" data-type="entity-link" >OfflineDatabaseService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/OfflineSyncService.html" data-type="entity-link" >OfflineSyncService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/PwaInstallService.html" data-type="entity-link" >PwaInstallService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/ReportsService.html" data-type="entity-link" >ReportsService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/RetryStrategyService.html" data-type="entity-link" >RetryStrategyService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/ThemeService.html" data-type="entity-link" >ThemeService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/UsersService.html" data-type="entity-link" >UsersService</a>
                                </li>
                            </ul>
                        </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#interfaces-links"' :
                            'data-bs-target="#xs-interfaces-links"' }>
                            <span class="icon ion-md-information-circle-outline"></span>
                            <span>Interfaces</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? ' id="interfaces-links"' : 'id="xs-interfaces-links"' }>
                            <li class="link">
                                <a href="interfaces/BeforeInstallPromptEvent.html" data-type="entity-link" >BeforeInstallPromptEvent</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BrandGroup.html" data-type="entity-link" >BrandGroup</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/CatalogoOffline.html" data-type="entity-link" >CatalogoOffline</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/ConceptoExhibicion.html" data-type="entity-link" >ConceptoExhibicion</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Coordenada.html" data-type="entity-link" >Coordenada</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/DashboardData.html" data-type="entity-link" >DashboardData</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/DayGroup.html" data-type="entity-link" >DayGroup</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/DayGroup-1.html" data-type="entity-link" >DayGroup</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/DropOption.html" data-type="entity-link" >DropOption</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/FiltersState.html" data-type="entity-link" >FiltersState</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/FurnitureMeta.html" data-type="entity-link" >FurnitureMeta</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/GeoValidationResult.html" data-type="entity-link" >GeoValidationResult</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/KpiCard.html" data-type="entity-link" >KpiCard</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/KpiRange.html" data-type="entity-link" >KpiRange</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/NetworkStatus.html" data-type="entity-link" >NetworkStatus</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/PdfSection.html" data-type="entity-link" >PdfSection</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/PdfSection-1.html" data-type="entity-link" >PdfSection</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/PermissionRow.html" data-type="entity-link" >PermissionRow</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/ProductoItem.html" data-type="entity-link" >ProductoItem</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/RegistroExhibicion.html" data-type="entity-link" >RegistroExhibicion</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/ReportsData.html" data-type="entity-link" >ReportsData</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/RetryConfig.html" data-type="entity-link" >RetryConfig</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/SyncLog.html" data-type="entity-link" >SyncLog</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/SyncResult.html" data-type="entity-link" >SyncResult</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/SyncStatus.html" data-type="entity-link" >SyncStatus</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/TiendaOffline.html" data-type="entity-link" >TiendaOffline</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/UbicacionExhibicion.html" data-type="entity-link" >UbicacionExhibicion</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/UpdateNotification.html" data-type="entity-link" >UpdateNotification</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/User.html" data-type="entity-link" >User</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/VisitaPendiente.html" data-type="entity-link" >VisitaPendiente</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/VisitaSnapshot.html" data-type="entity-link" >VisitaSnapshot</a>
                            </li>
                        </ul>
                    </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#miscellaneous-links"'
                            : 'data-bs-target="#xs-miscellaneous-links"' }>
                            <span class="icon ion-ios-cube"></span>
                            <span>Miscellaneous</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? 'id="miscellaneous-links"' : 'id="xs-miscellaneous-links"' }>
                            <li class="link">
                                <a href="miscellaneous/enumerations.html" data-type="entity-link">Enums</a>
                            </li>
                            <li class="link">
                                <a href="miscellaneous/typealiases.html" data-type="entity-link">Type aliases</a>
                            </li>
                            <li class="link">
                                <a href="miscellaneous/variables.html" data-type="entity-link">Variables</a>
                            </li>
                        </ul>
                    </li>
                        <li class="chapter">
                            <a data-type="chapter-link" href="routes.html"><span class="icon ion-ios-git-branch"></span>Routes</a>
                        </li>
                    <li class="chapter">
                        <a data-type="chapter-link" href="coverage.html"><span class="icon ion-ios-stats"></span>Documentation coverage</a>
                    </li>
            </ul>
        </nav>
        `);
        this.innerHTML = tp.strings;
    }
});