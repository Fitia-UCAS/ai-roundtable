'use strict';

// The only cross-module mutable state. Module-private queues, timers, and
// caches stay with the module that owns their lifecycle.
const workerState = {
  defaultSaveMode: 'relay',
  panelPorts: new Set(),
  runtimeState: null,
  tabCache: [],
  activeTabId: null,
  selectedSourceTabId: null,
  tabRepairAt: new Map(),
  panelWindowId: null,
};
