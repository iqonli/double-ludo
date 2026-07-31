# 双飞网页人机模型

两个模型均来自Stable-Baselines3 `MaskablePPO`，使用350维逻辑观察和292维固定动作空间。部署版只保留策略网络：

```text
350 → 256 ReLU → 256 ReLU → 128 ReLU → 292
```

## 正常

- 模型ID：`normal-v1`
- 来源：`df_level3_candidate_best.zip`
- 检查点训练步数：22,069,248
- 网页权重：`ai-model-normal.js`
- 四组固定输入的JavaScript/PyTorch最大绝对误差：`4.76837158203125e-7`

## 高级

- 模型ID：`advanced-v1`
- 来源：`best_main_v5.zip`
- 检查点训练步数：46,367,872
- 网页权重：`ai-model-advanced.js`
- 四组固定输入的JavaScript/PyTorch最大绝对误差：`9.5367431640625e-7`

`ai-controller.js`负责观察编码、合法动作枚举、动作掩码、模型注册和前向推理。网页部署文件不包含价值网络、优化器或训练状态。
