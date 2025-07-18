/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import type { BuildOptions, PartialMessage, Plugin } from 'esbuild';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { extname, relative } from 'node:path';
import type { NormalizedApplicationBuildOptions } from '../../builders/application/options';
import { ExperimentalPlatform } from '../../builders/application/schema';
import { allowMangle } from '../../utils/environment-options';
import { toPosixPath } from '../../utils/path';
import {
  SERVER_APP_ENGINE_MANIFEST_FILENAME,
  SERVER_APP_MANIFEST_FILENAME,
} from '../../utils/server-rendering/manifest';
import { AngularCompilation, NoopCompilation } from '../angular/compilation';
import { createCompilerPlugin } from './angular/compiler-plugin';
import { ComponentStylesheetBundler } from './angular/component-stylesheets';
import { SourceFileCache } from './angular/source-file-cache';
import { createAngularLocalizeInitWarningPlugin } from './angular-localize-init-warning-plugin';
import { BundlerOptionsFactory } from './bundler-context';
import { createCompilerPluginOptions } from './compiler-plugin-options';
import { createExternalPackagesPlugin } from './external-packages-plugin';
import { createAngularLocaleDataPlugin } from './i18n-locale-plugin';
import type { LoadResultCache } from './load-result-cache';
import { createLoaderImportAttributePlugin } from './loader-import-attribute-plugin';
import { createRxjsEsmResolutionPlugin } from './rxjs-esm-resolution-plugin';
import { createServerBundleMetadata } from './server-bundle-metadata-plugin';
import { createSourcemapIgnorelistPlugin } from './sourcemap-ignorelist-plugin';
import { SERVER_GENERATED_EXTERNALS, getFeatureSupport, isZonelessApp } from './utils';
import { createVirtualModulePlugin } from './virtual-module-plugin';
import { createWasmPlugin } from './wasm-plugin';

export function createBrowserCodeBundleOptions(
  options: NormalizedApplicationBuildOptions,
  target: string[],
  sourceFileCache: SourceFileCache,
  stylesheetBundler: ComponentStylesheetBundler,
  angularCompilation: AngularCompilation,
  templateUpdates: Map<string, string> | undefined,
): BundlerOptionsFactory {
  return (loadCache) => {
    const { entryPoints, outputNames, polyfills } = options;
    const zoneless = isZonelessApp(polyfills);

    const pluginOptions = createCompilerPluginOptions(
      options,
      sourceFileCache,
      loadCache,
      templateUpdates,
    );

    const buildOptions: BuildOptions = {
      ...getEsBuildCommonOptions(options),
      platform: 'browser',
      // Note: `es2015` is needed for RxJS v6. If not specified, `module` would
      // match and the ES5 distribution would be bundled and ends up breaking at
      // runtime with the RxJS testing library.
      // More details: https://github.com/angular/angular-cli/issues/25405.
      mainFields: ['es2020', 'es2015', 'browser', 'module', 'main'],
      entryNames: outputNames.bundles,
      entryPoints,
      target,
      supported: getFeatureSupport(target, zoneless),
    };

    buildOptions.plugins ??= [];
    buildOptions.plugins.push(
      createWasmPlugin({ allowAsync: zoneless, cache: loadCache }),
      createAngularLocalizeInitWarningPlugin(),
      createCompilerPlugin(
        // JS/TS options
        pluginOptions,
        angularCompilation,
        // Component stylesheet bundler
        stylesheetBundler,
      ),
    );

    if (options.plugins) {
      buildOptions.plugins.push(...options.plugins);
    }

    return buildOptions;
  };
}

