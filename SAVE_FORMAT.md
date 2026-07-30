# 对局文件与多房间自动存档

## 单房间手动对局文件

每个房间独立导出JSON。准备大厅示例：

```json
{
  "format": "double-flight-lan-save",
  "formatVersion": 4,
  "appVersion": "0.40.0",
  "roomId": 1,
  "roomStatus": "lobby",
  "lobbyConfig": {
    "mode": "speed",
    "playerAColors": ["red", "yellow"],
    "protectedColors": [],
    "launchValues": [5, 6],
    "tripleSixPenalty": true,
    "firstPlayer": "B"
  },
  "lobbyReady": { "B": true },
  "lobbySpeedRolls": {
    "A": [4, 2],
    "B": [5, 3]
  },
  "sourceVersion": 12,
  "chatVersion": 3,
  "chat": [],
  "roomLog": [],
  "game": null
}
```

对局进行中时，`game`包含规则引擎快照；`lobbyConfig`通常为`null`。

`lobbySpeedRolls`保存极速双飞开局时双方的一次性投掷结果。恢复大厅后，已投掷的玩家不能再次点击；只有玩家A将模式切回“双飞”再切回“极速双飞”才会清空该字段。

登录码和会话令牌不会写入手动对局文件。恢复文件时保留当前房间登录码；损坏文件不会覆盖原局。

## 多房间自动存档

`data/autosave.json`会包装全部房间：

```json
{
  "autosave": true,
  "reason": "lobby-order-roll",
  "multiroom": {
    "format": "double-flight-lan-multiroom-autosave",
    "formatVersion": 1,
    "nextRoomId": 4,
    "rooms": [
      { "roomId": 1, "gameFile": {} },
      { "roomId": 2, "gameFile": {} },
      { "roomId": 3, "gameFile": {} }
    ]
  }
}
```

重启恢复时：

- 房间号、棋局、大厅设置、极速双飞投掷结果、玩家B准备状态、聊天和房间日志保留；
- `nextRoomId`保留，后续房间继续递增；
- 旧会话令牌全部失效；
- 已开启房间重新生成全局唯一五位登录码；
- 兼容旧版单房间和多房间自动存档。
