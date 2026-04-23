/**
 * Navigator Plugins Evasion
 *
 * In headless mode navigator.mimeTypes and navigator.plugins are empty.
 * This evasion emulates both with functional mocks to match regular headful Chrome.
 * Ported from puppeteer-extra-plugin-stealth (MIT License).
 */

import pluginsData from '../data/plugins.json';

export const navigatorPluginsEvasion = `
(function() {
  try {
    const data = ${JSON.stringify(pluginsData)};

    // That means we're running headful
    const hasPlugins = 'plugins' in navigator && navigator.plugins.length;
    if (hasPlugins) {
      return; // nothing to do here
    }

    // Quick helper to set props with the same descriptors vanilla is using
    const defineProp = (obj, prop, value) =>
      Object.defineProperty(obj, prop, {
        value,
        writable: false,
        enumerable: false,
        configurable: true
      });

    // Generate function mocks
    const generateFunctionMocks = (proto, itemMainProp, dataArray) => {
      return {
        item: utils.createProxy(proto.item, {
          apply(target, ctx, args) {
            if (!args.length) {
              throw new TypeError(
                "Failed to execute 'item' on '" + proto[Symbol.toStringTag] +
                "': 1 argument required, but only 0 present."
              );
            }
            return dataArray[args[0]] || null;
          }
        }),
        namedItem: utils.createProxy(proto.namedItem, {
          apply(target, ctx, args) {
            if (!args.length) {
              throw new TypeError(
                "Failed to execute 'namedItem' on '" + proto[Symbol.toStringTag] +
                "': 1 argument required, but only 0 present."
              );
            }
            return dataArray.find(mt => mt[itemMainProp] === args[0]) || null;
          }
        }),
        refresh: proto.refresh
          ? utils.createProxy(proto.refresh, {
              apply(target, ctx, args) {
                return undefined;
              }
            })
          : undefined
      };
    };

    // Generate MimeType array
    const generateMimeTypeArray = () => {
      const mimeTypeArray = [];

      data.mimeTypes.forEach(mimeData => {
        const item = {};
        for (const prop of Object.keys(mimeData)) {
          if (prop.startsWith('__')) continue;
          defineProp(item, prop, mimeData[prop]);
        }

        // Create proper MimeType prototype chain
        const mimeType = Object.create(MimeType.prototype, Object.getOwnPropertyDescriptors(item));
        mimeTypeArray.push(mimeType);
      });

      // Add named access
      mimeTypeArray.forEach(mt => {
        defineProp(mimeTypeArray, mt.type, mt);
      });

      const arrayObj = Object.create(MimeTypeArray.prototype, {
        ...Object.getOwnPropertyDescriptors(mimeTypeArray),
        length: {
          value: mimeTypeArray.length,
          writable: false,
          enumerable: false,
          configurable: true
        }
      });

      const funcMocks = generateFunctionMocks(MimeTypeArray.prototype, 'type', mimeTypeArray);

      return new Proxy(arrayObj, {
        get(target, key) {
          if (key === 'item') return funcMocks.item;
          if (key === 'namedItem') return funcMocks.namedItem;
          return utils.cache.Reflect.get(target, key);
        },
        ownKeys(target) {
          const keys = [];
          mimeTypeArray.forEach((_, i) => keys.push(String(i)));
          mimeTypeArray.forEach(mt => keys.push(mt.type));
          return keys;
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'length') return undefined;
          return Reflect.getOwnPropertyDescriptor(target, prop);
        }
      });
    };

    // Generate Plugin array
    const generatePluginArray = (mimeTypes) => {
      const pluginArray = [];

      data.plugins.forEach(pluginData => {
        const item = {};
        for (const prop of Object.keys(pluginData)) {
          if (prop.startsWith('__')) continue;
          defineProp(item, prop, pluginData[prop]);
        }

        // Add length property for plugins
        const descriptor = {
          ...Object.getOwnPropertyDescriptors(item),
          length: {
            value: pluginData.__mimeTypes.length,
            writable: false,
            enumerable: false,
            configurable: true
          }
        };

        const plugin = Object.create(Plugin.prototype, descriptor);

        // Cross-reference mimeTypes
        pluginData.__mimeTypes.forEach((type, index) => {
          const mimeType = mimeTypes.find(mt => mt.type === type);
          if (mimeType) {
            plugin[index] = mimeType;
            defineProp(plugin, type, mimeType);
            // Set enabledPlugin back reference
            Object.defineProperty(mimeType, 'enabledPlugin', {
              value: plugin,
              writable: false,
              enumerable: false,
              configurable: true
            });
          }
        });

        pluginArray.push(plugin);
      });

      // Add named access
      pluginArray.forEach(p => {
        defineProp(pluginArray, p.name, p);
      });

      const arrayObj = Object.create(PluginArray.prototype, {
        ...Object.getOwnPropertyDescriptors(pluginArray),
        length: {
          value: pluginArray.length,
          writable: false,
          enumerable: false,
          configurable: true
        }
      });

      const funcMocks = generateFunctionMocks(PluginArray.prototype, 'name', pluginArray);

      return new Proxy(arrayObj, {
        get(target, key) {
          if (key === 'item') return funcMocks.item;
          if (key === 'namedItem') return funcMocks.namedItem;
          if (key === 'refresh') return funcMocks.refresh;
          return utils.cache.Reflect.get(target, key);
        },
        ownKeys(target) {
          const keys = [];
          pluginArray.forEach((_, i) => keys.push(String(i)));
          pluginArray.forEach(p => keys.push(p.name));
          return keys;
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'length') return undefined;
          return Reflect.getOwnPropertyDescriptor(target, prop);
        }
      });
    };

    // Generate and apply
    const mimeTypesProxy = generateMimeTypeArray();
    const mimeTypesArray = Array.from({ length: mimeTypesProxy.length }, (_, i) => mimeTypesProxy[i]);
    const pluginsProxy = generatePluginArray(mimeTypesArray);

    const patchNavigator = (name, value) =>
      utils.replaceProperty(Object.getPrototypeOf(navigator), name, {
        get() {
          return value;
        }
      });

    patchNavigator('mimeTypes', mimeTypesProxy);
    patchNavigator('plugins', pluginsProxy);
  } catch (err) {
    console.error('[stealth] navigator.plugins evasion error:', err);
  }
})();
`;