export function createBrowserPolyfillBundleOptions(
  options: NormalizedApplicationBuildOptions,
  target: string[],
  sourceFileCache: SourceFileCache,
  stylesheetBundler: ComponentStylesheetBundler,
): BuildOptions | BundlerOptionsFactory | undefined {
  const namespace = 'angular:polyfills';
  const polyfillBundleOptions = getEsBuildCommonPolyfillsOptions(
    options,
    namespace,
    true,
    sourceFileCache.loadResultCache,
  );
  if (!polyfillBundleOptions) {
    return;
  }

  const { outputNames, polyfills } = options;
  const hasTypeScriptEntries = polyfills?.some((entry) => /\.[cm]?tsx?$/.test(entry));

  const buildOptions: BuildOptions = {
    ...polyfillBundleOptions,
    platform: 'browser',
    // Note: `es2015` is needed for RxJS v6. If not specified, `module` would
    // match and the ES5 distribution would be bundled and ends up breaking at
    // runtime with the RxJS testing library.
    // More details: https://github.com/angular/angular-cli/issues/25405.
    mainFields: ['es2020', 'es2015', 'browser', 'module', 'main'],
    entryNames: outputNames.bundles,
    target,
    entryPoints: {
      'polyfills': namespace,
    },
  };

  // Only add the Angular TypeScript compiler if TypeScript files are provided in the polyfills
  if (hasTypeScriptEntries) {
    buildOptions.plugins ??= [];
    const pluginOptions = createCompilerPluginOptions(
      options,

      sourceFileCache,
    );
    buildOptions.plugins.push(
      createCompilerPlugin(
        // JS/TS options
        pluginOptions,
        // Browser compilation handles the actual Angular code compilation
        new NoopCompilation(),
        // Component stylesheet options are unused for polyfills but required by the plugin
        stylesheetBundler,
      ),
    );
  }

  // Use an options factory to allow fully incremental bundling when no TypeScript files are present.
  // The TypeScript compilation is not currently integrated into the bundler invalidation so
  // cannot be used with fully incremental bundling yet.
  return hasTypeScriptEntries ? buildOptions : () => buildOptions;
}

export function createServerPolyfillBundleOptions(
  options: NormalizedApplicationBuildOptions,
  target: string[],
  loadResultCache: LoadResultCache | undefined,
): BundlerOptionsFactory | undefined {
  const serverPolyfills: string[] = [];
  const polyfillsFromConfig = new Set(options.polyfills);
  const isNodePlatform = options.ssrOptions?.platform !== ExperimentalPlatform.Neutral;

  if (!isZonelessApp(options.polyfills)) {
    serverPolyfills.push(isNodePlatform ? 'zone.js/node' : 'zone.js');
  }

  if (
    polyfillsFromConfig.has('@angular/localize') ||
    polyfillsFromConfig.has('@angular/localize/init')
  ) {
    serverPolyfills.push('@angular/localize/init');
  }

  serverPolyfills.push('@angular/platform-server/init');

  const namespace = 'angular:polyfills-server';
  const polyfillBundleOptions = getEsBuildCommonPolyfillsOptions(
    {
      ...options,
      polyfills: serverPolyfills,
    },
    namespace,
    false,
    loadResultCache,
  );

  if (!polyfillBundleOptions) {
    return;
  }

  const jsBanner: string[] = [];
  if (polyfillBundleOptions.external?.length) {
    jsBanner.push(`globalThis['ngServerMode'] = true;`);
  }

  if (isNodePlatform) {
    // Note: Needed as esbuild does not provide require shims / proxy from ESModules.
    // See: https://github.com/evanw/esbuild/issues/1921.
    jsBanner.push(
      `import { createRequire } from 'node:module';`,
      `globalThis['require'] ??= createRequire(import.meta.url);`,
    );
  }

  const buildOptions: BuildOptions = {
    ...polyfillBundleOptions,
    platform: isNodePlatform ? 'node' : 'neutral',
    outExtension: { '.js': '.mjs' },
    // Note: `es2015` is needed for RxJS v6. If not specified, `module` would
    // match and the ES5 distribution would be bundled and ends up breaking at
    // runtime with the RxJS testing library.
    // More details: https://github.com/angular/angular-cli/issues/25405.
    mainFields: ['es2020', 'es2015', 'module', 'main'],
    entryNames: '[name]',
    banner: {
      js: jsBanner.join('\n'),
    },
    target,
    entryPoints: {
      'polyfills.server': namespace,
    },
  };

  buildOptions.plugins ??= [];
  buildOptions.plugins.push(createServerBundleMetadata());

  return () => buildOptions;
}

