'use strict';

function choice(name, value, values, fallback) {
  const result = String(value || fallback).trim().toLowerCase();
  if (!values.includes(result)) throw new Error(`${name} must be ${values.join(', ')}.`);
  return result;
}

function playerConfig(env = process.env) {
  return {
    perception: choice('JEV_PERCEPTION', env.JEV_PERCEPTION, ['player', 'unrestricted'], 'player'),
    coordinates: choice('JEV_COORDINATES', env.JEV_COORDINATES, ['hud', 'relative', 'off'], 'hud'),
    actions: choice('JEV_ACTIONS', env.JEV_ACTIONS, ['natural', 'unrestricted'], 'natural'),
    cooperation: choice('JEV_COOPERATION', env.JEV_COOPERATION, ['ask', 'off'], 'ask'),
    loader: choice('MC_LOADER', env.MC_LOADER, ['vanilla', 'fabric', 'forge', 'neoforge'], 'vanilla'),
  };
}

function playerMessage(message, { coordinates = 'hud', language = 'en-US' } = {}) {
  if (coordinates === 'hud' || typeof message !== 'string' || message.trimStart().startsWith('/')) return message;
  const place = language === 'pt-BR' ? 'no local observado' : 'at the observed location';
  return message.replace(/(?:\b(?:at|em)\s*)?\(?-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\)?/g, place)
    .replace(/\b[xyz]\s*[:=]\s*-?\d+(?:\.\d+)?(?:\s*[,;]?\s*[xyz]\s*[:=]\s*-?\d+(?:\.\d+)?){1,2}/gi, place);
}

module.exports = { playerConfig, playerMessage };
