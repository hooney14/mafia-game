'use strict';
/**
 * 실시간 마피아 게임 - 외부 npm 패키지 불필요
 * Node.js SSE(Server-Sent Events)로 실시간 전송 + POST로 행동 처리
 * 교육/친목용 소규모 게임. 서버 재시작 시 방은 초기화됩니다.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 5;
const PHASE_MS = { night: 23000, day: 45000, vote: 25000 };
const ROLES = { mafia: '마피아', doctor: '의사', detective: '경찰', citizen: '시민' };
const rooms = new Map();
const BOT_NAMES = [
  ['도윤', '차분한 분석가'], ['하린', '직감이 좋은 탐정'], ['민재', '말 많은 분위기메이커'],
  ['수아', '조심스러운 관찰자'], ['지훈', '승부욕 강한 전략가'], ['유나', '의심 많은 논리파'],
  ['태오', '농담을 좋아하는 낙천가'], ['세린', '조용하지만 날카로운 사람'],
  ['준서', '행동파'], ['나연', '신중한 중재자'], ['시온', '침착한 추리러']
];

function id() { return crypto.randomBytes(12).toString('hex'); }
function code() { return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6); }
function choose(xs) { return xs[Math.floor(Math.random() * xs.length)]; }
function shuffled(items) { const a=[...items]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a; }
function cleanName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 14) : '';
}
function findPlayer(room, token) { return room.players.find(p => !p.bot && p.token === token); }
function addLog(room, text, kind = 'system') {
  room.logs.push({ id: id(), text, kind, at: Date.now() });
  if (room.logs.length > 80) room.logs.shift();
}
function alive(room) { return room.players.filter(p => p.alive); }
function phaseSet(room, phase) {
  room.phase = phase;
  room.phaseStarted = Date.now();
  room.deadline = PHASE_MS[phase] ? room.phaseStarted + PHASE_MS[phase] : 0;
  room.revision++;
}
function publish(room) {
  room.updated = Date.now();
  for (const listener of [...room.listeners]) {
    try {
      const data = JSON.stringify(view(room, listener.pid));
      listener.res.write('data: ' + data + '\n\n');
    } catch (_) { room.listeners.delete(listener); }
  }
}
function view(room, pid) {
  const me = room.players.find(p => p.id === pid);
  if (!me) return { error: '방에서 제외되었습니다.' };
  const end = room.phase === 'ended';
  return {
    code: room.code,
    hostId: room.hostId,
    me: {
      id: me.id, name: me.name, alive: me.alive, role: me.role,
      isHost: room.hostId === me.id,
      team: me.role === 'mafia' ? room.players.filter(p => p.role === 'mafia').map(p => p.id) : [],
      clue: me.clue || null,
      selected: room.phase === 'night' ? (room.nightActions[me.id] || null) :
        room.phase === 'vote' ? (room.votes[me.id] || null) : null
    },
    players: room.players.map(p => ({ id:p.id, name:p.name, bot:p.bot, personality:p.personality || '',
      alive:p.alive, online:p.bot || [...room.listeners].some(l => l.pid === p.id),
      role: end ? p.role : (p.id === me.id ? p.role : null) })),
    phase:room.phase, dayNumber:room.dayNumber, deadline:room.deadline, now:Date.now(),
    events:room.logs.slice(-35), winner:room.winner, minPlayers:MIN_PLAYERS,
    roomSize:MAX_PLAYERS, phaseName: ({lobby:'대기실',night:'밤',day:'낮 · 토론',vote:'낮 · 투표',ended:'게임 종료'})[room.phase]
  };
}
function createRoom(name) {
  let roomCode; do { roomCode = code(); } while (rooms.has(roomCode));
  const host = { id:id(), token:id()+id(), name, bot:false, alive:true, role:null, clue:null };
  const room = {
    code:roomCode, players:[host], hostId:host.id, listeners:new Set(),
    logs:[], phase:'lobby', phaseStarted:Date.now(), deadline:0, revision:0, dayNumber:0,
    winner:null, nightActions:{}, votes:{}, botChatSteps:new Set(), updated:Date.now()
  };
  rooms.set(roomCode, room);
  addLog(room, '방이 만들어졌습니다. 초대 링크를 공유하거나 AI 참가자를 추가하세요.');
  return { room, host };
}
function addBot(room) {
  const used = new Set(room.players.map(p => p.name));
  const available = BOT_NAMES.filter(([name]) => !used.has(name));
  const [name, personality] = choose(available.length ? available : BOT_NAMES);
  const bot = { id:id(), name, bot:true, personality, alive:true, role:null, token:null, clue:null };
  room.players.push(bot);
  addLog(room, `🤖 ${name} 님이 AI 참가자로 입장했습니다.`);
}
function startGame(room) {
  const mafiaCount = room.players.length >= 8 ? 2 : 1;
  const roles = shuffled([
    ...Array(mafiaCount).fill('mafia'), 'doctor', 'detective',
    ...Array(room.players.length - mafiaCount - 2).fill('citizen')
  ]);
  room.players.forEach((p, i) => { p.alive=true; p.role=roles[i]; p.clue=null; });
  room.logs = [];
  room.dayNumber = 1; room.winner=null; room.nightActions={}; room.votes={}; room.botChatSteps=new Set();
  phaseSet(room,'night');
  addLog(room, `🎭 게임 시작! 총 ${room.players.length}명. 마피아 ${mafiaCount}명, 경찰 1명, 의사 1명.`);
  addLog(room, '🌙 첫 번째 밤입니다. 마피아는 제거 대상을, 의사는 보호 대상을, 경찰은 조사 대상을 정하세요.');
  publish(room);
}
function checkWinner(room) {
  const survivors=alive(room), mafias=survivors.filter(p=>p.role==='mafia').length;
  const others=survivors.length-mafias;
  if (mafias === 0) room.winner='citizens';
  else if (mafias >= others) room.winner='mafia';
  if (room.winner) {
    phaseSet(room,'ended');
    addLog(room, room.winner==='citizens' ? '🏆 시민 팀 승리! 모든 마피아를 찾아냈습니다.' : '🏆 마피아 팀 승리! 마피아가 마을을 장악했습니다.');
    publish(room); return true;
  }
  return false;
}
function enterNight(room) {
  room.dayNumber++;
  room.nightActions={}; room.votes={}; room.botChatSteps=new Set();
  phaseSet(room,'night');
  addLog(room, `🌙 ${room.dayNumber}번째 밤이 되었습니다. 모두 눈을 감으세요.`);
  publish(room);
}
function resolveNight(room) {
  if (room.phase!=='night') return;
  const mafiaVotes=alive(room).filter(p=>p.role==='mafia').map(p=>room.nightActions[p.id]).filter(Boolean);
  const score={}; mafiaVotes.forEach(pid=>{score[pid]=(score[pid]||0)+1;});
  const top=Math.max(0,...Object.values(score));
  const targetId=top?choose(Object.keys(score).filter(key=>score[key]===top)):null;
  const target=room.players.find(p=>p.id===targetId&&p.alive);
  const doctor=alive(room).find(p=>p.role==='doctor');
  const protectedId=doctor?room.nightActions[doctor.id]:null;
  if (target && protectedId !== target.id) {
    target.alive=false;
    addLog(room, `💀 아침이 밝았습니다. ${target.name} 님이 습격으로 탈락했습니다. (${ROLES[target.role]})`,'result');
  } else if (target) addLog(room, '💉 의사가 습격을 막았습니다. 오늘 밤에는 아무도 탈락하지 않았습니다.','result');
  else addLog(room, '☀️ 밤이 지나갔습니다. 탈락한 사람은 없습니다.','result');
  if (checkWinner(room)) return;
  room.votes={}; room.botChatSteps=new Set();
  phaseSet(room,'day');
  addLog(room, '☀️ 낮이 되었습니다. 45초 동안 추리하고 토론하세요.');
  publish(room);
}
function enterVote(room) {
  if (room.phase!=='day') return;
  room.votes={};
  phaseSet(room,'vote');
  addLog(room,'🗳️ 투표 시간입니다. 추방할 한 사람을 고르거나 기권하세요.');
  publish(room);
}
function resolveVote(room) {
  if (room.phase!=='vote') return;
  const tally={};
  for (const target of Object.values(room.votes)) tally[target]=(tally[target]||0)+1;
  const valid=Object.entries(tally).filter(([key])=>key!=='skip');
  const max=valid.length?Math.max(...valid.map(([,n])=>n)):0;
  const top=valid.filter(([,n])=>n===max).map(([key])=>key);
  // 유효 투표 1위가 기권보다 많아야 처형; 동률이면 추방 없음.
  if (top.length===1 && max>0 && max>(tally.skip||0)) {
    const target=room.players.find(p=>p.id===top[0] && p.alive);
    if (target) {
      target.alive=false;
      addLog(room, `⚖️ ${target.name} 님이 ${max}표로 추방되었습니다. (${ROLES[target.role]})`,'result');
    }
  } else addLog(room,'🤝 투표가 동률이거나 기권이 우세하여 아무도 추방되지 않았습니다.','result');
  if (checkWinner(room)) return;
  enterNight(room);
}
function chooseBotNightTarget(room, bot) {
  const candidates=alive(room);
  if (bot.role==='mafia') return choose(candidates.filter(p=>p.role!=='mafia'))?.id;
  if (bot.role==='doctor') return choose(candidates)?.id;
  if (bot.role==='detective') return choose(candidates.filter(p=>p.id!==bot.id))?.id;
  return null;
}
function submitNight(room, player, targetId) {
  if (room.phase!=='night' || !player.alive || !['mafia','doctor','detective'].includes(player.role)) throw Error('현재 행동할 수 없습니다.');
  const target=alive(room).find(p=>p.id===targetId);
  if (!target) throw Error('대상을 찾을 수 없습니다.');
  if (player.role==='mafia' && target.role==='mafia') throw Error('마피아 동료는 공격할 수 없습니다.');
  if (player.role==='detective' && target.id===player.id) throw Error('자기 자신은 조사할 수 없습니다.');
  if (room.nightActions[player.id]) throw Error('이미 행동을 선택했습니다.');
  room.nightActions[player.id]=target.id;
  if (player.role==='detective') player.clue = `${target.name} 님은 ${target.role==='mafia'?'마피아':'마피아가 아닙니다'}.`;
  publish(room);
  maybeEndEarly(room);
}
function chooseBotVote(room, bot) {
  const candidates=alive(room).filter(p=>p.id!==bot.id);
  if (!candidates.length) return 'skip';
  if (bot.role==='detective') {
    const known=room.players.find(p=>p.alive && p.id!==bot.id && bot.clue && bot.clue.startsWith(`${p.name} 님은 마피아.`));
    if (known) return known.id;
  }
  const pool=bot.role==='mafia'?candidates.filter(p=>p.role!=='mafia'):candidates;
  return Math.random()<0.12?'skip':choose(pool.length?pool:candidates).id;
}
function maybeEndEarly(room) {
  const living=alive(room);
  if (room.phase==='night') {
    const actors=living.filter(p=>['mafia','doctor','detective'].includes(p.role));
    if (actors.every(p=>room.nightActions[p.id])) resolveNight(room);
  } else if (room.phase==='vote' && living.every(p=>room.votes[p.id])) resolveVote(room);
}
function botMessage(room) {
  const bots=alive(room).filter(p=>p.bot);
  if (!bots.length) return;
  const speaker=choose(bots);
  const targets=alive(room).filter(p=>p.id!==speaker.id);
  if (!targets.length) return;
  const suspect = speaker.role==='mafia' ? choose(targets.filter(p=>p.role!=='mafia')) : choose(targets);
  if (!suspect) return;
  let line;
  if (speaker.role==='detective' && speaker.clue && speaker.clue.startsWith(`${suspect.name} 님은 마피아.`))
    line = `${suspect.name} 님이 정말 수상해요. 저는 확신이 있어요.`;
  else {
    const scripts = [
      `${suspect.name} 님은 아까부터 너무 조용한데요?`,
      `제 생각엔 ${suspect.name} 님을 한 번 의심해 봐야겠어요.`,
      '말만 믿지 말고 누가 이득을 보는지 생각해봐요.',
      '저는 아직 확신이 없어요. 다른 분들 의견은요?',
      `${suspect.name} 님은 어떻게 생각하세요?`,
      '이 상황에서 성급하게 투표하면 위험할 것 같아요.',
      '방금 상황을 보면 뭔가 앞뒤가 안 맞는 것 같은데요.'
    ];
    line=choose(scripts);
  }
  addLog(room, `${speaker.name}: ${line}`,'chat');
  publish(room);
}
function tick(room) {
  if (!['night','day','vote'].includes(room.phase)) return;
  const now=Date.now();
  if (room.phase==='night' && now-room.phaseStarted>3500) {
    for (const bot of alive(room).filter(p=>p.bot && ['mafia','doctor','detective'].includes(p.role) && !room.nightActions[p.id])) {
      const target=chooseBotNightTarget(room,bot);
      if (target) { submitNight(room,bot,target); if (room.phase!=='night') return; }
    }
  }
  if (room.phase==='day') {
    for (let i=0;i<4;i++) {
      if (now-room.phaseStarted>= [4000,14000,26000,38000][i] && !room.botChatSteps.has(i)) {
        room.botChatSteps.add(i); botMessage(room);
      }
    }
  }
  if (room.phase==='vote' && now-room.phaseStarted>3000) {
    for (const bot of alive(room).filter(p=>p.bot&&!room.votes[p.id])) {
      room.votes[bot.id]=chooseBotVote(room,bot);
      publish(room);
      maybeEndEarly(room);
      if (room.phase!=='vote') return;
    }
  }
  if (room.deadline && Date.now()>=room.deadline) {
    if (room.phase==='night') resolveNight(room);
    else if (room.phase==='day') enterVote(room);
    else if (room.phase==='vote') resolveVote(room);
  }
}
function send(res,status,obj) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'Access-Control-Allow-Origin':'same-origin'});
  res.end(JSON.stringify(obj));
}
async function parseJson(req) {
  return new Promise((resolve,reject)=>{
    let buf='';
    req.on('data',part=>{buf+=part;if(buf.length>8000){reject(Error('요청이 너무 큽니다.'));req.destroy();}});
    req.on('end',()=>{try{resolve(JSON.parse(buf||'{}'));}catch{reject(Error('올바른 요청이 아닙니다.'));}});
    req.on('error',reject);
  });
}
function secureRoom(body) {
  const room=rooms.get(String(body.code||'').toUpperCase());
  if (!room) throw Error('존재하지 않는 방입니다.');
  const me=findPlayer(room,body.token);
  if (!me) throw Error('참가자 인증에 실패했습니다. 새로 참가해 주세요.');
  return {room,me};
}
function onAction(room,me,body) {
  const type=String(body.type||'');
  const host=room.hostId===me.id;
  if (type==='add_bot') {
    if (!host||room.phase!=='lobby') throw Error('방장만 대기실에서 AI를 추가할 수 있습니다.');
    if (room.players.length>=MAX_PLAYERS) throw Error('최대 12명까지 참가할 수 있습니다.');
    addBot(room);
  } else if (type==='remove_player') {
    if (!host||room.phase!=='lobby') throw Error('방장만 대기실에서 제거할 수 있습니다.');
    const target=room.players.find(p=>p.id===body.target);
    if (!target || target.id===room.hostId) throw Error('삭제할 수 없는 참가자입니다.');
    room.players=room.players.filter(p=>p.id!==target.id);
    addLog(room, `${target.name} 님이 대기실에서 제외되었습니다.`);
  } else if (type==='start') {
    if (!host||room.phase!=='lobby') throw Error('방장만 게임을 시작할 수 있습니다.');
    if (room.players.length<MIN_PLAYERS) throw Error('5명 이상 모이면 시작할 수 있습니다.');
    startGame(room);
  } else if (type==='night') {
    submitNight(room,me,String(body.target||''));
  } else if (type==='vote') {
    if (room.phase!=='vote'||!me.alive) throw Error('지금은 투표할 수 없습니다.');
    if (room.votes[me.id]) throw Error('이미 투표했습니다.');
    const target=String(body.target||'');
    if (target!=='skip' && !alive(room).some(p=>p.id===target&&p.id!==me.id)) throw Error('투표할 수 없는 대상입니다.');
    room.votes[me.id]=target;
    addLog(room,`${me.name} 님이 투표를 완료했습니다.`);
    publish(room); maybeEndEarly(room);
  } else if (type==='chat') {
    if (room.phase!=='day'||!me.alive) throw Error('낮 토론에서 생존자만 발언할 수 있습니다.');
    const msg=String(body.message||'').trim().slice(0,120);
    if (!msg) throw Error('메시지를 입력해 주세요.');
    if (!me.lastChat || Date.now()-me.lastChat>1000) {
      me.lastChat=Date.now(); addLog(room,`${me.name}: ${msg}`,'chat');
    } else throw Error('메시지를 너무 빠르게 보내고 있습니다.');
  } else if (type==='restart') {
    if (!host||room.phase!=='ended') throw Error('방장만 종료된 게임을 다시 시작할 수 있습니다.');
    room.players.forEach(p=>{p.alive=true;p.role=null;p.clue=null;});
    room.dayNumber=0; room.winner=null; room.nightActions={};room.votes={};
    phaseSet(room,'lobby');room.logs=[];addLog(room,'🔄 대기실로 돌아왔습니다. 다음 게임을 준비하세요.');
  } else throw Error('지원하지 않는 행동입니다.');
  publish(room);
}
const indexFile=path.join(__dirname,'public','index.html');
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET' && (url.pathname==='/' || url.pathname==='/index.html')) {
    try { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});
      fs.createReadStream(indexFile).pipe(res); } catch {res.writeHead(500);res.end('HTML file missing');}
    return;
  }
  if(req.method==='GET' && url.pathname==='/health') return send(res,200,{ok:true,rooms:rooms.size});
  if(req.method==='GET' && url.pathname==='/events') {
    const room=rooms.get(String(url.searchParams.get('room')||'').toUpperCase());
    const me=room&&findPlayer(room,url.searchParams.get('token'));
    if(!me) return send(res,401,{error:'인증에 실패했습니다.'});
    res.writeHead(200,{
      'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive', 'X-Accel-Buffering':'no'
    });
    const listener={res,pid:me.id};room.listeners.add(listener);
    res.write('retry: 1500\n\n');
    res.write('data: '+JSON.stringify(view(room,me.id))+'\n\n');
    res.on('close',()=>{room.listeners.delete(listener);publish(room);});
    publish(room);
    return;
  }
  if(req.method!=='POST' || !url.pathname.startsWith('/api/')) return send(res,404,{error:'찾을 수 없습니다.'});
  try {
    const body=await parseJson(req);
    if(url.pathname==='/api/create') {
      const name=cleanName(body.name);
      if(name.length<2) throw Error('닉네임은 2글자 이상으로 입력해 주세요.');
      const {room,host}=createRoom(name);
      return send(res,200,{ok:true,code:room.code,token:host.token});
    }
    if(url.pathname==='/api/join') {
      const room=rooms.get(String(body.code||'').trim().toUpperCase());
      if(!room) throw Error('초대 코드가 올바르지 않습니다.');
      if(room.phase!=='lobby') throw Error('게임이 이미 시작되었습니다. 다음 판을 기다려 주세요.');
      if(room.players.length>=MAX_PLAYERS) throw Error('방에 빈자리가 없습니다.');
      const name=cleanName(body.name);
      if(name.length<2) throw Error('닉네임은 2글자 이상으로 입력해 주세요.');
      if(room.players.some(p=>p.name.toLowerCase()===name.toLowerCase())) throw Error('이미 사용 중인 닉네임입니다.');
      const player={id:id(),token:id()+id(),name,bot:false,alive:true,role:null,clue:null};
      room.players.push(player);
      addLog(room,`${name} 님이 입장했습니다.`);publish(room);
      return send(res,200,{ok:true,code:room.code,token:player.token});
    }
    if(url.pathname==='/api/action') {
      const {room,me}=secureRoom(body);
      onAction(room,me,body);
      return send(res,200,{ok:true});
    }
    return send(res,404,{error:'찾을 수 없습니다.'});
  } catch(err) { return send(res,400,{error:err.message||'요청 처리에 실패했습니다.'}); }
});
setInterval(()=>{
  const now=Date.now();
  for (const room of rooms.values()) {
    tick(room);
    if (now-room.updated>24*3600*1000 && room.listeners.size===0) rooms.delete(room.code);
  }
},700).unref();
setInterval(()=>{for(const room of rooms.values()) for(const l of room.listeners) {
  try {l.res.write(': keepalive\n\n');} catch {room.listeners.delete(l);}
}},15000).unref();
server.listen(PORT,HOST,()=>console.log(`🎭 마피아 서버 실행: http://localhost:${PORT}`));
module.exports={server,rooms};
