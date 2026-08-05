# Double Ludo 部署到 Render

本项目的同一份`public/game.html`可以连接本地局域网服务器、Render云端服务器或其他兼容服务器。Render模式提供公开账号开房页、在线登录码、内存房间、长轮询和管理员认证。

## 一、部署前准备

1. 将项目推送到GitHub仓库`iqonli/double-ludo`。
2. 确认根目录存在：

```text
server.js
package.json
render.yaml
public/game.html
public/host.html
```

3. 不要把管理员密码或其他秘密写进Git仓库。

## 二、使用render.yaml部署

1. 登录Render控制台。
2. 选择`New` → `Blueprint`。
3. 连接`iqonli/double-ludo`仓库。
4. Render读取根目录的`render.yaml`。
5. 在首次创建时填写`ADMIN_PASSWORD`。建议使用随机生成的长密码，不少于16个字符。
6. 完成创建并等待部署。

默认服务名是：

```text
dlol
```

Render服务名与GitHub仓库名相互独立：仓库可以继续叫`double-ludo`，`render.yaml`中的服务名固定为`dlol`。若`dlol`这个全局服务名可用，公网地址就是：

```text
https://dlol.onrender.com
```

如果你此前已经创建了其他名称的Render服务，仅向GitHub推送代码不会自动更换旧域名。需要在Render中把服务重命名为`dlol`，或者删除旧服务后通过Blueprint重新创建。若`dlol`已经被其他Render用户占用，则无法仅靠项目代码取得该域名。

根路径是玩家开房页：

```text
https://dlol.onrender.com/
```

游戏页面是：

```text
https://dlol.onrender.com/game.html
```

管理员页面是：

```text
https://dlol.onrender.com/admin
```

打开管理员页面时，浏览器会要求输入`ADMIN_USERNAME`和`ADMIN_PASSWORD`。默认用户名是`admin`。

如果未设置`ADMIN_PASSWORD`，`/admin`会显示明确的配置说明页面，而不再伪装成“文件不存在”。设置环境变量并重新部署后即可使用。

## 三、手动创建Web Service

不使用Blueprint时，在Render中选择`New` → `Web Service`，连接GitHub仓库并填写：

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /api/info
Instance Type: Free（或按需选择付费实例）
```

服务端会监听`0.0.0.0`和Render提供的`PORT`，不要手工固定公网端口。

至少配置这些环境变量：

```text
ONLINE_MODE=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的管理员密码
IP_KEY_SECRET=随机长字符串
ACCOUNT_KEY_SECRET=随机长字符串
ALLOWED_ORIGINS=https://iqonli.github.io
ALLOW_FILE_ORIGIN=true
```

可选变量：

```text
PUBLIC_BASE_URL=https://dlol.onrender.com
ROOM_IDLE_TTL_MS=900000
LONG_POLL_TIMEOUT_MS=25000
```

`PUBLIC_BASE_URL`通常可以不填，服务端会根据当前请求生成邀请链接。使用自定义域名，或代理传递的主机名不正确时再填写。

### ALLOWED_ORIGINS

`ALLOWED_ORIGINS`是允许跨域连接服务器的网页来源，多个来源用英文逗号分隔，只填写来源，不填写页面路径：

```text
https://iqonli.github.io,https://example.com
```

Render同源页面不需要额外加入。直接双击本地`game.html`时，请保留：

```text
ALLOW_FILE_ORIGIN=true
```

不需要本地文件连接时可改为`false`。

## 四、开房和邀请

1. 玩家打开服务根地址。
2. 输入至少8个字符作为账号。第一次输入创建账号，以后输入同一密码进入账号。
3. 点击`创建房间`。
4. 分别复制玩家A和玩家B邀请链接。
5. 邀请链接格式类似：

```text
https://dlol.onrender.com/game.html?port=12345A&URL=https%3A%2F%2Fdlol.onrender.com
```

打开邀请链接后，`game.html`会自动切换到联机页面、填写服务器地址和登录码，并尝试连接。

在线登录码格式为：

```text
5位数字 + 1位大写字母
例如：12345A
```

字母不使用`I`、`L`、`O`，输入小写字母也能识别。客户端已经为以后扩展到末尾两个字母预留解析能力。

## 五、运行规则

```text
每个账号最多5个活动房间
同一IP最多拥有5个账号，并且同时只能管理1个账号
登录第6个账号时，该IP最早拥有的账号及其全部房间会被删除
每个账号最多5个活动房间，不设置单独的IP房间数量上限
错误登录后，同一IP需等待1秒才能再次尝试登录码
账号被另一个IP登录后，账号与全部房间归新IP拥有，旧账号管理会话立即失效
账号接管不会自动踢出已经进入游戏的玩家
玩家A和玩家B都停止请求超过15分钟后，房间自动删除
```

账号被新IP接管后，该账号的全部房间归属信息同步转移到新IP。一个IP登录第6个账号时，最早拥有的账号会被删除，该账号中的房间将关闭并使玩家退出。

## 六、免费服务的临时性

在线模式不写入`data/autosave.json`，账号、房间、聊天和对局仅存在于服务器内存中。

以下情况会清空全部在线数据：

```text
免费服务休眠
Render重启服务
重新部署
手动重启
实例故障或迁移
```

免费Web Service长时间没有入站请求时会休眠。正在打开的玩家页面使用长轮询，会持续向服务端发送请求；双方关闭页面或断网后，不应期待房间能够恢复。

## 七、更新部署

向已连接的GitHub分支推送代码后，Render默认会自动构建并部署。部署过程会更换服务实例，当前内存中的账号、房间和对局将全部消失。因此不要在玩家对局期间部署。

部署后检查：

```text
GET /api/info
```

应返回：

```json
{
  "onlineMode": true,
  "pollingMode": "long-poll",
  "loginCodeFormat": "5digits+letter",
  "autosave": false
}
```

## 八、管理员能够看到的信息

权威服务端必须处理棋局状态、聊天和请求来源。当前管理员页面可以查看活动账号、房间、登录码、聊天、房间日志、在线状态和完整连接IP，并可删除账号及其房间。程序不保存账号明文密码，也不应将密码、会话令牌、聊天正文或完整IP主动输出到Render日志。

管理员密码泄露时应立即在Render环境变量中更换，并重新部署服务。
## 九、404短暂重试

游戏API、开房账号API和管理API收到HTTP 404时，不会立即报错，而是按以下顺序重试：

```text
等待100ms后重试，共10次
等待200ms后重试，共10次
等待300ms后重试，共5次
```

总计为初始请求加25次重试；最后一次仍为404时才向界面报告。长轮询仍使用25秒服务端等待，不退回高频短轮询；旧兼容轮询间隔由500ms改为1000ms。

局域网自动搜索会探测大量可能并非Double Ludo服务器的IP，404在该场景代表目标不是服务器，因此自动搜索探测不执行25次重试，避免扫描被严重拖慢。

