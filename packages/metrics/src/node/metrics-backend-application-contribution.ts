// *****************************************************************************
// Copyright (C) 2017-2018 Ericsson and others.
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

import { injectable, inject, named } from '@theia/core/shared/inversify';
import * as http from 'http';
import * as https from 'https';
import * as express from '@theia/core/shared/express';
import { ContributionProvider } from '@theia/core/lib/common';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { MetricsContribution } from './metrics-contribution';

@injectable()
export class MetricsBackendApplicationContribution implements BackendApplicationContribution {

    static file = "/Users/work/Third-Projects/theia/packages/metrics/src/node/metrics-backend-application-contribution.ts"
    static ENDPOINT = '/metrics';
    constructor(
        @inject(ContributionProvider) @named(MetricsContribution)
        protected readonly metricsProviders: ContributionProvider<MetricsContribution>
    ) {
    }

    configure(app: express.Application): void {
        app.get(MetricsBackendApplicationContribution.ENDPOINT, (req, res) => {
            const lastMetrics = this.fetchMetricsFromProviders();
            res.send(lastMetrics);
        });
    }

    onStart(server: http.Server | https.Server): void {
        console.log(`\x1b[1;4;35m%s\x1b[0m`, `\n###[调用BackendApplication Contribution onStart启动] MetricsBackendApplicationContribution `, ` [/Users/work/Third-Projects/theia/packages/metrics/src/node/metrics-backend-application-contribution.ts:44]`);

        this.metricsProviders.getContributions().forEach(contribution => {
            contribution.startCollecting();
        });
    }

    fetchMetricsFromProviders(): string {
        return this.metricsProviders.getContributions().reduce((total, contribution) =>
            total += contribution.getMetrics() + '\n', '');
    }
}
