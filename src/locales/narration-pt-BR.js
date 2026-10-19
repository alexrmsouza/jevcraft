'use strict';
const { displayName } = require('../language');
const name = value => displayName(value || '', 'pt-BR').toLocaleLowerCase('pt-BR');
const names = action => [...new Set((Array.isArray(action?.threats) ? action.threats : []).map(threat => name(threat.name || threat)))];
const amount = (count, value) => `${count > 1 ? `${count} × ` : ''}${name(value)}`;
const LANDMARKS = { village: 'vila', igloo: 'iglu', ruined_portal: 'portal em ruínas', lava_pool: 'lago de lava', dungeon: 'masmorra',
  mineshaft: 'mina abandonada', desert_temple: 'templo do deserto', jungle_temple: 'templo da selva', deep_dark: 'escuridão profunda',
  ancient_city: 'cidade ancestral', trial_chambers: 'câmaras do desafio', nether_fortress: 'fortaleza do Nether', fortress: 'fortaleza',
  warped_forest: 'floresta distorcida', bastion: 'bastião' };
const PHASES = { stone_tools: 'ferramentas de pedra', iron_tools: 'ferramentas de ferro', iron: 'ferro', diamond_tools: 'ferramentas de diamante',
  diamonds: 'diamantes', nether: 'ida ao Nether', portal: 'portal', fortress: 'fortaleza', blaze_rods: 'varas de blaze',
  ender_pearls: 'pérolas de ender', eyes_of_ender: 'olhos de ender', stronghold: 'fortaleza do End', end: 'ida ao End', dragon: 'dragão do End',
  arrows: 'flechas', bed: 'cama', carry_bed: 'levar uma cama', collect_rod_stash: 'recuperar as varas de blaze guardadas', complete: 'jornada concluída',
  craft_eyes: 'fabricar olhos de ender', defeat_dragon: 'derrotar o dragão do End', enter_end: 'entrar no End', errand: 'buscar suprimentos',
  eyes_out: 'recuperar os olhos de ender', fill_end_portal: 'ativar o portal do End', find_stronghold: 'encontrar a fortaleza do End',
  iron_armour: 'armadura de ferro', leather_armour: 'armadura de couro', obtain_blaze_rods: 'conseguir varas de blaze',
  obtain_ender_pearls: 'conseguir pérolas de ender', reach_nether: 'chegar ao Nether', restock_supplies: 'repor suprimentos',
  return_alive: 'voltar com vida', return_overworld: 'voltar à Superfície', return_with_blaze_supplies: 'voltar com os materiais dos blazes',
  unknown_dimension: 'verificar a dimensão', home_bed: 'cama de casa', home_level: 'nivelar o terreno de casa', home_pen: 'cercado de casa',
  home_plot: 'plantação de casa', home_site: 'escolher um lugar para morar', home_stash: 'reservas de casa', home_water: 'água em casa',
  nether_pickaxe: 'picareta para o Nether', nether_blocks: 'blocos para o Nether', nether_food: 'comida para o Nether', nether_chest: 'baú para o Nether' };
const phase = value => PHASES[value] || name(value);
const landmark = action => {
  const known = LANDMARKS[action.kind] || LANDMARKS[String(action.what || '').replaceAll(' ', '_')];
  const position = action.position;
  return known ? `${known}${Number.isFinite(position?.x) && Number.isFinite(position?.z) ? ` em ${position.x}, ${position.z}` : ''}` : null;
};
const sleepFailure = action => {
  const reason = String(action.reason || '');
  if (/not_safe|monsters|mobs|monster/i.test(reason)) return 'Não consigo dormir: há monstros por perto.';
  if (/not_possible_now|only.*night|not.*night|not.*tired/i.test(reason)) return 'Ainda não está na hora de dormir.';
  if (/occupied|in.use|already.*sleep/i.test(reason)) return 'Não consigo dormir: a cama está ocupada.';
  if (/too_far|too far|not close|no way|route/i.test(reason)) return 'Não consegui chegar perto o bastante da cama.';
  if (/obstruct|blocked/i.test(reason)) return 'Não consigo usar a cama: ela está bloqueada.';
  return 'Não consegui dormir nessa cama.';
};
const leave = fallback => (goal, action) => action.reason ? 'Saindo do abrigo. De volta ao trabalho.' : fallback;

