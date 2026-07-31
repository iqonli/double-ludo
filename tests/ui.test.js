'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const publicFile = name => path.join(__dirname, '../public', name);
const html = fs.readFileSync(publicFile('game.html'), 'utf8');
const game = fs.readFileSync(publicFile('game.js'), 'utf8');
const css = fs.readFileSync(publicFile('styles.css'), 'utf8');
const network = fs.readFileSync(publicFile('network-client.js'), 'utf8');
const engine = require('../shared/engine.js');
const protocol = fs.readFileSync(path.join(__dirname, '../shared/action-protocol.js'), 'utf8');

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML 不应包含重复 id');
const referencedIds = [...game.matchAll(/byId\('([^']+)'\)/g)].map(match => match[1]);
for (const id of referencedIds) assert(ids.includes(id), `game.js 引用了不存在的 #${id}`);

for (const required of ['previewPiece', 'previewGhost', 'timingControls', 'loopWaitMs', 'stepDurationMs', 'specialDurationMs', 'stageWaitMs', 'colorControls', 'copyPalette', 'defeatModal', 'defeatText', 'undoDefeat', 'acceptDefeat', 'victoryModal', 'victoryText', 'replayGame', 'continueGame', 'currentOperator', 'secondConfirm', 'undoActionButton', 'confirmActionButton', 'confirmationArrowLayer', 'confirmationArrowGroup', 'launchValueChoices', 'tripleSixPenalty', 'launchSummary', 'board', 'statusToast', 'lanChatPanel', 'lanChatLog', 'lanChatInput', 'lanChatSend', 'lanChatCount', 'lanChatHint', 'turnInteractionPanel']) {
  assert(ids.includes(required), `缺少界面元素 #${required}`);
}


assert(!fs.existsSync(publicFile('index.html')), 'game.html与index.html相同时只保留game.html');
for (const required of ['backToGame','aiSetupSection','setupAiAEnabled','setupAiAModel','setupAiBEnabled','setupAiBModel','aiControlModal','runtimeAiModel']) {
  assert(ids.includes(required), `缺少人机界面元素 #${required}`);
}
assert(html.includes('ai-model-normal.js') && html.includes('ai-controller.js'), '网页应加载人机模型与控制器');
assert(game.includes('DoubleFlightAI.predict') && game.includes('切换为人机') && game.includes('夺回控制权'), '应实现浏览器人机决策与中途接管');
assert(css.includes('max-height: calc(100dvh - 48px)') && css.includes('overflow-y: auto'), '开局设置卡应支持小屏滚动');
const forbiddenSourceKeys = [
  String.fromCharCode(110,101,116,109,97,110,102,105,115,104,101,114),
  String.fromCharCode(99,104,105,110,101,115,101,45,108,117,100,111),
  String.fromCharCode(67,104,105,110,101,115,101,32,76,117,100,111,32,67,111,110,116,114,105,98,117,116,111,114,115)
];
for (const forbidden of forbiddenSourceKeys) {
  assert(!game.includes(forbidden) && !html.includes(forbidden) && !css.includes(forbidden), '发行源码不应包含旧来源关键词');
}
assert(!fs.existsSync(publicFile('NOTICE.md')), '发行包不应保留旧来源说明文件');

assert.equal(engine.BOARD_PATH_LENGTH, 48);
assert.equal(Object.keys(engine.SHORTCUTS).length, 4, '应有四个飞线箭头');
assert(game.includes('loopWaitMs: 250') && game.includes('stepDurationMs: 300') && game.includes('specialDurationMs: 300') && game.includes('stageWaitMs: 100'), '四类动画默认时序应为250/300/300/100ms');
assert(css.includes('transition: left var(--motion-ms) linear, top var(--motion-ms) linear'), '棋子位移动画应使用可调时序');
assert(game.includes('当前操作：${current.name}'));
assert(game.includes('buildPaletteControls()'));
assert.equal((game.match(/label: '[红黄蓝绿]色(?:棋子|格子|机场)'/g) || []).length, 12, '调色面板应包含四种颜色各三项');
assert(!game.includes('未候选棋子'), '候选与非候选棋子应使用同一颜色');
assert(game.includes("['R', 'r', 0, 255]") && game.includes("['H', 'h', 0, 359]"), '调色面板应包含RGBHSL六滑块');
assert(game.includes('copyPalette()'), '应支持复制全部颜色信息');
assert(game.includes('undoPendingDefeat()'), '三连6弹窗应支持十次反悔');
assert(game.includes("stages.push({ type: 'move', events: [last] })"), '普通骰子移动应合并为一个单步阶段');
assert(game.includes('await delay(timing.loopWaitMs)'), '幽灵棋子循环之间应使用可调间隔');
assert(game.includes('overlap-expanded') && css.includes('opacity: .80'), '叠放棋子应支持80%透明及悬停分散');
assert(game.includes('玩家${number}获胜！！！！！！'), '获胜弹窗文案应符合要求');
assert(game.includes('analyzePendingSwap()'));
const drawBoardSource = game.slice(game.indexOf('function drawBoard()'), game.lastIndexOf('\n})();'));
assert(!drawBoardSource.includes("make('text'"), '棋盘内不应绘制文字');
assert(!drawBoardSource.includes('finishX1 + offset'), '中心3×3不应绘制内部网格线');
assert(!drawBoardSource.includes('whiteGlow'), '飞线箭头不应使用白色高亮');

assert(css.includes('--accent: #1b8ca3;'), 'UI 主色应为 #1b8ca3');
assert(!ids.includes('actionPanel') && !ids.includes('messagePanel'), '投掷与交换按钮下方不应保留旧交互控件');
assert(html.includes('id="rollButton" class="primary-btn full">投掷</button>'));
assert(html.includes('id="swapButton" class="ghost-btn full">交换棋子</button>'));
const launchBlock = (html.match(/id="launchValueChoices"[\s\S]*?<\/div>/) || [''])[0];
assert.equal((launchBlock.match(/type="checkbox"/g) || []).length, 6, '开局应提供1至6六个起飞点数复选框');
assert(html.includes('三6遣返（同一颜色同一回合连三个6全回家）'));
assert(game.includes('handleBoardPointerMove') && game.includes('overlapHitRegions'), '叠放悬停应使用模拟区域边缘检测');
assert(game.includes('count === 2') && game.includes('count === 3') && game.includes('count === 5'), '叠放展开应提供2、3、5枚专项布局');
assert(game.includes('-Math.PI / 2 + index * Math.PI * 2 / count'), '六枚及以上应圆形均分且顶部有一枚');
assert(game.includes("el.victoryText.textContent = '残局结束。'") && game.includes("el.continueGame.classList.add('hidden')"), '残局完成时应只显示残局结束与重玩');

assert(ids.includes('nextPlayerButton') && html.includes('>下一个玩家</button>'), '无路可走时应提供下一个玩家按钮');
assert(!game.includes('isEntry ?') && !game.includes("stroke: isEntry"), '终点跑道前一格不应有特殊边框绘制');
assert(game.includes("'stroke-width': 1.2"), '普通航道格应保持统一描边');
assert(game.includes("label.className = 'finish-count-label'") && game.includes("label.textContent = '4'"), '四枚完成棋子中央应显示白字4');
assert(css.includes('.finish-count-label') && css.includes('rotate(var(--confirm-counter-rotation, 0deg))'), '完成数量应位于独立标签并在棋盘旋转时保持正向');


assert(html.includes('id="secondConfirm" type="checkbox"'), '回合交互右侧应有二次确认复选框');
assert(html.includes('id="undoActionButton"') && html.includes('>撤销</button>'), '回合交互右侧应有撤销/取消按钮');
assert(html.includes('id="confirmActionButton"') && html.includes('>✓</button>'), '终点中央应有确认按钮');
assert(game.includes('pendingConfirmation') && game.includes('beginMoveConfirmation') && game.includes('beginSwapConfirmation'), '移动与交换应支持待确认事务');
assert(game.includes('startSwapConfirmationPreview'), '交换应有循环幽灵动画');
assert(game.includes('preview-capture-ghost') && game.includes('event.fromLocation'), '吃子返回机场应进入每轮预览动画');
assert(game.includes('engine.restore(record.snapshot)'), '撤销应恢复完整引擎快照');
assert(game.includes('assignmentCheckpoint'), '撤销骰子指派应保存选骰前检查点');
assert(game.includes('commitSnapshot: assignmentCheckpoint || engine.serialize()') && game.includes('selectionSnapshot: engine.serialize()'), '二次确认移动应同时保留撤销快照与选骰状态快照');
assert(game.includes('clearUndoRecord();') && game.includes('async function handleRoll(options = {})'), '每次投骰应清空旧撤销记录');
assert(css.includes('.confirm-action-button') && css.includes('.preview-swap-ghost') && css.includes('.preview-capture-ghost'));

assert(html.includes('<span>循环播放等待</span>') && html.includes('<span>单步时长</span>') && html.includes('<span>特殊时长</span>') && html.includes('<span>阶段等待</span>'), '时序名称应使用新版命名');
assert(game.includes("el.undoActionButton.textContent = pendingConfirmation ? '取消'") && game.includes("'等待回应'"), '待确认时按钮应改名为取消，联机申请中应显示等待回应');
assert(game.includes("el.board.addEventListener('click', handleBoardClick)"), '棋盘任意非确认区域应可取消待确认操作');
assert(game.includes("event.target.closest('#confirmActionButton')"), '棋盘取消不应拦截中央确认按钮');
assert(game.includes("node.classList.toggle('pending-confirm-target'"), '待确认棋子应保留专用高亮');
assert(css.includes('.piece.pending-confirm-target') && css.includes('rgba(255,255,255,.96)'), '待确认高亮应为白色光效');
assert(game.includes('previewPlan') && game.includes('buildAnimationStages((pending.previewPlan'), '交换幽灵预览应包含落点后续结算阶段');
assert(game.includes('timing.stageWaitMs') && game.includes('stageIndex < stages.length - 1'), '阶段等待只能插入相邻阶段之间');
assert(!game.includes('swapUndoLocked'), '不应保留强制重新交换的旧状态锁');
assert(game.includes(`if (swapMode) {\n      swapMode = false;\n      swapSelection = [];\n    }\n    clearUndoRecord();`), '进入交换模式后仍应允许直接改为投骰');


assert(game.includes('lockedOverlapKey') && game.includes('Touch-care mode'), '二次确认应支持点击锁定叠放展开');
assert(game.includes('pendingSwapOrderChoice') && game.includes('selectedFirstPieceId'), '交换顺序不同应先选择结算棋子再确认');
assert(game.includes('const startLocations = pieceIds.map') && game.includes('endLocations = pieceIds.map'), '交换幽灵应从真实交换前后位置生成');
assert(css.includes('.piece.rotating-swap-order-target::before') && css.includes('swap-order-dash-rotate') && css.includes('8s linear infinite'), '二次确认未勾选且需要选择交换结算顺序时，应显示8秒一圈的旋转黑色虚线');
assert(!css.includes('.piece.pending-swap-confirm-target::before') && !game.includes('pending-swap-confirm-target'), '二次确认期间不应再给待确认交换棋子显示黑色虚线');
assert(game.includes('engine.restore(pending.selectionSnapshot)') && game.includes('assignmentCheckpoint = pending.commitSnapshot'), '取消移动确认应保留骰子选中状态');
assert(html.includes('value="250"') && html.includes('id="stageWaitMs"') && html.includes('value="100"'), 'HTML 默认时序应为250/300/300/100ms');

assert(game.includes('window.clearTimeout(overlapCollapseTimer)') && game.includes('if (pendingConfirmation || (secondConfirmEnabled && lockedOverlapKey)) return;'), '触屏待确认预览不应被遗留的悬停关闭计时器终止');
assert(html.includes('id="confirmationArrowLayer"') && html.includes('id="confirmationArrowGroup"'), '棋盘应包含待确认方向箭头层');
assert(game.includes('function renderConfirmationArrows()') && game.includes('function createCustomArrowSegments') && game.includes('function appendCustomArrow') && game.includes('const aX = cx + dx * unit') && game.includes('const dX = cx - dx * unit') && game.includes('const abX = (-dx + px) / Math.SQRT2') && game.includes('const acX = (-dx - px) / Math.SQRT2') && game.includes("appendCustomArrow(el.confirmationArrowGroup") && game.includes("appendCustomArrow(svg"), '两类箭头应使用同一几何函数，并按A点主线/垂线/角平分线方式绘制');
assert(css.includes('.confirmation-direction-arrow') && css.includes('.board-direction-arrow') && css.includes('stroke: rgb(70, 73, 79)') && css.includes('stroke-width: 2.4'), '两类箭头应使用相同中性深色和线宽');
assert(html.indexOf('class="color-test-panel"') < html.indexOf('</main>'), '调色测试应与其他主要区域处于同一主工作区层级');
assert(css.includes('.left-panel { grid-column: 1; grid-row: 1;') && css.includes('.board-panel { grid-column: 1; grid-row: 2;') && css.includes('.right-panel { grid-column: 1; grid-row: 3;') && css.includes('.log-panel { grid-column: 1; grid-row: 4;') && css.includes('.color-test-panel { grid-column: 1; grid-row: 5;'), '窄屏应按玩家信息、棋盘、回合交互、对局记录、调色测试顺序排列');
console.log('ui static tests passed');

assert(html.includes('class="log-panel panel-column"'), '对局记录应拆为独立面板');
assert(css.includes('.game-log::-webkit-scrollbar') && css.includes('scrollbar-gutter: stable both-edges'), '对局记录应提供可见 scrollbar');
assert(css.includes('.log-panel { grid-column: 1; grid-row: 2;') && css.includes('.log-panel { grid-column: 1; grid-row: 4;'), '窄屏时对局记录应显示在回合交互下面');

assert(game.includes('The passed cx/cy is the midpoint of AD'), '箭头中心应定义为AD中点');

assert(html.includes('<strong>棋盘</strong>') && html.includes('id="rotateBoardLeft"') && html.includes('id="rotateBoardRight"') && !html.includes('左上黄 · 右上蓝 · 右下绿 · 左下红'), '棋盘顶栏应改为棋盘并提供左右旋转按钮，删除方位说明');
assert(game.includes('function rotateBoard(delta)') && game.includes('--board-rotation') && game.includes('--confirm-counter-rotation'), '棋盘旋转应使用CSS变量，并为确认按钮提供反向旋转');
assert(css.includes('transform: rotate(var(--board-rotation, 0deg))') && css.includes('rotate(var(--confirm-counter-rotation, 0deg))'), '棋盘图层应旋转，中央确认按钮应保持正向');
assert(game.includes('function getPieceVisualBoardCenter(piece)') && game.includes('node.style.left') && game.includes('getPieceVisualBoardCenter(piece) || coordinatesForLocation'), '确认箭头应优先使用展开后棋子的视觉中心');
assert(game.includes('function compactCjkAsciiSpacing') && game.includes('compactCjkAsciiSpacing(message)'), '对局记录应去掉CJK与非CJK之间的空格');

assert(game.includes('const isProtectedPiece = engine.isProtected(piece.color)') && game.includes("ring.className = 'protected-ring'"), '保护棋子应使用独立内部圆线元素');
assert(css.includes('.protected-ring') && css.includes('inset: 8.333333%') && css.includes('rgba(255,255,255,.60)') && !css.includes('border: 2px double var(--piece-color)'), '保护棋子应使用普通棋子外观加内部白色圆线');

assert(html.includes('局域网聊天') && html.includes('当前：Enter发送'), '玩家信息下方应包含多行局域网聊天控件和发送方式按钮');
assert(css.includes('body.lan-mode .lan-chat-panel') && css.includes('white-space: pre-wrap'), '聊天仅在局域网模式显示并保留多行格式');
assert(game.includes('function sendLanChat()') && game.includes('chat-only') || game.includes('Chat-only'), '应实现聊天发送并避免聊天刷新重建棋局');
assert(!css.includes('backdrop-filter: blur(8px)'), '启动界面背景不应使用模糊效果');
const toastBlock = (css.match(/\.status-toast\s*\{[\s\S]*?\}/) || [''])[0];
assert(/z-index:\s*(?:[3-9]\d{3,}|[1-9]\d{4,})/.test(toastBlock), '顶部消息层级应高于启动界面');
assert(html.includes('min="6666" max="8888"') && !html.includes('value="8765"'), '端口输入应匹配随机端口范围');
assert(game.includes("el.lanPort.value = location.port || '';"), '本地打开HTML时端口应由用户输入');

assert(html.includes('id="lanAutoSearchButton"') && html.includes('id="lanSmartInput"') && html.includes('id="lanSmartApplyButton"'), '局域网连接面板应包含自动搜索IP和智能输入');
assert(game.includes('function autoSearchLanIp()') && game.includes('function applySmartLanInput()') && game.includes('未找到本地服务器'), '应实现内网服务器搜索和智能字段提取');
assert(css.includes('height: 54px') && css.includes('calc(100vh - 54px)'), '顶栏应恢复原高度并同步工作区高度');
assert(game.includes('function animateLanTransition') && game.includes('lanVisualQueue') && game.includes('transitions'), '联机状态应按服务端转场排队播放动画');

assert(css.includes('height: 54px;') && css.includes('calc(100vh - 54px)') && css.includes('calc(100vh - 134px)'), '顶栏与棋盘尺寸应恢复v0.30高度');
assert(html.includes('class="brand-title-row"') && html.indexOf('id="gameTitle"') < html.indexOf('id="networkBadge"'), 'LAN身份气泡应位于双飞标题右侧');
assert(html.includes('id="lanChatHint" class="ghost-btn lan-chat-mode-button"') && html.includes('当前：Enter发送'), '聊天发送方式应为可切换按钮且默认Enter发送');
assert(game.includes("let lanChatSendKeyMode = 'enter'") && game.includes("lanChatSendKeyMode === 'enter' ? !event.shiftKey : event.shiftKey"), '聊天应支持Enter/Shift+Enter发送方式切换');
assert(game.includes("classList.toggle('your-turn', ownLanTurn)") && css.includes('.right-panel.your-turn'), '轮到局域网本人时回合交互卡片应显示淡绿色');

assert(protocol.includes("engine.phase === 'selectPiece'") && protocol.includes('actions.push(2 + dieIndex)'), '已选骰后应允许切换或取消骰子');
assert(!game.includes('局域网模式暂不提供二次确认'), '局域网模式应允许本地二次确认');
assert(html.includes('id="lanChatUnread"') && html.includes('id="setupLanChatUnread"'), '聊天应有未读气泡');
assert(css.includes('@keyframes selectable-white') && css.includes('scale(1.10)'), '待选棋子应恢复白光与缩放动效');

assert(html.includes('id="setupAboutButton"') && html.includes('id="gameAboutButton"') && html.includes('id="aboutModal"'), '游戏准备页和游戏顶栏应包含关于入口与统一弹窗');
assert(html.includes('by IQ Online Studio, github.com/iqonli/double-ludo') && html.includes('本项目源码使用MIT许可证开源。Copyright © 2026 IQ Online Studio.'), '关于弹窗文字应完整');
assert(game.includes('function submitLobbyProtection()') && game.includes('pausePollingBeforeRequest(600)') && game.includes('当前设置未提交，请点击提交'), '联机保护应采用本地草稿、红字提示与暂停轮询后提交');
assert(game.includes('dataset.renderSignature') && game.includes('Latency/status callbacks run for every HTTP request'), '保护控件应保持稳定DOM，状态回调不得每100ms重建准备页');
assert(game.includes('setLanPlayerBReady') && game.includes('等待玩家B准备') && network.includes('setLobbyReady'), '玩家B应确认准备后玩家A才能开局');
assert(css.includes('.about-card > strong, .about-card .about-copy, .about-card .about-copy p { display: block; width: 100%; text-align: left !important; }') && css.includes('.about-card .defeat-actions { justify-content: flex-end; }'), '关于正文应左对齐且关闭按钮居右');
assert(network.includes('async pausePollingBeforeRequest') && network.includes('pollingPauseDepth'), '网络客户端应支持提交保护时暂停轮询');
assert(css.includes('.protection-unsaved') && css.includes('.protection-submit'), '保护未提交提示和提交按钮应有样式');

assert(html.includes('id="undoRequestModal"') && html.includes('允许对方撤销？'), '应包含联机撤销审批弹窗');
assert(game.includes('requestUndo()') && game.includes('respondLanUndoRequest'), '客户端应支持申请和回应联机撤销');
assert(game.includes('动作编号无效。') && !game.includes('本地预判：当前操作不合法。'), '联机本地预判应宽松，复杂合法性由服务端判断');
assert(css.includes('background: #dfeff2') && css.includes('background: #f1f2d6'), '聊天消息应区分自己和服务端底色');
assert(css.includes('scale(1.10)') && css.includes('@keyframes selectable-white'), '候选棋子应恢复缩放光效');

assert(game.includes("el.undoDefeat.textContent = '申请反悔'") && game.includes("el.acceptDefeat.textContent = '我接受'"), '联机三6遣返弹窗应显示申请反悔与我接受');
assert(game.includes('申请反悔三6遣返！') && game.includes("el.rejectUndoRequest.textContent = '666我要是不同意呢'") && game.includes("el.allowUndoRequest.textContent = '我同意了'"), '对方应收到三6遣返反悔审批弹窗');
assert(network.includes('requestDefeatRegret()') && network.includes('respondDefeatRegret(allow)'), '网络客户端应支持三6遣返反悔申请和回应');
assert(game.includes('const initialHeight = Number.isFinite(saved) && saved >= 240 ? saved : 500'), 'game内局域网聊天区域默认高度应为500px');

assert(html.includes('v0.42.1 LAN'), '准备页版本号应为v0.42.1 LAN');
assert(!html.includes('标准飞行棋底盘，本地 1v1。'), '准备页不应保留旧副标题');
assert(html.includes('class="setup-game-icon"') && html.includes('class="header-game-icon"'), '准备页和游戏顶栏应内嵌项目图标');
assert(css.includes('width: 76px') && css.includes('width: 32px'), '项目图标尺寸应为76px和32px');
assert(html.indexOf('id="backToGame"') < html.indexOf('id="setupAboutButton"'), '返回原局应位于关于左侧');
assert(html.includes('rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,'), '游戏页应内嵌标签页图标');
assert(!game.includes('__doubleFlightDebug'), '发行版不应保留冒烟测试调试接口');
