'use strict';
// Player chat uses short, everyday language. Full engine errors and decision
// traces stay in saved state and logs, where debugging details belong.
const { isPortuguese, localize, displayName } = require('./language');
const PHASES_PT = {
  iron_armour: 'armadura de ferro', leather_armour: 'armadura de couro', diamond_armour: 'armadura de diamante',
  obtain_blaze_rods: 'conseguir varas de blaze', obtain_ender_pearls: 'conseguir pérolas do End', enter_nether: 'entrar no Nether',
  find_fortress: 'encontrar uma fortaleza', find_stronghold: 'encontrar uma fortaleza do End', enter_end: 'entrar no End',
  defeat_dragon: 'derrotar o dragão', return_home: 'voltar para casa', return_alive: 'voltar vivo', return_overworld: 'voltar à superfície',
  nether_pickaxe: 'picaretas para o Nether', nether_blocks: 'blocos para o Nether', nether_food: 'comida para o Nether', nether_chest: 'baú para o Nether',
  home_site: 'escolher o lugar da base', home_level: 'nivelar a base', home_stash: 'baú da base', home_bed: 'cama da base', home_water: 'água na base', home_plot: 'plantação da base', home_pen: 'curral da base',
  craft_eyes: 'fazer olhos do End', fill_end_portal: 'completar o portal do End', eyes_out: 'levar os olhos do End à superfície',
  collect_rod_stash: 'buscar as varas de blaze guardadas', return_with_blaze_supplies: 'voltar com os materiais de blaze',
  restock_supplies: 'reabastecer materiais', unknown_dimension: 'localizar a dimensão', errand: 'buscar materiais', complete: 'conclusão',
  carry_bed: 'levar uma cama', bed: 'cama', arrows: 'flechas', blocks: 'blocos', food: 'comida', portal: 'portal',
};
const name = (value, language) => isPortuguese(language) ? (PHASES_PT[value] || (value ? displayName(value, language) : 'itens')) : String(value || 'items').replace(/^minecraft:/, '').replaceAll('_', ' ');
const list = (tasks, language) => tasks.map(t => `${t.count} ${name(t.item, language)}`).join(', ');

// Not every blocker can be retried. Once the world no longer matches the saved
// plan, resume fails the same way every time, so name what does help instead.
const REPLAN = /building site changed/i;
// Radians of yaw either side of where Jev was already facing: a glance around
// while it ponders, never a full spin.
const SWAY = [-.55, .35, -.15, .7, .1, -.4];
function recoveryHint(error, language) {
  if (isPortuguese(language)) return REPLAN.test(String(error?.message || error || ''))
    ? (error?.waitOn ? 'Quebre esse bloco e eu continuo sozinho, ou peça a construção de novo para eu escolher outro lugar.' : 'Peça a construção de novo e eu escolho outro lugar.')
    : 'Diga "Jev resume" para tentar de novo.';
  return REPLAN.test(String(error?.message || error || ''))
    ? (error?.waitOn ? "Break it and I'll carry on by myself, or ask me to build it again and I'll pick a fresh spot." : 'Ask me to build it again and I will pick a fresh spot.')
    : 'Say "Jev resume" to try again.';
}

