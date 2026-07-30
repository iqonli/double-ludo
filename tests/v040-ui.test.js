
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/game.html'), 'utf8');
const game = fs.readFileSync(path.join(root, 'public/game.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const network = fs.readFileSync(path.join(root, 'public/network-client.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const room = fs.readFileSync(path.join(root, 'server/room.js'), 'utf8');

assert(css.includes('--left-panel-width: 350px') && css.includes('--right-panel-width: 350px'), '左右栏默认宽度应为350px');
assert(game.includes('randomBetween(150, 200)') && game.includes('randomBetween(500, 1000)'), '两类灵动动画应为150-200px与500-1000ms');
assert(css.includes('--lan-chat-flash-color: #faefc0'), '聊天闪烁颜色应为#faefc0');
assert(server.includes('#faefc0 64%'), '服务端聊天闪烁颜色也应为#faefc0');
assert(game.includes("label.className = 'finish-count-label'") && css.includes('.finish-count-label'), '完成数量4应使用独立居中标签');
assert(css.includes('translate(-50%, -50%) rotate(var(--confirm-counter-rotation, 0deg))'), '完成数量4应随棋盘反向旋转保持正向');
assert(html.includes('id="rollOrderA" class="ghost-btn order-roll-button"') && html.includes('id="rollOrderB" class="ghost-btn order-roll-button"'), '极速双飞应显示双方投掷按钮');
assert(game.includes("button.classList.toggle('own-roll', ownLanButton)") && css.includes('.order-roll-button.own-roll'), '自己的投掷按钮应使用绿色状态');
assert(game.includes('await lanClient.rollLobbyOrder()') && network.includes("'/api/lobby-order-roll'"), '客户端应通过服务端执行一次性投掷');
assert(server.includes("pathname === '/api/lobby-order-roll'") && room.includes('rollLobbyOrder(token)'), '服务端应提供权威开局投掷接口');
assert(room.includes('PLAYER_B_MUST_ROLL') && room.includes('ORDER_ROLL_ALREADY_USED'), '服务端应限制B准备前投掷和重复投掷');
console.log('v0.40 speed-opening/UI static tests passed');