export function createServerMainCodeBundleOptions(
  options: NormalizedApplicationBuildOptions,
  target: string[],
  sourceFileCache: SourceFileCache,
  stylesheetBundler: ComponentStylesheetBundler,
): BundlerOptionsFactory {
  const {
    serverEntryPoint: mainServerEntryPoint,
    workspaceRoot,
    outputMode,
    externalPackages,
    ssrOptions,
    polyfills,
  } = options;

  assert(
    mainServerEntryPoint,
    'createServerCodeBundleOptions should not be called without a defined serverEntryPoint.',
  );

  return (loadResultCache) => {
    const pluginOptions = createCompilerPluginOptions(options, sourceFileCache, loadResultCache);
    const mainServerNamespace = 'angular:main-server';
    const mainServerInjectManifestNamespace = 'angular:main-server-inject-manifest';
    const zoneless = isZonelessApp(polyfills);
    const entryPoints: Record<string, string> = {
      'main.server': mainServerNamespace,
    };

    const ssrEntryPoint = ssrOptions?.entry;
    const isOldBehaviour = !outputMode;

    if (ssrEntryPoint && isOldBehaviour) {
      // Old behavior: 'server.ts' was bundled together with the SSR (Server-Side Rendering) code.
      // This approach combined server-side logic and rendering into a single bundle.
      entryPoints['server'] = ssrEntryPoint;
    }

    const buildOptions: BuildOptions = {
      ...getEsBuildServerCommonOptions(options),
      target,
      banner: {
        js: `import './polyfills.server.mjs';`,
      },
      entryPoints,
      supported: getFeatureSupport(target, zoneless),
    };

    buildOptions.plugins ??= [];
    buildOptions.plugins.push(
      createWasmPlugin({ allowAsync: zoneless, cache: loadResultCache }),
      createAngularLocalizeInitWarningPlugin(),
      createCompilerPlugin(
        // JS/TS options
        pluginOptions,
        // Browser compilation handles the actual Angular code compilation
        new NoopCompilation(),
        // Component stylesheet bundler
        stylesheetBundler,
      ),
    );

    if (!externalPackages) {
      buildOptions.plugins.push(createRxjsEsmResolutionPlugin());
    }

    // Mark manifest and polyfills file as external as these are generated by a different bundle step.
    (buildOptions.external ??= []).push(...SERVER_GENERATED_EXTERNALS);
    const isNodePlatform = options.ssrOptions?.platform !== ExperimentalPlatform.Neutral;

    if (!isNodePlatform) {
      // `@angular/platform-server` lazily depends on `xhr2` for XHR usage with the HTTP client.
      // Since `xhr2` has Node.js dependencies, it cannot be used when targeting non-Node.js platforms.
      // Note: The framework already issues a warning when using XHR with SSR.
      buildOptions.external.push('xhr2');
    }

    buildOptions.plugins.push(
      createServerBundleMetadata(),
      createVirtualModulePlugin({
        namespace: mainServerInjectManifestNamespace,
        cache: loadResultCache,
        entryPointOnly: false,
        loadContent: async () => {
          const contents: string[] = [
            // Configure `@angular/ssr` manifest.
            `import manifest from './${SERVER_APP_MANIFEST_FILENAME}';`,
            `import { ɵsetAngularAppManifest } from '@angular/ssr';`,
            `ɵsetAngularAppManifest(manifest);`,
          ];

          return {
            contents: contents.join('\n'),
            loader: 'js',
            resolveDir: workspaceRoot,
          };
        },
      }),
      createVirtualModulePlugin({
        namespace: mainServerNamespace,
        cache: loadResultCache,
        loadContent: async () => {
          const mainServerEntryPointJsImport = entryFileToWorkspaceRelative(
            workspaceRoot,
            mainServerEntryPoint,
          );

          const contents: string[] = [
            // Inject manifest
            `import '${mainServerInjectManifestNamespace}';`,

            // Add @angular/ssr exports
            `export {
              ɵdestroyAngularServerApp,
              ɵextractRoutesAndCreateRouteTree,
              ɵgetOrCreateAngularServerApp,
            } from '@angular/ssr';`,

            // Need for HMR
            `export { ɵresetCompiledComponents } from '@angular/core';`,

            // Re-export all symbols including default export from 'main.server.ts'
            `export { default } from '${mainServerEntryPointJsImport}';`,
            `export * from '${mainServerEntryPointJsImport}';`,
          ];

          return {
            contents: contents.join('\n'),
            loader: 'js',
            resolveDir: workspaceRoot,
          };
        },
      }),
    );

    if (options.plugins) {
      buildOptions.plugins.push(...options.plugins);
    }

    return buildOptions;
  };
}