// Model calls and long searches leave the body perfectly still, which reads as
// "it did not hear me" rather than "it is thinking". A bare arm swing is the
// only safe emote here: it writes one arm_animation packet and touches no
// physics, controls or rotation. Looking around would fight the flight
// controller and boat paddling, which rewrite yaw every tick; sneaking would
// corrupt the deliberate sneak in placement and navigation recovery. Repeated
// chat is not an option either, because vanilla kicks for spam.
function thinking(bot, intervalMs = 1500) {
  if (typeof bot?.swingArm !== 'function') return () => {};
  const swing = () => { try { bot.swingArm('right'); } catch (_) { /* a closed socket is not worth reporting */ } };
  // Where Jev was facing before it started pondering, to be given back at the
  // end so a think never leaves it staring off in a new direction.
  const home = bot.entity && Number.isFinite(bot.entity.yaw) ? { yaw: bot.entity.yaw, pitch: bot.entity.pitch } : null;
  const canLook = home && typeof bot.look === 'function';
  const glance = (yaw, pitch) => {
    try { Promise.resolve(bot.look(yaw, pitch, true)).catch(() => {}); } catch (_) { /* as above */ }
  };
  // Looking around is only safe while Jev is standing still. The navigator
  // aims the head every tick while it flies or walks, and an emote must never
  // fight it for that; comparing position beat to beat needs no knowledge of
  // which subsystem is driving.
  let previous = bot.entity?.position?.clone?.() || null, beat = 0;
  const tick = () => {
    const here = bot.entity?.position;
    const still = here && previous && here.distanceTo(previous) < .05;
    if (here?.clone) previous = here.clone();
    // An even beat reads as a stuck animation rather than as thought, so the
    // arm rests every third one and the head drifts on its own longer cycle.
    if (beat % 3 !== 2) swing();
    if (still && canLook) glance(home.yaw + SWAY[beat % SWAY.length], home.pitch + (beat % 4 === 0 ? -.3 : .12));
    beat++;
  };
  swing(); beat = 1;
  const timer = setInterval(tick, Math.max(200, Math.round(intervalMs / 2)));
  timer.unref?.();
  return () => {
    clearInterval(timer);
    if (canLook) glance(home.yaw, home.pitch);
  };
}

// One rule for everything the bot says: the same line twice in short
// succession is a stuck bot, not news. Installed once on the bot, it drops an
// exact repeat within the window, except when a player spoke a moment ago,
// because "Jev status" asked twice deserves the same answer twice.
const CHAT_BURST = 5, CHAT_EVERY_MS = 1200;
// The chat packet's sender is the bot itself: by its uuid, else its name.
const plainName = n => typeof n === 'string' ? n.replace(/§./g, '') : n?.toString?.() || JSON.stringify(n ?? '');
function ownLine(bot, data) {
  const uuid = bot._client?.uuid || bot.player?.uuid;
  const norm = u => String(u || '').replaceAll('-', '').toLowerCase();
  if (data?.sender && uuid) return norm(data.sender) === norm(uuid);
  return !!bot.username && plainName(data?.senderName).includes(bot.username);
}
function quietRepeats(bot, { windowMs = 120000, replyMs = 15000 } = {}) {
  if (typeof bot?.chat !== 'function' || bot._quietRepeats) return bot;
  const original = bot.chat.bind(bot), said = new Map();
  bot._quietRepeats = { dropped: 0 };
  // A player's, not the bot's own line coming back from the server: that
  // echo counted as a player speaking, so every line the bot said let the
  // next fifteen seconds of repeats through. 25591 said "I'm getting nowhere
  // with the rods waiting. Trying another way." four times in 1.3 seconds
  // (note 697).
  bot._client?.on?.('playerChat', data => { if (!ownLine(bot, data)) bot._lastPlayerChatAt = Date.now(); });
  // And no faster than the server allows: vanilla counts twenty a message
  // against a limit of two hundred, less one a tick, and kicks for spam
  // past it. mid-229-b, its wool search spinning twenty times a second and
  // saying a changing line each time, was kicked 230 times in three hours
  // (2026-09-26). A burst of five, then one each 1.2 seconds; the rest is
  // dropped, not queued (a queue would say stale things late).
  let tokens = CHAT_BURST, filledAt = Date.now();
  bot.chat = message => {
    const text = String(message), now = Date.now();
    tokens = Math.min(CHAT_BURST, tokens + (now - filledAt) / CHAT_EVERY_MS); filledAt = now;
    const answering = now - (bot._lastPlayerChatAt || 0) < replyMs;
    if (!answering && said.has(text) && now - said.get(text) < windowMs) { bot._quietRepeats.dropped++; return; }
    if (tokens < 1) { bot._quietRepeats.dropped++; bot._quietRepeats.throttled = (bot._quietRepeats.throttled || 0) + 1; return; }
    tokens -= 1;
    said.set(text, now);
    if (said.size > 64) said.delete(said.keys().next().value);
    return original(message);
  };
  return bot;
}

