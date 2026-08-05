(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const state={token:sessionStorage.getItem('doubleLudoAccountSession')||'',timer:null,statsTimer:null,pendingImportRoomId:null,copyTimer:null,confirmResolve:null,confirmReturnFocus:null};

  const localDateTimeFormatter=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  function parseServerDate(value){const raw=String(value||'').trim();const normalized=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)?raw.replace(' ','T')+'Z':raw;const date=new Date(normalized);return Number.isFinite(date.getTime())?date:null}
  function formatServerTimeLocal(value){const date=parseServerDate(value);return date?localDateTimeFormatter.format(date):String(value||'未知')}

  function notice(text,error=false){
    $('notice').textContent=String(text||'');
    $('notice').classList.toggle('error',Boolean(error));
  }

  async function api(path,body={}){
    const requestFetch=window.DoubleLudoRequestRetry&&window.DoubleLudoRequestRetry.fetch
      ?window.DoubleLudoRequestRetry.fetch
      :window.fetch.bind(window);
    const response=await requestFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});
    let payload=null;
    try{payload=await response.json()}catch(_){payload=null}
    if(!response.ok){
      const error=new Error(payload&&payload.message?payload.message:`HTTP ${response.status}`);
      error.code=payload&&payload.error;
      error.status=response.status;
      throw error;
    }
    return payload;
  }


  async function refreshServerStats(){
    try{
      const requestFetch=window.DoubleLudoRequestRetry&&window.DoubleLudoRequestRetry.fetch
        ?window.DoubleLudoRequestRetry.fetch
        :window.fetch.bind(window);
      const response=await requestFetch('/api/info',{method:'GET',cache:'no-store'});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const data=await response.json();
      $('activeRoomCount').textContent=String(Number(data.activeRoomCount??data.roomCount)||0);
      $('onlinePlayerCount').textContent=String(Number(data.onlinePlayerCount)||0);
    }catch(_){
      $('activeRoomCount').textContent='—';
      $('onlinePlayerCount').textContent='—';
    }
  }

  function escapeHtml(value){
    return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }

  function safeInviteUrl(value){
    try{
      const parsed=new URL(String(value||''),location.origin);
      return /^https?:$/.test(parsed.protocol)?parsed.href:location.origin+'/game.html';
    }catch(_){return location.origin+'/game.html'}
  }

  function copyText(text){
    if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text);
    const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();return Promise.resolve();
  }

  function showCopyPop(button){
    const pop=$('copyPop');
    const rect=button.getBoundingClientRect();
    pop.style.left=`${Math.max(58,Math.min(innerWidth-58,rect.left+rect.width/2))}px`;
    pop.style.top=`${Math.max(50,rect.top)}px`;
    pop.classList.remove('hidden');
    pop.style.animation='none';void pop.offsetWidth;pop.style.animation='';
    if(state.copyTimer)clearTimeout(state.copyTimer);
    state.copyTimer=setTimeout(()=>pop.classList.add('hidden'),900);
  }

  async function copyWithPop(button,text){
    await copyText(text);
    showCopyPop(button);
  }

  function settleConfirm(accepted){
    const resolve=state.confirmResolve;
    state.confirmResolve=null;
    $('hostConfirmModal').classList.add('hidden');
    if(resolve)resolve(Boolean(accepted));
    const target=state.confirmReturnFocus;
    state.confirmReturnFocus=null;
    if(target&&typeof target.focus==='function')requestAnimationFrame(()=>target.focus());
  }

  function askConfirm(message,acceptLabel='确认'){
    if(state.confirmResolve)settleConfirm(false);
    state.confirmReturnFocus=document.activeElement;
    $('hostConfirmMessage').textContent=String(message||'');
    $('hostConfirmAccept').textContent=String(acceptLabel||'确认');
    $('hostConfirmModal').classList.remove('hidden');
    requestAnimationFrame(()=>$('hostConfirmCancel').focus());
    return new Promise(resolve=>{state.confirmResolve=resolve});
  }

  function downloadJson(filename,value){
    const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download=filename||'double-ludo-room.json';document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  async function exportRoom(roomId){
    const data=await api('/api/account/room/export',{sessionToken:state.token,roomId});
    downloadJson(data.filename,data.gameFile);
    notice(`已导出房间${roomId}`);
  }

  function renderRoom(room){
    const card=document.createElement('article');
    card.className='card room-card';
    const roomId=Number(room.roomId);
    const status=room.roomStatus==='playing'?'游戏中':'等待开局';
    const lastActivity=formatServerTimeLocal(room.lastPlayerActivityAt);
    card.innerHTML=`
      <div class="room-head">
        <div><h2>房间 ${Number.isInteger(roomId)?roomId:'—'}</h2><div class="room-meta">状态：${status}<br>最近玩家活动（本地时间）：${escapeHtml(lastActivity)}<br>归属IP：${escapeHtml(room.ownerIpAddress||'未知')}</div></div>
        <button class="danger" data-delete-room="${Number.isInteger(roomId)?roomId:''}">删除房间</button>
      </div>
      <div class="codes">
        ${['A','B'].map(role=>{const code=escapeHtml(room.codes&&room.codes[role]);const invite=escapeHtml(safeInviteUrl(room.invites&&room.invites[role]));return `<div class="code-box"><span>玩家${role}登录码</span><strong>${code}</strong><div class="code-actions"><button data-copy-code="${role}">复制登录码</button><button data-copy-invite="${role}">复制邀请链接</button><a class="button primary" target="_blank" rel="noopener" href="${invite}">打开</a></div></div>`}).join('')}
      </div>
      <div class="room-file-actions"><button data-export-room>导出对局</button><button data-import-room>导入对局</button></div>`;
    card.querySelectorAll('[data-copy-code]').forEach(button=>button.onclick=()=>copyWithPop(button,room.codes[button.dataset.copyCode]));
    card.querySelectorAll('[data-copy-invite]').forEach(button=>button.onclick=()=>copyWithPop(button,room.invites[button.dataset.copyInvite]));
    card.querySelector('[data-export-room]').onclick=async()=>{try{await exportRoom(roomId)}catch(error){handleError(error)}};
    card.querySelector('[data-import-room]').onclick=()=>{state.pendingImportRoomId=roomId;$('importFile').value='';$('importFile').click()};
    card.querySelector('[data-delete-room]').onclick=async()=>{
      if(!(await askConfirm(`确定删除房间${room.roomId}？正在游戏的玩家会立即失去连接。`,'删除房间')))return;
      try{render(await api('/api/account/room/delete',{sessionToken:state.token,roomId:room.roomId}));notice(`已删除房间${room.roomId}`)}catch(error){handleError(error)}
    };
    return card;
  }

  function render(data){
    $('loginCard').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    $('accountId').textContent=data.accountId;
    $('ownerIp').textContent=`当前管理IP：${data.ownerIpAddress||'未知'}`;
    $('quota').textContent=`当前账号房间 ${data.roomCount}/${data.accountRoomLimit}；当前IP拥有账号 ${data.ipAccountCount}/${data.ipAccountLimit}`;
    $('createRoomButton').disabled=data.roomCount>=data.accountRoomLimit;
    $('rooms').innerHTML='';
    if(!data.rooms.length){
      const empty=document.createElement('section');empty.className='card muted';empty.textContent='当前账号还没有房间。';$('rooms').appendChild(empty);
    }else data.rooms.forEach(room=>$('rooms').appendChild(renderRoom(room)));
  }

  function showLogin(message=''){
    state.token='';sessionStorage.removeItem('doubleLudoAccountSession');
    $('dashboard').classList.add('hidden');$('loginCard').classList.remove('hidden');
    if(message)notice(message,true);
    if(state.timer){clearInterval(state.timer);state.timer=null}
  }

  function handleError(error){
    if(error&&error.status===401){showLogin(error.message);return}
    notice(error&&error.message?error.message:String(error),true);
  }

  async function refresh(){
    if(!state.token)return;
    try{render(await api('/api/account/state',{sessionToken:state.token}))}catch(error){handleError(error)}
  }

  function beginRefresh(){
    if(state.timer)clearInterval(state.timer);
    state.timer=setInterval(()=>{if(!document.hidden)refresh()},5000);
  }

  $('loginButton').onclick=async()=>{
    const password=$('accountPassword').value;
    $('loginButton').disabled=true;notice('正在进入账号…');
    try{
      const data=await api('/api/account/login',{password});
      state.token=data.sessionToken;sessionStorage.setItem('doubleLudoAccountSession',state.token);$('accountPassword').value='';render(data);beginRefresh();
      const evicted=Array.isArray(data.evictedAccounts)&&data.evictedAccounts.length?` 已自动删除最早拥有的${data.evictedAccounts.length}个账号及其房间。`:'';
      notice((data.takenOver?'账号已由当前IP接管，原管理会话已失效。':(data.created?'账号已创建。':'已进入账号。'))+evicted);
    }catch(error){handleError(error)}finally{$('loginButton').disabled=false}
  };
  $('accountPassword').addEventListener('keydown',event=>{if(event.key==='Enter')$('loginButton').click()});
  $('createRoomButton').onclick=async()=>{try{$('createRoomButton').disabled=true;const data=await api('/api/account/room/create',{sessionToken:state.token});render(data);notice(`已创建房间${data.createdRoom.roomId}`)}catch(error){handleError(error)}finally{await refresh()}};
  $('logoutButton').onclick=async()=>{try{await api('/api/account/logout',{sessionToken:state.token})}catch(_){}showLogin('已退出账号。')};
  $('deleteAccountButton').onclick=async()=>{if(!(await askConfirm('确定删除账号及其全部房间？正在对局的玩家会立即退出，此操作不能撤销。','删除账号')))return;try{await api('/api/account/delete',{sessionToken:state.token});showLogin('账号及其房间已删除。')}catch(error){handleError(error)}};
  $('hostConfirmCancel').onclick=()=>settleConfirm(false);
  $('hostConfirmAccept').onclick=()=>settleConfirm(true);
  $('hostConfirmModal').onclick=event=>{if(event.target===$('hostConfirmModal'))settleConfirm(false)};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('hostConfirmModal').classList.contains('hidden')){event.preventDefault();settleConfirm(false)}});
  $('importFile').onchange=async()=>{
    const file=$('importFile').files&&$('importFile').files[0];
    const roomId=state.pendingImportRoomId;
    state.pendingImportRoomId=null;
    if(!file||!roomId)return;
    try{
      const parsed=JSON.parse(await file.text());
      const data=await api('/api/account/room/import',{sessionToken:state.token,roomId,gameFile:parsed});
      render(data);notice(`已向房间${roomId}导入：${file.name}`);
    }catch(error){handleError(error)}
  };
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
  refreshServerStats();
  state.statsTimer=setInterval(()=>{if(!document.hidden)refreshServerStats()},5000);
  if(state.token){refresh();beginRefresh()}else showLogin();
})();
