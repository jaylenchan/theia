// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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

import { BackendApplicationContribution } from '@theia/core/lib/node';
import { BackendApplicationConfigProvider } from '@theia/core/lib/node/backend-application-config-provider';
import { injectable } from '@theia/core/shared/inversify';
import { WebviewExternalEndpoint } from '../common/webview-protocol';

@injectable()
export class WebviewBackendSecurityWarnings implements BackendApplicationContribution {

    static file = "/Users/work/Third-Projects/theia/packages/plugin-ext/src/main/node/webview-backend-security-warnings.ts"

    initialize(): void {
        console.log(`\x1b[1;4;35m%s\x1b[0m`, `\n###[调用BackendApplicaton8个实现了initialize方法的Contribution的initialize方法进行初始化 ]\n###[初始化BackendApplication Contribution] WebviewBackendSecurityWarnings `, ` [/Users/work/Third-Projects/theia/packages/plugin-ext/src/main/node/webview-backend-security-warnings.ts:28]`);

        this.checkHostPattern();
    }

    protected async checkHostPattern(): Promise<void> {
        if (BackendApplicationConfigProvider.get()['warnOnPotentiallyInsecureHostPattern'] === false) {
            return;
        }
        const envHostPattern = process.env[WebviewExternalEndpoint.pattern];
        if (envHostPattern && envHostPattern !== WebviewExternalEndpoint.defaultPattern) {
            console.warn(`\
WEBVIEW SECURITY WARNING

    Changing the @theia/plugin-ext webview host pattern can lead to security vulnerabilities.
        Current pattern: "${envHostPattern}"
    Please read @theia/plugin-ext/README.md for more information.
`
            );
        }
    }
}