// What to say when a request could not be understood. "Say it another
// way" was the answer to everything, including a Jev outage (rephrasing
// cannot fix that), a command that needed one more detail, and a list of
// twenty items, each of which had its own useful message that was thrown
// away.
const SAY_AS_IS = /Please request at most|spans too many catalog branches|Unknown movement target|Invalid item quantity/;
function intakeProblem(error, language) {
  const text = String(error?.message || error || '');
  if (error?.name === 'CommandClarification' || SAY_AS_IS.test(text)) {
    if (isPortuguese(language)) return /movement target/.test(text) ? 'Não sei até quem você quer que eu vá. Diga o nome de um jogador que esteja online.'
      : /item quantity/.test(text) ? 'Não entendi a quantidade. Diga um número.'
        : /at most (\d+)/.test(text) ? `Peça no máximo ${text.match(/at most (\d+)/)[1]} tipos de item por vez.`
          : /catalog branches/.test(text) ? 'Esse pedido reúne itens de muitos tipos diferentes. Divida em pedidos menores.'
            : 'Preciso de mais detalhes para esse comando. Diga o alvo e o que você quer fazer.';
    return /movement target/.test(text) ? "I don't know who you want me to go to. Name a player who's online." :
      /item quantity/.test(text) ? "I couldn't work out how many you want. Give me a number." : text;
  }
  if (error?.name === 'TypeSafeError' || /API|TypeSafe|fetch|network|timeout|timed out|ECONN|socket/i.test(text)) {
    return localize(language, 'I\'m having trouble thinking right now. Please try again in a moment; "Jev stop" and "Jev status" still work.', 'Estou com dificuldade para pensar agora. Tente de novo daqui a pouco; "Jev stop" e "Jev status" continuam funcionando.');
  }
  return localize(language, 'I had trouble understanding that. Please try saying it another way.', 'Não consegui entender esse pedido. Tente dizer de outro jeito.');
}