export function createSsrEntryCodeBundleOptions(
  options: NormalizedApplicationBuildOptions,
  target: string[],
  sourceFileCache: SourceFileCache,
  stylesheetBundler: ComponentStylesheetBundler,
): BundlerOptionsFactory {
  const { workspaceRoot, ssrOptions, externalPackages } = options;
  const serverEntryPoint = ssrOptions?.entry;
  assert(
    serverEntryPoint,
    'createSsrEntryCodeBundleOptions should not be called without a defined serverEntryPoint.',
  );

  return (loadResultCache) => {
    const pluginOptions = createCompilerPluginOptions(options, sourceFileCache, loadResultCache);
    const ssrEntryNamespace = 'angular:ssr-entry';
    const ssrInjectManifestNamespace = 'angular:ssr-entry-inject-manifest';
    const isNodePlatform = options.ssrOptions?.platform !== ExperimentalPlatform.Neutral;

    const jsBanner: string[] = [];
    if (options.externalDependencies?.length) {
      jsBanner.push(`globalThis['ngServerMode'] = true;`);
    }

    if (isNodePlatform) {
      // Note: Needed as esbuild does not provide require shims / proxy from ESModules.
      // See: https://github.com/evanw/esbuild/issues/1921.
      jsBanner.push(
        `import { createRequire } from 'node:module';`,
        `globalThis['require'] ??= createRequire(import.meta.url);`,
      );
    }

    const buildOptions: BuildOptions = {
      ...getEsBuildServerCommonOptions(options),
      target,
      banner: {
        js: jsBanner.join('\n'),
      },
      entryPoints: {
        'server': ssrEntryNamespace,
      },
      supported: getFeatureSupport(target, true),
    };

    buildOptions.plugins ??= [];
    buildOptions.plugins.push(
      createAngularLocalizeInitWarningPlugin(),
      createCompilerPlugin(
        // JS/TS options
        pluginOptions,
        // Browser compilation handles the actual Angular code compilation
        new NoopCompilation(),
        // Component stylesheet bundler
        stylesheetBundler,
      ),
    );

    if (!externalPackages) {
      buildOptions.plugins.push(createRxjsEsmResolutionPlugin());
    }

    // Mark manifest file as external. As this will be generated later on.
    (buildOptions.external ??= []).push('*/main.server.mjs', ...SERVER_GENERATED_EXTERNALS);

    if (!isNodePlatform) {
      // `@angular/platform-server` lazily depends on `xhr2` for XHR usage with the HTTP client.
      // Since `xhr2` has Node.js dependencies, it cannot be used when targeting non-Node.js platforms.
      // Note: The framework already issues a warning when using XHR with SSR.
      buildOptions.external.push('xhr2');
    }

    buildOptions.plugins.push(
      createServerBundleMetadata({ ssrEntryBundle: true }),
      createVirtualModulePlugin({
        namespace: ssrInjectManifestNamespace,
        cache: loadResultCache,
        entryPointOnly: false,
        loadContent: () => {
          const contents: string[] = [
            // Configure `@angular/ssr` app engine manifest.
            `import manifest from './${SERVER_APP_ENGINE_MANIFEST_FILENAME}';`,
            `import { ɵsetAngularAppEngineManifest } from '@angular/ssr';`,
            `ɵsetAngularAppEngineManifest(manifest);`,
          ];

          return {
            contents: contents.join('\n'),
            loader: 'js',
            resolveDir: workspaceRoot,
          };
        },
      }),
      createVirtualModulePlugin({
        namespace: ssrEntryNamespace,
        cache: loadResultCache,
        loadContent: () => {
          const serverEntryPointJsImport = entryFileToWorkspaceRelative(
            workspaceRoot,
            serverEntryPoint,
          );
          const contents: string[] = [
            // Configure `@angular/ssr` app engine manifest.
            `import '${ssrInjectManifestNamespace}';`,

            // Re-export all symbols including default export
            `import * as server from '${serverEntryPointJsImport}';`,
            `export * from '${serverEntryPointJsImport}';`,
            // The below is needed to avoid
            // `Import "default" will always be undefined because there is no matching export` warning when no default is present.
            `const defaultExportName = 'default';`,
            `export default server[defaultExportName]`,

            // Add @angular/ssr exports
            `export { AngularAppEngine } from '@angular/ssr';`,
          ];

          return {
            contents: contents.join('\n'),
            loader: 'js',
            resolveDir: workspaceRoot,
          };
        },
      }),
    );

    if (options.plugins) {
      buildOptions.plugins.push(...options.plugins);
    }

    return buildOptions;
  };
}

