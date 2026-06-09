#!/usr/bin/env node

// Suppress Node deprecation warnings (e.g. punycode)
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
    return;
  }
  console.warn(warning.message || warning);
});

// Dynamically import the main module to ensure warning listeners are in place first
await import('../dist/index.js');