function friendlyProblem(error, { known = null, bot = null, language = bot } = {}) {
  const say = (english, portuguese) => localize(language, english, portuguese);
  const text = String(error?.message || error || '');
  if (/silk touch/i.test(text)) return say('I need a tool with Silk Touch to pick up that block.', 'Preciso de uma ferramenta com Toque suave para pegar esse bloco.');
  if (/That place is in the /i.test(text)) return say(text, `Esse lugar fica ${/nether/i.test(text) ? 'no Nether' : /end/i.test(text) ? 'no End' : 'na superfície'}. Leve-me até lá e diga "Jev resume".`);
  if (REPLAN.test(text)) {
    const w = error?.waitOn;
    const thing = String(w?.name || 'block').replaceAll('_', ' ');
    return w ? say(`There's ${/^[aeiou]/.test(thing) ? 'an' : 'a'} ${thing} at ${w.x}, ${w.y}, ${w.z} where I'm building, and I didn't put it there.`, `Há ${w.name ? name(w.name, language) : 'um bloco'} em ${w.x}, ${w.y}, ${w.z} no lugar da construção, e não fui eu que coloquei.`) : say('Something new is in the way where I planned to build, so that plan no longer fits.', 'Apareceu algo no lugar da construção, e o plano não cabe mais ali.');
  }
  if (/No supported survival acquisition|bedrock/i.test(text)) return say('I don\'t know a way to get that in Survival.', 'Não conheço um jeito de conseguir isso no modo Sobrevivência.');
  if (/Chest handover is unconfirmed/i.test(text)) return say(text, `Não consegui confirmar a entrega no baú${text.match(/ at (.*?)\./)?.[1] ? ` em ${text.match(/ at (.*?)\./)[1]}` : ''}. Confira esse baú antes de pedir reposições.`);
  if (/chest.*(?:lid|open)|free block near you for a chest/i.test(text)) return say(text, /free block/.test(text) ? 'Preciso de um bloco livre perto de você para colocar um baú.' : 'Não consigo abrir a tampa desse baú. Confira se há espaço livre acima dele.');
  if (/handover was interrupted|pickup.*(?:unconfirmed|not confirmed)/i.test(text)) return say('I\'m not sure you got all the items. Please check the ground nearby before asking for more.', 'Não tenho certeza de que você recebeu todos os itens. Confira o chão por perto antes de pedir mais.');
  if (/recipient|player.*(?:visible|loaded)|cannot see|can.t see|pickup.*confirm/i.test(text)) return say('I need you a bit closer so I can give you the items.', 'Preciso que você chegue mais perto para entregar os itens.');
  if (/inventory.*full|inventory space|free.*slot/i.test(text)) return say('My pockets are full. I need to make some room.', 'Meu inventário está cheio. Preciso abrir espaço.');
  if (/food|hungry|hunger/i.test(text)) return say('I need some food before I can keep going.', 'Preciso de comida antes de continuar.');
  if (/tool|pickaxe|durability/i.test(text)) return say('I need the right tool before I can keep going.', 'Preciso da ferramenta certa antes de continuar.');
  // A search that has found what it looks for and stalls getting to it is
  // not "not found": 25590 said "I haven't found it yet" 16 blocks from its
  // fortress, the stalled step's own `found` in the message (note 687).
  const stalled = /^No measurable progress on (\{.*\})/.exec(text);
  let step = null;
  if (stalled) { try { step = JSON.parse(stalled[1]); } catch (_) { step = null; } }
  // The step's own find, else the one the search keeps (`known`, the
  // fortress search's found) for a stall on the fortress search.
  // The fortress by its one place (mob-hunt.js fortressAnchor, note 706), not
  // the brick the approach aims at.
  const found = step?.fortress || step?.found || (known && (!step || step.action === 'find_fortress') ? known : null);
  if ((stalled || /find_fortress|fortress/i.test(text)) && found && Number.isFinite(found.x) && Number.isFinite(found.z)) {
    const what = !step || step.action === 'find_fortress' ? 'the fortress' : 'it';
    return say(`I know where ${what} is, near ${Math.round(found.x)}, ${Math.round(found.z)}, but I'm not getting any closer to it.`, `Sei onde ${what === 'the fortress' ? 'fica a fortaleza' : 'isso fica'}, perto de ${Math.round(found.x)}, ${Math.round(found.z)}, mas não estou conseguindo me aproximar.`);
  }
  if (/find|search|explor/i.test(text)) return say('I haven\'t found it yet. We may need to look farther away.', 'Ainda não encontrei. Talvez seja preciso procurar mais longe.');
  if (/^No route from here.*passes beside lava/.test(text)) return say('I can\'t find a way there that keeps off the lava\'s edge.', 'Não encontrei um caminho até lá que evite a borda da lava.');
  if (/^No route from here/.test(text)) return say('I can\'t find a way there from here.', 'Não encontrei um caminho daqui até lá.');
  if (/route|path|reach|standing|navigation|stair|surface|obstruct|place|support/i.test(text)) return say('I can\'t reach a safe spot to do that yet.', 'Ainda não consigo chegar a um lugar seguro para fazer isso.');
  // Whole words: "lapis" has "api" in it, and a stash error listing lapis
  // lazuli told the player seven times that Jev could not think.
  if (/\bAPI\b|TypeSafe|OpenRouter|\bfetch\b|\bmodel\b|\bnetwork\b|\btimeout\b|timed out/i.test(text)) return say('I\'m having trouble thinking right now. Please try again in a moment.', 'Estou com dificuldade para pensar agora. Tente de novo daqui a pouco.');
  return say('I got stuck and couldn\'t finish that yet.', 'Fiquei preso e ainda não consegui terminar.');
}