function getEsBuildServerCommonOptions(options: NormalizedApplicationBuildOptions): BuildOptions {
  const isNodePlatform = options.ssrOptions?.platform !== ExperimentalPlatform.Neutral;

  const commonOptions = getEsBuildCommonOptions(options);
  commonOptions.define ??= {};
  commonOptions.define['ngServerMode'] = 'true';

  return {
    ...commonOptions,
    platform: isNodePlatform ? 'node' : 'neutral',
    outExtension: { '.js': '.mjs' },
    // Note: `es2015` is needed for RxJS v6. If not specified, `module` would
    // match and the ES5 distribution would be bundled and ends up breaking at
    // runtime with the RxJS testing library.
    // More details: https://github.com/angular/angular-cli/issues/25405.
    mainFields: ['es2020', 'es2015', 'module', 'main'],
    entryNames: '[name]',
  };
}

function getEsBuildCommonOptions(options: NormalizedApplicationBuildOptions): BuildOptions {
  const {
    workspaceRoot,
    outExtension,
    optimizationOptions,
    sourcemapOptions,
    tsconfig,
    externalDependencies,
    outputNames,
    preserveSymlinks,
    jit,
    loaderExtensions,
    jsonLogs,
    i18nOptions,
    customConditions,
    frameworkVersion,
  } = options;

  // Ensure unique hashes for i18n translation changes when using post-process inlining.
  // This hash value is added as a footer to each file and ensures that the output file names (with hashes)
  // change when translation files have changed. If this is not done the post processed files may have
  // different content but would retain identical production file names which would lead to browser caching problems.
  let footer;
  if (i18nOptions.shouldInline) {
    // Update file hashes to include translation file content
    const i18nHash = Object.values(i18nOptions.locales).reduce(
      (data, locale) => data + locale.files.map((file) => file.integrity || '').join('|'),
      '',
    );

    footer = { js: `/**i18n:${createHash('sha256').update(i18nHash).digest('hex')}*/` };
  }

  // Core conditions that are always included
  const conditions = [
    // Required to support rxjs 7.x which will use es5 code if this condition is not present
    'es2015',
    'es2020',
  ];
  // The pre-linked code is not used with JIT for two reasons:
  // 1) The pre-linked code may not have the metadata included that is required for JIT
  // 2) The CLI is otherwise setup to use runtime linking for JIT to match the application template compilation
  if (!jit) {
    // The pre-linked package condition is based on the framework version.
    // Currently this is specific to each patch version of the framework.
    conditions.push('angular:linked-' + frameworkVersion);
  }

  // Append custom conditions if present
  if (customConditions) {
    conditions.push(...customConditions);
  } else {
    // Include default conditions
    conditions.push('module', optimizationOptions.scripts ? 'production' : 'development');
  }

  const plugins: Plugin[] = [
    createLoaderImportAttributePlugin(),
    createSourcemapIgnorelistPlugin(),
  ];

  let packages: BuildOptions['packages'] = 'bundle';
  if (options.externalPackages) {
    // Package files affected by a customized loader should not be implicitly marked as external
    if (
      options.loaderExtensions ||
      options.plugins ||
      typeof options.externalPackages === 'object'
    ) {
      // Plugin must be added after custom plugins to ensure any added loader options are considered
      plugins.push(
        createExternalPackagesPlugin(
          options.externalPackages !== true ? options.externalPackages : undefined,
        ),
      );

      packages = 'bundle';
    } else {
      // Safe to use the packages external option directly
      packages = 'external';
    }
  }

  return {
    absWorkingDir: workspaceRoot,
    format: 'esm',
    bundle: true,
    packages,
    assetNames: outputNames.media,
    conditions,
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.cjs'],
    metafile: true,
    legalComments: options.extractLicenses ? 'none' : 'eof',
    logLevel: options.verbose && !jsonLogs ? 'debug' : 'silent',
    minifyIdentifiers: optimizationOptions.scripts && allowMangle,
    minifySyntax: optimizationOptions.scripts,
    minifyWhitespace: optimizationOptions.scripts,
    pure: ['forwardRef'],
    outdir: workspaceRoot,
    outExtension: outExtension ? { '.js': `.${outExtension}` } : undefined,
    sourcemap: sourcemapOptions.scripts && (sourcemapOptions.hidden ? 'external' : true),
    sourcesContent: sourcemapOptions.sourcesContent,
    splitting: true,
    chunkNames: options.namedChunks ? '[name]-[hash]' : 'chunk-[hash]',
    tsconfig,
    external: externalDependencies ? [...externalDependencies] : undefined,
    write: false,
    preserveSymlinks,
    define: {
      ...options.define,
      // Only set to false when script optimizations are enabled. It should not be set to true because
      // Angular turns `ngDevMode` into an object for development debugging purposes when not defined
      // which a constant true value would break.
      ...(optimizationOptions.scripts ? { 'ngDevMode': 'false' } : undefined),
      'ngJitMode': jit ? 'true' : 'false',
      'ngServerMode': 'false',
      'ngHmrMode': options.templateUpdates ? 'true' : 'false',
    },
    loader: loaderExtensions,
    footer,
    plugins,
  };
}

