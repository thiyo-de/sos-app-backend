// Test environment setup for server gateway
// This file sets up the test environment and mocks external dependencies

// Mock console to reduce noise
global.console = {
  ...console,
  log: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Suppress unhandled rejection warnings during tests
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection in test:', reason);
});