function portugueseActivity(step, language) {
  const item = name(step.item || step.drops || step.resource || step.name || step.block, language);
  switch (step.action) {
    case 'boat_travel': return 'Estou atravessando a água de barco.';
    case 'reach_shore': return 'Estou nadando de volta para terra firme.';
    case 'prepare_build_site': return step.operation === 'fill' ? 'Estou preenchendo uma base firme para a construção.' : 'Estou nivelando o terreno para a construção.';
    case 'craft': return `Estou fazendo ${item}.`;
    case 'mine': case 'collect': return `Estou coletando ${item}.`;
    case 'deliver': return `Estou levando ${item} para você.`;
    case 'store_delivery': return `Estou colocando ${item} no seu baú.`;
    case 'collect_nearby_resource': return `Vi ${item} por perto. Vou pegar e depois volto à sua tarefa.`;
    case 'smelt': case 'cook_food': return `Estou preparando ${item === 'itens' ? 'comida' : item} na fornalha.`;
    case 'make_obsidian': return { pour: 'Estou jogando água na lava para fazer obsidiana.', mine: 'Estou minerando a obsidiana que fiz.', reach_lava: 'Estou escavando até a lava para fazer obsidiana.' }[step.phase] || 'Estou fazendo obsidiana com lava.';
    case 'refuel_furnace': return step.item === 'oak_planks' ? 'Estou buscando mais combustível para a fornalha.' : 'Estou buscando o que falta para a fornalha.';
    case 'explore': case 'approach_discovery': case 'approach_found_creature': return `Estou procurando ${name(step.name || step.entity || step.resource, language)}.`;
    case 'come': return 'Estou indo até você.';
    case 'follow': return 'Estou seguindo você.';
    case 'visit': return `Estou indo até ${step.label || 'o lugar salvo'}.`;
    case 'eat': case 'eat_food': return 'Estou comendo alguma coisa.';
    case 'return_to_surface': case 'ascend_to_surface': return 'Estou procurando um caminho de volta para a superfície.';
    case 'prepare_expedition_food': return 'Estou separando comida para a viagem.';
    case 'tunnel': return `Estou cavando uma escadaria${step.target ? ` em direção a y=${step.target.y}` : ''}.`;
    case 'return_to_mine': return `Estou voltando ao meu poço de mineração de ${item}.`;
    case 'persist': return 'Fiquei preso e estou tentando de novo.';
    case 'hunt_mob': return `Estou caçando ${name(step.entity, language)} para conseguir ${item}.`;
    case 'stalk_mob': return `Há ${name(step.entity, language)} por perto. Estou esperando uma oportunidade.`;
    case 'find_fortress': return step.found ? 'Estou vendo uma fortaleza. Vou até ela.' : `Estou procurando uma fortaleza, no trecho ${step.legs || 1}.`;
    case 'recover_before_combat': return 'Estou recuperando minhas forças antes de lutar.';
    case 'equip_combat': case 'prepare_combat_equipment': return 'Estou equipando a armadura e a espada.';
    case 'home_site': return 'Estou procurando um lugar para a base.';
    case 'level_site': return `Estou nivelando o terreno da base: ${step.digs || 0} blocos para cavar, ${step.fills || 0} para preencher.`;
    case 'pour_water': return 'Estou fazendo um lago ao lado da plantação.';
    case 'return_home': return 'Estou voltando para a base.';
    case 'place_bed': case 'claim_bed': return 'Estou preparando a cama na base.';
    case 'place_chest': return 'Estou colocando o baú ao lado da cama.';
    case 'till': return 'Estou arando o terreno.';
    case 'plant': return 'Estou plantando no terreno.';
    case 'build_pen': return 'Estou cercando o curral das vacas.';
    case 'gather_wool': return 'Estou buscando lã para uma cama.';
    case 'restock': return 'Estou reabastecendo pelo baú da base.';
    case 'stash_valuables': return 'Estou guardando meus itens valiosos na base.';
    case 'sleep': return 'Estou dormindo até amanhecer.';
    case 'stay_up': return 'Vou ficar acordado esta noite; há tarefas que precisam do escuro.';
    case 'return_to_portal': case 'enter_nether': return 'Estou indo para meu portal do Nether.';
    case 'return_overworld': return 'Estou voltando pelo portal.';
    default: return 'Estou trabalhando nisso.';
  }
}

