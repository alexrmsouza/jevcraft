'use strict';
require('../src/env').loadEnv();
const { contentCompatibility } = require('../src/content-compatibility');
try {
  const report = contentCompatibility();
  console.log(JSON.stringify(report, (key, value) => typeof value === 'function' ? undefined : value, 2));
  process.exitCode = report.status === 'unsupported' ? 1 : 0;
} catch (error) { console.error(error.message); process.exitCode = 1; }
