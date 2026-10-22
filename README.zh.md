# dsh-skill-install

DeepSeek Harness 的技能安装器：在 Web 设置页（设置 → 「技能」）里，按名字
搜索 GitHub 仓库，或直接输入 `owner/repo` / 完整仓库地址，列出该仓库中的 `SKILL.md`
技能，勾选后安装到可选目标目录。与内置 skill-filesystem 联动，装完即时生效，无需重启。

[English](README.md)

## 功能

- **按名字搜索 / 直接输入地址**：一个输入框同时接受技能/仓库名字（按名字搜仓库）或
  `owner/repo`、`https://github.com/owner/repo` 地址。
- **只列出匹配项**：搜索返回具体匹配的仓库，点「打开」查看仓库里的技能；不做全站发现流。
- **目标目录可选，默认全局**：
  
  安装目标为 **全局**（`<DSH_HOME>/skills`）、**某个工作区**（`<工作区目录>/.dsh/skills`，工作区列表取自宿主注册表）或**自定义绝对目录**。不再按进程 cwd 推断项目。
- **已安装**：按目标目录分组列出，可一键移除。
- **当前已加载技能**：来自内置 skill-filesystem 与本插件的合并目录（只读）。
- **代理（折叠小入口）**：点击展开后配置代理地址、测试连通、清除；配置后经系统 `curl`
  走代理，留空为直连。

## 安装

```sh
# 本地目录（请先完全退出桌面端；--profile 为必填）
dsh plugin --profile <profile> add ./dsh-skill-install

# GitHub 源码
dsh plugin --profile <profile> add github:<owner>/dsh-skill-install
```

安装后重启 Harness 以组合新 bundle；随后「设置 → 技能」出现新页面。本插件**零外部运行时依赖**，
因此从 GitHub 安装**无需** `allowBuilds` 的代码执行授权。

## 运行时依赖

- 宿主插件为纯 ESM，零外部运行时依赖（`js-yaml` 以自包含 ESM 构建内置于 `js-yaml.mjs`，MIT 许可）。
- 解压 GitHub tarball 需要系统 `tar`（Windows 10 1809+ 自带）；配置代理时需要 `curl`。

## 与内置技能系统联动

- 全局 / 工作区安装写入 skill-filesystem 已监视的标准根，watcher 即时热加载；
- 自定义目录由本插件通过 `ctx.skills.registerProvider` 注册为独立 skill 提供方，
  与 skill-filesystem 使用相同发现规则（`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`），
  并在安装 / 移除 / 目录变化时 `invalidate()`；
- 所有路由与 provider 均用 `ctx.effect` 登记，插件停用 / 重载时自动摘除，不会重复注册。

## 许可证

MIT
