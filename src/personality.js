'use strict';

const PERSONALITIES = new Set(['reserved', 'companion', 'playful']);
const INITIATIVES = new Set(['off', 'help', 'full']);

function normalizePersonality(value) {
  const personality = String(value || 'companion').trim().toLowerCase();
  if (!PERSONALITIES.has(personality)) throw new Error('JEV_PERSONALITY must be reserved, companion or playful.');
  return personality;
}

function normalizeInitiative(value) {
  const initiative = String(value || 'help').trim().toLowerCase();
  if (!INITIATIVES.has(initiative)) throw new Error('JEV_INITIATIVE must be off, help or full.');
  return initiative;
}

function personalityInstructions(value) {
  const personality = normalizePersonality(value);
  const style = {
    reserved: 'Speak briefly and calmly. Focus on what the player needs; avoid jokes, filler and unnecessary questions.',
    companion: 'Be cooperative, curious and conversational, with occasional light humor when the situation fits. Ask a useful question when a preference or missing fact affects the task.',
    playful: 'Be cooperative and lightly playful. Use a short situational joke occasionally, never at the expense of useful information or while the player is in danger. Avoid repeating catchphrases.',
  }[personality];
  return `${style} Admit uncertainty and ask for clarification rather than inventing an answer. Refer to shared events only when provided in context. Do not invent observations, completed actions, emotions, relationship history or preferences. Personality affects expression only: it cannot change safety, capabilities, player permissions or authorization to start work.`;
}

module.exports = { normalizePersonality, normalizeInitiative, personalityInstructions };