function activity(step = {}, language) {
  if (step.action === 'combined_request') return activity(step.detail || { action: 'collect', item: step.item }, language);
  if (isPortuguese(language)) return portugueseActivity(step, language);
  const item = name(step.item || step.drops || step.resource || step.name || step.block);
  switch (step.action) {
    case 'boat_travel': return "I'm taking a boat across the water.";
    case 'reach_shore': return "I'm swimming back to dry land.";
    case 'prepare_build_site': return step.operation === 'fill' ? "I'm filling in a solid base for the building." : "I'm making the ground level for the building.";
    case 'craft': return `I'm making ${item}.`;
    case 'mine': case 'collect': return `I'm collecting ${item}.`;
    case 'deliver': return `I'm bringing you ${item}.`;
    case 'store_delivery': return `I'm putting your ${item} in a chest.`;
    case 'collect_nearby_resource': return `I spotted some ${item} nearby. I'll grab it, then get back to your task.`;
    case 'smelt': case 'cook_food': return `I'm cooking ${item === 'items' ? 'food' : item}.`;
    case 'make_obsidian': return { pour: "I'm pouring water on lava to make obsidian.", mine: "I'm mining the obsidian I made.", reach_lava: "I'm digging toward lava to make obsidian." }[step.phase] || "I'm making obsidian from lava.";
    case 'refuel_furnace': return step.item === 'oak_planks' ? "I'm getting more fuel for the furnace." : "I'm getting the missing supplies for the furnace.";
    case 'explore': case 'approach_discovery': case 'approach_found_creature': return `I'm looking for ${name(step.name || step.entity || step.resource)}.`;
    case 'come': return "I'm coming to you.";
    case 'follow': return "I'm following you.";
    case 'visit': return `I'm heading to ${step.label || 'the saved place'}.`;
    case 'eat': case 'eat_food': return "I'm eating something.";
    case 'return_to_surface': case 'ascend_to_surface': return "I'm finding a way back up.";
    case 'prepare_expedition_food': return "I'm packing some food for the trip.";
    case 'tunnel': return `I'm digging a staircase${step.target ? ` toward y=${step.target.y}` : ''}.`;
    case 'return_to_mine': return `I'm heading back to my ${item || 'mine'} shaft.`;
    case 'persist': return "I got stuck and I'm trying again.";
    case 'hunt_mob': return `I'm hunting a ${name(step.entity)} for ${item}.`;
    case 'stalk_mob': return `There's a ${name(step.entity)} near. I'm waiting for my chance.`;
    case 'find_fortress': return step.found ? "I can see a fortress. Heading for it." : `I'm sweeping for a fortress, leg ${step.legs || 1}.`;
    case 'recover_before_combat': return "I'm getting my strength back before a fight.";
    case 'equip_combat': case 'prepare_combat_equipment': return "I'm getting my armour and sword on.";
    case 'home_site': return "I'm looking for a spot for a base.";
    case 'level_site': return `I'm levelling the ground for the base: ${step.digs || 0} to dig, ${step.fills || 0} to fill.`;
    case 'pour_water': return "I'm making a pond beside the plot.";
    case 'return_home': return "I'm walking back to the base.";
    case 'place_bed': case 'claim_bed': return "I'm setting up the bed at the base.";
    case 'place_chest': return "I'm putting the stash chest beside the bed.";
    case 'till': return "I'm tilling the plot."; case 'plant': return "I'm planting the plot.";
    case 'build_pen': return "I'm fencing the cow pen."; case 'gather_wool': return "I'm getting wool for a bed.";
    case 'restock': return "I'm restocking from the chest at the base."; case 'stash_valuables': return "I'm leaving my valuables at the base.";
    case 'sleep': return "I'm sleeping the night through."; case 'stay_up': return "I'm staying up tonight; there's work the dark is good for.";
    case 'return_to_portal': case 'enter_nether': return "I'm heading for my Nether portal.";
    case 'return_overworld': return "I'm heading back through the portal.";
    default: return "I'm working on it.";
  }
}

