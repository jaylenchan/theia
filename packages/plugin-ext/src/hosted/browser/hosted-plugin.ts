// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// some code copied and modified from https://github.com/microsoft/vscode/blob/da5fb7d5b865aa522abc7e82c10b746834b98639/src/vs/workbench/api/node/extHostExtensionService.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

import { generateUuid } from '@theia/core/lib/common/uuid';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { PluginWorker } from './plugin-worker';
import { getPluginId, DeployedPlugin, HostedPluginServer } from '../../common/plugin-protocol';
import { HostedPluginWatcher } from './hosted-plugin-watcher';
import { ExtensionKind, MAIN_RPC_CONTEXT, PluginManagerExt, UIKind } from '../../common/plugin-api-rpc';
import { setUpPluginApi } from '../../main/browser/main-context';
import { RPCProtocol, RPCProtocolImpl } from '../../common/rpc-protocol';
import {
    Disposable, DisposableCollection, isCancelled,
    CommandRegistry, WillExecuteCommandEvent,
    CancellationTokenSource, ProgressService, nls,
    RpcProxy
} from '@theia/core';
import { PreferenceServiceImpl, PreferenceProviderProvider } from '@theia/core/lib/browser/preferences';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { PluginContributionHandler } from '../../main/browser/plugin-contribution-handler';
import { getQueryParameters } from '../../main/browser/env-main';
import { getPreferences } from '../../main/browser/preference-registry-main';
import { Deferred, waitForEvent } from '@theia/core/lib/common/promise-util';
import { DebugSessionManager } from '@theia/debug/lib/browser/debug-session-manager';
import { DebugConfigurationManager } from '@theia/debug/lib/browser/debug-configuration-manager';
import { Event, WaitUntilEvent } from '@theia/core/lib/common/event';
import { FileSearchService } from '@theia/file-search/lib/common/file-search-service';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { PluginViewRegistry } from '../../main/browser/view/plugin-view-registry';
import { WillResolveTaskProvider, TaskProviderRegistry, TaskResolverRegistry } from '@theia/task/lib/browser/task-contribution';
import { TaskDefinitionRegistry } from '@theia/task/lib/browser/task-definition-registry';
import { WebviewEnvironment } from '../../main/browser/webview/webview-environment';
import { WebviewWidget } from '../../main/browser/webview/webview';
import { WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import URI from '@theia/core/lib/common/uri';
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { environment } from '@theia/core/shared/@theia/application-package/lib/environment';
import { JsonSchemaStore } from '@theia/core/lib/browser/json-schema-store';
import { FileService, FileSystemProviderActivationEvent } from '@theia/filesystem/lib/browser/file-service';
import { PluginCustomEditorRegistry } from '../../main/browser/custom-editors/plugin-custom-editor-registry';
import { CustomEditorWidget } from '../../main/browser/custom-editors/custom-editor-widget';
import { StandaloneServices } from '@theia/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneServices';
import { ILanguageService } from '@theia/monaco-editor-core/esm/vs/editor/common/languages/language';
import { LanguageService } from '@theia/monaco-editor-core/esm/vs/editor/common/services/languageService';
import { Uint8ArrayReadBuffer, Uint8ArrayWriteBuffer } from '@theia/core/lib/common/message-rpc/uint8-array-message-buffer';
import { BasicChannel } from '@theia/core/lib/common/message-rpc/channel';
import { NotebookTypeRegistry, NotebookService, NotebookRendererMessagingService } from '@theia/notebook/lib/browser';
import { ApplicationServer } from '@theia/core/lib/common/application-protocol';
import {
    AbstractHostedPluginSupport, PluginContributions, PluginHost,
    ALL_ACTIVATION_EVENT, isConnectionScopedBackendPlugin
} from '../common/hosted-plugin';
import { isRemote } from '@theia/core/lib/browser/browser';

export type DebugActivationEvent = 'onDebugResolve' | 'onDebugInitialConfigurations' | 'onDebugAdapterProtocolTracker' | 'onDebugDynamicConfigurations';

export const PluginProgressLocation = 'plugin';

@injectable()
export class HostedPluginSupport extends AbstractHostedPluginSupport<PluginManagerExt, RpcProxy<HostedPluginServer>> {

    protected static ADDITIONAL_ACTIVATION_EVENTS_ENV = 'ADDITIONAL_ACTIVATION_EVENTS';
    protected static BUILTIN_ACTIVATION_EVENTS = [
        '*',
        'onLanguage',
        'onCommand',
        'onDebug',
        'onDebugInitialConfigurations',
        'onDebugResolve',
        'onDebugAdapterProtocolTracker',
        'onDebugDynamicConfigurations',
        'onTaskType',
        'workspaceContains',
        'onView',
        'onUri',
        'onTerminalProfile',
        'onWebviewPanel',
        'onFileSystem',
        'onCustomEditor',
        'onStartupFinished',
        'onAuthenticationRequest',
        'onNotebook',
        'onNotebookSerializer'
    ];

    @inject(HostedPluginWatcher)
    protected readonly watcher: HostedPluginWatcher;

    @inject(PluginContributionHandler)
    protected readonly contributionHandler: PluginContributionHandler;

    @inject(PreferenceProviderProvider)
    protected readonly preferenceProviderProvider: PreferenceProviderProvider;

    @inject(PreferenceServiceImpl)
    protected readonly preferenceServiceImpl: PreferenceServiceImpl;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(NotebookService)
    protected readonly notebookService: NotebookService;

    @inject(NotebookRendererMessagingService)
    protected readonly notebookRendererMessagingService: NotebookRendererMessagingService;

    @inject(CommandRegistry)
    protected readonly commands: CommandRegistry;

    @inject(DebugSessionManager)
    protected readonly debugSessionManager: DebugSessionManager;

    @inject(DebugConfigurationManager)
    protected readonly debugConfigurationManager: DebugConfigurationManager;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(FileSearchService)
    protected readonly fileSearchService: FileSearchService;

    @inject(FrontendApplicationStateService)
    protected readonly appState: FrontendApplicationStateService;

    @inject(NotebookTypeRegistry)
    protected readonly notebookTypeRegistry: NotebookTypeRegistry;

    @inject(PluginViewRegistry)
    protected readonly viewRegistry: PluginViewRegistry;

    @inject(TaskProviderRegistry)
    protected readonly taskProviderRegistry: TaskProviderRegistry;

    @inject(TaskResolverRegistry)
    protected readonly taskResolverRegistry: TaskResolverRegistry;

    @inject(TaskDefinitionRegistry)
    protected readonly taskDefinitionRegistry: TaskDefinitionRegistry;

    @inject(ProgressService)
    protected readonly progressService: ProgressService;

    @inject(WebviewEnvironment)
    protected readonly webviewEnvironment: WebviewEnvironment;

    @inject(WidgetManager)
    protected readonly widgets: WidgetManager;

    @inject(TerminalService)
    protected readonly terminalService: TerminalService;

    @inject(JsonSchemaStore)
    protected readonly jsonSchemaStore: JsonSchemaStore;

    @inject(PluginCustomEditorRegistry)
    protected readonly customEditorRegistry: PluginCustomEditorRegistry;

    @inject(ApplicationServer)
    protected readonly applicationServer: ApplicationServer;

    constructor() {
        super(generateUuid());
    }

    @postConstruct()
    protected override init(): void {
        super.init();

        this.workspaceService.onWorkspaceChanged(() => this.updateStoragePath());

        const languageService = (StandaloneServices.get(ILanguageService) as LanguageService);
        for (const language of languageService['_requestedBasicLanguages'] as Set<string>) {
            this.activateByLanguage(language);
        }
        languageService.onDidRequestBasicLanguageFeatures(language => this.activateByLanguage(language));
        this.commands.onWillExecuteCommand(event => this.ensureCommandHandlerRegistration(event));
        this.debugSessionManager.onWillStartDebugSession(event => this.ensureDebugActivation(event));
        this.debugSessionManager.onWillResolveDebugConfiguration(event => this.ensureDebugActivation(event, 'onDebugResolve', event.debugType));
        this.debugConfigurationManager.onWillProvideDebugConfiguration(event => this.ensureDebugActivation(event, 'onDebugInitialConfigurations'));
        // Activate all providers of dynamic configurations, i.e. Let the user pick a configuration from all the available ones.
        this.debugConfigurationManager.onWillProvideDynamicDebugConfiguration(event => this.ensureDebugActivation(event, 'onDebugDynamicConfigurations', ALL_ACTIVATION_EVENT));
        this.viewRegistry.onDidExpandView(id => this.activateByView(id));
        this.taskProviderRegistry.onWillProvideTaskProvider(event => this.ensureTaskActivation(event));
        this.taskResolverRegistry.onWillProvideTaskResolver(event => this.ensureTaskActivation(event));
        this.fileService.onWillActivateFileSystemProvider(event => this.ensureFileSystemActivation(event));
        this.customEditorRegistry.onWillOpenCustomEditor(event => this.activateByCustomEditor(event));
        this.notebookService.onWillOpenNotebook(async event => this.activateByNotebook(event));
        this.notebookRendererMessagingService.onWillActivateRenderer(rendererId => this.activateByNotebookRenderer(rendererId));

        this.widgets.onDidCreateWidget(({ factoryId, widget }) => {
            // note: state restoration of custom editors is handled in `PluginCustomEditorRegistry.init`
            if (factoryId === WebviewWidget.FACTORY_ID && widget instanceof WebviewWidget) {
                const storeState = widget.storeState.bind(widget);
                const restoreState = widget.restoreState.bind(widget);

                widget.storeState = () => {
                    if (this.webviewRevivers.has(widget.viewType)) {
                        return storeState();
                    }
                    return undefined;
                };

                widget.restoreState = state => {
                    if (state.viewType) {
                        restoreState(state);
                        this.preserveWebview(widget);
                    } else {
                        widget.dispose();
                    }
                };
            }
        });
    }

    protected createTheiaReadyPromise(): Promise<unknown> {
        return Promise.all([this.preferenceServiceImpl.ready, this.workspaceService.roots]);
    }

    protected override runOperation(operation: () => Promise<void>): Promise<void> {
        return this.progressService.withProgress('', PluginProgressLocation, () => {
            console.log(`\x1b[1;3;30;44m%s\x1b[0m`, `\n ==========>==========>在浏览器上调用HostedPluginSupport.doLoad方法加载插件 `, ` [/Users/work/Third-Projects/theia/packages/plugin-ext/src/hosted/browser/hosted-plugin.ts:242]`);

            return this.doLoad()
        });
    }

    protected override afterStart(): void {
        this.watcher.onDidDeploy(() => this.load());
        this.server.onDidOpenConnection(() => this.load());
    }

    // Only load connection-scoped plugins
    protected acceptPlugin(plugin: DeployedPlugin): boolean {
        return isConnectionScopedBackendPlugin(plugin);
    }

    protected override async beforeSyncPlugins(toDisconnect: DisposableCollection): Promise<void> {
        await super.beforeSyncPlugins(toDisconnect);

        toDisconnect.push(Disposable.create(() => this.preserveWebviews()));
        this.server.onDidCloseConnection(() => toDisconnect.dispose());
    }

    protected override async beforeLoadContributions(toDisconnect: DisposableCollection): Promise<void> {
        // make sure that the previous state, including plugin widgets, is restored
        // and core layout is initialized, i.e. explorer, scm, debug views are already added to the shell
        // but shell is not yet revealed
        await this.appState.reachedState('initialized_layout');
    }

    protected override async afterLoadContributions(toDisconnect: DisposableCollection): Promise<void> {
        await this.viewRegistry.initWidgets();
        // remove restored plugin widgets which were not registered by contributions
        this.viewRegistry.removeStaleWidgets();
    }

    protected handleContributions(plugin: DeployedPlugin): Disposable {
        // contrbutionHandler位于packages/plugin-ext/src/main/browser/plugin-contribution-handler.ts
        return this.contributionHandler.handleContributions(this.clientId, plugin);
    }

    protected override handlePluginStarted(manager: PluginManagerExt, plugin: DeployedPlugin): void {
        this.activateByWorkspaceContains(manager, plugin);
    }

    protected async obtainManager(host: string, hostContributions: PluginContributions[], toDisconnect: DisposableCollection): Promise<PluginManagerExt | undefined> {
        // 1. 检查是否已有 manager 实例：每个 host 都有一个独立的 manager 实例，用于管理该 host 上的插件
        /**
         * 在 Theia 框架中，host（插件宿主环境）主要有以下几种：
         * 
         * 1. 前端（Frontend）：运行在浏览器中的环境，负责处理用户界面和用户交互，主要管理与用户界面相关的插件。
         * 2. 后端（Backend）：运行在服务器上的环境，负责处理业务逻辑和数据存储，主要管理与服务器端逻辑相关的插件。
         * 3. 无头模式（Headless）：没有用户界面的环境，通常用于自动化任务或后台服务，主要管理不需要用户界面的插件。
         */
        let manager = this.managers.get(host);
        if (!manager) {
            const pluginId = getPluginId(hostContributions[0].plugin.metadata.model);
            // 2. 初始化rpc
            const rpc = this.initRpc(host, pluginId);
            toDisconnect.push(rpc);

            console.log(`\x1b[1;3;30;44m%s\x1b[0m`, `\n ==========>==========>获取指定ID的rpc proxy `, ` [/Users/work/Third-Projects/theia/packages/plugin-ext/src/hosted/browser/hosted-plugin.ts:293]`);
            // 3. 获取 RPC 代理对象
            manager = rpc.getProxy(MAIN_RPC_CONTEXT.HOSTED_PLUGIN_MANAGER_EXT);
            // 设置host和manager之间的映射："main" <---> "rpc proxy(manager)"
            this.managers.set(host, manager);
            toDisconnect.push(Disposable.create(() => this.managers.delete(host)));

            // 4. 获取插件相关的各种状态和配置：
            const [extApi, globalState, workspaceState, webviewResourceRoot, webviewCspSource, defaultShell, jsonValidation] = await Promise.all([
                this.server.getExtPluginAPI(),
                this.pluginServer.getAllStorageValues(undefined),
                this.pluginServer.getAllStorageValues({
                    workspace: this.workspaceService.workspace?.resource.toString(),
                    roots: this.workspaceService.tryGetRoots().map(root => root.resource.toString())
                }),
                this.webviewEnvironment.resourceRoot(host),
                this.webviewEnvironment.cspSource(),
                this.terminalService.getDefaultShell(),
                this.jsonSchemaStore.schemas
            ]);
            if (toDisconnect.disposed) {
                return undefined;
            }

            const isElectron = environment.electron.is();

            const supportedActivationEvents = [...HostedPluginSupport.BUILTIN_ACTIVATION_EVENTS];
            const [additionalActivationEvents, appRoot] = await Promise.all([
                this.envServer.getValue(HostedPluginSupport.ADDITIONAL_ACTIVATION_EVENTS_ENV),
                this.applicationServer.getApplicationRoot()
            ]);
            if (additionalActivationEvents && additionalActivationEvents.value) {
                additionalActivationEvents.value.split(',').forEach(event => supportedActivationEvents.push(event));
            }

            console.log(`\x1b[1;3;30;44m%s\x1b[0m`, `\n ==========>==========>使用rpc proxy发送$init rpc方法调用 `, ` [/Users/work/Third-Projects/theia/packages/plugin-ext/src/hosted/browser/hosted-plugin.ts:327]`);

            // 5. 初始化代理对象manager
            await manager.$init({
                preferences: getPreferences(this.preferenceProviderProvider, this.workspaceService.tryGetRoots()),
                globalState,
                workspaceState,
                env: {
                    queryParams: getQueryParameters(),
                    language: nls.locale || nls.defaultLocale,
                    shell: defaultShell,
                    uiKind: isElectron ? UIKind.Desktop : UIKind.Web,
                    appName: FrontendApplicationConfigProvider.get().applicationName,
                    appHost: isElectron ? 'desktop' : 'web', // TODO: 'web' could be the embedder's name, e.g. 'github.dev'
                    appRoot,
                    appUriScheme: FrontendApplicationConfigProvider.get().electron.uriScheme
                },
                extApi,
                webview: {
                    webviewResourceRoot,
                    webviewCspSource
                },
                jsonValidation,
                pluginKind: isRemote ? ExtensionKind.Workspace : ExtensionKind.UI,
                supportedActivationEvents
            });
            if (toDisconnect.disposed) {
                return undefined;
            }

            // 6. 激活事件
            this.activationEvents.forEach(event => manager!.$activateByEvent(event));
        }
        return manager;
    }

    protected initRpc(host: PluginHost, pluginId: string): RPCProtocol {
        const rpc = host === 'frontend' ? new PluginWorker().rpc : this.createServerRpc(host);
        setUpPluginApi(rpc, this.container);
        this.mainPluginApiProviders.getContributions().forEach(p => p.initialize(rpc, this.container));
        return rpc;
    }

    protected createServerRpc(pluginHostId: string): RPCProtocol {

        const channel = new BasicChannel(() => {
            const writer = new Uint8ArrayWriteBuffer();
            writer.onCommit(buffer => {
                this.server.onMessage(pluginHostId, buffer);
            });
            return writer;
        });

        // Create RPC protocol before adding the listener to the watcher to receive the watcher's cached messages after the rpc protocol was created.
        const rpc = new RPCProtocolImpl(channel);

        this.watcher.onPostMessageEvent(received => {
            if (pluginHostId === received.pluginHostId) {
                channel.onMessageEmitter.fire(() => new Uint8ArrayReadBuffer(received.message));
            }
        });

        return rpc;
    }

    protected async updateStoragePath(): Promise<void> {
        const path = await this.getStoragePath();
        for (const manager of this.managers.values()) {
            manager.$updateStoragePath(path);
        }
    }

    protected async getStoragePath(): Promise<string | undefined> {
        const roots = await this.workspaceService.roots;
        return this.pluginPathsService.getHostStoragePath(this.workspaceService.workspace?.resource.toString(), roots.map(root => root.resource.toString()));
    }

    protected async getHostGlobalStoragePath(): Promise<string> {
        const configDirUri = await this.envServer.getConfigDirUri();
        const globalStorageFolderUri = new URI(configDirUri).resolve('globalStorage');

        // Make sure that folder by the path exists
        if (!await this.fileService.exists(globalStorageFolderUri)) {
            await this.fileService.createFolder(globalStorageFolderUri, { fromUserGesture: false });
        }
        const globalStorageFolderFsPath = await this.fileService.fsPath(globalStorageFolderUri);
        if (!globalStorageFolderFsPath) {
            throw new Error(`Could not resolve the FS path for URI: ${globalStorageFolderUri}`);
        }
        return globalStorageFolderFsPath;
    }

    async activateByViewContainer(viewContainerId: string): Promise<void> {
        await Promise.all(this.viewRegistry.getContainerViews(viewContainerId).map(viewId => this.activateByView(viewId)));
    }

    async activateByView(viewId: string): Promise<void> {
        await this.activateByEvent(`onView:${viewId}`);
    }

    async activateByLanguage(languageId: string): Promise<void> {
        await this.activateByEvent('onLanguage');
        await this.activateByEvent(`onLanguage:${languageId}`);
    }

    async activateByUri(scheme: string, authority: string): Promise<void> {
        await this.activateByEvent(`onUri:${scheme}://${authority}`);
    }

    async activateByCommand(commandId: string): Promise<void> {
        await this.activateByEvent(`onCommand:${commandId}`);
    }

    async activateByTaskType(taskType: string): Promise<void> {
        await this.activateByEvent(`onTaskType:${taskType}`);
    }

    async activateByCustomEditor(viewType: string): Promise<void> {
        await this.activateByEvent(`onCustomEditor:${viewType}`);
    }

    async activateByNotebook(viewType: string): Promise<void> {
        await this.activateByEvent(`onNotebook:${viewType}`);
    }

    async activateByNotebookSerializer(viewType: string): Promise<void> {
        await this.activateByEvent(`onNotebookSerializer:${viewType}`);
    }

    async activateByNotebookRenderer(rendererId: string): Promise<void> {
        await this.activateByEvent(`onRenderer:${rendererId}`);
    }

    activateByFileSystem(event: FileSystemProviderActivationEvent): Promise<void> {
        return this.activateByEvent(`onFileSystem:${event.scheme}`);
    }

    activateByTerminalProfile(profileId: string): Promise<void> {
        return this.activateByEvent(`onTerminalProfile:${profileId}`);
    }

    protected ensureFileSystemActivation(event: FileSystemProviderActivationEvent): void {
        event.waitUntil(this.activateByFileSystem(event).then(() => {
            if (!this.fileService.hasProvider(event.scheme)) {
                return waitForEvent(Event.filter(this.fileService.onDidChangeFileSystemProviderRegistrations,
                    ({ added, scheme }) => added && scheme === event.scheme), 3000);
            }
        }));
    }

    protected ensureCommandHandlerRegistration(event: WillExecuteCommandEvent): void {
        const activation = this.activateByCommand(event.commandId);
        if (this.commands.getCommand(event.commandId) &&
            (!this.contributionHandler.hasCommand(event.commandId) ||
                this.contributionHandler.hasCommandHandler(event.commandId))) {
            return;
        }
        const waitForCommandHandler = new Deferred<void>();
        const listener = this.contributionHandler.onDidRegisterCommandHandler(id => {
            if (id === event.commandId) {
                listener.dispose();
                waitForCommandHandler.resolve();
            }
        });
        const p = Promise.all([
            activation,
            waitForCommandHandler.promise
        ]);
        p.then(() => listener.dispose(), () => listener.dispose());
        event.waitUntil(p);
    }

    protected ensureTaskActivation(event: WillResolveTaskProvider): void {
        const promises = [this.activateByCommand('workbench.action.tasks.runTask')];
        const taskType = event.taskType;
        if (taskType) {
            if (taskType === ALL_ACTIVATION_EVENT) {
                for (const taskDefinition of this.taskDefinitionRegistry.getAll()) {
                    promises.push(this.activateByTaskType(taskDefinition.taskType));
                }
            } else {
                promises.push(this.activateByTaskType(taskType));
            }
        }

        event.waitUntil(Promise.all(promises));
    }

    protected ensureDebugActivation(event: WaitUntilEvent, activationEvent?: DebugActivationEvent, debugType?: string): void {
        event.waitUntil(this.activateByDebug(activationEvent, debugType));
    }

    async activateByDebug(activationEvent?: DebugActivationEvent, debugType?: string): Promise<void> {
        const promises = [this.activateByEvent('onDebug')];
        if (activationEvent) {
            promises.push(this.activateByEvent(activationEvent));
            if (debugType) {
                promises.push(this.activateByEvent(activationEvent + ':' + debugType));
            }
        }
        await Promise.all(promises);
    }

    protected async activateByWorkspaceContains(manager: PluginManagerExt, plugin: DeployedPlugin): Promise<void> {
        const activationEvents = plugin.contributes && plugin.contributes.activationEvents;
        if (!activationEvents) {
            return;
        }
        const paths: string[] = [];
        const includePatterns: string[] = [];
        // should be aligned with https://github.com/microsoft/vscode/blob/da5fb7d5b865aa522abc7e82c10b746834b98639/src/vs/workbench/api/node/extHostExtensionService.ts#L460-L469
        for (const activationEvent of activationEvents) {
            if (/^workspaceContains:/.test(activationEvent)) {
                const fileNameOrGlob = activationEvent.substring('workspaceContains:'.length);
                if (fileNameOrGlob.indexOf(ALL_ACTIVATION_EVENT) >= 0 || fileNameOrGlob.indexOf('?') >= 0) {
                    includePatterns.push(fileNameOrGlob);
                } else {
                    paths.push(fileNameOrGlob);
                }
            }
        }

        const activatePlugin = () => {
            console.log(`\x1b[1;3;30;44m%s\x1b[0m`,
                `\n [激活插件]-调用manager.$activateByEvent激活[${plugin.metadata.model.id}] \n`,
                ` [/Users/work/Third-Projects/theia/packages/plugin-ext/src/hosted/browser/hosted-plugin.ts:543]\n`,
            );

            return manager.$activateByEvent(`onPlugin:${plugin.metadata.model.id}`)
        };
        const promises: Promise<boolean>[] = [];
        if (paths.length) {
            promises.push(this.workspaceService.containsSome(paths));
        }
        if (includePatterns.length) {
            const tokenSource = new CancellationTokenSource();
            const searchTimeout = setTimeout(() => {
                tokenSource.cancel();
                // activate eagerly if took to long to search
                activatePlugin();
            }, 7000);
            promises.push((async () => {
                try {
                    const result = await this.fileSearchService.find('', {
                        rootUris: this.workspaceService.tryGetRoots().map(r => r.resource.toString()),
                        includePatterns,
                        limit: 1
                    }, tokenSource.token);
                    return result.length > 0;
                } catch (e) {
                    if (!isCancelled(e)) {
                        console.error(e);
                    }
                    return false;
                } finally {
                    clearTimeout(searchTimeout);
                }
            })());
        }
        if (promises.length && await Promise.all(promises).then(exists => exists.some(v => v))) {
            await activatePlugin();
        }
    }

    protected readonly webviewsToRestore = new Map<string, WebviewWidget>();
    protected readonly webviewRevivers = new Map<string, (webview: WebviewWidget) => Promise<void>>();

    registerWebviewReviver(viewType: string, reviver: (webview: WebviewWidget) => Promise<void>): void {
        if (this.webviewRevivers.has(viewType)) {
            throw new Error(`Reviver for ${viewType} already registered`);
        }
        this.webviewRevivers.set(viewType, reviver);

        if (this.webviewsToRestore.has(viewType)) {
            this.restoreWebview(this.webviewsToRestore.get(viewType) as WebviewWidget);
        }
    }

    unregisterWebviewReviver(viewType: string): void {
        this.webviewRevivers.delete(viewType);
    }

    protected async preserveWebviews(): Promise<void> {
        for (const webview of this.widgets.getWidgets(WebviewWidget.FACTORY_ID)) {
            this.preserveWebview(webview as WebviewWidget);
        }
        for (const webview of this.widgets.getWidgets(CustomEditorWidget.FACTORY_ID)) {
            (webview as CustomEditorWidget).modelRef.dispose();
            if ((webview as any)['closeWithoutSaving']) {
                delete (webview as any)['closeWithoutSaving'];
            }
            this.customEditorRegistry.resolveWidget(webview as CustomEditorWidget);
        }
    }

    protected preserveWebview(webview: WebviewWidget): void {
        if (!this.webviewsToRestore.has(webview.viewType)) {
            this.activateByEvent(`onWebviewPanel:${webview.viewType}`);
            this.webviewsToRestore.set(webview.viewType, webview);
            webview.disposed.connect(() => this.webviewsToRestore.delete(webview.viewType));
        }
    }

    protected async restoreWebview(webview: WebviewWidget): Promise<void> {
        const restore = this.webviewRevivers.get(webview.viewType);
        if (restore) {
            try {
                await restore(webview);
            } catch (e) {
                webview.setHTML(this.getDeserializationFailedContents(`
                An error occurred while restoring '${webview.viewType}' view. Please check logs.
                `));
                console.error('Failed to restore the webview', e);
            }
        }
    }

    protected getDeserializationFailedContents(message: string): string {
        return `<!DOCTYPE html>
        <html>
            <head>
                <meta http-equiv="Content-type" content="text/html;charset=UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none';">
            </head>
            <body>${message}</body>
        </html>`;
    }

}
