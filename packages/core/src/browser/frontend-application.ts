// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { inject, injectable, named } from 'inversify';
import { ContributionProvider, CommandRegistry, MenuModelRegistry, isOSX, BackendStopwatch, LogLevel, Stopwatch } from '../common';
import { MaybePromise } from '../common/types';
import { KeybindingRegistry } from './keybinding';
import { Widget } from './widgets';
import { ApplicationShell } from './shell/application-shell';
import { ShellLayoutRestorer, ApplicationShellLayoutMigrationError } from './shell/shell-layout-restorer';
import { FrontendApplicationStateService } from './frontend-application-state';
import { preventNavigation, parseCssTime, animationFrame } from './browser';
import { CorePreferences } from './core-preferences';
import { WindowService } from './window/window-service';
import { TooltipService } from './tooltip-service';
import { FrontendApplicationContribution } from './frontend-application-contribution';

const TIMER_WARNING_THRESHOLD = 100;

@injectable()
export class FrontendApplication {

    @inject(CorePreferences)
    protected readonly corePreferences: CorePreferences;

    @inject(WindowService)
    protected readonly windowsService: WindowService;

    @inject(TooltipService)
    protected readonly tooltipService: TooltipService;

    @inject(Stopwatch)
    protected readonly stopwatch: Stopwatch;

    @inject(BackendStopwatch)
    protected readonly backendStopwatch: BackendStopwatch;

    constructor(
        @inject(CommandRegistry) protected readonly commands: CommandRegistry,
        @inject(MenuModelRegistry) protected readonly menus: MenuModelRegistry,
        @inject(KeybindingRegistry) protected readonly keybindings: KeybindingRegistry,
        @inject(ShellLayoutRestorer) protected readonly layoutRestorer: ShellLayoutRestorer,
        @inject(ContributionProvider) @named(FrontendApplicationContribution)
        protected readonly contributions: ContributionProvider<FrontendApplicationContribution>,
        @inject(ApplicationShell) protected readonly _shell: ApplicationShell,
        @inject(FrontendApplicationStateService) protected readonly stateService: FrontendApplicationStateService
    ) { }

    get shell(): ApplicationShell {
        return this._shell;
    }