function completion(goal, language) {
  const say = (english, portuguese) => localize(language, english, portuguese);
  const chest = [goal, ...(goal.tasks || [])].flatMap(g => g.deliveryEvidence || []).filter(e => e.method === 'chest');
  if (chest.length) {
    const places = [...new Set(chest.map(e => `${e.position.x}, ${e.position.y}, ${e.position.z}`))];
    return places.length === 1 ? say(`All done! I left items for you in the chest at ${places[0]}.`, `Tudo pronto! Deixei seus itens no baú em ${places[0]}.`) : say('All done! I left items in the chests I pointed out.', 'Tudo pronto! Deixei os itens nos baús que indiquei.');
  }
  if (['obtain', 'craft'].includes(goal.kind)) return goal.deliver ? say(`You got ${goal.count} ${name(goal.item)}!`, `Você recebeu ${goal.count} ${name(goal.item, language)}!`) : say(`I've got ${goal.count} ${name(goal.item)}.`, `Consegui ${goal.count} ${name(goal.item, language)}.`);
  if (goal.kind === 'bundle') return say(`All done! ${list(goal.tasks)}. ${goal.tasks.every(t => t.deliver) ? 'You have the whole list.' : 'I kept the items you asked me to keep.'}`, `Tudo pronto! ${list(goal.tasks, language)}. ${goal.tasks.every(t => t.deliver) ? 'Você recebeu a lista inteira.' : 'Fiquei com os itens que você pediu para guardar.'}`);
  if (goal.kind === 'find') {
    const p = goal.discovery.found.position;
    return say(`Found ${name(goal.discoveryTarget.name)}! It's at ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}.`, `Encontrei ${name(goal.discoveryTarget.name, language)}! Está em ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}.`);
  }
  if (goal.kind === 'come') return say(`I'm here with ${goal.target || goal.from}!`, `Cheguei até ${goal.target || goal.from}!`);
  if (goal.kind === 'explore') return say(`I explored ${goal.playerExploration?.visited?.length || 0} new areas and saved what I observed.`, `Explorei ${goal.playerExploration?.visited?.length || 0} novas áreas e salvei o que observei.`);
  if (goal.kind === 'visit') return say(`I'm at ${goal.destination.label}!`, `Cheguei a ${goal.destination.label}!`);
  if (goal.kind === 'house' || goal.kind === 'build') {
    const changed = goal.buildContinuation?.mode === 'edit' && goal.buildContinuation.name;
    return changed ? say(`${changed} is changed, and I checked it over for missing blocks.`, `Terminei as mudanças em ${changed} e conferi se faltava algum bloco.`)
      : say('The building is done! I checked it for missing blocks.', 'A construção está pronta! Conferi se faltava algum bloco.');
  }
  if (goal.kind === 'win') return say('We beat the dragon! I made it back home alive.', 'Derrotamos o dragão! Voltei para casa vivo.');
  if (goal.kind === 'concrete') return say(`You got ${goal.count} purple concrete!`, `Você recebeu ${goal.count} ${name('purple_concrete', language)}!`);
  return say('The Nether portal works! I went through to check.', 'O portal do Nether funciona! Atravessei para conferir.');
}
module.exports = { intakeProblem, quietRepeats, name, list, friendlyProblem, recoveryHint, thinking, activity, completion };
