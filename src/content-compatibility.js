'use strict';

const { playerConfig } = require('./player-config');
const FAMILY = /^26\.1(?:\.\d+)?$/;
const identifier = value => typeof value === 'string' && /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]{1,120}$/.test(value);

// Adapters are injected by trusted integration code, never loaded from model
// output or an executable path in a user-supplied content manifest.
function contentCompatibility({ env = process.env, adapter = null, registry = null } = {}) {
  const config = playerConfig(env);
  const requested = env.MC_VERSION && env.MC_VERSION !== 'false' ? String(env.MC_VERSION) : null;
  if (adapter) {
    if (typeof adapter.id !== 'string' || !Array.isArray(adapter.loaders) || !adapter.loaders.includes(config.loader) ||
      typeof adapter.supportsVersion !== 'function' || typeof adapter.supportsItem !== 'function' ||
      typeof adapter.describe !== 'function') throw new Error('A content adapter must declare its loader, version and item capabilities.');
    if (requested && !adapter.supportsVersion(requested)) throw new Error(`The content adapter does not support Minecraft ${requested}.`);
    return { adapter: adapter.id, loader: config.loader, minecraftVersion: requested, status: 'adapter_required_at_runtime',
      customContent: true, capabilities: adapter.describe(), supportsItem: item => identifier(item) && adapter.supportsItem(item, registry) === true };
  }
  const reasons = [];
  if (['forge', 'neoforge'].includes(config.loader)) reasons.push('The built-in client has no Forge/NeoForge networking adapter.');
  if (requested && !FAMILY.test(requested)) reasons.push('The built-in acquisition catalog is for Minecraft 26.1; another version needs a matching content adapter.');
  return { adapter: 'vanilla-26.1', loader: config.loader, minecraftVersion: requested,
    status: reasons.length ? 'unsupported' : config.loader === 'fabric' ? 'vanilla_protocol_only' : 'vanilla',
    customContent: false, reasons,
    capabilities: ['vanilla_items', 'vanilla_recipes', 'vanilla_smelting', 'vanilla_interactions'],
    supportsItem: item => identifier(item) && (!item.includes(':') || item.startsWith('minecraft:')) &&
      (!registry || Object.hasOwn(registry.itemsByName || {}, item.replace(/^minecraft:/, ''))) };
}

function assertContentCompatibility(options = {}) {
  const report = contentCompatibility(options);
  if (report.status === 'unsupported') throw new Error(`Unsupported content configuration: ${report.reasons.join(' ')} Select a concrete modpack/version and install its client/content adapter.`);
  return report;
}

module.exports = { contentCompatibility, assertContentCompatibility };