    /**
     * Start the frontend application.
     *
     * Start up consists of the following steps:
     * - start frontend contributions
     * - attach the application shell to the host element
     * - initialize the application shell layout
     * - reveal the application shell if it was hidden by a startup indicator
     */
    async start(): Promise<void> {
        // 启动前端应用程序计时器
        const startup = this.backendStopwatch.start('frontend');

        const contributions = this.contributions.getContributions()
        console.log(`\x1b[1;3;30;43m%s\x1b[0m`, `\n FrontendApplication当前有${contributions.length}个可用的Contribution `, ` [/Users/work/Third-Projects/theia/packages/core/src/node/backend-application.ts:226]\n`);
        console.table(contributions.map(contribution => {
            const Contribution = contribution.constructor as any
            const methods = [];
            if (Contribution.prototype.initialize) methods.push('initialize');
            if (Contribution.prototype.configure) methods.push('configure');
            if (Contribution.prototype.onStart) methods.push('onStart');
            return {
                "FrontendApplication Contribution": Contribution.name,
                File: Contribution.file,
                Method: methods.join(" | ")
            }
        }).sort((a, b) => {
            if (a.Method === '' && b.Method === '') return 0;
            if (a.Method === '') return 1;
            if (b.Method === '') return -1;
            const order = ['initialize', 'configure', 'onStart'];
            const aIndex = order.indexOf(a.Method.split(' | ')[0]);
            const bIndex = order.indexOf(b.Method.split(' | ')[0]);
            return aIndex - bIndex;
        }))

        // 将所有frontend application contributions初始化
        await this.initializeContributions()
        await this.configureContributions()
        await this.startContributions()
        // 等待所有frontend application contributions初始化完成
        // 然后将stateService的state设置为started_contributions，标记为frontend application contributions初始化完成
        this.stateService.state = 'started_contributions';

        // 获取前端应用要挂载的DOM元素，其实就是document.body
        const host = await this.getHost();
        // 将应用程序 shell 附加到 host 元素。如果存在启动指示器，则将 shell 插入到该指示器之前，以便它尚不可见。
        this.attachShell(host);
        // 将工具提示容器附加到 host 元素
        this.attachTooltip(host);

        // 如果没有提供参数，则在下一个动画帧后解析，或者在给定的动画帧数后解析。
        await animationFrame();
        // 等待浏览器刷新屏幕一次，然后将stateService的state设置为attached_shell，标记为应用程序shell已附加到DOM
        this.stateService.state = 'attached_shell';

        // 初始化应用程序 shell 布局，要么使用布局恢复服务，要么创建默认布局。
        // 而默认布局的创建是通过让FrontendApplication的Contributions依次初始化 shell 布局开始的。
        // 用户可以重写此方法以创建特定于应用程序的自定义布局。
        await this.measure('initializeLayout', () => this.initializeLayout(), 'Initialize the workbench layout', false);
        // 等待所有shell布局初始化完成，然后将stateService的state设置为initialized_layout，标记为应用程序shell布局初始化完成
        this.stateService.state = 'initialized_layout';
        // 派发所有frontend application contributions的onDidInitializeLayout事件
        await this.fireOnDidInitializeLayout();

        // 如果存在启动指示器，则首先使用 theia-hidden CSS 类将其隐藏，然后在一段时间后将其移除。
        // 移除的延迟时间取自 CSS 过渡持续时间。
        await this.measure('revealShell', () => this.revealShell(host), 'Replace loading indicator with ready workbench UI (animation)', false);
        // 注册全局事件监听器
        this.registerEventListeners();

        // 将stateService的state设置为ready，标记为前端应用程序已准备好
        this.stateService.state = 'ready';

        // 停止前端应用程序启动计时器
        // 这个玩意是用来记录前端应用程序启动的时间的
        startup.then(idToken => this.backendStopwatch.stop(idToken, 'Frontend application start', []));
    }

    /**
     * Return a promise to the host element to which the application shell is attached.
     */
    protected getHost(): Promise<HTMLElement> {
        if (document.body) {
            return Promise.resolve(document.body);
        }
        return new Promise<HTMLElement>(resolve =>
            window.addEventListener('load', () => resolve(document.body), { once: true })
        );
    }

    /**
     * Return an HTML element that indicates the startup phase, e.g. with an animation or a splash screen.
     */
    protected getStartupIndicator(host: HTMLElement): HTMLElement | undefined {
        const startupElements = host.getElementsByClassName('theia-preload');
        return startupElements.length === 0 ? undefined : startupElements[0] as HTMLElement;
    }