const SURVIVAL = {
  gather_shelter_materials: ['Está escurecendo. Vou pegar blocos para me abrigar.', 'A noite vem aí. Preciso de blocos para um abrigo.', 'O sol está baixando. Vou juntar blocos para me proteger.'],
  seal_shelter: ['Vou me fechar aqui durante a noite.', 'Fechando meu esconderijo.', 'Vou ficar protegido aqui até amanhecer.'],
  sheltered: ['Estou seguro aqui. Vou esperar amanhecer.', 'Nada entra aqui. Vou esperar a noite passar.', 'Abrigo pronto. Vou ficar aqui até o sol nascer.'],
  sleep: ['Hora de dormir. Boa noite!', 'Vou para a cama. Boa noite!', 'Aaah... hora de descansar.'],
  go_home_for_night: [(goal, action) => (action.distance ?? 99) > 24 ? 'Está escurecendo. Vou para casa dormir.' : null,
    (goal, action) => (action.distance ?? 99) > 24 ? 'Está ficando tarde. Vou voltar para casa.' : null,
    (goal, action) => (action.distance ?? 99) > 24 ? 'Vou para casa antes que os monstros apareçam.' : null],
  wait_for_bedtime: ['Cheguei antes de escurecer. Vou esperar a hora de dormir.', 'Já estou em casa. Daqui a pouco vou dormir.', 'Em casa! Só falta escurecer para eu dormir.'],
  evening_chore: (goal, action) => `Cheguei antes de escurecer. Vou ${({ stock_stash: 'guardar reservas no baú', harvest_and_bake: 'colher trigo e assar pão', tend_farm: 'cuidar da plantação', breed_cows: 'alimentar as vacas para terem filhotes', light_home: 'colocar algumas tochas', wall_home: 'fazer um muro em volta de casa' })[action.chore] || 'adiantar uma tarefa'} antes de dormir.`,
  grow_plot: ['Cheguei antes de escurecer. Amanhã vou aumentar a plantação em mais uma fileira.', 'Amanhã vou abrir mais uma fileira na plantação.'],
  sleep_failed: (goal, action) => sleepFailure(action),
  stay_up: ['Vou ficar acordado esta noite. Ainda dá para trabalhar no escuro.', 'Nada de dormir hoje. Tenho trabalho para fazer.', 'Vou passar a noite acordado.']
    .map(line => (goal, action) => action?.shelterFailed ? 'Meu abrigo não funcionou, então vou passar a noite acordado.' : line),
  leave_shelter: [leave('Bom dia! De volta ao trabalho.'), leave('O sol nasceu. Vamos lá!'), leave('Bom dia! Onde eu estava mesmo?')],
  escape_threat: [(goal, action) => names(action).length ? `Eita, ${names(action).join(' e ')}! Vou sair daqui.` : 'Tem algo atrás de mim! Vou sair daqui.',
    (goal, action) => names(action).length ? `Não vou enfrentar ${names(action).join(' e ')} agora. Correndo!` : 'Melhor correr!',
    (goal, action) => names(action).length ? `Tem ${names(action).join(' e ')} atrás de mim! Vou recuar.` : 'Tem algo atrás de mim! Vou recuar.'],
  hold_defensive_position: ['Estou encurralado. Vou me defender aqui.', 'Não tenho por onde sair. Vou segurar a posição.'],
  dig_in_bunker: (goal, action) => `Tem inimigos demais aqui${names(action).length ? ` (${names(action).join(', ')})` : ''}. Vou cavar um abrigo na rocha e enfrentar um de cada vez.`,
  fight: [(goal, action) => `Pode vir, ${names(action).join(' e ')}!`, (goal, action) => `Toma essa, ${names(action).join(' e ')}!`, (goal, action) => `Vou enfrentar ${names(action).join(' e ')}!`],
  charge: (goal, action) => `Vou para cima: ${name(action.target)}!`,
  dig_in: [(goal, action) => names(action).length ? `Vou levantar uma parede entre mim e ${names(action).join(' e ')} até o perigo passar.` : 'Vou me fechar aqui até ficar seguro.',
    (goal, action) => names(action).length ? `Blocos no lugar! ${names(action).join(' e ')} ficam do lado de fora.` : 'Vou levantar uma parede até as coisas se acalmarem.'],
  wall_off: 'Estou encurralado. Vou fechar o túnel com blocos.',
  no_shelter_here: 'Não há onde me abrigar nem blocos para construir. Vou seguir com cuidado.',
  leave_lava_edge: ['Opa, lava! Vou me afastar primeiro.', 'Estou perto demais da lava. Vou recuar.', 'Quente, quente! Melhor sair de perto da lava.'],
  douse: ['Ainda estou queimando! Água nos pés.', 'Vou me apagar com o balde de água.'],
  out_of_fire: ['Ahh, estou no fogo! Vou sair daqui!', 'Ai, ai, fogo! Correndo!', 'Estou queimando! Fora, fora, fora!'],
  return_to_surface: ['Vou voltar para a superfície.', 'Subindo, de volta à luz do dia.', 'Vou subir de volta.'],
  recover_items: ['Vou buscar os itens que perdi.', 'Minhas coisas ainda estão lá. Vou recuperá-las.'],
  gather_food: [(goal, action) => `Estou ficando com fome. ${action.item ? `Vou buscar ${name(action.item)}.` : 'Hora de procurar comida.'}`,
    (goal, action) => `Minha barriga está roncando. ${action.item ? `Vou atrás de ${name(action.item)}.` : 'Comida primeiro.'}`],
  fishing: ['Vou ver o que tem na água. Hora de pescar.', 'Vara na mão. Vou pescar para o jantar.'],
  search_food: ['Estou com fome. Vou procurar algo para comer.', 'Será que tem comida por aqui?', 'É melhor eu encontrar comida.'],
  return_for_food: 'Não tenho o que comer aqui. Vou voltar pelo portal para buscar comida.',
  cook_food: ['Vou cozinhar a comida primeiro.', 'Preparando algo para comer.', 'Hora de comer. Comida na fornalha!'],
  go_home_for_food: ['Vou para casa comer alguma coisa.', 'Tem comida em casa. Vou para lá.'],
  village_found: ['Olha, uma vila! Vou lembrar deste lugar.', 'Uma vila! Bom saber onde fica.', 'Achei uma vila. Lugar anotado!'],
  landmark_found: [(goal, action) => landmark(action) ? `Olha só: ${landmark(action)}! Vou lembrar deste lugar.` : 'Vale a pena lembrar deste lugar.',
    (goal, action) => landmark(action) ? `Lugar anotado: ${landmark(action)}.` : 'Interessante! Vou guardar este lugar.',
    (goal, action) => landmark(action) ? `Achei ${landmark(action)}.` : 'Anotado. Talvez eu volte aqui.'],
  village_food: ['Vou até a vila buscar comida.', 'Deve ter comida na vila. Vou para lá.'],
  prepare_hunting_weapon: ['Vou fazer uma arma para caçar.', 'Preciso de uma arma antes de sair para caçar.'],
  reach_shore: ['Vou nadar até a margem.', 'Nadando de volta para terra firme.', 'Terra à vista! Vou nadar até lá.'],
  surface: ['Preciso de ar! Vou subir.', 'Ar! Para cima, para cima!', 'Estou sem fôlego. Vou subir.'],
};

