window.__ModuleLoader__.load({
  id: "dsh-skill-install",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const CSS = [
      ".skx-root{display:flex;flex-direction:column;gap:14px;padding:20px;max-width:920px;margin:0 auto;color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:1.5}",
      ".skx-title{font-size:16px;font-weight:600;line-height:24px;margin:0}",
      ".skx-sub{color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:18px;margin:0}",
      ".skx-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".skx-input{box-sizing:border-box;flex:1;min-width:220px;height:36px;padding:0 12px;border-radius:var(--dsw-radius-md,8px);border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit}",
      ".skx-btn{box-sizing:border-box;height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit;cursor:pointer}",
      ".skx-btn:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".skx-btn:disabled{opacity:.5;cursor:default}",
      ".skx-btn-primary{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5);border:1px solid rgba(127,127,127,.4);color:var(--dsw-alias-label-primary,#111)}",
      ".skx-btn-primary:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,#f0f0f0)}",
      ".skx-btn-danger{color:var(--dsw-alias-state-error-primary,#d4380d);border:1px solid rgba(212,56,13,.4)}",
      ".skx-card{box-sizing:border-box;padding:12px 0}",
      ".skx-card+.skx-card{border-top:1px solid rgba(127,127,127,.48);padding-top:16px}",
      ".skx-card-title{font-size:13px;font-weight:600;margin:0 0 6px}",
      ".skx-list{display:flex;flex-direction:column;gap:6px}",
      ".skx-item{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid rgba(127,127,127,.48);border-radius:14px}",
      ".skx-item-main{flex:1;min-width:0}",
      ".skx-item-name{font-weight:500}",
      ".skx-item-desc{color:var(--dsw-alias-label-secondary,#666);font-size:12px;margin-top:2px;word-break:break-word}",
      ".skx-meta{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}",
      ".skx-hint{color:var(--dsw-alias-label-secondary,#666);font-size:12px;margin:0}",
      ".skx-error{color:var(--dsw-alias-state-error-primary,#d4380d);font-size:12px;white-space:pre-wrap;word-break:break-word}",
      ".skx-ok{color:var(--dsw-alias-state-success-primary,#389e0d);font-size:12px}",
      ".skx-proxy-toggle{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#666);font-size:12px;cursor:pointer;background:none;border:none;padding:0}",
      ".skx-collapse{display:inline-flex;align-items:center;gap:4px;background:none;border:none;padding:0;color:inherit;font:inherit;font-size:13px;font-weight:600;cursor:pointer}",
      ".skx-checkbox{width:16px;height:16px;margin-top:3px}",
      ".skx-tag{display:inline-block;padding:0 6px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,#f0f0f0);font-size:11px;color:var(--dsw-alias-label-secondary,#666)}",
      ".skx-radio{display:inline-flex;align-items:center;gap:4px;margin-right:12px}",
    ].join("\n");

    function qs(params) {
      if (params == null) return "";
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") sp.set(k, v);
      }
      const s = sp.toString();
      return s ? "?" + s : "";
    }
    // Mutating endpoints accept POST + JSON only; reads stay GET with a query.
    const WRITE_PATHS = new Set(["install", "remove", "proxy", "token"]);
    function api(path, params) {
      if (WRITE_PATHS.has(path)) {
        return fetch("/skill-install/" + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params ?? {}),
        }).then((r) => r.json());
      }
      return fetch("/skill-install/" + path + qs(params)).then((r) => r.json());
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      render() {
        if (this.state.error !== null) {
          return h("div", { className: "skx-error" },
            "页面渲染出错：" + (this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)));
        }
        return this.props.children;
      }
    }

    function RepoList({ items, onOpen }) {
      if (items.length === 0) return h("p", { className: "skx-sub" }, "没有匹配的仓库。");
      return h("div", { className: "skx-list" },
        items.map((it) => h("div", { className: "skx-item", key: it.fullName },
          h("div", { className: "skx-item-main" },
            h("div", { className: "skx-item-name" }, it.fullName),
            it.description ? h("div", { className: "skx-item-desc" }, it.description) : null,
            h("div", { className: "skx-meta" }, [it.stars + " ★", it.language].filter(Boolean).join(" · ")),
          ),
          h("button", { className: "skx-btn", onClick: () => onOpen(it.fullName) }, "打开"),
        )));
    }

    function SkillsPanel({ repo, sel, toggle, rootKey, setRootKey, customPath, setCustomPath, roots, busy, onInstall }) {
      const hasSelection = Object.keys(sel).length > 0;
      const needCustomPath = rootKey === "custom";
      return h("div", { className: "skx-card" },
        h("div", { className: "skx-row" },
          h("h3", { className: "skx-card-title", style: { margin: 0, flex: 1 } }, repo.meta.fullName),
          h("span", { className: "skx-meta" }, (repo.meta.stars || 0) + " ★"),
        ),
        repo.meta.description ? h("p", { className: "skx-sub" }, repo.meta.description) : null,
        repo.treeError ? h("p", { className: "skx-error" }, "目录树读取失败：" + repo.treeError) : null,
        repo.listError ? h("p", { className: "skx-error" }, "读取技能列表失败：" + repo.listError) : null,
        repo.skills.length === 0
          ? (repo.listError ? null : h("p", { className: "skx-sub" }, "该仓库没有可安装的 SKILL.md 技能。"))
          : h("div", { className: "skx-list" },
            repo.skills.map((s) => h("label", { className: "skx-item", key: s.dir, style: { cursor: "pointer" } },
              h("input", { type: "checkbox", className: "skx-checkbox", checked: !!sel[s.dir], onChange: () => toggle(s.dir) }),
              h("div", { className: "skx-item-main" },
                h("div", { className: "skx-item-name" }, s.name),
                s.description ? h("div", { className: "skx-item-desc" }, s.description) : null,
                s.whenToUse ? h("div", { className: "skx-meta" }, "何时使用：" + s.whenToUse) : null,
                h("div", { className: "skx-meta" }, "目录：" + (s.dir === "." ? "/" : s.dir)),
              ),
            ))),
        repo.truncated ? h("p", { className: "skx-hint" }, "仅显示前 24 个技能。") : null,
        hasSelection ? h("div", null,
          h("div", { className: "skx-row", style: { marginTop: 12 } },
            h("span", { className: "skx-hint" }, "安装到："),
            roots && [roots.global, roots.project].map((r) => h("label", { className: "skx-radio", key: r.key },
              h("input", { type: "radio", name: "root", checked: rootKey === r.key, onChange: () => setRootKey(r.key) }),
              r.label + "（" + r.path + "）",
            )),
            h("label", { className: "skx-radio" },
              h("input", { type: "radio", name: "root", checked: rootKey === "custom", onChange: () => setRootKey("custom") }),
              "自定义",
            ),
          ),
          needCustomPath ? h("input", {
            className: "skx-input", style: { marginTop: 8, width: "100%" },
            placeholder: "绝对目录，例如 D:\\skills（或用 ~/.dsh/skills 形式）",
            value: customPath, onChange: (e) => setCustomPath(e.target.value),
          }) : null,
          h("div", { className: "skx-row", style: { marginTop: 10 } },
            h("button", { className: "skx-btn skx-btn-primary", disabled: busy || (needCustomPath && !customPath.trim()), onClick: onInstall }, busy ? "安装中…" : "安装所选（" + Object.keys(sel).length + "）"),
          ),
        ) : null,
      );
    }

    function InstalledList({ items, onRemove, busy }) {
      const groups = {};
      for (const it of items) (groups[it.root] = groups[it.root] || []).push(it);
      const keys = Object.keys(groups);
      if (keys.length === 0) return h("p", { className: "skx-sub" }, "尚未安装任何技能。");
      return h("div", { className: "skx-list" },
        keys.map((root) => h("div", { className: "skx-card", key: root },
          h("div", { className: "skx-card-title" }, root),
          groups[root].map((it) => h("div", { className: "skx-item", key: it.name + "@" + it.root },
            h("div", { className: "skx-item-main" },
              h("span", { className: "skx-item-name" }, it.name),
              it.source ? h("span", { className: "skx-meta" }, "　来自 " + it.source) : null,
              !it.exists ? h("span", { className: "skx-error" }, "　（目录已不存在）") : null,
            ),
            h("button", { className: "skx-btn skx-btn-danger", disabled: busy, onClick: () => onRemove(it) }, "移除"),
          )),
        )));
    }

    function LoadedList({ items }) {
      if (items.length === 0) return h("p", { className: "skx-sub" }, "当前没有已加载的技能。");
      return h("div", { className: "skx-list" },
        items.map((s) => h("div", { className: "skx-item", key: s.name },
          h("div", { className: "skx-item-main" },
            h("span", { className: "skx-item-name" }, s.name),
            h("span", { className: "skx-tag", style: { marginLeft: 6 } }, s.provider || s.source || "skills"),
            s.description ? h("div", { className: "skx-item-desc" }, s.description) : null,
          ),
        )));
    }

    function ProxyPanel({ open, setOpen, proxy, setProxy, token, setToken, tokenMasked, onApply, onClear, onTest, onSaveToken, onClearToken, testResult, busy }) {
      if (!open) {
        return h("button", { className: "skx-proxy-toggle", onClick: () => setOpen(true) }, "GitHub 设置 ▸");
      }
      return h("div", { className: "skx-card" },
        h("div", { className: "skx-row", style: { justifyContent: "space-between" } },
          h("span", { className: "skx-card-title", style: { margin: 0 } }, "GitHub 设置"),
          h("button", { className: "skx-proxy-toggle", onClick: () => setOpen(false) }, "收起 ▾"),
        ),
        h("div", { className: "skx-row", style: { marginTop: 8 } },
          h("input", { className: "skx-input", placeholder: "代理，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7891", value: proxy, onChange: (e) => setProxy(e.target.value) }),
          h("button", { className: "skx-btn", disabled: busy, onClick: onApply }, "应用"),
          h("button", { className: "skx-btn", disabled: busy, onClick: onClear }, "清除"),
          h("button", { className: "skx-btn", disabled: busy, onClick: onTest }, "测试"),
        ),
        testResult ? h("div", { className: testResult.ok ? "skx-ok" : "skx-error", style: { marginTop: 8 } },
          testResult.ok ? ("连通，延迟 " + testResult.latencyMs + " ms") : ("失败：" + (testResult.error || "未知"))) : null,
        h("div", { className: "skx-row", style: { marginTop: 12 } },
          h("input", { className: "skx-input", type: "password", placeholder: tokenMasked ? ("已配置 Token：" + tokenMasked) : "GitHub Token（可选，认证后限流提高到 5000 次/小时）", value: token, onChange: (e) => setToken(e.target.value) }),
          h("button", { className: "skx-btn", disabled: busy, onClick: onSaveToken }, "保存"),
          h("button", { className: "skx-btn", disabled: busy, onClick: onClearToken }, "清除"),
        ),
        h("p", { className: "skx-hint", style: { marginBottom: 0 } }, "代理留空为直连；Token 仅存本地（$DSH_HOME/skill-install.json），只用于访问 GitHub API。"),
      );
    }

    function SkillInstall() {
      const [query, setQuery] = useState("");
      const [result, setResult] = useState(null);
      const [repo, setRepo] = useState(null);
      const [sel, setSel] = useState({});
      const [rootKey, setRootKey] = useState("global");
      const [customPath, setCustomPath] = useState("");
      const [roots, setRoots] = useState(null);
      const [installed, setInstalled] = useState([]);
      const [loaded, setLoaded] = useState([]);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [proxyOpen, setProxyOpen] = useState(false);
      const [proxy, setProxy] = useState("");
      const [testResult, setTestResult] = useState(null);
      const [token, setToken] = useState("");
      const [tokenMasked, setTokenMasked] = useState("");
      const [loadedOpen, setLoadedOpen] = useState(false);

      const refresh = useCallback(() => {
        api("roots").then((r) => r && r.ok && setRoots(r));
        api("installed").then((r) => r && r.ok && setInstalled(r.items));
        api("skills").then((r) => r && r.ok && setLoaded(r.items));
        api("proxy").then((r) => r && r.ok && setProxy(r.proxy || ""));
        api("token").then((r) => r && r.ok && setTokenMasked(r.masked || ""));
      }, []);

      useEffect(() => { refresh(); }, [refresh]);

      const doResolve = useCallback(() => {
        const q = query.trim();
        if (!q) return;
        setBusy(true); setError(""); setNotice("");
        api("resolve", { q }).then((r) => {
          setBusy(false);
          if (!r.ok) { setError(r.error); return; }
          if (r.kind === "none") { setResult(null); setRepo(null); return; }
          if (r.kind === "repo") { setRepo(r); setResult(null); setSel({}); }
          else { setResult(r); setRepo(null); }
        }).catch((e) => { setBusy(false); setError(String(e && e.message ? e.message : e)); });
      }, [query]);

      const openRepo = useCallback((fullName) => {
        setBusy(true); setError("");
        api("repo", { repo: fullName }).then((r) => {
          setBusy(false);
          if (!r.ok) { setError(r.error); return; }
          setRepo(r); setResult(null); setSel({});
        }).catch((e) => { setBusy(false); setError(String(e && e.message ? e.message : e)); });
      }, []);

      const toggle = (dir) => setSel((prev) => {
        const next = { ...prev };
        if (next[dir]) delete next[dir]; else next[dir] = true;
        return next;
      });

      const doInstall = useCallback(() => {
        const dirs = Object.keys(sel);
        if (!repo || dirs.length === 0) return;
        setBusy(true); setError(""); setNotice("");
        api("install", { repo: repo.meta.fullName, dirs: dirs.join(","), root: rootKey, customPath: rootKey === "custom" ? customPath : undefined }).then((r) => {
          setBusy(false);
          if (!r.ok) { setError(r.error); return; }
          setNotice("已安装：" + r.installed.map((i) => i.name).join("、"));
          setSel({});
          refresh();
        }).catch((e) => { setBusy(false); setError(String(e && e.message ? e.message : e)); });
      }, [repo, sel, rootKey, customPath, refresh]);

      const doRemove = useCallback((it) => {
        setBusy(true); setError(""); setNotice("");
        api("remove", { root: it.scope === "custom" ? "custom" : it.scope, customPath: it.scope === "custom" ? it.root : undefined, dir: it.dir }).then((r) => {
          setBusy(false);
          if (!r.ok) { setError(r.error); return; }
          setNotice("已移除：" + it.name);
          refresh();
        }).catch((e) => { setBusy(false); setError(String(e && e.message ? e.message : e)); });
      }, [refresh]);

      const applyProxy = useCallback(() => api("proxy", { set: proxy }).then((r) => { if (r && r.ok) { setNotice(r.curl ? "代理已保存。" : "代理已保存，但未检测到 curl，代理将不可用。"); refresh(); } }), [proxy, refresh]);
      const clearProxy = useCallback(() => api("proxy", { clear: "1" }).then((r) => { if (r && r.ok) { setProxy(""); setNotice("已清除代理。"); refresh(); } }), [refresh]);
      const testProxy = useCallback(() => { setBusy(true); setTestResult(null); api("proxy-test").then((r) => { setBusy(false); setTestResult(r); }); }, []);
      const saveToken = useCallback(() => api("token", { set: token }).then((r) => { if (r && r.ok) { setToken(""); setTokenMasked(r.masked || ""); setNotice("Token 已保存。"); } }), [token]);
      const clearToken = useCallback(() => api("token", { clear: "1" }).then((r) => { if (r && r.ok) { setToken(""); setTokenMasked(""); setNotice("Token 已清除。"); } }), []);

      return h("div", { className: "skx-root" },
        h("h2", { className: "skx-title" }, "技能"),
        h("p", { className: "skx-sub" }, "按名字搜索 GitHub 仓库，或直接输入 owner/repo 或完整仓库地址；勾选仓库中的 SKILL.md 技能，安装到全局 / 当前项目 / 自定义目录。装完即时生效。"),
        error ? h("div", { className: "skx-error" }, error) : null,
        notice ? h("div", { className: "skx-ok" }, notice) : null,

        h("div", { className: "skx-row" },
          h("input", {
            className: "skx-input", placeholder: "技能/仓库名字，或 owner/repo、完整地址",
            value: query, onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") doResolve(); },
          }),
          h("button", { className: "skx-btn skx-btn-primary", disabled: busy, onClick: doResolve }, busy ? "查询中…" : "查询"),
          h("button", { className: "skx-btn", disabled: busy, onClick: () => { setRepo(null); setResult(null); setSel({}); setError(""); setQuery(""); } }, "清空"),
        ),

        h(ProxyPanel, { open: proxyOpen, setOpen: setProxyOpen, proxy, setProxy, token, setToken, tokenMasked, onApply: applyProxy, onClear: clearProxy, onTest: testProxy, onSaveToken: saveToken, onClearToken: clearToken, testResult, busy }),

        result && result.kind === "search"
          ? h("div", { className: "skx-card" },
            h("div", { className: "skx-card-title" }, "搜索“" + result.query + "”的结果"),
            h(RepoList, { items: result.items, onOpen: openRepo }))
          : null,

        repo
          ? h(SkillsPanel, { repo, sel, toggle, rootKey, setRootKey, customPath, setCustomPath, roots, busy, onInstall: doInstall })
          : null,

        h("div", { className: "skx-card" },
          h("div", { className: "skx-card-title" }, "已安装（本插件）"),
          h(InstalledList, { items: installed, onRemove: doRemove, busy })),

        h("div", { className: "skx-card" },
          h("button", { className: "skx-collapse", onClick: () => setLoadedOpen((v) => !v) },
            "当前已加载的技能（" + loaded.length + "）" + (loadedOpen ? " ▾" : " ▸")),
          loadedOpen ? h("div", { style: { marginTop: 8 } },
            h("p", { className: "skx-hint", style: { marginTop: 0, marginBottom: 6 } }, "来自内置 skill-filesystem 与本插件的合并目录（只读）。"),
            h(LoadedList, { items: loaded })) : null),
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement("style");
          tag.dataset.plugin = "dsh-skill-install";
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => { tag.remove(); };
        }, "skill-install: css");
        ctx.slots.inject("settings.section", () => ctx.slots.register(
          { name: "settings.section", id: "skill-install", order: 1000, label: () => "技能" },
          () => h(Boundary, null, h(SkillInstall, null)),
        ));
      },
    };
  },
});
