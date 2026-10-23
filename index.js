/**
 * dsh-skill-install — 宿主插件。
 *
 * 一个轻量的技能安装器：在 Web 设置页里按名字搜索 GitHub 仓库，或直接输入
 * 仓库地址，列出该仓库中的 SKILL.md 技能，勾选后安装到可选目标目录
 * （全局 / 宿主工作区 / 自定义目录）。安装走 skill-filesystem 已监视的标准根，
 * 自定义目录由本插件自建 skill provider 服务并热刷新——装完即时生效。
 *
 * 零外部运行时依赖（js-yaml 以 ESM 构建内置于 ./js-yaml.mjs）。GitHub 抓取默认直连；
 * 配置代理后经系统 curl 走代理。所有路由与 provider 都用 ctx.effect 登记，
 * 停用/重载时自动摘除，不会重复注册。
 * @module dsh-skill-install
 */

import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, watch } from 'node:fs'
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { URL } from 'node:url'
import yaml from './js-yaml.mjs'

const GH_API = 'https://api.github.com'
const GH_RAW = 'https://raw.githubusercontent.com'
const GH_CODELOAD = 'https://codeload.github.com'
const SETTINGS_FILE = 'skill-install.json'
const SRC_DIR_NAME = '.skill-install-src'
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const UNSAFE_RE = /[\u0000-\u001f\u007f'`;|&$<>(){}[\]\\]/

export const name = 'skill-install'

// 硬依赖：webServer 不存在（非 web profile）时 fiber 保持 PENDING，不产生副作用。
// skills 注册表（dsh-skill）在桌面 profile 中存在，但按需惰性解析，缺失时降级。
export const inject = ['webServer']

function clip(value, max) {
  const text = typeof value === 'string' ? value : ''
  return text.length > max ? text.slice(0, max) : text
}

export function apply(ctx) {
  const webServer = ctx.webServer
  let skills = ctx.get('skills')
  // Same optional-injection rule as workspaceRegistry: without it the skills
  // registry reads as empty and "loaded" only ever showed this plugin's own rows.
  ctx.inject(['skills'], (scope) => {
    skills = scope.skills
    scope.effect(() => () => { skills = undefined })
  })
  // workspaceRegistry is optional: inject it so it is actually readable, and keep
  // the plugin usable (global + custom only) when the host does not provide it.
  let workspaceRegistry
  ctx.inject(['workspaceRegistry'], (scope) => {
    workspaceRegistry = scope.workspaceRegistry
    scope.effect(() => () => { workspaceRegistry = undefined })
  })

  // ------------------------------------------------------------------ paths
  function dshHomeDir() {
    return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? resolve(process.env.DSH_HOME)
      : join(homedir(), '.dsh')
  }
  function agentsHomeDir() {
    return typeof process.env.DSH_AGENTS_HOME === 'string' && process.env.DSH_AGENTS_HOME.trim() !== ''
      ? resolve(process.env.DSH_AGENTS_HOME)
      : join(homedir(), '.agents')
  }
  function expandHome(path) {
    if (typeof path !== 'string') return ''
    const p = path.trim()
    if (p === '~') return homedir()
    if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
    return p
  }
  /** 宿主工作区（项目）= 绝对目录；拿不到注册表时返回空数组，UI 只剩全局与自定义。 */
  function listWorkspaces() {
    const registry = workspaceRegistry
    if (!registry || typeof registry.list !== 'function') return []
    let rows = []
    try {
      rows = registry.list()
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    return rows.map((w) => {
      const path = [w?.path, w?.cwd, w?.dir, w?.root, w?.directory].find((v) => typeof v === 'string' && v !== '') ?? ''
      if (path === '') return null
      return {
        id: String(w?.id ?? path),
        title: String(w?.title ?? w?.name ?? path),
        path,
      }
    }).filter(Boolean)
  }

  // ------------------------------------------------------------- settings
  function settingsPath() {
    return join(dshHomeDir(), SETTINGS_FILE)
  }
  function loadSettings() {
    try {
      const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
      return {
        proxy: typeof raw.proxy === 'string' ? raw.proxy : '',
        githubToken: typeof raw.githubToken === 'string' ? raw.githubToken.trim() : '',
        customDirs: Array.isArray(raw.customDirs) ? raw.customDirs.filter((d) => typeof d === 'string' && d.trim() !== '') : [],
        installed: Array.isArray(raw.installed) ? raw.installed : [],
      }
    } catch {
      return { proxy: '', githubToken: '', customDirs: [], installed: [] }
    }
  }
  function saveSettings(next) {
    mkdirSync(dshHomeDir(), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
    // The file carries the optional GitHub token: keep it owner-only. On Windows
    // this only toggles the read-only attribute, hence the best-effort catch.
    void chmod(settingsPath(), 0o600).catch(() => {})
  }
  function customDirs() {
    return loadSettings().customDirs.map(expandHome).filter((d) => d !== '' && d !== '.')
  }

  // -------------------------------------------------------------- GitHub io
  function probeCurl() {
    try {
      return spawnSync('curl', ['--version'], { timeout: 5000 }).status === 0
    } catch {
      return false
    }
  }
  function proxyOf() {
    const proxy = loadSettings().proxy.trim()
    return proxy !== '' && proxy !== 'direct' ? proxy : ''
  }
  function tokenOf() {
    return loadSettings().githubToken
  }
  function githubHeaders() {
    const headers = {
      'user-agent': 'dsh-skill-install',
      accept: 'application/vnd.github+json',
    }
    const token = tokenOf()
    if (token !== '') headers.authorization = 'Bearer ' + token
    return headers
  }
  function httpError(status, text) {
    const body = clip(text, 300)
    if (status === 403 && /rate limit/i.test(body)) {
      return 'GitHub API 限流：未认证请求每小时仅 60 次，当前 IP 已用完。建议稍后再试，或在「GitHub 设置」里配置一个 Token（认证后每小时 5000 次）。'
    }
    if (status === 404) return 'GitHub 404：仓库不存在或名称拼写有误。'
    return 'HTTP ' + status + (body !== '' ? ' ' + body : '')
  }
  function directText(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    return fetch(url, {
      headers: githubHeaders(),
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.ok) throw new Error(httpError(res.status, await safeText(res)))
      return await res.text()
    }).finally(() => clearTimeout(timer))
  }
  async function safeText(res) {
    try {
      return clip(await res.text(), 200)
    } catch {
      return ''
    }
  }
  function curlText(url, proxy, token) {
    return new Promise((resolve, reject) => {
      let child
      const args = ['-sL', '--max-time', '45', '-x', proxy]
      if (token && token !== '') args.push('-H', 'Authorization: Bearer ' + token, '-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: dsh-skill-install')
      args.push('--', url)
      try {
        child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        reject(new Error('无法启动 curl：' + (error instanceof Error ? error.message : String(error))))
        return
      }
      let out = ''
      let err = ''
      let settled = false
      const finish = (fn, value) => { if (settled) return; settled = true; fn(value) }
      child.stdout.on('data', (chunk) => { out += chunk })
      child.stderr.on('data', (chunk) => { err += chunk })
      child.on('error', (error) => finish(reject, new Error('curl 调用失败：' + error.message)))
      child.on('close', (code) => {
        if (code === 0) finish(resolve, out)
        else finish(reject, new Error(err.trim() !== '' ? err.trim() : 'curl 退出码 ' + code))
      })
    })
  }
  async function ghText(url) {
    const proxy = proxyOf()
    if (proxy !== '') {
      if (!probeCurl()) throw new Error('已配置代理，但宿主未找到 curl；请安装 curl 或清除代理')
      return await curlText(url, proxy, tokenOf())
    }
    return await directText(url)
  }
  async function ghJson(url, maxChars = 2000000) {
    const text = await ghText(url)
    if (text.length > maxChars) throw new Error('响应过大（' + text.length + ' 字符），已截断')
    return JSON.parse(text)
  }
  /** 给抓取加独立超时；raw.githubusercontent.com 在国内常无响应，不能等满 45 秒。 */
  function withTimeout(promise, ms, message) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(message ?? '请求超时')), ms)
      promise.then(
        (value) => { clearTimeout(timer); resolvePromise(value) },
        (error) => { clearTimeout(timer); rejectPromise(error) },
      )
    })
  }

  // ------------------------------------------------------------ frontmatter
  function parseFrontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
    if (!match) return null
    let data = {}
    try {
      data = yaml.load(match[1]) ?? {}
    } catch {
      return null
    }
    if (data === null || typeof data !== 'object') data = {}
    return { data, body: text.slice(match[0].length) }
  }
  function toBool(value) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const s = value.trim().toLowerCase()
      if (s === 'true' || s === 'yes' || s === 'on' || s === '1') return true
      if (s === 'false' || s === 'no' || s === 'off' || s === '0') return false
    }
    return undefined
  }
  function parseInvocation(data) {
    const disabledModel = toBool(data['disable-model-invocation'])
    const user = toBool(data['user-invocable'])
    return {
      modelInvocable: disabledModel === true ? false : true,
      userInvocable: user === false ? false : true,
    }
  }

  // -------------------------------------------------------------- discovery
  function classifyInput(raw) {
    const q = String(raw ?? '').trim()
    if (q === '') return { kind: 'none' }
    const urlMatch = /github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)/.exec(q)
    if (urlMatch) return { kind: 'repo', fullName: urlMatch[1] }
    if (REPO_RE.test(q)) return { kind: 'repo', fullName: q }
    return { kind: 'search', query: q }
  }
  function trimRepo(item) {
    return {
      fullName: String(item.full_name ?? ''),
      url: String(item.html_url ?? ''),
      description: clip(item.description ?? '', 240),
      stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
      language: typeof item.language === 'string' ? item.language : '',
      archived: item.archived === true,
      owner: item.owner !== null && typeof item.owner === 'object'
        ? { login: String(item.owner.login ?? ''), avatar: String(item.owner.avatar_url ?? '') }
        : { login: '', avatar: '' },
    }
  }
  async function searchRepos(query) {
    const q = encodeURIComponent(query + ' in:name')
    const url = GH_API + '/search/repositories?q=' + q + '&per_page=20&sort=stars&order=desc'
    const data = await ghJson(url, 1000000)
    return Array.isArray(data.items) ? data.items.map(trimRepo) : []
  }
  async function repoMeta(fullName) {
    const data = await ghJson(GH_API + '/repos/' + fullName, 500000)
    return {
      fullName: String(data.full_name ?? fullName),
      url: String(data.html_url ?? ''),
      description: clip(data.description ?? '', 400),
      stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : 0,
      defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : 'HEAD',
      topics: Array.isArray(data.topics) ? data.topics.slice(0, 12) : [],
      license: data.license && typeof data.license.spdx_id === 'string' ? data.license.spdx_id : '',
    }
  }
  /** 扫描一个已解压的目录树，收集全部合法 SKILL.md 技能。 */
  function scanSkillsInTree(rootDir, repoName) {
    const skills = []
    const walk = (dir, rel) => {
      if (skills.length >= 80) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const abs = join(dir, entry.name)
        const relPath = rel === '' ? entry.name : rel + '/' + entry.name
        if (entry.isDirectory()) {
          walk(abs, relPath)
          continue
        }
        if (entry.name !== 'SKILL.md') continue
        let text = ''
        try {
          text = readFileSync(abs, 'utf8')
        } catch {
          continue
        }
        const parsed = parseFrontmatter(text)
        if (!parsed) continue
        const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
        if (!SKILL_NAME_RE.test(name)) continue
        const skillDir = rel === '' ? '.' : rel
        skills.push({
          dir: skillDir,
          name,
          suggestedDir: skillDir === '.' ? repoName : basename(skillDir),
          description: clip(parsed.data.description, 240),
          whenToUse: clip(parsed.data.whenToUse, 160),
          invocation: typeof parsed.data.invocation === 'string' ? parsed.data.invocation : '',
        })
      }
    }
    walk(rootDir, '')
    skills.sort((a, b) => (a.name < b.name ? -1 : 1))
    return skills
  }
  /** 固定仓库默认分支的 commit；后续 tree / raw / tarball 一律用这个 SHA。 */
  async function headCommit(fullName, branch) {
    const data = await ghJson(GH_API + '/repos/' + fullName + '/commits/' + encodeURIComponent(branch), 800000)
    const sha = data !== null && typeof data === 'object' && typeof data.sha === 'string' ? data.sha : ''
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('无法固定仓库 commit：' + fullName + '@' + branch)
    return sha
  }
  /** 下载仓库 tarball 到本地解压后扫描——不依赖 raw.githubusercontent.com。 */
  async function listSkillsFromTarball(fullName, ref) {
    const work = join(dshHomeDir(), SRC_DIR_NAME, 'list-' + Date.now().toString(36) + '-' + basename(fullName))
    await mkdir(work, { recursive: true })
    try {
      await downloadExtract(fullName, ref, work)
      return scanSkillsInTree(work, basename(fullName))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  /** 列出仓库里的全部 SKILL.md 技能。先走树 API + raw，失败或不全时用本地 tarball 兜底。 */
  async function repoSkills(fullName) {
    const meta = await repoMeta(fullName)
    const commit = await headCommit(fullName, meta.defaultBranch)
    let dirs = []
    let treeError = ''
    try {
      const treeUrl = GH_API + '/repos/' + fullName + '/git/trees/' + encodeURIComponent(commit) + '?recursive=1'
      const data = await ghJson(treeUrl, 3000000)
      const tree = Array.isArray(data.tree) ? data.tree : []
      const seen = new Set()
      for (const item of tree) {
        if (item === null || typeof item !== 'object' || item.type !== 'blob') continue
        const p = typeof item.path === 'string' ? item.path : ''
        let dir = ''
        if (p === 'SKILL.md') dir = '.'
        else if (p.endsWith('/SKILL.md')) dir = p.slice(0, -'/SKILL.md'.length)
        else continue
        if (seen.has(dir)) continue
        const segments = dir === '.' ? [] : dir.split('/')
        if (segments.some((seg) => seg.startsWith('.') || seg === 'node_modules')) continue
        seen.add(dir)
        dirs.push(dir)
        if (dirs.length >= 60) break
      }
    } catch (error) {
      treeError = error instanceof Error ? error.message : String(error)
    }

    let skills = []
    if (dirs.length > 0) {
      const results = await Promise.all(dirs.slice(0, 24).map(async (dir) => {
        const rawPath = dir === '.' ? 'SKILL.md' : dir + '/SKILL.md'
        try {
          const rawUrl = GH_RAW + '/' + fullName + '/' + encodeURIComponent(commit) + '/' + rawPath.split('/').map(encodeURIComponent).join('/')
          const text = await withTimeout(ghText(rawUrl), 8000, 'raw 抓取超时（国内网络常见）')
          const parsed = parseFrontmatter(text)
          if (!parsed) return null
          const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
          if (!SKILL_NAME_RE.test(name)) return null
          return {
            dir,
            name,
            suggestedDir: dir === '.' ? basename(fullName) : basename(dir),
            description: clip(parsed.data.description, 240),
            whenToUse: clip(parsed.data.whenToUse, 160),
            invocation: typeof parsed.data.invocation === 'string' ? parsed.data.invocation : '',
          }
        } catch {
          return null
        }
      }))
      skills = results.filter(Boolean)
    }

    // raw 全部失败（国内常见），或目录树读取失败 → 下载 tarball 本地扫描兜底
    let listError = ''
    if (skills.length === 0 && (dirs.length > 0 || treeError !== '')) {
      try {
        const fromTar = await listSkillsFromTarball(fullName, commit)
        if (fromTar.length > 0) {
          skills = fromTar
          treeError = ''
        } else {
          listError = treeError
        }
      } catch (error) {
        listError = error instanceof Error ? error.message : String(error)
      }
    }

    skills.sort((a, b) => (a.name < b.name ? -1 : 1))
    return { meta, commit, skills, truncated: dirs.length > 24, treeError, listError }
  }

  // -------------------------------------------------------------- 目标目录
  function rootTarget(rootKey, customPath, workspaceId) {
    if (rootKey === 'global') return { path: join(dshHomeDir(), 'skills'), custom: false, label: '全局' }
    if (rootKey === 'workspace') {
      const found = listWorkspaces().find((w) => w.id === String(workspaceId ?? ''))
      if (found === undefined) throw new Error('工作区不存在：' + String(workspaceId))
      return { path: join(found.path, '.dsh', 'skills'), custom: false, label: found.title }
    }
    if (rootKey === 'custom') {
      const p = expandHome(customPath)
      if (p === '' || p === '.') throw new Error('自定义目录不能为空')
      return { path: resolve(p), custom: true, label: '自定义' }
    }
    throw new Error('未知目标目录')
  }
  function safeJoin(root, dir) {
    const target = resolve(join(root, dir))
    if (target !== root && !target.startsWith(resolve(root) + sep)) throw new Error('目录越界：' + dir)
    return target
  }
  function rootsSummary() {
    const settings = loadSettings()
    const global = rootTarget('global')
    const customs = customDirs().map((path) => ({ key: 'custom', path, exists: existsSync(path) }))
    return {
      global: { key: 'global', label: '全局', path: global.path, exists: existsSync(global.path) },
      workspaces: listWorkspaces(),
      customs,
      default: 'global',
    }
  }

  // ------------------------------------------------------------ 安装 / 移除
  /** 压缩包与解压产物的准入上限。 */
  const MAX_TARBALL_BYTES = 64 * 1024 * 1024
  const MAX_MEMBER_BYTES = 64 * 1024 * 1024
  const MAX_TREE_BYTES = 256 * 1024 * 1024
  const MAX_TREE_ENTRIES = 20000
  const DIR_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

  /** 校验请求里的相对技能目录：拒绝绝对路径、`..`、反斜杠与空段。 */
  function assertSkillDir(dir) {
    if (typeof dir !== 'string' || dir === '' || dir.length > 200) throw new Error('技能目录无效：' + String(dir))
    if (dir === '.') return '.'
    for (const seg of dir.split('/')) {
      if (seg === '' || seg === '.' || seg === '..' || !DIR_SEGMENT_RE.test(seg)) throw new Error('技能目录越界：' + dir)
    }
    return dir
  }

  /** 解压产物准入：删除符号链接，限制条目数与解压后总体积。 */
  function sanitizeTree(rootDir) {
    const root = realpathSync(rootDir)
    let entries = 0
    let bytes = 0
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        entries += 1
        if (entries > MAX_TREE_ENTRIES) throw new Error('解压内容条目过多（上限 ' + MAX_TREE_ENTRIES + '）')
        const info = lstatSync(abs)
        if (info.isSymbolicLink()) {
          rmSync(abs, { force: true })
          continue
        }
        if (info.isDirectory()) {
          walk(abs)
          continue
        }
        if (!info.isFile()) {
          rmSync(abs, { recursive: true, force: true })
          continue
        }
        bytes += info.size
        if (bytes > MAX_TREE_BYTES) throw new Error('解压内容超过体积上限')
      }
    }
    walk(root)
  }

  /** 从 `tar -tvzf` 一行里取成员大小；GNU 与 bsdtar 两种列格式都认，认不出就失败关闭。 */
  function parseTarSize(line) {
    const gnu = /^[^\s]+\s+\S+\s+(\d+)\s+/.exec(line)
    const bsd = /^[^\s]+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/.exec(line)
    const match = bsd ?? gnu
    if (match === null) return undefined
    const size = Number(match[1])
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined
  }

  /** 解压前审计归档成员：类型、路径与展开体积（压缩炸弹防线）。 */
  function inspectArchive(tarball) {
    const listing = spawnSync('tar', ['-tzf', tarball], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 })
    if (listing.status !== 0) throw new Error('归档清单读取失败')
    const names = String(listing.stdout).split(/\r?\n/).filter((line) => line !== '')
    if (names.length > MAX_TREE_ENTRIES) throw new Error('归档条目过多（上限 ' + MAX_TREE_ENTRIES + '）')
    for (const name of names) {
      if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\')) {
        throw new Error('归档包含绝对路径成员（' + name + '）')
      }
      if (name.split('/').includes('..')) throw new Error('归档包含越界成员（' + name + '）')
    }
    const verbose = spawnSync('tar', ['-tvzf', tarball], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 })
    if (verbose.status !== 0) throw new Error('归档清单读取失败')
    let expanded = 0
    for (const line of String(verbose.stdout).split(/\r?\n/)) {
      if (line === '') continue
      const type = line[0]
      if (type === 'l' || type === 'h') throw new Error('归档包含链接成员，已拒绝')
      if (type !== '-' && type !== 'd') throw new Error('归档包含非常规成员，已拒绝')
      if (type !== '-') continue
      const size = parseTarSize(line)
      if (size === undefined) throw new Error('无法解析归档成员大小，已拒绝：' + line.slice(0, 80))
      if (size > MAX_MEMBER_BYTES) throw new Error('归档单成员超过展开上限')
      expanded += size
      if (expanded > MAX_TREE_BYTES) throw new Error('归档展开体积超过上限')
    }
  }

  async function downloadExtract(fullName, ref, destDir) {
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('安装源必须是固定 commit：' + String(ref))
    const tarball = join(destDir, 'repo.tar.gz')
    const url = GH_CODELOAD + '/' + fullName + '/tar.gz/' + ref
    const proxy = proxyOf()
    if (proxy !== '') {
      if (!probeCurl()) throw new Error('已配置代理，但宿主未找到 curl')
      await new Promise((resolvePromise, reject) => {
        let child
        try {
          child = spawn('curl', ['-sL', '--max-time', '120', '--max-filesize', String(MAX_TARBALL_BYTES), '-x', proxy, '-o', tarball, '--', url], { stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
          reject(new Error('无法启动 curl：' + error.message)); return
        }
        let err = ''
        child.stderr.on('data', (chunk) => { err += chunk })
        child.on('error', (error) => reject(new Error('curl 调用失败：' + error.message)))
        child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(err.trim() || 'curl 退出码 ' + code))))
      })
    } else {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120000)
      try {
        const res = await fetch(url, { headers: { 'user-agent': 'dsh-skill-install' }, signal: controller.signal })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const declared = Number(res.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) throw new Error('压缩包超过体积上限')
        const chunks = []
        let total = 0
        for await (const chunk of res.body) {
          total += chunk.length
          if (total > MAX_TARBALL_BYTES) throw new Error('压缩包超过体积上限')
          chunks.push(Buffer.from(chunk))
        }
        await writeFile(tarball, Buffer.concat(chunks))
      } finally {
        clearTimeout(timer)
      }
    }
    if (statSync(tarball).size > MAX_TARBALL_BYTES) throw new Error('压缩包超过体积上限')
    inspectArchive(tarball)
    const result = spawnSync('tar', ['-xzf', tarball, '-C', destDir, '--strip-components=1'], { timeout: 120000 })
    if (result.status !== 0) {
      const detail = (result.stderr && result.stderr.toString().trim()) || ('tar 退出码 ' + result.status)
      throw new Error('解压失败：' + detail)
    }
    sanitizeTree(destDir)
  }

  async function installSkills(fullName, dirs, rootKey, customPath, workspaceId) {
    const meta = await repoMeta(fullName)
    const commit = await headCommit(fullName, meta.defaultBranch)
    const target = rootTarget(rootKey, customPath, workspaceId)
    const work = join(dshHomeDir(), SRC_DIR_NAME, Date.now().toString(36) + '-' + basename(fullName))
    await mkdir(work, { recursive: true })
    const installed = []
    const committed = []
    let targetRoot = ''
    try {
      await downloadExtract(fullName, commit, work)
      const workRoot = realpathSync(work)
      await mkdir(target.path, { recursive: true })
      targetRoot = realpathSync(target.path)
      for (const rawDir of dirs) {
        const dir = assertSkillDir(rawDir)
        const srcDir = dir === '.' ? workRoot : resolve(join(workRoot, ...dir.split('/')))
        if (srcDir !== workRoot && !srcDir.startsWith(workRoot + sep)) throw new Error('技能目录越界：' + rawDir)
        const realSrc = realpathSync(srcDir)
        if (realSrc !== workRoot && !realSrc.startsWith(workRoot + sep)) throw new Error('技能目录越界（链接）：' + rawDir)
        const skillMd = join(realSrc, 'SKILL.md')
        if (!existsSync(skillMd)) throw new Error('技能目录缺少 SKILL.md：' + (dir === '.' ? fullName : dir))
        const parsed = parseFrontmatter(readFileSync(skillMd, 'utf8'))
        if (!parsed) throw new Error('技能 frontmatter 无效：' + (dir === '.' ? fullName : dir))
        const name = typeof parsed.data.name === 'string' && SKILL_NAME_RE.test(parsed.data.name.trim()) ? parsed.data.name.trim() : (dir === '.' ? basename(fullName) : basename(dir))
        if (!SKILL_NAME_RE.test(name)) throw new Error('技能名称无效：' + name)
        const targetDir = safeJoin(targetRoot, name)
        if (existsSync(targetDir)) throw new Error('技能已存在：' + name + '（' + targetRoot + '）')
        // 先复制到同目录的临时名，再原子改名提交；中途失败不会留下半装的技能。
        const staging = join(targetRoot, '.install-' + name + '-' + randomBytes(4).toString('hex'))
        await cp(realSrc, staging, { recursive: true, dereference: false })
        await rename(staging, targetDir)
        committed.push(targetDir)
        installed.push({ name, dir: name, root: targetRoot, scope: rootKey, source: fullName, commit, time: new Date().toISOString() })
      }
      const settings = loadSettings()
      if (target.custom) {
        if (!settings.customDirs.some((d) => resolve(expandHome(d)) === targetRoot)) settings.customDirs.push(targetRoot)
        startCustomWatcher(targetRoot)
      }
      settings.installed = settings.installed.filter((r) => !installed.some((n) => n.name === r.name && n.root === r.root))
      settings.installed.push(...installed)
      saveSettings(settings)
      invalidateCustom()
      return { ok: true, commit, installed }
    } catch (error) {
      for (const dir of committed) {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      throw error
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  async function removeSkill(rootKey, customPath, dir) {
    if (typeof dir !== 'string' || !SKILL_NAME_RE.test(dir)) throw new Error('技能名称无效：' + String(dir))
    const target = rootTarget(rootKey, customPath)
    const targetDir = safeJoin(target.path, dir)
    if (existsSync(targetDir)) await rm(targetDir, { recursive: true, force: true })
    const settings = loadSettings()
    settings.installed = settings.installed.filter((r) => !(r.name === dir && r.root === target.path))
    saveSettings(settings)
    invalidateCustom()
    return { ok: true, removed: targetDir }
  }
  function installedRecords() {
    const records = loadSettings().installed.map((r) => ({
      name: r.name,
      dir: r.dir,
      root: r.root,
      scope: r.scope ?? (r.root === join(dshHomeDir(), 'skills') ? 'global' : 'custom'),
      source: r.source ?? '',
      time: r.time ?? '',
      exists: existsSync(join(r.root, r.dir)),
    }))
    // Global first, then workspaces, then custom directories.
    const rank = (r) => (r.scope === 'global' ? 0 : r.scope === 'workspace' ? 1 : 2)
    return records.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : 1))
  }

  // ----------------------------------------------- skills provider（自定义目录）
  let invalidateCustom = () => {}
  const customWatchers = new Map()
  function readCustomSkills() {
    const out = []
    for (const root of customDirs()) {
      if (!existsSync(root)) continue
      let entries
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        let skillPath = null
        let directory = root
        if (entry.isDirectory()) {
          const p = join(root, entry.name, 'SKILL.md')
          if (existsSync(p)) { skillPath = p; directory = join(root, entry.name) }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          skillPath = join(root, entry.name)
        }
        if (skillPath === null) continue
        const parsed = parseFrontmatter(readFileSync(skillPath, 'utf8'))
        if (!parsed) continue
        const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
        const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : ''
        if (!SKILL_NAME_RE.test(name) || description === '') continue
        out.push({
          name,
          description,
          ...(typeof parsed.data.whenToUse === 'string' ? { whenToUse: parsed.data.whenToUse } : {}),
          invocation: parseInvocation(parsed.data),
          source: 'custom',
          provider: 'skill-install',
          rank: 300,
          path: skillPath,
          locator: { path: skillPath, directory },
        })
      }
    }
    return out
  }
  function startCustomWatcher(dir) {
    if (customWatchers.has(dir)) return
    try {
      const handle = watch(dir, { persistent: false }, () => {
        clearTimeout(handle._debounce)
        handle._debounce = setTimeout(() => invalidateCustom(), 300)
      })
      handle._debounce = null
      customWatchers.set(dir, handle)
    } catch {
      /* 目录尚不存在或不可监视时忽略；安装到该目录时会再尝试 */
    }
  }
  if (skills) {
    ctx.effect(() => skills.registerProvider((control) => {
      invalidateCustom = () => control.invalidate()
      return {
        name: 'skill-install',
        async list() {
          return readCustomSkills()
        },
        async get(candidate) {
          const text = await readFile(candidate.locator.path, 'utf8')
          const parsed = parseFrontmatter(text)
          if (!parsed) return undefined
          return {
            name: parsed.data.name,
            description: parsed.data.description,
            ...(typeof parsed.data.whenToUse === 'string' ? { whenToUse: parsed.data.whenToUse } : {}),
            invocation: parseInvocation(parsed.data),
            source: candidate.source,
            provider: 'skill-install',
            resourceBase: { kind: 'directory', path: candidate.locator.directory },
            path: candidate.locator.path,
            content: parsed.body.trim(),
          }
        },
      }
    }))
    for (const dir of customDirs()) startCustomWatcher(dir)
  }

  // --------------------------------------------------- 本地 JSON API 路由
  /** 本机载体只监听环回地址；非环回 Host 一律拒绝。 */
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0:0:0:0:0:0:0:1'])
  const MAX_BODY_BYTES = 16 * 1024

  function hostnameOf(hostHeader) {
    const host = String(hostHeader).toLowerCase()
    if (host.startsWith('[')) {
      const end = host.indexOf(']')
      return end > 0 ? host.slice(0, end + 1) : ''
    }
    const colon = host.lastIndexOf(':')
    return colon > 0 ? host.slice(0, colon) : host
  }
  /** 只接受本机同源调用：环回 Host、非跨站、Origin 与 Host 一致。 */
  function trustedCaller(req) {
    const hostHeader = req.headers?.host
    if (typeof hostHeader !== 'string' || hostHeader === '') return false
    if (!LOOPBACK_HOSTS.has(hostnameOf(hostHeader))) return false
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      let parsed
      try {
        parsed = new URL(origin)
      } catch {
        return false
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      if (parsed.host.toLowerCase() !== hostHeader.toLowerCase()) return false
    }
    return true
  }
  function sendJson(res, value, status = 200) {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  function reject(res, status, code, message, headers = {}) {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
    sendJson(res, { ok: false, error: message, code }, status)
  }
  /** 读取有界 JSON 正文；超过上限或不是 JSON 时带 statusCode 抛出。 */
  async function readBoundedJson(req) {
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      const error = new Error('请求正文超过 ' + MAX_BODY_BYTES + ' 字节上限')
      error.statusCode = 413
      throw error
    }
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        const error = new Error('请求正文超过 ' + MAX_BODY_BYTES + ' 字节上限')
        error.statusCode = 413
        throw error
      }
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') return {}
    let value
    try {
      value = JSON.parse(text)
    } catch {
      const error = new Error('请求正文不是合法 JSON')
      error.statusCode = 400
      throw error
    }
    return value !== null && typeof value === 'object' ? value : {}
  }
  function registerRoute(path, handler) {
    ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), `skill-install: ${path}`)
  }
  /** 只读路由：GET，query 传参。 */
  function routeRead(path, fn) {
    registerRoute(path, async (req, res) => {
      if (req.method !== 'GET') return reject(res, 405, 'method-not-allowed', 'GET only', { Allow: 'GET' })
      if (!trustedCaller(req)) return reject(res, 403, 'untrusted-caller', '仅接受本机同源调用')
      try {
        const params = new URL(req.url ?? '/', 'http://skill-install.local').searchParams
        sendJson(res, await fn(params))
      } catch (error) {
        sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error), code: 'skill-install/failed' }, 400)
      }
    })
  }
  /** 写入路由：POST + application/json + 有界正文。 */
  function routeWrite(path, fn) {
    registerRoute(path, async (req, res) => {
      if (req.method !== 'POST') return reject(res, 405, 'method-not-allowed', 'POST only', { Allow: 'POST' })
      if (!trustedCaller(req)) return reject(res, 403, 'untrusted-caller', '仅接受本机同源调用')
      if (!/^application\/json\b/i.test(String(req.headers?.['content-type'] ?? ''))) {
        return reject(res, 415, 'unsupported-media-type', '只接受 application/json')
      }
      try {
        sendJson(res, await fn(await readBoundedJson(req)))
      } catch (error) {
        const status = typeof error?.statusCode === 'number' ? error.statusCode : 400
        sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error), code: 'skill-install/failed' }, status)
      }
    })
  }
  /** 只读路由的简写；旧的 `route(...)` 调用点全部落在这一类。 */
  function route(path, fn) {
    routeRead(path, fn)
  }

  route('/skill-install/resolve', async (params) => {
    const q = (params.get('q') ?? '').trim()
    const kind = classifyInput(q)
    if (kind.kind === 'none') return { ok: true, kind: 'none' }
    if (kind.kind === 'repo') {
      const detail = await repoSkills(kind.fullName)
      return { ok: true, kind: 'repo', ...detail }
    }
    const items = await searchRepos(kind.query)
    return { ok: true, kind: 'search', query: kind.query, items }
  })

  route('/skill-install/repo', async (params) => {
    const fullName = (params.get('repo') ?? '').trim()
    if (!REPO_RE.test(fullName)) throw new Error('仓库名无效：' + fullName)
    const detail = await repoSkills(fullName)
    return { ok: true, kind: 'repo', ...detail }
  })

  route('/skill-install/roots', async () => ({ ok: true, ...rootsSummary() }))

  routeWrite('/skill-install/install', async (body) => {
    const fullName = String(body.repo ?? '').trim()
    const dirs = String(body.dirs ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
    const rootKey = String(body.root ?? 'global').trim()
    const customPath = String(body.customPath ?? '').trim()
    const workspaceId = String(body.workspaceId ?? '').trim()
    if (!REPO_RE.test(fullName)) throw new Error('仓库名无效：' + fullName)
    if (dirs.length === 0) throw new Error('未选择要安装的技能')
    if (dirs.length > 20) throw new Error('一次最多安装 20 个技能')
    return await installSkills(fullName, dirs, rootKey, customPath, workspaceId)
  })

  routeWrite('/skill-install/remove', async (body) => {
    const rootKey = String(body.root ?? 'global').trim()
    const customPath = String(body.customPath ?? '').trim()
    const dir = String(body.dir ?? '').trim()
    return await removeSkill(rootKey, customPath, dir)
  })

  route('/skill-install/installed', async () => ({ ok: true, items: installedRecords() }))

  route('/skill-install/skills', async () => {
    let items = []
    if (skills) {
      // The registry resolves skills per scope: no argument means the global
      // roots only, which is why the '/' menu and this list disagreed. Query
      // once per scope and keep the workspace title as the location label.
      const seenNames = new Set()
      const scopes = [
        { scope: {}, location: '' },
        ...listWorkspaces().map((w) => ({ scope: { cwd: w.path }, location: w.title })),
      ]
      for (const entry of scopes) {
        let list = []
        try {
          list = await skills.list(entry.scope)
        } catch {
          list = []
        }
        if (!Array.isArray(list)) list = []
        for (const s of list) {
          if (s === null || typeof s !== 'object' || typeof s.name !== 'string' || seenNames.has(s.name)) continue
          seenNames.add(s.name)
          items.push({
            name: s.name,
            description: s.description,
            source: s.source,
            provider: s.provider,
            ...(entry.location !== '' && s.source !== 'global' ? { location: entry.location } : {}),
            ...(s.path ? { path: s.path } : {}),
          })
        }
      }
    }
    // 宿主注册表不一定暴露给插件（或只报本会话可调用的技能），所以再扫一遍
    // 已知的技能根目录，把文件系统里真实存在的 SKILL.md 也列出来。
    {
      const scanRoots = [
        { dir: join(dshHomeDir(), 'skills'), location: '' },
        ...listWorkspaces().map((w) => ({ dir: join(w.path, '.dsh', 'skills'), location: w.title })),
        ...customDirs().map((d) => ({ dir: d, location: '自定义' })),
      ]
      for (const scan of scanRoots) {
        if (!existsSync(scan.dir)) continue
        let entries = []
        try {
          entries = readdirSync(scan.dir, { withFileTypes: true })
        } catch {
          continue
        }
        const candidates = []
        for (const entry of entries) {
          if (entry.isDirectory()) candidates.push({ fallback: entry.name, file: join(scan.dir, entry.name, 'SKILL.md') })
          else if (entry.isFile() && entry.name.endsWith('.md')) candidates.push({ fallback: entry.name.replace(/\.md$/, ''), file: join(scan.dir, entry.name) })
        }
        for (const candidate of candidates) {
          if (!existsSync(candidate.file)) continue
          let parsed = null
          try {
            parsed = parseFrontmatter(readFileSync(candidate.file, 'utf8'))
          } catch {
            parsed = null
          }
          const name = typeof parsed?.data?.name === 'string' && parsed.data.name.trim() !== ''
            ? parsed.data.name.trim()
            : candidate.fallback
          if (!SKILL_NAME_RE.test(name)) continue
          if (items.some((s) => s.name === name)) continue
          items.push({
            name,
            description: clip(parsed?.data?.description ?? '', 160),
            source: 'filesystem',
            provider: 'skills',
            location: scan.location,
            path: candidate.file,
          })
        }
      }
    }
    // Registry 只报它当前加载的技能；已装但尚未被加载器扫到的，按安装记录补进来，
    // 免得刚装完的技能在「已加载」里看不到。
    const seen = new Set(items.map((s) => s.name))
    for (const record of installedRecords()) {
      if (!record.exists || seen.has(record.name)) continue
      items.push({
        name: record.name,
        description: '',
        source: 'installed',
        provider: 'skill-install',
        path: record.root + '/' + record.dir,
      })
    }
    return { ok: true, items }
  })

  routeWrite('/skill-install/proxy', async (body) => {
    const settings = loadSettings()
    if (typeof body.set === 'string') {
      settings.proxy = body.set.trim()
      saveSettings(settings)
    } else if (body.clear !== undefined) {
      settings.proxy = ''
      saveSettings(settings)
    }
    return { ok: true, proxy: settings.proxy, curl: probeCurl() }
  })

  routeWrite('/skill-install/token', async (body) => {
    const settings = loadSettings()
    if (typeof body.set === 'string') {
      settings.githubToken = body.set.trim()
      saveSettings(settings)
    } else if (body.clear !== undefined) {
      settings.githubToken = ''
      saveSettings(settings)
    }
    const token = settings.githubToken
    return { ok: true, hasToken: token !== '', masked: token !== '' ? token.slice(0, 4) + '…' + token.slice(-4) : '' }
  })

  route('/skill-install/proxy-test', async () => {
    const proxy = proxyOf()
    const started = Date.now()
    try {
      const text = proxy !== '' ? await curlText(GH_API + '/zen', proxy, tokenOf()) : await directText(GH_API + '/zen')
      return { ok: true, proxy: proxy || 'direct', latencyMs: Date.now() - started, sample: clip(text, 80) }
    } catch (error) {
      return { ok: false, proxy: proxy || 'direct', latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