const SURVIVAL_ELSEWHERE = {
  seal_shelter: ['Vou me fechar aqui.', 'Fechando meu esconderijo.', 'Vou ficar protegido aqui por enquanto.'],
  sheltered: ['Estou seguro aqui por enquanto.', 'Nada entra aqui.', 'Abrigo fechado. Hora de pensar.'],
  leave_shelter: [leave('Vou sair. De volta ao trabalho.'), leave('Certo, vamos lá!'), leave('Abrindo a passagem. Onde eu estava mesmo?')],
  return_to_surface: ['Vou subir de volta.', 'Subindo.'],
};
const SURVIVAL_BY_NIGHT = {
  return_to_surface: ['Vou voltar para a superfície. Lá em cima é noite.', 'Subindo de volta, para o escuro.', 'Vou subir para a superfície. Está de noite, então vou ficar atento.'],
  leave_shelter: [leave('Vou sair. De volta ao trabalho.'), leave('Certo, vamos lá!'), leave('Abrindo a passagem. Onde eu estava mesmo?')],
};
const STOCKING = {
  gather_food: (goal, action) => action.item ? `Vou guardar ${name(action.item)} para a viagem.` : 'Vou repor minha reserva de comida.',
  search_food: ['Vou repor a comida. Procurando animais.', 'Vou aumentar minha reserva de comida.'],
  go_home_for_food: ['Vou para casa repor a comida.', 'Tem comida em casa. Vou buscar mais.'],
};

