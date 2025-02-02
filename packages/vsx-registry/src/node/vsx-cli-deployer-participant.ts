// *****************************************************************************
// Copyright (C) 2024 TypeFox and others.
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

import { inject, injectable } from '@theia/core/shared/inversify';
import { PluginDeployerParticipant, PluginDeployerStartContext } from '@theia/plugin-ext';
import { VsxCli } from './vsx-cli';
import { VSXExtensionUri } from '../common';
import * as fs from 'fs';
import { FileUri } from '@theia/core/lib/node';
import * as path from 'path';

@injectable()
export class VsxCliDeployerParticipant implements PluginDeployerParticipant {

    static file = "/Users/work/Third-Projects/theia/packages/vsx-registry/src/node/vsx-cli-deployer-participant.ts"

    @inject(VsxCli)
    protected readonly vsxCli: VsxCli;

    async onWillStart(context: PluginDeployerStartContext): Promise<void> {
        console.log(`\x1b[1;4;35m%s\x1b[0m`, `\n######[初始化PluginDeployerContribution阶段]\n######[初始化PluginDeployerParticipant几个实现了onWillStart方法的Contribution]\n######[调用VsxCliDeployerParticipant的onWillStart方法] `, ` [/Users/work/Third-Projects/theia/packages/vsx-registry/src/node/vsx-cli-deployer-participant.ts:34]`, `\n\n`);

        const pluginUris = await Promise.all(this.vsxCli.pluginsToInstall.map(async id => {
            try {
                const resolvedPath = path.resolve(id);
                const stat = await fs.promises.stat(resolvedPath);
                if (stat.isFile()) {
                    return FileUri.create(resolvedPath).withScheme('local-file').toString();
                }
            } catch (e) {
                // expected if file does not exist
            }
            return VSXExtensionUri.fromVersionedId(id).toString();
        }));
        //  []
        const entries = pluginUris
        context.userEntries.push(...entries);
    }
}
