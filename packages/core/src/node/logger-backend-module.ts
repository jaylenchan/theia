// *****************************************************************************
// Copyright (C) 2017 Ericsson and others.
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

import { ContainerModule, Container, interfaces } from 'inversify';
import { ConnectionHandler, RpcConnectionHandler } from '../common/messaging';
import { ILogger, LoggerFactory, Logger, setRootLogger, LoggerName, rootLoggerName } from '../common/logger';
import { ILoggerServer, ILoggerClient, loggerPath, DispatchingLoggerClient } from '../common/logger-protocol';
import { ConsoleLoggerServer } from './console-logger-server';
import { LoggerWatcher } from '../common/logger-watcher';
import { BackendApplicationContribution } from './backend-application';
import { CliContribution } from './cli';
import { LogLevelCliContribution } from './logger-cli-contribution';

export function bindLogger(bind: interfaces.Bind, props?: {
    onLoggerServerActivation?: (context: interfaces.Context, server: ILoggerServer) => void
}): void {
    bind(LoggerName).toConstantValue(rootLoggerName);
    bind(ILogger).to(Logger).inSingletonScope().whenTargetIsDefault();
    bind(LoggerWatcher).toSelf().inSingletonScope();
    bind<ILoggerServer>(ILoggerServer).to(ConsoleLoggerServer).inSingletonScope().onActivation((context, server) => {
        if (props && props.onLoggerServerActivation) {
            props.onLoggerServerActivation(context, server);
        }
        return server;
    });
    bind(LogLevelCliContribution).toSelf().inSingletonScope();
    bind(CliContribution).toService(LogLevelCliContribution);
    bind(LoggerFactory).toFactory(ctx =>
        (name: string) => {
            const child = new Container({ defaultScope: 'Singleton' });
            child.parent = ctx.container;
            child.bind(ILogger).to(Logger).inTransientScope();
            child.bind(LoggerName).toConstantValue(name);
            return child.get(ILogger);
        }
    );
}

/**
 * IMPORTANT: don't use in tests, since it overrides console
 */
export const loggerBackendModule = new ContainerModule(bind => {
    bind(BackendApplicationContribution).toDynamicValue(ctx => {

        class MyLogger {
            static file = "/Users/work/Third-Projects/theia/packages/core/src/node/logger-backend-module.ts"
            initialize(): void {
                console.log(`\x1b[1;4;35m%s\x1b[0m`, `\n###[调用BackendApplicaton8个实现了initialize方法的Contribution的initialize方法进行初始化 ]\n###[初始化BackendApplication Contribution] MyLogger `, ` [/Users/work/Third-Projects/theia/packages/core/src/node/logger-backend-module.ts:61]`);

                setRootLogger(ctx.container.get<ILogger>(ILogger));
            }
        }

        const logger = new MyLogger();

        return logger
    });

    bind(DispatchingLoggerClient).toSelf().inSingletonScope();
    bindLogger(bind, {
        onLoggerServerActivation: ({ container }, server) => {
            const dispatchingLoggerClient = container.get(DispatchingLoggerClient);
            server.setClient(dispatchingLoggerClient);

            // register backend logger watcher as a client
            const loggerWatcher = container.get(LoggerWatcher);
            dispatchingLoggerClient.clients.add(loggerWatcher.getLoggerClient());

            // make sure dispatching logger client is the only client
            server.setClient = () => {
                throw new Error('use DispatchingLoggerClient');
            };
        }
    });

    bind(ConnectionHandler).toDynamicValue(({ container }) =>
        new RpcConnectionHandler<ILoggerClient>(loggerPath, client => {
            const dispatching = container.get(DispatchingLoggerClient);
            dispatching.clients.add(client);
            client.onDidCloseConnection(() => dispatching.clients.delete(client));
            return container.get<ILoggerServer>(ILoggerServer);
        })
    ).inSingletonScope();
});