    /**
     * Register global event listeners.
     */
    protected registerEventListeners(): void {
        this.windowsService.onUnload(() => {
            this.stateService.state = 'closing_window';
            this.layoutRestorer.storeLayout(this);
            this.stopContributions();
        });
        window.addEventListener('resize', () => this.shell.update());

        this.keybindings.registerEventListeners(window);

        document.addEventListener('touchmove', event => { event.preventDefault(); }, { passive: false });
        // Prevent forward/back navigation by scrolling in OS X
        if (isOSX) {
            document.body.addEventListener('wheel', preventNavigation, { passive: false });
        }
        // Prevent the default browser behavior when dragging and dropping files into the window.
        document.addEventListener('dragenter', event => {
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'none';
            }
            event.preventDefault();
        }, false);
        document.addEventListener('dragover', event => {
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'none';
            } event.preventDefault();
        }, false);
        document.addEventListener('drop', event => {
            event.preventDefault();
        }, false);

    }

    /**
     * Attach the application shell to the host element. If a startup indicator is present, the shell is
     * inserted before that indicator so it is not visible yet.
     */
    protected attachShell(host: HTMLElement): void {
        const ref = this.getStartupIndicator(host);
        Widget.attach(this.shell, host, ref);
    }

    /**
     * Attach the tooltip container to the host element.
     */
    protected attachTooltip(host: HTMLElement): void {
        this.tooltipService.attachTo(host);
    }

    /**
     * If a startup indicator is present, it is first hidden with the `theia-hidden` CSS class and then
     * removed after a while. The delay until removal is taken from the CSS transition duration.
     */
    protected revealShell(host: HTMLElement): Promise<void> {
        const startupElem = this.getStartupIndicator(host);
        if (startupElem) {
            return new Promise(resolve => {
                window.requestAnimationFrame(() => {
                    startupElem.classList.add('theia-hidden');
                    const preloadStyle = window.getComputedStyle(startupElem);
                    const transitionDuration = parseCssTime(preloadStyle.transitionDuration, 0);
                    window.setTimeout(() => {
                        const parent = startupElem.parentElement;
                        if (parent) {
                            parent.removeChild(startupElem);
                        }
                        resolve();
                    }, transitionDuration);
                });
            });
        } else {
            return Promise.resolve();
        }
    }

    /**
     * Initialize the shell layout either using the layout restorer service or, if no layout has
     * been stored, by creating the default layout.
     */
    protected async initializeLayout(): Promise<void> {
        if (!await this.restoreLayout()) {
            // Fallback: Create the default shell layout
            await this.createDefaultLayout();
        }
        await this.shell.pendingUpdates;
    }

    /**
     * Try to restore the shell layout from the storage service. Resolves to `true` if successful.
     */
    protected async restoreLayout(): Promise<boolean> {
        try {
            return await this.layoutRestorer.restoreLayout(this);
        } catch (error) {
            if (ApplicationShellLayoutMigrationError.is(error)) {
                console.warn(error.message);
                console.info('Initializing the default layout instead...');
            } else {
                console.error('Could not restore layout', error);
            }
            return false;
        }
    }

    /**
     * Let the frontend application contributions initialize the shell layout. Override this
     * method in order to create an application-specific custom layout.
     */
    protected async createDefaultLayout(): Promise<void> {
        for (const contribution of this.contributions.getContributions()) {
            if (contribution.initializeLayout) {
                await this.measure(contribution.constructor.name + '.initializeLayout',
                    () => contribution.initializeLayout!(this)
                );
            }
        }
    }

    protected async fireOnDidInitializeLayout(): Promise<void> {
        for (const contribution of this.contributions.getContributions()) {
            if (contribution.onDidInitializeLayout) {
                await this.measure(contribution.constructor.name + '.onDidInitializeLayout',
                    () => contribution.onDidInitializeLayout!(this)
                );
            }
        }
    }

    protected async initializeContributions(): Promise<void> {
        const contributions = this.contributions.getContributions()

        // =======================constribution initialize start============================
        console.log(`\x1b[1;3;30;43m%s\x1b[0m`, `\n FrontendApplicaton当前有${contributions.filter(c => !!c.initialize).length}个拥有initialize方法的Contribution `, ` [/Users/work/Third-Projects/theia/packages/core/src/browser/frontend-application.ts:310]\n`);
        console.table(contributions.filter(c => !!c.initialize).map(contribution => {
            const Contribution = contribution.constructor as any
            return {
                "FrontendApplicaton Contribution": Contribution.name,
                File: Contribution.file,
                Method: [Contribution.prototype.initialize, Contribution.prototype.configure, Contribution.prototype.onStart].filter((c) => !!c).map(c => {
                    switch (c) {
                        case Contribution.prototype.initialize: return 'initialize'
                        case Contribution.prototype.configure: return 'configure'
                        case Contribution.prototype.onStart: return 'onStart'
                        default: return 'unknown'
                    }
                }).join(" | ")
            }
        }))
        for (const contribution of contributions) {
            if (contribution.initialize) {
                try {
                    await this.measure(contribution.constructor.name + '.initialize',
                        () => contribution.initialize!()
                    );
                } catch (error) {
                    console.error('Could not initialize contribution', error);
                }
            }
        }
        // =======================constribution initialize end============================
    }

    protected async configureContributions(): Promise<void> {
        const contributions = this.contributions.getContributions()

        // =======================constribution configure start============================
        console.log(`\x1b[1;3;30;43m%s\x1b[0m`, `\n FrontendApplicaton当前有${contributions.filter(c => !!c.configure).length}个拥有configure方法的Contribution `, ` [/Users/work/Third-Projects/theia/packages/core/src/browser/frontend-application.ts:341]\n`);
        console.table(contributions.filter(c => !!c.configure).map(contribution => {
            const Contribution = contribution.constructor as any
            return {
                "FrontendApplicaton Contribution": Contribution.name,
                File: Contribution.file,
                Method: [Contribution.prototype.initialize, Contribution.prototype.configure, Contribution.prototype.onStart].filter((c) => !!c).map(c => {
                    switch (c) {
                        case Contribution.prototype.initialize: return 'initialize'
                        case Contribution.prototype.configure: return 'configure'
                        case Contribution.prototype.onStart: return 'onStart'
                        default: return 'unknown'
                    }
                }).join(" | ")
            }
        }))
        for (const contribution of contributions) {
            if (contribution.configure) {
                try {
                    await this.measure(contribution.constructor.name + '.configure',
                        () => contribution.configure!(this)
                    );
                } catch (error) {
                    console.error('Could not configure contribution', error);
                }
            }
        }
        // =======================constribution configure end============================
    }

    /**
     * Initialize and start the frontend application contributions.
     */
    protected async startContributions(): Promise<void> {
        const contributions = this.contributions.getContributions()

        /**
         * FIXME:
         * - decouple commands & menus
         * - consider treat commands, keybindings and menus as frontend application contributions
         */
        await this.measure('commands.onStart',
            () => this.commands.onStart()
        );
        await this.measure('keybindings.onStart',
            () => this.keybindings.onStart()
        );
        await this.measure('menus.onStart',
            () => this.menus.onStart()
        );

        // =======================constribution onStart start============================
        console.log(`\x1b[1;3;30;43m%s\x1b[0m`, `\n FrontendApplicaton当前有${contributions.filter(c => !!c.onStart).length}个拥有onStart方法的Contribution `, ` [/Users/work/Third-Projects/theia/packages/core/src/browser/frontend-application.ts:387]\n`);
        console.table(contributions.filter(c => !!c.onStart).map(contribution => {
            const Contribution = contribution.constructor as any
            return {
                "FrontendApplicaton Contribution": Contribution.name,
                File: Contribution.file,
                Method: [Contribution.prototype.initialize, Contribution.prototype.configure, Contribution.prototype.onStart].filter((c) => !!c).map(c => {
                    switch (c) {
                        case Contribution.prototype.initialize: return 'initialize'
                        case Contribution.prototype.configure: return 'configure'
                        case Contribution.prototype.onStart: return 'onStart'
                        default: return 'unknown'
                    }
                }).join(" | ")
            }
        }))
        for (const contribution of contributions) {
            if (contribution.onStart) {
                try {
                    await this.measure(contribution.constructor.name + '.onStart',
                        () => contribution.onStart!(this)
                    );
                } catch (error) {
                    console.error('Could not start contribution', error);
                }
            }
        }
        // =======================constribution onStart end============================
    }

    /**
     * Stop the frontend application contributions. This is called when the window is unloaded.
     */
    protected stopContributions(): void {
        console.info('>>> Stopping frontend contributions...');
        for (const contribution of this.contributions.getContributions()) {
            if (contribution.onStop) {
                try {
                    contribution.onStop(this);
                } catch (error) {
                    console.error('Could not stop contribution', error);
                }
            }
        }
        console.info('<<< All frontend contributions have been stopped.');
    }

    protected async measure<T>(name: string, fn: () => MaybePromise<T>, message = `Frontend ${name}`, threshold = true): Promise<T> {
        return this.stopwatch.startAsync(name, message, fn,
            threshold ? { thresholdMillis: TIMER_WARNING_THRESHOLD, defaultLogLevel: LogLevel.DEBUG } : {});
    }

}
