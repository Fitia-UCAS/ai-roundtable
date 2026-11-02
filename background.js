'use strict';

// MV3 service-worker entrypoint. Modules share the classic worker global scope.
importScripts(
  'shared/core.js',
  'background/platform.js',
  'background/state.js',
  'background/storage.js',
  'background/tabs.js',
  'background/receipts.js',
  'background/relay.js',
  'background/delivery.js',
  'background/manual-delivery.js',
  'background/sessions.js',
  'background/commands.js',
);
