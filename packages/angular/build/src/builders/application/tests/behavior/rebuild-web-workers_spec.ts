/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { logging } from '@angular-devkit/core';
import { buildApplication } from '../../index';
import { APPLICATION_BUILDER_INFO, BASE_OPTIONS, describeBuilder } from '../setup';

/**
 * A regular expression used to check if a built worker is correctly referenced in application code.
 */
const REFERENCED_WORKER_REGEXP =
  /new Worker\(new URL\("worker-[A-Z0-9]{8}\.js", import\.meta\.url\)/;

describeBuilder(buildApplication, APPLICATION_BUILDER_INFO, (harness) => {
  describe('Behavior: "Rebuilds when Web Worker files change"', () => {
    it('Recovers from error when directly referenced worker file is changed', async () => {
      harness.useTarget('build', {
        ...BASE_OPTIONS,
        watch: true,
      });

      const workerCodeFile = `
        console.log('WORKER FILE');
      `;

      const errorText = `Expected ";" but found "~"`;

      // Create a worker file
      await harness.writeFile('src/app/worker.ts', workerCodeFile);

      // Create app component that uses the directive
      await harness.writeFile(
        'src/app/app.component.ts',
        `
        import { Component } from '@angular/core'
        @Component({
          selector: 'app-root',
          standalone: false,
          template: '<h1>Worker Test</h1>',
        })
        export class AppComponent {
          worker = new Worker(new URL('./worker', import.meta.url), { type: 'module' });
        }
      `,
      );

      await harness.executeWithCases(
        [
          async ({ result }) => {
            expect(result?.success).toBeTrue();

            // Ensure built worker is referenced in the application code
            harness.expectFile('dist/browser/main.js').content.toMatch(REFERENCED_WORKER_REGEXP);

            // Update the worker file to be invalid syntax
            await harness.writeFile('src/app/worker.ts', `asd;fj$3~kls;kd^(*fjlk;sdj---flk`);
          },
          async ({ result, logs }) => {
            expect(result?.success).toBeFalse();
            expect(logs).toContain(
              jasmine.objectContaining<logging.LogEntry>({
                message: jasmine.stringMatching(errorText),
              }),
            );

            // Make an unrelated change to verify error cache was updated
            // Should persist error in the next rebuild
            await harness.modifyFile('src/main.ts', (content) => content + '\n');
          },
          async ({ logs }) => {
            expect(logs).toContain(
              jasmine.objectContaining<logging.LogEntry>({
                message: jasmine.stringMatching(errorText),
              }),
            );

            // Revert the change that caused the error
            // Should remove the error
            await harness.writeFile('src/app/worker.ts', workerCodeFile);
          },
          async ({ result, logs }) => {
            expect(result?.success).toBeTrue();
            expect(logs).not.toContain(
              jasmine.objectContaining<logging.LogEntry>({
                message: jasmine.stringMatching(errorText),
              }),
            );

            // Make an unrelated change to verify error cache was updated
            // Should continue showing no error
            await harness.modifyFile('src/main.ts', (content) => content + '\n');
          },
          ({ result, logs }) => {
            expect(result?.success).toBeTrue();
            expect(logs).not.toContain(
              jasmine.objectContaining<logging.LogEntry>({
                message: jasmine.stringMatching(errorText),
              }),
            );

            // Ensure built worker is referenced in the application code
            harness.expectFile('dist/browser/main.js').content.toMatch(REFERENCED_WORKER_REGEXP);
          },
        ],
        { outputLogsOnFailure: false },
      );
    });
  });
});
