(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  let latest=null,selectedRoomId=null,pendingImportRoomId=null,chatSendKeyMode='enter',copyTimer=null;
  const lastChatByRoom=new Map(),unreadByRoom=new Map(),followByRoom=new Map();
  const requestFetch=window.DoubleLudoRequestRetry&&window.DoubleLudoRequestRetry.fetch?window.DoubleLudoRequestRetry.fetch:window.fetch.bind(window);

  function notice(text){$('notice').textContent=String(text||'')}
  function escapeText(value){return String(value??'')}
  async function api(path,body){
    const options=body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'};
    const response=await requestFetch(path,options);let data=null;try{data=await response.json()}catch(_){}
    if(!response.ok)throw new Error(data&&data.message?data.message:`HTTP ${response.status}`);return data;
  }
  function copyText(value){if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(String(value));const area=document.createElement('textarea');area.value=String(value);area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();return Promise.resolve()}
  function showCopyPop(button){const pop=$('copyPop'),rect=button.getBoundingClientRect();pop.style.left=Math.max(58,Math.min(innerWidth-58,rect.left+rect.width/2))+'px';pop.style.top=Math.max(50,rect.top)+'px';pop.classList.remove('hidden');pop.style.animation='none';void pop.offsetWidth;pop.style.animation='';if(copyTimer)clearTimeout(copyTimer);copyTimer=setTimeout(()=>pop.classList.add('hidden'),900)}
  async function copyWithPop(button,value){await copyText(value);showCopyPop(button)}
  function statusLabel(status){return status==='playing'?'游戏中':status==='lobby'?'等待开局':'已关闭'}
  function roomById(id){return latest&&Array.isArray(latest.rooms)?latest.rooms.find(room=>Number(room.roomId)===Number(id)):null}
  function selectRoom(roomId){selectedRoomId=Number(roomId);renderRooms();renderChat()}
  function inviteUrl(code){try{const game=new URL(latest.gameUrl||location.origin+'/game.html');return `${game.origin}/game.html?port=${encodeURIComponent(code)}&URL=${encodeURIComponent(game.origin)}`}catch(_){return location.origin+'/game.html'}}

  function renderRooms(){
    const grid=$('roomsGrid');grid.replaceChildren();const rooms=latest&&Array.isArray(latest.rooms)?latest.rooms:[];
    if(!rooms.length){const empty=document.createElement('section');empty.className='card muted';empty.textContent=latest&&latest.onlineMode?'当前没有活动联机房间。':'当前没有房间。';grid.appendChild(empty);return}
    for(const room of rooms){
      const card=document.createElement('article');card.className='card room-card'+(Number(room.roomId)===Number(selectedRoomId)?' selected':'');card.onclick=event=>{if(!event.target.closest('button,a'))selectRoom(room.roomId)};
      const head=document.createElement('div');head.className='room-head';const title=document.createElement('div');title.innerHTML=`<div class="room-title">房间 ${room.roomId}</div><div class="room-state">${statusLabel(room.roomStatus)} · 版本 ${room.version}</div>`;head.appendChild(title);card.appendChild(head);
      const meta=document.createElement('div');meta.className='muted';meta.textContent=latest.onlineMode?`账号：${room.ownerAccountId||'管理员房间'} · 归属IP：${room.createdByIpAddress||'未记录'}`:`端口：${latest.port}`;card.appendChild(meta);
      const codes=document.createElement('div');codes.className='codes';
      for(const role of ['A','B']){
        const code=room.codes&&room.codes[role]||'-----';const box=document.createElement('div');box.className='code';const label=document.createElement('span');label.textContent=`玩家${role}`;const strong=document.createElement('strong');strong.textContent=code;const online=document.createElement('span');online.className='code-status';online.textContent=room.connected&&room.connected[role]?'在线':'离线';const buttons=document.createElement('div');buttons.className='code-buttons';
        const copy=document.createElement('button');copy.textContent='复制登录码';copy.disabled=code==='-----';copy.onclick=()=>copyWithPop(copy,code);buttons.appendChild(copy);
        if(latest.onlineMode){const invite=inviteUrl(code);const copyInvite=document.createElement('button');copyInvite.textContent='复制邀请链接';copyInvite.disabled=code==='-----';copyInvite.onclick=()=>copyWithPop(copyInvite,invite);const open=document.createElement('a');open.className='button primary';open.textContent='打开';open.target='_blank';open.rel='noopener';open.href=invite;buttons.append(copyInvite,open)}else{const bundle=document.createElement('button');bundle.textContent='复制端口+登录码';bundle.disabled=code==='-----';bundle.onclick=()=>copyWithPop(bundle,String(latest.port)+'-'+code);buttons.appendChild(bundle)}
        box.append(label,strong,online,buttons);codes.appendChild(box)
      }
      card.appendChild(codes);
      const actions=document.createElement('div');actions.className='room-actions';const defs=room.roomStatus==='closed'?[['开房','open','primary']]:[['重新开局','restart',''],['刷新登录码','refresh',''],['导出对局','export',''],['恢复对局','import',''],['关闭房间','close','danger']];
      for(const [label,action,klass] of defs){const button=document.createElement('button');button.textContent=label;if(klass)button.className=klass;button.onclick=()=>roomAction(room.roomId,action);actions.appendChild(button)}card.appendChild(actions);
      const logTitle=document.createElement('div');logTitle.className='muted';logTitle.textContent='日志';const log=document.createElement('pre');log.className='room-log';log.textContent=Array.isArray(room.roomLog)&&room.roomLog.length?room.roomLog.join('\n'):'暂无日志';card.append(logTitle,log);grid.appendChild(card)
    }
  }

  function renderAccounts(){
    const card=$('accountsCard');if(!latest||!latest.onlineMode){card.classList.add('hidden');return}card.classList.remove('hidden');const accounts=Array.isArray(latest.accounts)?latest.accounts:[];$('accountCount').textContent=String(accounts.length);const list=$('accounts');list.replaceChildren();
    if(!accounts.length){const empty=document.createElement('div');empty.className='muted';empty.textContent='当前没有账号。';list.appendChild(empty);return}
    for(const account of accounts){const item=document.createElement('article');item.className='account-item';const title=document.createElement('strong');title.textContent=account.accountId;const meta=document.createElement('div');meta.className='account-meta';meta.textContent=`IP：${account.ownerIpAddress||'未知'}\n状态：${account.active?'管理页在线':'未登录'}\n房间：${account.roomIds&&account.roomIds.length?account.roomIds.join('、'):'无'}\n创建：${new Date(account.createdAt).toLocaleString()}\n最近访问：${new Date(account.lastAccessAt).toLocaleString()}`;meta.style.whiteSpace='pre-line';const del=document.createElement('button');del.className='danger';del.textContent='删除账号及房间';del.onclick=async()=>{if(!confirm(`确定删除账号 ${account.accountId} 及其全部房间？对局玩家会立即退出。`))return;try{paint(await api('/api/admin/account/delete',{accountId:account.accountId}));notice('账号已删除')}catch(error){notice('删除失败：'+error.message)}};item.append(title,meta,del);list.appendChild(item)}
  }

  function renderOnlinePlayers(){
    const card=$('onlinePlayersCard');
    if(!latest||!latest.onlineMode){card.classList.add('hidden');return}
    card.classList.remove('hidden');
    const players=Array.isArray(latest.onlinePlayers)?latest.onlinePlayers:[];
    $('onlinePlayerAdminCount').textContent=String(players.length);
    const list=$('onlinePlayers');list.replaceChildren();
    if(!players.length){const empty=document.createElement('div');empty.className='muted';empty.textContent='当前没有在线玩家。';list.appendChild(empty);return}
    for(const player of players){
      const item=document.createElement('article');item.className='online-player-item';
      const title=document.createElement('strong');title.textContent=`房间 ${player.roomId} · 玩家${player.role}`;
      const meta=document.createElement('div');meta.className='online-player-meta';
      meta.textContent=`IP：${player.ipAddress||'未知'}\n账号：${player.accountId||'管理员房间'}\n最后活动：${player.lastSeenAt?new Date(player.lastSeenAt).toLocaleString():'未知'}`;
      item.append(title,meta);list.appendChild(item);
    }
  }

  function renderChat(){
    const rooms=latest&&Array.isArray(latest.rooms)?latest.rooms:[],select=$('chatRoomSelect');select.replaceChildren();for(const room of rooms){const option=document.createElement('option');option.value=String(room.roomId);option.textContent=`房间 ${room.roomId} · ${statusLabel(room.roomStatus)}`;select.appendChild(option)}
    if(!rooms.length)selectedRoomId=null;else if(!roomById(selectedRoomId))selectedRoomId=rooms[0].roomId;select.value=selectedRoomId==null?'':String(selectedRoomId);const room=roomById(selectedRoomId),roomId=Number(selectedRoomId),log=$('chatLog'),near=followByRoom.get(roomId)!==false,previousTop=log.scrollTop,messages=room&&Array.isArray(room.chatMessages)?room.chatMessages:[],newVersion=room?Number(room.chatVersion):-1,oldVersion=lastChatByRoom.get(roomId);const incoming=oldVersion!==undefined&&newVersion>oldVersion&&messages.length&&messages.at(-1).player!=='SERVER';let unread=Number(unreadByRoom.get(roomId)||0);if(incoming){$('chatCard').classList.remove('chat-bg-shake');void $('chatCard').offsetWidth;$('chatCard').classList.add('chat-bg-shake');unread=near?0:unread+Math.max(1,newVersion-oldVersion)}log.replaceChildren();$('chatCount').textContent=String(messages.length);
    if(!messages.length){const empty=document.createElement('div');empty.className='chat-empty';empty.textContent=room&&room.roomStatus!=='closed'?'暂无消息。':'请选择已开启的房间。';log.appendChild(empty)}else for(const msg of messages){const item=document.createElement('article');item.className='chat-message'+(msg.player==='SERVER'?' server':'');const meta=document.createElement('div');meta.className='chat-meta';meta.textContent=`${escapeText(msg.time)} ${escapeText(msg.name)}:`;const content=document.createElement('div');content.className='chat-content';content.textContent=escapeText(msg.content);item.append(meta,content);log.appendChild(item)}
    requestAnimationFrame(()=>{log.scrollTop=near?log.scrollHeight:previousTop});unreadByRoom.set(roomId,unread);$('chatUnread').textContent='未读 '+unread;$('chatUnread').classList.toggle('hidden',unread<=0);const enabled=Boolean(room&&room.roomStatus!=='closed');$('chatInput').disabled=!enabled;$('chatHint').disabled=!enabled;$('sendChat').disabled=!enabled||!$('chatInput').value.trim();$('chatHint').textContent=enabled?`当前：${chatSendKeyMode==='enter'?'Enter':'Shift+Enter'}发送`:'请选择已开启房间';if(room)lastChatByRoom.set(roomId,newVersion)
  }

  function applyLanguage(){
    const online=Boolean(latest&&latest.onlineMode);document.title=online?'双飞 v0.42.2 联机服务器管理':'双飞 v0.42.2 多房间局域网服务端';$('adminTitle').textContent=document.title;$('adminSubtitle').textContent=online?'在线登录码自动绑定房间；账号和房间仅保存在当前服务实例内存中。':'登录码自动绑定房间，客户端无需输入房间号。';$('chatTitle').textContent=online?'联机聊天':'局域网聊天';$('createRoom').textContent=online?'新建管理员房间':'新建房间';$('aboutContent').innerHTML=online?'<p>by IQ Online Studio, <a href="https://github.com/iqonli/double-ludo" target="_blank" rel="noopener noreferrer">github.com/iqonli/double-ludo</a></p><p>本项目使用MIT许可证。Copyright © 2026 IQ Online Studio.</p><p>当前页面是双飞联机服务器管理端。管理员可以检查并删除活动账号和房间、查看聊天、房间日志及完整连接IP。</p>':'<p>by IQ Online Studio, <a href="https://github.com/iqonli/double-ludo" target="_blank" rel="noopener noreferrer">github.com/iqonli/double-ludo</a></p><p>本项目使用MIT许可证。Copyright © 2026 IQ Online Studio.</p><p>当前页面是本机多房间局域网服务端管理页面。</p>'
  }

  function paint(data){latest=data;if(selectedRoomId==null&&data.rooms&&data.rooms.length)selectedRoomId=data.rooms[0].roomId;applyLanguage();$('gameLink').href=data.gameUrl||location.origin+'/game.html';$('gameLink').textContent='游戏端';renderRooms();renderAccounts();renderOnlinePlayers();renderChat();const pre=$('consoleLog'),near=pre.scrollHeight-pre.clientHeight-pre.scrollTop<55;pre.textContent=data.consoleText||'';if(near)requestAnimationFrame(()=>{pre.scrollTop=pre.scrollHeight})}
  async function status(){try{paint(await api('/api/admin/status'))}catch(error){notice('读取状态失败：'+error.message)}}
  async function roomAction(roomId,action){try{if(action==='export'){location.href='/api/admin/export-game?roomId='+encodeURIComponent(roomId)+'&download='+Date.now();return}if(action==='import'){pendingImportRoomId=Number(roomId);$('importFile').value='';$('importFile').click();return}const paths={open:'/api/admin/room/open',restart:'/api/admin/room/restart',refresh:'/api/admin/room/refresh-codes',close:'/api/admin/room/close'};paint(await api(paths[action],{roomId:Number(roomId)}));selectedRoomId=Number(roomId);notice(`房间${roomId}操作完成`)}catch(error){notice('操作失败：'+error.message);await status()}}

  $('createRoom').onclick=async()=>{try{const data=await api('/api/admin/rooms/create',{});paint(data);selectedRoomId=data.createdRoomId;renderRooms();renderChat();notice(`已新建房间${data.createdRoomId}`)}catch(error){notice('新建失败：'+error.message)}};
  $('chatRoomSelect').onchange=()=>selectRoom(Number($('chatRoomSelect').value));$('chatInput').oninput=renderChat;$('chatHint').onclick=()=>{chatSendKeyMode=chatSendKeyMode==='enter'?'shift-enter':'enter';renderChat()};$('sendChat').onclick=async()=>{const content=$('chatInput').value.replace(/\r\n?/g,'\n').trim();if(!content||selectedRoomId==null)return;try{paint(await api('/api/admin/chat',{roomId:Number(selectedRoomId),content}));$('chatInput').value='';renderChat()}catch(error){notice('发送失败：'+error.message)}};$('chatInput').onkeydown=event=>{if(event.key!=='Enter')return;const send=chatSendKeyMode==='enter'?!event.shiftKey:event.shiftKey;if(send){event.preventDefault();$('sendChat').click()}};
  $('chatUnread').onclick=()=>{const log=$('chatLog'),roomId=Number(selectedRoomId);unreadByRoom.set(roomId,0);followByRoom.set(roomId,true);$('chatUnread').classList.add('hidden');log.scrollTop=log.scrollHeight};$('chatLog').onscroll=()=>{const log=$('chatLog'),roomId=Number(selectedRoomId),atBottom=log.scrollHeight-log.clientHeight-log.scrollTop<24;followByRoom.set(roomId,atBottom);if(atBottom){unreadByRoom.set(roomId,0);$('chatUnread').classList.add('hidden')}};
  $('aboutButton').onclick=()=>$('aboutModal').classList.remove('hidden');$('closeAboutButton').onclick=()=>$('aboutModal').classList.add('hidden');$('aboutModal').onclick=event=>{if(event.target===$('aboutModal'))$('aboutModal').classList.add('hidden')};
  $('importFile').onchange=async()=>{const file=$('importFile').files[0];if(!file||pendingImportRoomId==null)return;try{const parsed=JSON.parse(await file.text());paint(await api('/api/admin/import-game',{roomId:pendingImportRoomId,gameFile:parsed}));selectedRoomId=pendingImportRoomId;notice('已恢复：'+file.name)}catch(error){notice('恢复失败，原局未改变：'+error.message);await status()}finally{pendingImportRoomId=null}};
  (()=>{const card=$('chatCard'),handle=$('chatResizeHandle');let startY=0,startHeight=0;try{const saved=Number(localStorage.getItem('doubleFlightAdminChatHeight'));if(Number.isFinite(saved)&&saved>=300)card.style.height=Math.min(saved,innerHeight-28)+'px'}catch(_){}const move=event=>{card.style.height=Math.max(300,Math.min(innerHeight-28,startHeight+event.clientY-startY))+'px'};const stop=()=>{removeEventListener('pointermove',move);removeEventListener('pointerup',stop);try{localStorage.setItem('doubleFlightAdminChatHeight',String(Math.round(card.getBoundingClientRect().height)))}catch(_){}};handle.onpointerdown=event=>{event.preventDefault();startY=event.clientY;startHeight=card.getBoundingClientRect().height;addEventListener('pointermove',move);addEventListener('pointerup',stop,{once:true})}})();
  status();setInterval(()=>{if(!document.hidden)status()},3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)status()});
})();
