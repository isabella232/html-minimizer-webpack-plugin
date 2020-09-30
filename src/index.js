import os from 'os';

import RequestShortener from 'webpack/lib/RequestShortener';
import webpack, {
  ModuleFilenameHelpers,
  version as webpackVersion,
} from 'webpack';
import validateOptions from 'schema-utils';

import schema from './options.json';

import { minify as minifyFn } from './minify';

// webpack 5 exposes the sources property to ensure the right version of webpack-sources is used
const { RawSource } =
  // eslint-disable-next-line global-require
  webpack.sources || require('webpack-sources');

class HtmlMinimizerPlugin {
  constructor(options = {}) {
    validateOptions(schema, options, {
      name: 'Html Minimizer Plugin',
      baseDataPath: 'options',
    });

    const {
      minify,
      minimizerOptions = {},
      test = /\.html(\?.*)?$/i,
      cache = true,
      cacheKeys = (defaultCacheKeys) => defaultCacheKeys,
      parallel = true,
      include,
      exclude,
    } = options;

    this.options = {
      test,
      cache,
      cacheKeys,
      parallel,
      include,
      exclude,
      minify,
      minimizerOptions,
    };
  }

  static buildError(error, file, sourceMap, requestShortener) {
    if (error.line) {
      const original =
        sourceMap &&
        sourceMap.originalPositionFor({
          line: error.line,
          column: error.column,
        });

      if (original && original.source && requestShortener) {
        return new Error(
          `${file} from Html Minimizer Webpack Plugin\n${
            error.message
          } [${requestShortener.shorten(original.source)}:${original.line},${
            original.column
          }][${file}:${error.line},${error.column}]${
            error.stack
              ? `\n${error.stack.split('\n').slice(1).join('\n')}`
              : ''
          }`
        );
      }

      return new Error(
        `${file} from Html Minimizer \n${error.message} [${file}:${
          error.line
        },${error.column}]${
          error.stack ? `\n${error.stack.split('\n').slice(1).join('\n')}` : ''
        }`
      );
    }

    if (error.stack) {
      return new Error(`${file} from Html Minimizer\n${error.stack}`);
    }

    return new Error(`${file} from Html Minimizer\n${error.message}`);
  }

  static getAvailableNumberOfCores(parallel) {
    // In some cases cpus() returns undefined
    // https://github.com/nodejs/node/issues/19022
    const cpus = os.cpus() || { length: 1 };

    return parallel === true
      ? cpus.length - 1
      : Math.min(Number(parallel) || 0, cpus.length - 1);
  }

  // eslint-disable-next-line consistent-return
  static getAsset(compilation, name) {
    // New API
    if (compilation.getAsset) {
      return compilation.getAsset(name);
    }

    if (compilation.assets[name]) {
      return { name, source: compilation.assets[name], info: {} };
    }
  }

  static updateAsset(compilation, name, newSource, assetInfo) {
    // New API
    if (compilation.updateAsset) {
      compilation.updateAsset(name, newSource, assetInfo);
    }

    // eslint-disable-next-line no-param-reassign
    compilation.assets[name] = newSource;
  }

  async optimize(compiler, compilation, assets) {
    const matchObject = ModuleFilenameHelpers.matchObject.bind(
      // eslint-disable-next-line no-undefined
      undefined,
      this.options
    );

    const assetNames = Object.keys(
      typeof assets === 'undefined' ? compilation.assets : assets
    ).filter((assetName) => matchObject(assetName));

    if (assetNames.length === 0) {
      return Promise.resolve();
    }

    const scheduledTasks = [];

    for (const assetName of assetNames) {
      scheduledTasks.push(
        (async () => {
          const { source: assetSource, info } = HtmlMinimizerPlugin.getAsset(
            compilation,
            assetName
          );

          // Skip double minimize assets from child compilation
          if (info.minimized) {
            return;
          }

          let input = assetSource.source();

          if (Buffer.isBuffer(input)) {
            input = input.toString();
          }

          let output;

          try {
            const minimizerOptions = {
              assetName,
              input,
              minimizerOptions: this.options.minimizerOptions,
              minify: this.options.minify,
            };

            output = await minifyFn(minimizerOptions);
          } catch (error) {
            compilation.errors.push(
              HtmlMinimizerPlugin.buildError(
                error,
                assetName,
                new RequestShortener(compiler.context)
              )
            );

            return;
          }

          output.source = new RawSource(output.html);

          HtmlMinimizerPlugin.updateAsset(
            compilation,
            assetName,
            output.source,
            {
              ...info,
              minimized: true,
            }
          );
        })()
      );
    }

    return Promise.all(scheduledTasks);
  }

  static isWebpack4() {
    return webpackVersion[0] === '4';
  }

  apply(compiler) {
    const pluginName = this.constructor.name;
    const weakCache = new WeakMap();

    compiler.hooks.compilation.tap(pluginName, (compilation) => {
      if (HtmlMinimizerPlugin.isWebpack4()) {
        // eslint-disable-next-line global-require
        const CacheEngine = {};

        compilation.hooks.optimizeChunkAssets.tapPromise(pluginName, () => {
          return this.optimize(
            compiler,
            compilation,
            // eslint-disable-next-line no-undefined
            undefined,
            CacheEngine,
            weakCache
          );
        });
      } else {
        if (this.options.sourceMap) {
          compilation.hooks.buildModule.tap(pluginName, (moduleArg) => {
            // to get detailed location info about errors
            // eslint-disable-next-line no-param-reassign
            moduleArg.useSourceMap = true;
          });
        }

        // eslint-disable-next-line global-require
        const CacheEngine = {};

        // eslint-disable-next-line global-require
        const Compilation = require('webpack/lib/Compilation');

        compilation.hooks.processAssets.tapPromise(
          {
            name: pluginName,
            stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE,
          },
          (assets) => this.optimize(compiler, compilation, assets, CacheEngine)
        );

        compilation.hooks.statsPrinter.tap(pluginName, (stats) => {
          stats.hooks.print
            .for('asset.info.minimized')
            .tap(
              'html-minimizer-webpack-plugin',
              (minimized, { green, formatFlag }) =>
                // eslint-disable-next-line no-undefined
                minimized ? green(formatFlag('minimized')) : undefined
            );
        });
      }
    });
  }
}

export default HtmlMinimizerPlugin;
