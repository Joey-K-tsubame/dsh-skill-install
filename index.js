/**
 * dsh-skill-install — 宿主插件。
 *
 * 一个轻量的技能安装器：在 Web 设置页里按名字搜索 GitHub 仓库，或直接输入
 * 仓库地址，列出该仓库中的 SKILL.md 技能，勾选后安装到可选目标目录
 * （全局 / 当前项目 / 自定义目录）。安装走 skill-filesystem 已监视的标准根，
 * 自定义目录由本插件自建 skill provider 服务并热刷新——装完即时生效。
 *
 * 零外部运行时依赖（js-yaml 以 ESM 构建内置于 ./js-yaml.mjs）。GitHub 抓取默认直连；
 * 配置代理后经系统 curl 走代理。所有路由与 provider 都用 ctx.effect 登记，
 * 停用/重载时自动摘除，不会重复注册。
 * @module dsh-skill-install
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, watch } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
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
  const skills = ctx.get('skills')

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
  /** 当前项目根：最近含 .git 的祖先，否则进程 cwd（与 skill-filesystem 一致）。 */
  function projectRootDir() {
    let cur = resolve(process.cwd())
    while (true) {
      if (existsSync(join(cur, '.git'))) return cur
      const parent = dirname(cur)
      if (parent === cur) return resolve(process.cwd())
      cur = parent
    }
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
  /** 下载仓库 tarball 到本地解压后扫描——不依赖 raw.githubusercontent.com。 */
  async function listSkillsFromTarball(fullName, branch) {
    const work = join(dshHomeDir(), SRC_DIR_NAME, 'list-' + Date.now().toString(36) + '-' + basename(fullName))
    await mkdir(work, { recursive: true })
    try {
      await downloadExtract(fullName, branch, work)
      return scanSkillsInTree(work, basename(fullName))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  /** 列出仓库里的全部 SKILL.md 技能。先走树 API + raw，失败或不全时用本地 tarball 兜底。 */
  async function repoSkills(fullName) {
    const meta = await repoMeta(fullName)
    const branch = meta.defaultBranch
    let dirs = []
    let treeError = ''
    try {
      const treeUrl = GH_API + '/repos/' + fullName + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
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
          const rawUrl = GH_RAW + '/' + fullName + '/' + encodeURIComponent(branch) + '/' + rawPath.split('/').map(encodeURIComponent).join('/')
          const text = await ghText(rawUrl)
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
        const fromTar = await listSkillsFromTarball(fullName, branch)
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
    return { meta, skills, truncated: dirs.length > 24, treeError, listError }
  }

  // -------------------------------------------------------------- 目标目录
  function rootTarget(rootKey, customPath) {
    if (rootKey === 'global') return { path: join(dshHomeDir(), 'skills'), custom: false, label: '全局' }
    if (rootKey === 'project') return { path: join(projectRootDir(), '.dsh', 'skills'), custom: false, label: '当前项目' }
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
    const project = rootTarget('project')
    const customs = customDirs().map((path) => ({ key: 'custom', path, exists: existsSync(path) }))
    return {
      global: { key: 'global', label: '全局', path: global.path, exists: existsSync(global.path) },
      project: { key: 'project', label: '当前项目', path: project.path, exists: existsSync(project.path) },
      customs,
      default: 'global',
    }
  }

  // ------------------------------------------------------------ 安装 / 移除
  async function downloadExtract(fullName, branch, destDir) {
    const tarball = join(destDir, 'repo.tar.gz')
    const url = GH_CODELOAD + '/' + fullName + '/tar.gz/refs/heads/' + encodeURIComponent(branch)
    const proxy = proxyOf()
    if (proxy !== '') {
      if (!probeCurl()) throw new Error('已配置代理，但宿主未找到 curl')
      await new Promise((resolvePromise, reject) => {
        let child
        try {
          child = spawn('curl', ['-sL', '--max-time', '120', '-x', proxy, '-o', tarball, '--', url], { stdio: ['ignore', 'pipe', 'pipe'] })
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
        const buf = Buffer.from(await res.arrayBuffer())
        await writeFile(tarball, buf)
      } finally {
        clearTimeout(timer)
      }
    }
    const result = spawnSync('tar', ['-xzf', tarball, '-C', destDir, '--strip-components=1'], { timeout: 120000 })
    if (result.status !== 0) {
      const detail = (result.stderr && result.stderr.toString().trim()) || ('tar 退出码 ' + result.status)
      throw new Error('解压失败：' + detail)
    }
  }
  async function installSkills(fullName, dirs, rootKey, customPath) {
    const meta = await repoMeta(fullName)
    const target = rootTarget(rootKey, customPath)
    const work = join(dshHomeDir(), SRC_DIR_NAME, Date.now().toString(36) + '-' + basename(fullName))
    await mkdir(work, { recursive: true })
    const installed = []
    try {
      await downloadExtract(fullName, meta.defaultBranch, work)
      for (const dir of dirs) {
        const srcDir = dir === '.' ? work : join(work, ...dir.split('/'))
        const skillMd = join(srcDir, 'SKILL.md')
        if (!existsSync(skillMd)) throw new Error('技能目录缺少 SKILL.md：' + (dir === '.' ? fullName : dir))
        const parsed = parseFrontmatter(readFileSync(skillMd, 'utf8'))
        if (!parsed) throw new Error('技能 frontmatter 无效：' + (dir === '.' ? fullName : dir))
        const name = typeof parsed.data.name === 'string' && SKILL_NAME_RE.test(parsed.data.name.trim()) ? parsed.data.name.trim() : (dir === '.' ? basename(fullName) : basename(dir))
        if (!SKILL_NAME_RE.test(name)) throw new Error('技能名称无效：' + name)
        await mkdir(target.path, { recursive: true })
        const targetDir = safeJoin(target.path, name)
        if (existsSync(targetDir)) throw new Error('技能已存在：' + name + '（' + target.path + '）')
        await cp(srcDir, targetDir, { recursive: true, dereference: false })
        installed.push({ name, dir: name, root: target.path, scope: rootKey, source: fullName, time: new Date().toISOString() })
      }
      const settings = loadSettings()
      if (target.custom) {
        const resolvedCustom = target.path
        if (!settings.customDirs.some((d) => resolve(expandHome(d)) === resolvedCustom)) settings.customDirs.push(resolvedCustom)
        startCustomWatcher(resolvedCustom)
      }
      settings.installed = settings.installed.filter((r) => !installed.some((n) => n.name === r.name && n.root === r.root))
      settings.installed.push(...installed)
      saveSettings(settings)
      invalidateCustom()
      return { ok: true, installed }
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
      scope: r.scope ?? (r.root === join(dshHomeDir(), 'skills') ? 'global' : r.root === join(projectRootDir(), '.dsh', 'skills') ? 'project' : 'custom'),
      source: r.source ?? '',
      time: r.time ?? '',
      exists: existsSync(join(r.root, r.dir)),
    }))
    return records.sort((a, b) => (a.name < b.name ? -1 : 1))
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
  function sendJson(res, value) {
    const body = JSON.stringify(value)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  function route(path, fn) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          const params = new URL(req.url ?? '/', 'http://skill-install.local').searchParams
          sendJson(res, await fn(params))
        } catch (error) {
          sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), `skill-install: ${path}`)
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

  route('/skill-install/install', async (params) => {
    const fullName = (params.get('repo') ?? '').trim()
    const dirs = (params.get('dirs') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
    const rootKey = (params.get('root') ?? 'global').trim()
    const customPath = (params.get('customPath') ?? '').trim()
    if (!REPO_RE.test(fullName)) throw new Error('仓库名无效：' + fullName)
    if (dirs.length === 0) throw new Error('未选择要安装的技能')
    return await installSkills(fullName, dirs, rootKey, customPath)
  })

  route('/skill-install/remove', async (params) => {
    const rootKey = (params.get('root') ?? 'global').trim()
    const customPath = (params.get('customPath') ?? '').trim()
    const dir = (params.get('dir') ?? '').trim()
    return await removeSkill(rootKey, customPath, dir)
  })

  route('/skill-install/installed', async () => ({ ok: true, items: installedRecords() }))

  route('/skill-install/skills', async () => {
    let items = []
    if (skills) {
      const list = await skills.list({})
      items = list.map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        provider: s.provider,
        ...(s.path ? { path: s.path } : {}),
      }))
    }
    return { ok: true, items }
  })

  route('/skill-install/proxy', async (params) => {
    const settings = loadSettings()
    const set = params.get('set')
    const clear = params.get('clear')
    if (set !== null) {
      settings.proxy = set.trim()
      saveSettings(settings)
    } else if (clear !== null) {
      settings.proxy = ''
      saveSettings(settings)
    }
    return { ok: true, proxy: settings.proxy, curl: probeCurl() }
  })

  route('/skill-install/token', async (params) => {
    const settings = loadSettings()
    const set = params.get('set')
    const clear = params.get('clear')
    if (set !== null) {
      settings.githubToken = set.trim()
      saveSettings(settings)
    } else if (clear !== null) {
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
