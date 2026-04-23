/**
 * Chrome Runtime Evasion
 *
 * Mock the chrome.runtime object if not available (e.g. when running headless) and on a secure site.
 * Ported from puppeteer-extra-plugin-stealth (MIT License).
 */

import chromeRuntimeData from '../data/chrome-runtime.json';

export const chromeRuntimeEvasion = `
(function() {
  try {
    const STATIC_DATA = ${JSON.stringify(chromeRuntimeData)};

    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        writable: true,
        enumerable: true,
        configurable: false,
        value: {}
      });
    }

    const existsAlready = 'runtime' in window.chrome;
    const isNotSecure = !window.location.protocol.startsWith('https');
    if (existsAlready || isNotSecure) {
      return; // Nothing to do here
    }

    window.chrome.runtime = {
      ...STATIC_DATA,
      get id() {
        return undefined;
      },
      connect: null,
      sendMessage: null
    };

    const makeCustomRuntimeErrors = (preamble, method, extensionId) => ({
      NoMatchingSignature: new TypeError(
        preamble + 'No matching signature.'
      ),
      MustSpecifyExtensionID: new TypeError(
        preamble +
          method + ' called from a webpage must specify an Extension ID (string) for its first argument.'
      ),
      InvalidExtensionID: new TypeError(
        preamble + "Invalid extension id: '" + extensionId + "'"
      )
    });

    const isValidExtensionID = str =>
      str.length === 32 && str.toLowerCase().match(/^[a-p]+$/);

    const sendMessageHandler = {
      apply: function(target, ctx, args) {
        const [extensionId, options, responseCallback] = args || [];

        const errorPreamble = 'Error in invocation of runtime.sendMessage(optional string extensionId, any message, optional object options, optional function responseCallback): ';
        const Errors = makeCustomRuntimeErrors(
          errorPreamble,
          'chrome.runtime.sendMessage()',
          extensionId
        );

        const noArguments = args.length === 0;
        const tooManyArguments = args.length > 4;
        const incorrectOptions = options && typeof options !== 'object';
        const incorrectResponseCallback =
          responseCallback && typeof responseCallback !== 'function';
        if (
          noArguments ||
          tooManyArguments ||
          incorrectOptions ||
          incorrectResponseCallback
        ) {
          throw Errors.NoMatchingSignature;
        }

        if (args.length < 2) {
          throw Errors.MustSpecifyExtensionID;
        }

        if (typeof extensionId !== 'string') {
          throw Errors.NoMatchingSignature;
        }

        if (!isValidExtensionID(extensionId)) {
          throw Errors.InvalidExtensionID;
        }

        return undefined;
      }
    };
    utils.mockWithProxy(
      window.chrome.runtime,
      'sendMessage',
      function sendMessage() {},
      sendMessageHandler
    );

    const connectHandler = {
      apply: function(target, ctx, args) {
        const [extensionId, connectInfo] = args || [];

        const errorPreamble = 'Error in invocation of runtime.connect(optional string extensionId, optional object connectInfo): ';
        const Errors = makeCustomRuntimeErrors(
          errorPreamble,
          'chrome.runtime.connect()',
          extensionId
        );

        const noArguments = args.length === 0;
        const emptyStringArgument = args.length === 1 && extensionId === '';
        if (noArguments || emptyStringArgument) {
          throw Errors.MustSpecifyExtensionID;
        }

        const tooManyArguments = args.length > 2;
        const incorrectConnectInfoType =
          connectInfo && typeof connectInfo !== 'object';

        if (tooManyArguments || incorrectConnectInfoType) {
          throw Errors.NoMatchingSignature;
        }

        const extensionIdIsString = typeof extensionId === 'string';
        if (extensionIdIsString && extensionId === '') {
          throw Errors.MustSpecifyExtensionID;
        }
        if (extensionIdIsString && !isValidExtensionID(extensionId)) {
          throw Errors.InvalidExtensionID;
        }

        const validateConnectInfo = ci => {
          if (args.length > 1) {
            throw Errors.NoMatchingSignature;
          }
          if (Object.keys(ci).length === 0) {
            throw Errors.MustSpecifyExtensionID;
          }
          Object.entries(ci).forEach(([k, v]) => {
            const isExpected = ['name', 'includeTlsChannelId'].includes(k);
            if (!isExpected) {
              throw new TypeError(
                errorPreamble + "Unexpected property: '" + k + "'."
              );
            }
            const MismatchError = (propName, expected, found) =>
              TypeError(
                errorPreamble +
                  "Error at property '" + propName + "': Invalid type: expected " + expected + ", found " + found + "."
              );
            if (k === 'name' && typeof v !== 'string') {
              throw MismatchError(k, 'string', typeof v);
            }
            if (k === 'includeTlsChannelId' && typeof v !== 'boolean') {
              throw MismatchError(k, 'boolean', typeof v);
            }
          });
        };
        if (typeof extensionId === 'object') {
          validateConnectInfo(extensionId);
          throw Errors.MustSpecifyExtensionID;
        }

        return utils.patchToStringNested(makeConnectResponse());
      }
    };
    utils.mockWithProxy(
      window.chrome.runtime,
      'connect',
      function connect() {},
      connectHandler
    );

    function makeConnectResponse() {
      const onSomething = () => ({
        addListener: function addListener() {},
        dispatch: function dispatch() {},
        hasListener: function hasListener() {},
        hasListeners: function hasListeners() {
          return false;
        },
        removeListener: function removeListener() {}
      });

      const response = {
        name: '',
        sender: undefined,
        disconnect: function disconnect() {},
        onDisconnect: onSomething(),
        onMessage: onSomething(),
        postMessage: function postMessage() {
          if (!arguments.length) {
            throw new TypeError('Insufficient number of arguments.');
          }
          throw new Error('Attempting to use a disconnected port object');
        }
      };
      return response;
    }
  } catch (err) {}
})();
`;