function stepVariants(goal, step, bot, helpers) {
  const { keptOnHungry, fortressAlreadyAnnounced, knownFortressSays, fortressLeft, legHeading } = helpers;
  switch (step.action) {
    case 'combined_request': return step.detail && typeof step.detail === 'object' ? stepVariants(goal, step.detail, bot, helpers) : null;
    case 'mine': { const what = amount(step.count, step.drops || step.block); return [`Preciso coletar: ${what}.`, `Vou buscar: ${what}.`, `Hora de coletar: ${what}.`]; }
    case 'craft': { const what = amount(step.count, step.item); return [`Vou fabricar: ${what}.`, `Fabricando: ${what}.`, `Vou montar: ${what}.`]; }
    case 'smelt': { const what = amount(step.count, step.item); return [`Vou fundir: ${what}.`, `Na fornalha: ${what}.`, `Acendendo a fornalha para fazer ${what}.`]; }
    case 'harden': return 'Vou endurecer o concreto na água.';
    case 'make_obsidian': return `Água na lava: vou fazer ${step.count ? `${step.count} blocos de ` : ''}obsidiana.`;
    case 'fill_bucket': return step.item === 'lava_bucket' ? ['Vou buscar lava com um balde.', 'Vou até a lava com meus baldes.'] : ['Vou buscar água.', 'Enchendo meu balde.'];
    case 'cast_portal': return 'Lava embaixo, água por cima: vou moldar o portal.';
    case 'to_lava_for_portal': return 'Vou fazer o portal perto da lava para encurtar as viagens com o balde.';
    case 'buckets_for_portal': return 'Mais baldes primeiro. Assim levo mais lava por viagem.';
    case 'hunt_mob': return bot && keptOnHungry(goal, bot)
      ? [`Vou continuar sem comida por enquanto. Não vou caçar ${name(step.entity)}, mas me defendo se vier até mim.`]
      : [`Vou caçar ${name(step.entity)} para conseguir ${name(step.item)}.`, `Vou atrás de ${name(step.entity)}. Preciso de ${name(step.item)}.`];
    case 'strike_out': return ['Não achei nada aqui. Vou tentar outro lugar.', 'Hora de procurar em outro lugar.'];
    case 'stock_food_for_nether': return 'Vou juntar comida antes de entrar no Nether.';
    case 'return_for_food': return 'Fiquei sem comida. Vou voltar pelo portal para comer.';
    case 'find_fortress': return step.walking ? 'Já estou na fortaleza. Agora, onde estão os blazes?'
      : step.found && fortressAlreadyAnnounced(goal, step) ? null
      : step.found ? 'Uma fortaleza! Vou até lá.'
      : knownFortressSays(goal, step, bot) === false ? null
      : fortressLeft(goal) ? `Vou deixar a fortaleza por enquanto e continuar procurando (trecho ${step.legs || 1}${legHeading(goal, bot)}).`
      : knownFortressSays(goal, step, bot) || `Estou procurando uma fortaleza (trecho ${step.legs || 1}${legHeading(goal, bot)}).`;
    case 'collect': return `Vou pegar ${name(step.item || step.drops)}.`;
    case 'place': case 'build': case 'build_schematic': {
      const what = goal.kind === 'house' ? ' a casa' : goal.design?.source?.name ? ` ${goal.design.source.name}` : '';
      return [`Vou construir${what}.`, `Hora de construir${what ? `:${what}` : ''}!`];
    }
    case 'clear': return 'Vou limpar o terreno.';
    case 'prepare_build_site': return 'Vou preparar o chão.';
    case 'find_build_site': return 'Vou procurar um lugar plano para construir.';
    case 'return_to_site': return 'Vou voltar para a obra.';
    case 'deliver': return `Estou levando para você: ${step.count ? `${step.count} × ` : ''}${name(step.item)}.`;
    case 'prepare_expedition_food': return 'Vou juntar comida antes da viagem.';
    case 'refuel_furnace': return 'A fornalha precisa de mais combustível.';
    case 'return_overworld': return 'Vou voltar para a Superfície.';
    case 'return_to_portal': return 'Vou voltar até meu portal.';
    case 'home_site': return step.origin ? [`Vou morar aqui perto da água, em ${step.origin.x}, ${step.origin.z}.`, `Minha casa vai ficar perto da água, em ${step.origin.x}, ${step.origin.z}.`]
      : ['Vou procurar um terreno plano perto da água para morar.', 'Hora de encontrar um lugar bom para morar.'];
    case 'return_home': return ['Vou voltar para casa.', 'De volta para casa.'];
    case 'gather_wool': return ['Preciso de lã para uma cama. Onde estão as ovelhas?', 'Ovelhas, cadê vocês? Preciso de lã para uma cama.'];
    case 'explore': return step.target ? [`Vou ver o que tem em ${step.target.x}, ${step.target.z}.`, `O que será que tem em ${step.target.x}, ${step.target.z}? Vou descobrir.`] : 'Vou explorar um pouco.';
    case 'village_bed': return step.village?.igloo ? [`Tem um iglu em ${step.village.x}, ${step.village.z}. Vou buscar a cama de lá!`, `Iglu em ${step.village.x}, ${step.village.z}. Tem uma cama lá para mim.`]
      : step.village ? `Vou até a vila em ${step.village.x}, ${step.village.z} buscar uma cama.` : 'Vou até a vila buscar uma cama.';
    case 'village_harvest': return `Vou colher ${name(step.crop)} que já amadureceu na plantação da vila.`;
    case 'village_hay': return 'Vou pegar um fardo de feno para fazer pão.';
    case 'place_bed': return ['Vou colocar minha cama em casa.', 'Arrumando minha cama.'];
    case 'claim_bed': return 'Vou usar a cama para renascer aqui se algo der errado.';
    case 'till': return ['Vou preparar a terra para plantar.', 'Arando a plantação.'];
    case 'plant': return ['Vou plantar trigo.', 'Sementes na terra.'];
    case 'harvest': return ['O trigo está maduro. Hora de colher!', 'Colhendo o trigo.'];
    case 'bake': return [`Vou assar ${step.loaves ? `${step.loaves} pães` : 'pão'}.`, 'Vai sair pão fresquinho.'];
    case 'build_pen': return ['Vou cercar um espaço para as vacas.', 'Construindo um cercado para as vacas.'];
    case 'lure_cows': return ['Vamos, vacas, para dentro do cercado!', 'Ei, vacas! Por aqui.'];
    case 'breed_cows': return ['Vou alimentar as vacas para terem filhotes.', 'Trigo para as vacas. Logo teremos bezerros!'];
    case 'take_steak': return 'Vou pegar carne no cercado.';
    case 'cut_cobwebs': return ['Cortando teias para conseguir linha.', 'Tesoura nas teias. Preciso de linha.'];
    case 'wall_home': return ['Vou fazer um muro em volta de casa. Chega de creepers perto da cama!', 'Vou cercar a casa com um muro e uma porta.'];
    case 'place_chest': return ['Vou colocar um baú perto da cama para guardar equipamentos.', 'Um baú perto da cama para minhas reservas.'];
    case 'stock_stash': return ['Vou guardar equipamentos de reserva no baú.', 'Guardando minhas reservas no baú.'];
    case 'restock': return ['Vou buscar os equipamentos de reserva no baú.', 'Repondo meus equipamentos com o que guardei no baú.'];
    case 'stash_valuables': return 'Vou deixar meus itens valiosos no baú enquanto estou em casa.';
    case 'idle': return {
      cook_food: `Está tudo tranquilo. Vou cozinhar ${name(step.item)}.`,
      stone_tools: `Está tudo tranquilo. Vou fazer ${name(step.item)}.`,
      stock_wood: 'Está tudo tranquilo. Vou juntar madeira.',
      torches: 'Está tudo tranquilo. Vou fazer tochas.',
      long_game: `Não tem nada urgente agora. Vou avançar na minha jornada: ${phase(step.phase)}.`,
      tend_farm: 'Está tudo tranquilo. Vou cuidar da plantação.',
      harvest_and_bake: 'Está tudo tranquilo. Vou colher trigo e assar pão.',
      breed_cows: 'Está tudo tranquilo. Vou alimentar as vacas para terem filhotes.',
      lure_cows: 'Está tudo tranquilo. Vou trazer vacas para o cercado.',
      stock_stash: 'Está tudo tranquilo. Vou abastecer o baú de reservas.',
    }[step.choice] || null;
    case 'game_progression': return `Próxima etapa para zerar o jogo: ${phase(step.phase)}.`;
    default: return null;
  }
}

module.exports = { SURVIVAL, SURVIVAL_ELSEWHERE, SURVIVAL_BY_NIGHT, STOCKING, stepVariants };
