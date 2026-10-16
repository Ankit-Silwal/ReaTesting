import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Braces, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2, Command, Download, Folder, FolderClosed, Globe2, History, Layers3, Loader2, MoreHorizontal, Plus, Radio, Save, Search, Send, Settings2, ShieldCheck, Terminal, Trash2, Upload, Variable, X, Zap } from "lucide-react";
import { cancelRequest, isDesktop, loadWorkspace, saveWorkspace, sendRequest, startDemo } from "./bridge";
import { CodeViewer, CopyButton, IconButton, Modal, PairEditor } from "./components";
import { cloneRequest, defaults, displayUrl, exportCollection, formatSize, importCollections, initialWorkspace, methods, newRequest, pair, prettyBody, resolveRequest, toCurl, uid, validateWorkspace } from "./model";
import type { Collection, Environment, Pair, Request, RunState, Workspace } from "./types";
import "./App.css";

type Dialog = "save" | "new-collection" | "import" | "environment" | "settings" | "code" | "help" | "collection" | null;
type RequestPanel = "Params" | "Authorization" | "Headers" | "Body" | "Settings";
const panelNames: RequestPanel[] = ["Params", "Authorization", "Headers", "Body", "Settings"];

function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const [workspace, setWorkspace] = useState<Workspace>(() => initialWorkspace("http://127.0.0.1:8787"));
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState("");
  const [persistError, setPersistError] = useState("");
  const [saving, setSaving] = useState(false);
  const [sidebar, setSidebar] = useState<"collections" | "history">("collections");
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [requestPanel, setRequestPanel] = useState<RequestPanel>("Params");
  const [responsePanel, setResponsePanel] = useState<"Body" | "Headers" | "Cookies">("Body");
  const [bodyView, setBodyView] = useState<"Pretty" | "Raw">("Pretty");
  const [responseSearch, setResponseSearch] = useState("");
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogName, setDialogName] = useState("");
  const [selectedCollection, setSelectedCollection] = useState("playground");
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null);
  const [editingEnvironment, setEditingEnvironment] = useState<Environment | null>(null);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveQueue = useRef(Promise.resolve());
  const currentWorkspace = useRef(workspace);
  currentWorkspace.current = workspace;
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingIds = useRef(new Set<string>());

  const notify = useCallback((message: string) => { setNotice(message); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(""), 3600); }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const closeDialog = useCallback(() => { setDialog(null); setImportError(""); }, []);

  useEffect(() => {
    let active = true;
    Promise.all([loadWorkspace(), startDemo()]).then(([saved, baseUrl]) => {
      if (!active) return;
      const data = saved ? validateWorkspace(saved) : initialWorkspace(baseUrl);
      const local = data.environments.find(e => e.id === "local");
      if (local) local.variables = [...local.variables.filter(p => p.key !== "base_url"), pair("base_url", baseUrl)];
      setWorkspace(data); setReady(true);
    }).catch(error => { if (active) setStartupError(String(error)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    setSaving(true);
    const timer = setTimeout(() => {
      saveQueue.current = saveQueue.current.then(() => saveWorkspace(workspace)).then(() => { setPersistError(""); setSaving(false); }).catch(error => { setPersistError(String(error)); setSaving(false); });
    }, 400);
    return () => clearTimeout(timer);
  }, [workspace, ready]);

  useEffect(() => { document.documentElement.dataset.theme = workspace.settings.theme; }, [workspace.settings.theme]);

  const request = workspace.tabs.find(t => t.id === workspace.activeId) ?? workspace.tabs[0];
  const environment = workspace.environments.find(e => e.id === workspace.activeEnvironmentId);
  const run = runs[request.id] ?? { loading: false };
  const response = run.response;
  const collection = workspace.collections.find(c => c.id === request.collectionId);
  const savedRequest = collection?.requests.find(r => r.id === request.id);
  const dirty = !savedRequest || JSON.stringify(savedRequest) !== JSON.stringify(request);
  const activePairs = (rows: Pair[]) => rows.filter(p => p.enabled && p.key).length;
  const responseBody = useMemo(() => response ? bodyView === "Pretty" && !response.binary ? prettyBody(response.body) : response.body : "", [response, bodyView]);
  const cookies = response?.headers.filter(([name]) => name.toLowerCase() === "set-cookie") ?? [];

  const updateRequest = useCallback((patch: Partial<Request>) => setWorkspace(ws => ({ ...ws, tabs: ws.tabs.map(t => t.id === ws.activeId ? { ...t, ...patch } : t) })), []);
  const addTab = useCallback(() => {
    const tab = newRequest(); setWorkspace(ws => ({ ...ws, tabs: [...ws.tabs, tab], activeId: tab.id })); setRequestPanel("Params");
  }, []);
  function openRequest(r: Request, duplicate = false) {
    const tab = duplicate ? cloneRequest(r) : structuredClone(r);
    setWorkspace(ws => ({ ...ws, tabs: ws.tabs.some(t => t.id === tab.id) ? ws.tabs : [...ws.tabs, tab], activeId: tab.id }));
    setRequestPanel(tab.bodyMode === "none" ? "Params" : "Body");
  }
  function closeTab(id: string) {
    if (pendingIds.current.has(id)) { notify("Cancel the running request before closing this tab."); return; }
    setWorkspace(ws => {
      const position = ws.tabs.findIndex(t => t.id === id);
      const tabs = ws.tabs.filter(t => t.id !== id);
      if (!tabs.length) tabs.push(newRequest());
      return { ...ws, tabs, activeId: ws.activeId === id ? tabs[Math.max(0, position - 1)].id : ws.activeId };
    });
    setRuns(prev => { const next = { ...prev }; delete next[id]; return next; });
  }

  const send = useCallback(async () => {
    const ws = currentWorkspace.current;
    const original = ws.tabs.find(r => r.id === ws.activeId)!;
    if (pendingIds.current.has(original.id) || !ready) return;
    let resolved: Request;
    try { resolved = resolveRequest(original, ws.environments.find(e => e.id === ws.activeEnvironmentId)); }
    catch (e) { setRuns(prev => ({ ...prev, [original.id]: { loading: false, error: e instanceof Error ? e.message : String(e) } })); return; }
    pendingIds.current.add(original.id);
    setRuns(prev => ({ ...prev, [original.id]: { loading: true } })); setResponsePanel("Body");
    const started = Date.now();
    try {
      const result = await sendRequest({ ...resolved, ...ws.settings });
      setRuns(prev => ({ ...prev, [original.id]: { loading: false, response: result } }));
      setWorkspace(current => ({ ...current, history: [{ id: uid(), request: structuredClone(original), timestamp: Date.now(), status: result.status, timeMs: result.timeMs }, ...current.history].slice(0, 80) }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setRuns(prev => ({ ...prev, [original.id]: { loading: false, error } }));
      setWorkspace(current => ({ ...current, history: [{ id: uid(), request: structuredClone(original), timestamp: Date.now(), status: null, timeMs: Date.now() - started }, ...current.history].slice(0, 80) }));
    } finally { pendingIds.current.delete(original.id); }
  }, [ready]);

  const beginSave = useCallback(() => {
    const ws = currentWorkspace.current; const current = ws.tabs.find(t => t.id === ws.activeId)!;
    setDialogName(current.name === "Untitled request" ? "" : current.name);
    setSelectedCollection(current.collectionId && ws.collections.some(c => c.id === current.collectionId) ? current.collectionId : ws.collections[0]?.id ?? ""); setDialog("save");
  }, []);

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === "Enter" && !dialog) { event.preventDefault(); void send(); }
      if (event.key.toLowerCase() === "s") { event.preventDefault(); if (!dialog) beginSave(); }
      if (event.key.toLowerCase() === "k") { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key.toLowerCase() === "t" && !dialog) { event.preventDefault(); addTab(); }
    }
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [send, beginSave, addTab, dialog]);

  function commitSave() {
    if (!dialogName.trim() || !selectedCollection) return;
    const updated = { ...request, name: dialogName.trim(), collectionId: selectedCollection };
    setWorkspace(ws => ({ ...ws, tabs: ws.tabs.map(t => t.id === updated.id ? updated : t), collections: ws.collections.map(c => c.id === selectedCollection ? { ...c, requests: c.requests.some(r => r.id === updated.id) ? c.requests.map(r => r.id === updated.id ? structuredClone(updated) : r) : [...c.requests, structuredClone(updated)] } : { ...c, requests: c.requests.filter(r => r.id !== updated.id) }) }));
    closeDialog(); notify("Request saved to collection");
  }

  function createCollection() {
    if (!dialogName.trim()) return;
    const created = { id: uid(), name: dialogName.trim(), requests: [] };
    setWorkspace(ws => ({ ...ws, collections: [...ws.collections, created] })); setSelectedCollection(created.id); closeDialog(); notify("Collection created");
  }

  function performImport() {
    try {
      const data = JSON.parse(importText);
      const parsed = importCollections(data);
      setWorkspace(ws => ({ ...ws, collections: [...ws.collections, ...parsed] }));
      closeDialog(); setImportText(""); notify(`Imported ${parsed.reduce((sum, c) => sum + c.requests.length, 0)} requests`);
    } catch (e) { setImportError(e instanceof Error ? e.message : String(e)); }
  }

  function openEnvironment() {
    setEditingEnvironment(environment ? structuredClone(environment) : { id: uid(), name: "New environment", variables: [] }); setDialog("environment");
  }

  let code = "";
  if (dialog === "code") { try { code = toCurl(request, environment); } catch (e) { code = e instanceof Error ? e.message : String(e); } }

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><ArrowUpRight size={23} strokeWidth={2.5} /></span><span>relay<span className="brand-period">.</span></span><span className="desktop-label">DESKTOP</span></div>
      <div className="workspace-title"><Layers3 size={15} /> Personal workspace <ChevronDown size={13} /></div>
      <div className="header-spacer" />
      <button className="header-search" onClick={() => searchRef.current?.focus()}><Search size={14} /> Find a request <kbd>Ctrl K</kbd></button>
      <div className="local-indicator"><span className="status-dot" /> Local workspace</div>
      <IconButton label="Settings" onClick={() => setDialog("settings")}><Settings2 size={17} /></IconButton>
      <span className="avatar" title="Your personal workspace">Y</span>
    </header>

    <div className="workspace-layout">
      <nav className="nav-rail" aria-label="Workspace navigation">
        <button className={sidebar === "collections" ? "rail-item active" : "rail-item"} onClick={() => setSidebar("collections")}><FolderClosed size={20} /><span>Collections</span></button>
        <button className={sidebar === "history" ? "rail-item active" : "rail-item"} onClick={() => setSidebar("history")}><History size={20} /><span>History</span></button>
        <button className="rail-item" onClick={openEnvironment}><Variable size={20} /><span>Variables</span></button>
        <div className="rail-spacer" />
        <button className="rail-item" onClick={() => setDialog("help")}><CircleHelp size={20} /><span>Help</span></button>
        <div className="rail-version">v0.1</div>
      </nav>

      <aside className="sidebar">
        <div className="sidebar-title"><h2>{sidebar === "collections" ? "Collections" : "History"}</h2><div className="button-row">{sidebar === "collections" ? <><IconButton label="New collection" onClick={() => { setDialogName(""); setDialog("new-collection"); }}><Plus size={16} /></IconButton><IconButton label="Import collection" onClick={() => setDialog("import")}><Upload size={15} /></IconButton></> : <IconButton label="Clear history" onClick={() => { setWorkspace(ws => ({ ...ws, history: [] })); notify("History cleared"); }} disabled={!workspace.history.length}><Trash2 size={15} /></IconButton>}</div></div>
        <div className="sidebar-filter"><Search size={13} /><input ref={searchRef} placeholder="Filter requests..." aria-label="Filter requests" value={filter} onChange={e => setFilter(e.target.value)} /><span>/</span></div>
        <div className="sidebar-content">
          {sidebar === "collections" ? <>
            {workspace.collections.map(c => {
              const requests = c.requests.filter(r => `${r.name} ${r.url} ${r.method}`.toLowerCase().includes(filter.toLowerCase()));
              if (filter && !requests.length && !c.name.toLowerCase().includes(filter.toLowerCase())) return null;
              const closed = collapsed.includes(c.id) && !filter;
              return <div className="collection" key={c.id}>
                <div className="collection-row"><button className="collection-toggle" onClick={() => setCollapsed(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}>{closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<Folder size={15} /><span>{c.name}</span><span className="collection-count">{c.requests.length}</span></button><IconButton label={`Manage ${c.name}`} onClick={() => { setEditingCollection(c); setDialogName(c.name); setDialog("collection"); }}><MoreHorizontal size={15} /></IconButton></div>
                {!closed && <div className="collection-requests">{requests.map(r => <button key={r.id} className={`saved-request ${request.id === r.id ? "selected" : ""}`} onClick={() => openRequest(r)}><span className={`method-label ${r.method.toLowerCase()}`}>{r.method}</span><span className="request-name">{r.name}</span></button>)}{!c.requests.length && <button className="empty-collection" onClick={() => { const tab = newRequest({ collectionId: c.id }); openRequest(tab); }}>+ Add your first request</button>}</div>}
              </div>;
            })}
            {!workspace.collections.length && <div className="sidebar-empty"><Folder size={24} /><p>A home for your requests</p><span>Create a collection to keep related APIs together.</span><button className="subtle-button" onClick={() => { setDialogName(""); setDialog("new-collection"); }}>Create collection <Plus size={13} /></button></div>}
            <button className="new-collection" onClick={() => { setDialogName(""); setDialog("new-collection"); }}><Plus size={13} /> New collection</button>
          </> : <>
            <div className="history-heading">RECENT REQUESTS <span>{workspace.history.length}</span></div>
            {workspace.history.filter(h => `${h.request.name} ${h.request.url} ${h.request.method}`.toLowerCase().includes(filter.toLowerCase())).map(h => <button className="history-item" key={h.id} onClick={() => openRequest(h.request, true)}><div><span className={`method-label ${h.request.method.toLowerCase()}`}>{h.request.method}</span><span className={h.status && h.status < 400 ? "history-status ok" : "history-status"}>{h.status ?? "Error"}</span></div><span>{h.request.name === "Untitled request" ? displayUrl(h.request.url) : h.request.name}</span><small>{new Date(h.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {h.timeMs} ms</small></button>)}
            {!workspace.history.length && <div className="sidebar-empty"><Clock3 size={25} /><p>Your next request starts here</p><span>Requests you send will appear in this history.</span></div>}
          </>}
        </div>
        <div className="sidebar-bottom"><span className="mini-symbol"><Zap size={13} /></span><div><strong>Your APIs. Your workspace.</strong><span>Saved locally on this device.</span></div></div>
      </aside>

      <main className="main-workspace">
        <div className="tab-bar"><div className="request-tabs" role="tablist" aria-label="Request tabs">{workspace.tabs.map(t => <div role="tab" aria-selected={t.id === request.id} tabIndex={0} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setWorkspace(ws => ({ ...ws, activeId: t.id })); }} onClick={() => setWorkspace(ws => ({ ...ws, activeId: t.id }))} className={`request-tab ${t.id === request.id ? "active" : ""}`} key={t.id}><span className={`method-label ${t.method.toLowerCase()}`}>{t.method}</span><span>{t.name}</span>{runs[t.id]?.loading ? <Loader2 size={12} className="spin" /> : t.id === request.id && dirty ? <span className="unsaved-dot" title="Changes not saved to a collection" /> : null}<button className="close-tab" aria-label={`Close ${t.name}`} onClick={e => { e.stopPropagation(); closeTab(t.id); }}><X size={12} /></button></div>)}</div><IconButton label="New request" onClick={addTab}><Plus size={17} /></IconButton><div className="environment-picker"><Globe2 size={14} /><select aria-label="Active environment" value={workspace.activeEnvironmentId} onChange={e => setWorkspace(ws => ({ ...ws, activeEnvironmentId: e.target.value }))}><option value="">No environment</option>{workspace.environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><IconButton label="Edit environment" onClick={openEnvironment}><Variable size={15} /></IconButton></div></div>

        {(startupError || persistError) && <div className="error-banner" role="alert">{startupError || `Could not save workspace: ${persistError}`}</div>}
        <div className="request-heading"><div className="request-breadcrumb"><Folder size={14} /><span>{collection?.name ?? "Unsaved requests"}</span><ChevronRight size={13} /><input aria-label="Request name" value={request.name} onChange={e => updateRequest({ name: e.target.value })} /></div><div className="button-row"><button className="subtle-button" onClick={() => setDialog("code")}><Code2 size={14} /> Code</button><button className={`save-button ${dirty ? "has-changes" : ""}`} onClick={beginSave}><Save size={14} /> Save <kbd>Ctrl S</kbd></button></div></div>

        <section className="request-composer" aria-label="Request editor">
          <div className="url-row"><div className="url-input-group"><select aria-label="HTTP method" className={`method-select ${request.method.toLowerCase()}`} value={request.method} onChange={e => updateRequest({ method: e.target.value as Request["method"] })}>{methods.map(m => <option key={m}>{m}</option>)}</select><div className="url-divider" /><input aria-label="Request URL" placeholder="Enter a URL or paste an endpoint" spellCheck={false} value={request.url} onChange={e => updateRequest({ url: e.target.value })} onKeyDown={e => { if (e.key === "Enter") void send(); }} /><span className="url-environment" title="Use {{variable}} to reference your environment"><Braces size={15} /></span></div>{run.loading ? <button className="send-button cancel" onClick={() => void cancelRequest(request.id).catch(e => notify(String(e)))}><Loader2 size={15} className="spin" /> Cancel</button> : <button className="send-button" disabled={!ready || !request.url.trim()} onClick={() => void send()}><span>Send</span><ArrowRight size={16} /><span className="send-shortcut">⌘ ↵</span></button>}</div>
          <div className="request-panel-tabs" role="tablist" aria-label="Request sections">{panelNames.map(name => <button key={name} role="tab" aria-selected={requestPanel === name} className={requestPanel === name ? "active" : ""} onClick={() => name === "Settings" ? setDialog("settings") : setRequestPanel(name)}>{name}{name === "Params" && activePairs(request.params) > 0 && <span className="tab-count">{activePairs(request.params)}</span>}{name === "Headers" && activePairs(request.headers) > 0 && <span className="tab-count">{activePairs(request.headers)}</span>}{name === "Authorization" && request.auth.kind !== "none" && <span className="tiny-dot" />}{name === "Body" && request.bodyMode !== "none" && <span className="tiny-dot" />}</button>)}</div>
          <div className="request-panel">
            {requestPanel === "Params" && <><div className="panel-title"><span>Query parameters</span><span className="muted">Added to your URL when you send</span></div><PairEditor rows={request.params} onChange={params => updateRequest({ params })} /></>}
            {requestPanel === "Headers" && <><div className="panel-title"><span>Request headers</span><span className="muted">Content-Type is automatic for JSON</span></div><PairEditor rows={request.headers} onChange={headers => updateRequest({ headers })} kind="Header" /></>}
            {requestPanel === "Authorization" && <div className="auth-panel"><div className="auth-type"><label htmlFor="auth-type">Authorization type</label><select id="auth-type" value={request.auth.kind} onChange={e => updateRequest({ auth: { ...request.auth, kind: e.target.value as Request["auth"]["kind"] } })}><option value="none">No authentication</option><option value="bearer">Bearer token</option><option value="basic">Basic authentication</option></select><p>Credentials are included only when this request is sent.</p></div><div className="auth-fields">{request.auth.kind === "none" ? <div className="auth-empty"><ShieldCheck size={25} /><p>This request does not use authentication.</p></div> : request.auth.kind === "bearer" ? <label className="field">Token<input type="password" autoComplete="off" placeholder="Token or {{access_token}}" value={request.auth.token} onChange={e => updateRequest({ auth: { ...request.auth, token: e.target.value } })} /><span className="field-hint">Relay adds the Bearer prefix automatically.</span></label> : <><label className="field">Username<input autoComplete="off" value={request.auth.username} onChange={e => updateRequest({ auth: { ...request.auth, username: e.target.value } })} /></label><label className="field">Password<input type="password" autoComplete="off" value={request.auth.password} onChange={e => updateRequest({ auth: { ...request.auth, password: e.target.value } })} /></label></>}</div></div>}
            {requestPanel === "Body" && <div className="body-panel"><div className="body-toolbar"><div className="body-modes">{(["none", "json", "text"] as const).map(mode => <label key={mode}><input type="radio" name="body-mode" checked={request.bodyMode === mode} onChange={() => updateRequest({ bodyMode: mode })} />{mode === "json" ? "JSON" : mode === "text" ? "Raw text" : "None"}</label>)}</div>{request.bodyMode === "json" && <button className="subtle-button" onClick={() => { try { updateRequest({ body: JSON.stringify(JSON.parse(request.body), null, 2) }); } catch { notify("Enter valid JSON to format the body."); } }}><Braces size={13} /> Format</button>}</div>{request.bodyMode === "none" ? <div className="body-empty">This request has no body.</div> : <textarea className="body-editor" aria-label="Request body" placeholder={request.bodyMode === "json" ? '{\n  "hello": "world"\n}' : "Enter request body"} spellCheck={false} value={request.body} onChange={e => updateRequest({ body: e.target.value })} />}</div>}
          </div>
        </section>

        <section className="response-section" aria-label="Response">
          <div className="response-heading"><div className="response-title"><span className="response-live-dot" />Response{run.loading && <span className="muted">Sending request…</span>}</div>{response && <div className="response-metrics"><span className={`status-badge ${response.status >= 400 ? "bad" : ""}`}><span />{response.status} {response.statusText}</span><span><Clock3 size={12} />{response.timeMs} ms</span><span><ArrowDownToLine size={12} />{formatSize(response.size)}</span><IconButton label="Download response" onClick={() => download(response.binary ? "response.hex.txt" : "response.txt", response.body, "text/plain")}><Download size={14} /></IconButton></div>}</div>
          {response && <><div className="response-toolbar"><div className="response-panel-tabs" role="tablist" aria-label="Response sections">{(["Body", "Headers", "Cookies"] as const).map(name => <button role="tab" aria-selected={responsePanel === name} key={name} className={responsePanel === name ? "active" : ""} onClick={() => setResponsePanel(name)}>{name}{name === "Headers" && <span>{response.headers.length}</span>}{name === "Cookies" && cookies.length > 0 && <span>{cookies.length}</span>}</button>)}</div><div className="button-row">{responsePanel === "Body" && <><div className="segmented-control">{(["Pretty", "Raw"] as const).map(mode => <button key={mode} className={bodyView === mode ? "active" : ""} onClick={() => setBodyView(mode)}>{mode}</button>)}</div><span className="content-type-label">{response.binary ? "HEX" : (() => { try { JSON.parse(response.body); return "JSON"; } catch { return "TEXT"; } })()}</span><CopyButton text={responseBody} label="Copy response" onError={notify} /></>}</div></div>{response.truncated && <div className="warning-banner">Response capped at 10 MiB. The captured body is incomplete.</div>}{response.binary && <div className="warning-banner">Binary response. Showing a hex preview of the first 4096 bytes.</div>}
          {responsePanel === "Body" ? <><div className="response-find"><Search size={12} /><input aria-label="Find in response" placeholder="Find in response" value={responseSearch} onChange={e => setResponseSearch(e.target.value)} />{responseSearch && <span>{responseBody.split("\n").filter(line => line.toLowerCase().includes(responseSearch.toLowerCase())).length} matching lines</span>}</div><CodeViewer text={responseBody || "(empty response body)"} search={responseSearch} /></> : responsePanel === "Headers" ? <div className="response-table"><div className="response-table-head"><span>HEADER</span><span>VALUE</span></div>{response.headers.map(([name, value], index) => <div key={index}><span>{name}</span><span>{value}</span></div>)}</div> : cookies.length ? <div className="response-table">{cookies.map(([, value], i) => <div key={i}><span>Set-Cookie</span><span>{value}</span></div>)}</div> : <div className="small-empty"><ShieldCheck size={25} /><p>This response did not set cookies.</p><span>The session cookie jar automatically sends matching cookies on later requests.</span></div>}</>}
          {!response && <div className="response-empty">{run.loading ? <><div className="empty-orbit loading"><Loader2 size={27} className="spin" /></div><h3>Making the connection</h3><p>Waiting for your API to respond.</p><button className="subtle-button" onClick={() => void cancelRequest(request.id).catch(e => notify(String(e)))}>Cancel request</button></> : run.error ? <><div className="empty-orbit error"><Radio size={25} /></div><h3>Something interrupted the request</h3><p className="request-error" role="alert">{run.error}</p><button className="subtle-button" onClick={() => void send()}>Try again <ArrowRight size={13} /></button></> : <><div className="empty-orbit"><Send size={27} strokeWidth={1.5} /><span className="orbit-dot dot-one" /><span className="orbit-dot dot-two" /></div><h3>Ready when you are.</h3><p>Send a request and see what comes back.</p><div className="empty-hint"><kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd><span>to send your request</span></div><div className="playground-hint"><span><Zap size={13} /></span><p>Try the <strong>Getting started</strong> collection.<br />A local API is ready for you to explore.</p></div></>}</div>}
        </section>
      </main>
    </div>

    <footer className="status-bar"><span className="footer-brand"><Activity size={12} />All systems local</span><span className="footer-divider" /><span>{isDesktop() ? "Rust HTTP engine" : "Browser preview · open the desktop app to send"}</span><div className="header-spacer" /><span className={persistError ? "footer-error" : ""}>{!ready ? startupError ? "Workspace unavailable" : "Opening workspace…" : saving ? "Saving…" : persistError ? "Save failed" : <><CheckCircle2 size={11} /> Workspace saved</>}</span><button onClick={() => setDialog("help")}><Command size={11} />Shortcuts</button><span className="version-tag">RELAY 0.1.0</span></footer>
    {notice && <div className="toast" role="status"><Check size={15} />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={13} /></button></div>}

    {dialog === "save" && <Modal title="Save request" subtitle="Keep this request in a collection for next time." onClose={closeDialog}><label className="field">Request name<input value={dialogName} onChange={e => setDialogName(e.target.value)} placeholder="e.g. Get all users" onKeyDown={e => { if (e.key === "Enter") commitSave(); }} /></label><label className="field">Collection<select value={selectedCollection} onChange={e => setSelectedCollection(e.target.value)}><option value="" disabled>Select a collection</option>{workspace.collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{!workspace.collections.length && <button className="subtle-button" onClick={() => { setDialogName(""); setDialog("new-collection"); }}>Create a collection first <Plus size={13} /></button>}<div className="modal-actions"><button className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" disabled={!dialogName.trim() || !selectedCollection} onClick={commitSave}><Save size={14} />Save request</button></div></Modal>}
    {dialog === "new-collection" && <Modal title="New collection" subtitle="Give your related requests a place to live." onClose={closeDialog}><label className="field">Collection name<input placeholder="e.g. My API" value={dialogName} onChange={e => setDialogName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") createCollection(); }} /></label><div className="modal-actions"><button className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" disabled={!dialogName.trim()} onClick={createCollection}><Plus size={14} />Create collection</button></div></Modal>}
    {dialog === "collection" && editingCollection && <Modal title="Manage collection" onClose={closeDialog}><label className="field">Name<input value={dialogName} onChange={e => setDialogName(e.target.value)} /></label><div className="collection-management"><button className="secondary-button" onClick={() => { download(`${editingCollection.name.replace(/[^a-z0-9]/gi, "-")}.postman_collection.json`, JSON.stringify(exportCollection(editingCollection), null, 2)); notify("Collection exported"); }}><Download size={14} />Export Postman collection</button><p className="field-hint">Exports include saved request bodies, headers, and authentication values.</p><button className="danger-button" onClick={() => { setWorkspace(ws => ({ ...ws, collections: ws.collections.filter(c => c.id !== editingCollection.id), tabs: ws.tabs.map(t => t.collectionId === editingCollection.id ? { ...t, collectionId: undefined } : t) })); closeDialog(); notify("Collection removed. Open request tabs were kept."); }}><Trash2 size={14} />Delete collection</button></div><div className="modal-actions"><button className="secondary-button" onClick={closeDialog}>Close</button><button className="primary-button" disabled={!dialogName.trim()} onClick={() => { setWorkspace(ws => ({ ...ws, collections: ws.collections.map(c => c.id === editingCollection.id ? { ...c, name: dialogName.trim() } : c) })); closeDialog(); }}>Save name</button></div></Modal>}
    {dialog === "import" && <Modal title="Import collection" subtitle="Bring your Postman v2 or v2.1 collections into Relay." wide onClose={closeDialog}><label className="file-upload"><Upload size={21} /><span>Choose a JSON collection file</span><small>or paste its contents below · up to 5 MiB</small><input type="file" accept=".json,application/json" aria-label="Collection file" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) { setImportError("Choose a file smaller than 5 MiB."); return; } setImportText(await file.text()); setImportError(""); }} /></label><textarea aria-label="Collection JSON" className="import-editor" placeholder={'{ "info": { "name": "My collection" }, "item": [...] }'} value={importText} onChange={e => setImportText(e.target.value)} spellCheck={false} />{importError && <p role="alert" className="form-error">{importError}</p>}<div className="modal-actions"><button className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" disabled={!importText.trim()} onClick={performImport}><Upload size={14} />Import collection</button></div></Modal>}
    {dialog === "environment" && editingEnvironment && <Modal title="Environment variables" subtitle="Use {{variable_name}} in URLs, headers, bodies, and authentication." wide onClose={closeDialog}><div className="environment-modal-heading"><select aria-label="Edit saved environment" value={workspace.environments.some(e => e.id === editingEnvironment.id) ? editingEnvironment.id : "new"} onChange={e => setEditingEnvironment(structuredClone(workspace.environments.find(env => env.id === e.target.value)!))}>{workspace.environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}{!workspace.environments.some(e => e.id === editingEnvironment.id) && <option value="new">New environment</option>}</select><button className="secondary-button" onClick={() => setEditingEnvironment({ id: uid(), name: "New environment", variables: [] })}><Plus size={14} />New</button></div><label className="field">Environment name<input value={editingEnvironment.name} onChange={e => setEditingEnvironment({ ...editingEnvironment, name: e.target.value })} /></label><PairEditor rows={editingEnvironment.variables} onChange={variables => setEditingEnvironment({ ...editingEnvironment, variables })} kind="Variable" /><p className="field-hint">The local playground's base_url is refreshed each time Relay starts. Saved values are stored as plain text on this device.</p><div className="modal-actions">{editingEnvironment.id !== "local" && workspace.environments.some(e => e.id === editingEnvironment.id) && <button className="danger-button" onClick={() => { setWorkspace(ws => ({ ...ws, environments: ws.environments.filter(e => e.id !== editingEnvironment.id), activeEnvironmentId: ws.activeEnvironmentId === editingEnvironment.id ? "local" : ws.activeEnvironmentId })); closeDialog(); }}>Delete</button>}<button className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" disabled={!editingEnvironment.name.trim()} onClick={() => { setWorkspace(ws => ({ ...ws, activeEnvironmentId: editingEnvironment.id, environments: ws.environments.some(e => e.id === editingEnvironment.id) ? ws.environments.map(e => e.id === editingEnvironment.id ? editingEnvironment : e) : [...ws.environments, editingEnvironment] })); closeDialog(); notify("Environment saved"); }}>Save environment</button></div></Modal>}
    {dialog === "settings" && <Modal title="Workspace settings" subtitle="These settings apply to all requests in this workspace." onClose={closeDialog}><div className="setting-row"><div><strong>Request timeout</strong><p>100–600,000 milliseconds</p></div><input type="number" aria-label="Request timeout" min={100} max={600000} value={workspace.settings.timeoutMs} onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value)) setWorkspace(ws => ({ ...ws, settings: { ...ws.settings, timeoutMs: value } })); }} /></div><label className="setting-row"><div><strong>Follow redirects</strong><p>Follow up to 10 HTTP redirects.</p></div><input type="checkbox" checked={workspace.settings.followRedirects} onChange={e => setWorkspace(ws => ({ ...ws, settings: { ...ws.settings, followRedirects: e.target.checked } }))} /></label><label className="setting-row"><div><strong>Verify SSL certificates</strong><p>Disable only for a trusted local test server.</p></div><input type="checkbox" checked={workspace.settings.verifyTls} onChange={e => setWorkspace(ws => ({ ...ws, settings: { ...ws.settings, verifyTls: e.target.checked } }))} /></label><div className="setting-row"><div><strong>Appearance</strong><p>Choose your workspace theme.</p></div><select aria-label="Theme" value={workspace.settings.theme} onChange={e => setWorkspace(ws => ({ ...ws, settings: { ...ws.settings, theme: e.target.value as "dark" | "light" } }))}><option value="dark">Dark</option><option value="light">Light</option></select></div><div className="storage-note"><ShieldCheck size={18} /><p>Workspace data stays on this computer. Request credentials are stored in plain text. Use variables for reusable values and take care when exporting collections.</p></div><div className="modal-actions"><button className="subtle-button" onClick={() => setWorkspace(ws => ({ ...ws, settings: { ...defaults } }))}>Reset settings</button><button className="primary-button" onClick={closeDialog}>Done</button></div></Modal>}
    {dialog === "code" && <Modal title="Request as code" subtitle="cURL · POSIX shell syntax (bash, zsh, or Git Bash)" wide onClose={closeDialog}><pre className="curl-code">{code}</pre><div className="modal-actions"><CopyButton text={code} label="Copy cURL" onError={notify} /><button className="primary-button" onClick={closeDialog}>Done</button></div></Modal>}
    {dialog === "help" && <Modal title="Make yourself at home." subtitle="Relay is your local desktop workspace for exploring HTTP APIs." onClose={closeDialog}><div className="shortcuts-list"><div><span>Send request</span><kbd>Ctrl + Enter</kbd></div><div><span>Save request to collection</span><kbd>Ctrl + S</kbd></div><div><span>Open a new request tab</span><kbd>Ctrl + T</kbd></div><div><span>Find a saved request</span><kbd>Ctrl + K</kbd></div></div><div className="help-note"><Terminal size={19} /><div><strong>A playground, built in.</strong><p>Try /users, /echo, /health, /status/404, or /delay/3 using the local environment. The demo API runs on loopback only.</p></div></div><p className="field-hint">This release supports HTTP/HTTPS, raw JSON/text bodies, bearer/basic auth, and Postman collection import/export. OAuth flows, multipart uploads, scripting, WebSocket, and cloud sync are not included.</p><div className="modal-actions"><button className="primary-button" onClick={closeDialog}>Let's go <ArrowRight size={14} /></button></div></Modal>}
  </div>;
}

export default App;