function getEsBuildCommonPolyfillsOptions(
  options: NormalizedApplicationBuildOptions,
  namespace: string,
  tryToResolvePolyfillsAsRelative: boolean,
  loadResultCache: LoadResultCache | undefined,
): BuildOptions | undefined {
  const { jit, workspaceRoot, i18nOptions } = options;

  const buildOptions = getEsBuildCommonOptions(options);
  buildOptions.splitting = false;
  buildOptions.plugins ??= [];

  let polyfills = options.polyfills ? [...options.polyfills] : [];

  // Angular JIT mode requires the runtime compiler
  if (jit) {
    polyfills.unshift('@angular/compiler');
  }

  // Add Angular's global locale data if i18n options are present.
  // Locale data should go first so that project provided polyfill code can augment if needed.
  let needLocaleDataPlugin = false;
  if (i18nOptions.shouldInline) {
    // Remove localize polyfill as this is not needed for build time i18n.
    polyfills = polyfills.filter((path) => !path.startsWith('@angular/localize'));

    // Add locale data for all active locales
    // TODO: Inject each individually within the inlining process itself
    for (const locale of i18nOptions.inlineLocales) {
      polyfills.unshift(`angular:locale/data:${locale}`);
    }
    needLocaleDataPlugin = true;
  } else if (i18nOptions.hasDefinedSourceLocale) {
    // When not inlining and a source local is present, use the source locale data directly
    polyfills.unshift(`angular:locale/data:${i18nOptions.sourceLocale}`);
    needLocaleDataPlugin = true;
  }
  if (needLocaleDataPlugin) {
    buildOptions.plugins.push(createAngularLocaleDataPlugin());
  }

  if (polyfills.length === 0) {
    return;
  }

  buildOptions.plugins.push(
    createVirtualModulePlugin({
      namespace,
      cache: loadResultCache,
      loadContent: async (_, build) => {
        let polyfillPaths = polyfills;
        let warnings: PartialMessage[] | undefined;

        if (tryToResolvePolyfillsAsRelative) {
          polyfillPaths = await Promise.all(
            polyfills.map(async (path) => {
              if (path.startsWith('zone.js') || !extname(path)) {
                return path;
              }

              const potentialPathRelative = './' + path;
              const result = await build.resolve(potentialPathRelative, {
                kind: 'import-statement',
                resolveDir: workspaceRoot,
              });

              return result.path ? potentialPathRelative : path;
            }),
          );
        }

        // Generate module contents with an import statement per defined polyfill
        let contents = polyfillPaths.map((file) => `import '${toPosixPath(file)}';`).join('\n');

        // The below should be done after loading `$localize` as otherwise the locale will be overridden.
        if (i18nOptions.shouldInline) {
          // When inlining, a placeholder is used to allow the post-processing step to inject the $localize locale identifier.
          contents += '(globalThis.$localize ??= {}).locale = "___NG_LOCALE_INSERT___";\n';
        } else if (i18nOptions.hasDefinedSourceLocale) {
          // If not inlining translations and source locale is defined, inject the locale specifier.
          contents += `(globalThis.$localize ??= {}).locale = "${i18nOptions.sourceLocale}";\n`;
        }

        return {
          contents,
          loader: 'js',
          warnings,
          resolveDir: workspaceRoot,
        };
      },
    }),
  );

  return buildOptions;
}

function entryFileToWorkspaceRelative(workspaceRoot: string, entryFile: string): string {
  return './' + toPosixPath(relative(workspaceRoot, entryFile).replace(/.[mc]?ts$/, ''));
}
