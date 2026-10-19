'use strict';
const { friendlyProblem, recoveryHint, activity, name } = require('./speech');
const { localize } = require('./language');

function statusMessage(bot, active, saved) {
  const say = (english, portuguese) => localize(bot, english, portuguese);
  const goal = active && !active.idle ? active.goal : saved;
  const messages = [];
  if (goal) {
    if (goal.status === 'complete') messages.push(say('I finished your last task.', 'Terminei sua última tarefa.'));
    else if (goal.status === 'cancelled' || goal.status === 'interrupted') messages.push(say('I stopped. Say "Jev resume" when you want me to carry on.', 'Parei. Diga "Jev resume" quando quiser que eu continue.'));
    else if (goal.recoveryAdvice?.active) messages.push(say("I'm stuck. I need to think for a bit.", 'Fiquei preso. Preciso pensar um pouco.'));
    else if (goal.status === 'blocked') messages.push(`${friendlyProblem(goal.lastError, { bot })} ${recoveryHint(goal.lastError, bot)}`);
    else messages.push(activity(goal.step, bot));
    // The dream has a ladder; say which rung, and where home is.
    if (goal.kind === 'win') {
      const rung = goal.gameProgress?.phase;
      messages.unshift(say(`Beating the game${rung ? `, on the ${name(rung)} rung` : ''}.`, `Zerando o jogo${rung ? `, na etapa de ${name(rung, bot)}` : ''}.`));
      const home = goal.survival?.home;
      if (home?.bed?.claimedAt) messages.push(say(`Base at ${home.origin.x}, ${home.origin.z}.`, `Base em ${home.origin.x}, ${home.origin.z}.`));
    }
    if (goal.dream === 'custom' && goal.status !== 'complete') messages.unshift(say(`Working on my dream: ${goal.request}.`, `Estou realizando meu sonho: ${goal.request}.`));
    if (goal.kind === 'bundle') {
      const done = goal.tasks.filter(t => t.status === 'complete').length, next = goal.tasks.find(t => t.status !== 'complete');
      messages.push(say(`${done} of ${goal.tasks.length} things done.${next ? ` Next: ${name(next.item)}.` : ''}`, `${done} de ${goal.tasks.length} itens concluídos.${next ? ` Próximo: ${name(next.item, bot)}.` : ''}`));
    }
  }
  if (active?.idle) {
    const idle = active.goal;
    messages.push(idle.survivalAction ? activity(idle.survivalAction, bot) : say("I'm nearby and ready to help.", 'Estou por perto e pronto para ajudar.'));
  }
  return messages.join(' ') || say("I'm ready. What should we do?", 'Estou pronto. O que vamos fazer?');
}

module.exports = { statusMessage };
