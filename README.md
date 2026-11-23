# music

桌面媒体与歌词的 MSP World 节点。此仓库作为 [msp-world-cli](https://github.com/msp-world/msp-world-cli) 的子模块使用，依赖同级 `shared` 和主仓库中的 `msp-ts`，不能仅克隆本仓库后直接运行。

## 使用

需要 Node.js 22.6 或更新版本。

```bash
git clone --recurse-submodules https://github.com/msp-world/msp-world-cli.git
cd msp-world-cli
npm start -- music
```

主要配置：无。通用连接配置及详细说明见[主仓库](https://github.com/msp-world/msp-world-cli)。

## 上游与致谢

源码注明移植自 [cortico-world-music](https://github.com/Sakayume02/cortico-world-music)；上游包元数据列出的作者：Sakayume02。

源码注明移植自 [better-cortico-world-netease-companion](https://github.com/wocwang/cortico-world-netease-companion)；上游包元数据列出的作者：wocwang & oceanxuhaiao。

本仓库是 MSP 适配实现，并非上游原仓库。感谢上游作者及贡献者。
