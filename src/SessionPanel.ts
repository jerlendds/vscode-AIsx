import * as vscode from 'vscode';
import { getSessionDetails, getFileHistoryFile, Message } from './historyProvider';

export class SessionPanel {
    public static readonly viewType = 'aisx.session';
    private static readonly _panels = new Map<string, SessionPanel>();

    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];

    public static createOrShow(
        context: vscode.ExtensionContext,
        sessionId: string,
        locator: string,
        source: string,
    ) {
        const key = `${source}:${sessionId}`;
        const existing = SessionPanel._panels.get(key);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            SessionPanel.viewType,
            `AIsx: ${sessionId.substring(0, 8)}…`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri],
            },
        );

        const sp = new SessionPanel(panel, sessionId, locator, source);
        SessionPanel._panels.set(key, sp);
        panel.onDidDispose(() => SessionPanel._panels.delete(key));
    }

    private constructor(
        panel: vscode.WebviewPanel,
        sessionId: string,
        locator: string,
        source: string,
    ) {
        this._panel = panel;
        this._panel.webview.html = loadingHtml();

        try {
            const result = getSessionDetails(sessionId, locator, source);
            if (result.error) {
                this._panel.webview.html = errorHtml(result.error);
            } else {
                this._panel.webview.html = sessionHtml(result.messages || [], sessionId, source);
            }
        } catch (e) {
            this._panel.webview.html = errorHtml(String(e));
        }

        this._panel.webview.onDidReceiveMessage(
            (msg: { type: string; sessionId?: string; backupFileName?: string }) => {
                if (msg.type === 'getFileHistory' && msg.sessionId && msg.backupFileName) {
                    const res = getFileHistoryFile(msg.sessionId, msg.backupFileName);
                    this._panel.webview.postMessage({
                        type: 'fileHistoryResult',
                        backupFileName: msg.backupFileName,
                        ...res,
                    });
                }
            },
            null,
            this._disposables,
        );
    }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
    return t;
}

function loadingHtml(): string {
    return `<!DOCTYPE html><html><body style="background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);padding:32px;text-align:center">Loading session…</body></html>`;
}

function errorHtml(error: string): string {
    return `<!DOCTYPE html><html><body style="background:var(--vscode-editor-background);color:var(--vscode-errorForeground);font-family:var(--vscode-font-family);padding:32px">Error: ${esc(error)}</body></html>`;
}

function sessionHtml(messages: Message[], sessionId: string, source: string): string {
    const nonce = getNonce();
    const messagesJson = JSON.stringify(messages);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net;">
<title>AIsx Session</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:13px;line-height:1.6;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;height:100vh;overflow:hidden}

.topbar{padding:8px 16px;border-bottom:1px solid var(--vscode-widget-border,#333);background:var(--vscode-sideBar-background);flex-shrink:0;display:flex;align-items:center;gap:10px}
.topbar-title{font-size:11px;color:var(--vscode-descriptionForeground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family,monospace)}
.topbar-source{font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;text-transform:uppercase;letter-spacing:.08em;flex-shrink:0}
.topbar-source.claude{background:#d97706;color:#fff}
.topbar-source.codex{background:#0284c7;color:#fff}

.filterbar{padding:5px 16px;border-bottom:1px solid var(--vscode-widget-border,#333);background:var(--vscode-sideBar-background);display:flex;gap:4px;flex-shrink:0}
.fbtn{padding:2px 10px;font-size:10px;font-family:var(--vscode-font-family);background:transparent;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-widget-border,#555);border-radius:3px;cursor:pointer;text-transform:uppercase;letter-spacing:.05em}
.fbtn:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground)}
.fbtn.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-background)}

.feed{flex:1;overflow-y:auto;padding:0}
.feed::-webkit-scrollbar{width:8px}
.feed::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:4px}
.feed::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}

.msg{padding:14px 20px;border-bottom:1px solid var(--vscode-widget-border,#1e1e1e)}
.msg.hidden{display:none}
.msg-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.role-badge{font-size:9px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.08em;flex-shrink:0}
.role-badge.user{background:#d97706;color:#fff}
.role-badge.assistant{background:#0891b2;color:#fff}
.msg-time{font-size:10px;color:var(--vscode-descriptionForeground)}

/* Markdown */
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{color:var(--vscode-editor-foreground);margin:10px 0 5px;font-weight:600}
.md h1{font-size:1.35em}.md h2{font-size:1.18em}.md h3{font-size:1.04em}
.md p{margin:5px 0}
.md ul,.md ol{padding-left:20px;margin:5px 0}
.md li{margin:2px 0}
.md code{font-family:var(--vscode-editor-font-family,'Courier New',monospace);font-size:12px;background:var(--vscode-textCodeBlock-background,#1e1e1e);padding:1px 5px;border-radius:3px;color:var(--vscode-textPreformat-foreground,#ce9178)}
.md pre{background:var(--vscode-textCodeBlock-background,#1e1e1e);border:1px solid var(--vscode-widget-border,#333);border-radius:4px;padding:12px;overflow-x:auto;margin:8px 0}
.md pre code{background:transparent;padding:0;color:inherit;font-size:12px}
.md blockquote{border-left:3px solid var(--vscode-button-background,#0891b2);padding-left:12px;color:var(--vscode-descriptionForeground);margin:8px 0}
.md a{color:var(--vscode-textLink-foreground,#4ec9b0)}
.md table{border-collapse:collapse;width:100%;margin:8px 0}
.md th,.md td{padding:5px 10px;border:1px solid var(--vscode-widget-border,#333);text-align:left}
.md th{background:var(--vscode-sideBar-background);font-weight:600}
.md hr{border:none;border-top:1px solid var(--vscode-widget-border,#333);margin:12px 0}

/* Tool blocks */
.tool{border:1px solid var(--vscode-widget-border,#333);border-radius:4px;margin:4px 0}
.tool-head{padding:5px 10px;background:var(--vscode-sideBar-background);display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.tool-head:hover{background:var(--vscode-list-hoverBackground)}
.tool-icon{font-size:10px;color:#22c55e;font-weight:700}
.tool-name{font-size:11px;font-weight:600;color:#22c55e;font-family:var(--vscode-editor-font-family,monospace)}
.tool-cmd{font-size:11px;color:var(--vscode-descriptionForeground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family,monospace)}
.chevron{font-size:9px;color:var(--vscode-descriptionForeground);transition:transform .15s;flex-shrink:0}
.chevron.open{transform:rotate(90deg)}
.tool-body{padding:0 10px;background:var(--vscode-textCodeBlock-background,#1e1e1e);max-height:0;overflow:hidden;border-top:0 solid var(--vscode-widget-border,#333);transition:max-height .2s ease,padding .2s ease,border-top-width .2s ease}
.tool-body.open{padding:10px;max-height:36rem;overflow-y:auto;border-top:1px solid var(--vscode-widget-border,#333)}
.tool-body pre{font-family:var(--vscode-editor-font-family,monospace);font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--vscode-editor-foreground);line-height:1.5}

/* Tool result blocks */
.result{border:1px solid var(--vscode-widget-border,#333);border-radius:4px;margin:4px 0}
.result.error{border-color:#ef444444}
.result-head{padding:5px 10px;background:var(--vscode-sideBar-background);display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.result-head:hover{background:var(--vscode-list-hoverBackground)}
.result.error .result-head{background:#ef444418}
.result-icon{font-size:10px;font-weight:700;color:#60a5fa}
.result.error .result-icon{color:#ef4444}
.result-label{font-size:11px;font-weight:600;color:#60a5fa;font-family:var(--vscode-editor-font-family,monospace)}
.result.error .result-label{color:#ef4444}
.result-id{font-size:10px;color:var(--vscode-descriptionForeground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family,monospace)}
.result-body{padding:0 10px;background:var(--vscode-textCodeBlock-background,#1e1e1e);max-height:0;overflow:hidden;border-top:0 solid var(--vscode-widget-border,#333);transition:max-height .2s ease,padding .2s ease,border-top-width .2s ease}
.result-body.open{padding:10px;max-height:36rem;overflow-y:auto;border-top:1px solid var(--vscode-widget-border,#333)}
.result-body pre{font-family:var(--vscode-editor-font-family,monospace);font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--vscode-editor-foreground);line-height:1.5}

/* Snapshot blocks */
.snap{border:1px solid #7c3aed44;border-radius:4px;margin:4px 0}
.snap-head{padding:5px 10px;background:#7c3aed18;display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.snap-head:hover{background:#7c3aed28}
.snap-icon{font-size:10px;color:#a78bfa;font-weight:700}
.snap-title{font-size:11px;font-weight:600;color:#a78bfa}
.snap-body{padding:0 10px;background:var(--vscode-textCodeBlock-background,#1e1e1e);max-height:0;overflow:hidden;border-top:0 solid #7c3aed44;transition:max-height .2s ease,padding .2s ease,border-top-width .2s ease}
.snap-body.open{padding:10px;max-height:36rem;overflow-y:auto;border-top:1px solid #7c3aed44}
.snap-file{margin:4px 0;border:1px solid var(--vscode-widget-border,#333);border-radius:3px;overflow:hidden}
.snap-file-head{padding:4px 8px;background:var(--vscode-sideBar-background);font-family:var(--vscode-editor-font-family,monospace);font-size:10px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:6px;cursor:pointer}
.snap-file-head:hover{background:var(--vscode-list-hoverBackground)}
.snap-file-content{display:none;padding:8px;background:var(--vscode-textCodeBlock-background,#1e1e1e);border-top:1px solid var(--vscode-widget-border,#333)}
.snap-file-content.open{display:block}
.snap-file-content pre{font-family:var(--vscode-editor-font-family,monospace);font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--vscode-editor-foreground)}
.load-btn{font-size:10px;padding:2px 7px;background:var(--vscode-button-secondaryBackground,#333);color:var(--vscode-button-secondaryForeground,#ccc);border:1px solid var(--vscode-widget-border,#555);border-radius:2px;cursor:pointer;font-family:var(--vscode-font-family);flex-shrink:0}
.load-btn:hover{background:var(--vscode-button-secondaryHoverBackground,#444)}

.empty-state{text-align:center;color:var(--vscode-descriptionForeground);padding:48px 16px;font-size:13px}
</style>
</head>
<body>
<div class="topbar">
  <span class="topbar-source ${esc(source)}">${esc(source)}</span>
  <span class="topbar-title">${esc(sessionId)}</span>
  <span style="font-size:10px;color:var(--vscode-descriptionForeground)">${esc(messages.length + ' messages')}</span>
</div>
<div class="filterbar">
  <button class="fbtn active" data-f="all">All</button>
  <button class="fbtn" data-f="user">User</button>
  <button class="fbtn" data-f="assistant">Assistant</button>
  <button class="fbtn" data-f="tool">Tool Calls</button>
  <button class="fbtn" data-f="result">Tool Results</button>
  <button class="fbtn" data-f="snap">Snapshots</button>
</div>
<div class="feed" id="feed"></div>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked@11.1.0/marked.min.js"></script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/highlight.min.js"></script>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const SESSION_ID = ${JSON.stringify(sessionId)};
const MESSAGES = ${messagesJson};
const feed = document.getElementById('feed');
let currentFilter = 'all';

// Setup marked with highlight.js
if (typeof marked !== 'undefined' && typeof hljs !== 'undefined') {
  marked.setOptions({
    breaks: true, gfm: true,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, {language: lang}).value; } catch {}
      }
      return hljs.highlightAuto(code).value;
    }
  });
} else if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function md(text) {
  if (!text) return '';
  try { return marked.parse(text); } catch { return '<pre>'+esc(text)+'</pre>'; }
}

function timeStr(ts) {
  if (!ts) return '';
  try { const d=new Date(ts); return isNaN(d)?'':d.toLocaleString(); } catch { return ''; }
}

function uid() { return Math.random().toString(36).slice(2); }

function toggle(id) {
  const el=document.getElementById(id);
  const ch=document.getElementById(id+'-ch');
  if(el){el.classList.toggle('open');if(ch)ch.classList.toggle('open');}
}

const loadedFiles=new Set(), pending=new Map();

function loadFile(fid, sid, fname) {
  if(loadedFiles.has(fname))return;
  const el=document.getElementById(fid);
  if(el)el.innerHTML='<div style="color:var(--vscode-descriptionForeground);font-size:11px;padding:4px">Loading…</div>';
  pending.set(fname,fid);
  vscode.postMessage({type:'getFileHistory',sessionId:sid,backupFileName:fname});
}

document.addEventListener('click', function(e) {
  const head = e.target.closest('[data-toggle]');
  if (head) { toggle(head.dataset.toggle); return; }
  const btn = e.target.closest('[data-load-fid]');
  if (btn) {
    const fid=btn.dataset.loadFid, sid=btn.dataset.loadSid, fname=btn.dataset.loadFname;
    loadFile(fid, sid, fname);
    const fc=document.getElementById(fid);
    if(fc)fc.classList.add('open');
  }
});

function buildTool(tool) {
  const id=uid();
  const hasPayload=tool.payload&&tool.payload.trim();
  const preview=(tool.command||tool.name||'').substring(0,100);
  return \`<div class="tool">
    <div class="tool-head" data-toggle="\${id}">
      <span class="tool-icon">⚙</span>
      <span class="tool-name">\${esc(tool.name)}</span>
      \${preview?\`<span class="tool-cmd">\${esc(preview)}</span>\`:''}
      \${hasPayload?\`<span class="chevron" id="\${id}-ch">▶</span>\`:''}
    </div>
    \${hasPayload?\`<div class="tool-body" id="\${id}"><pre>\${esc(tool.payload)}</pre></div>\`:''}
  </div>\`;
}

function buildResult(result) {
  const id=uid();
  const hasContent=result.content&&result.content.trim();
  const errClass=result.isError?' error':'';
  const label=result.isError?'Tool Error':'Tool Result';
  const icon=result.isError?'✗':'✓';
  return \`<div class="result\${errClass}">
    <div class="result-head" data-toggle="\${id}">
      <span class="result-icon">\${icon}</span>
      <span class="result-label">\${label}</span>
      \${result.toolUseId?\`<span class="result-id">\${esc(result.toolUseId)}</span>\`:''}
      \${hasContent?\`<span class="chevron" id="\${id}-ch">▶</span>\`:''}
    </div>
    \${hasContent?\`<div class="result-body" id="\${id}"><pre>\${esc(result.content)}</pre></div>\`:''}
  </div>\`;
}

function buildSnap(snap) {
  const id=uid();
  const files=Object.entries(snap.trackedFileBackups||{});
  const filesHtml=files.map(([fp,bf])=>{
    const fid=uid();
    return \`<div class="snap-file">
      <div class="snap-file-head">
        <span>📄</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${esc(fp)}</span>
        <button class="load-btn" data-load-fid="\${fid}" data-load-sid="\${esc(SESSION_ID)}" data-load-fname="\${esc(bf)}">Load</button>
      </div>
      <div class="snap-file-content" id="\${fid}">
        <div style="color:var(--vscode-descriptionForeground);font-size:11px;padding:4px">Click Load to view file contents</div>
      </div>
    </div>\`;
  }).join('');
  return \`<div class="snap">
    <div class="snap-head" data-toggle="\${id}">
      <span class="snap-icon">◈</span>
      <span class="snap-title">File Snapshot (\${files.length} file\${files.length!==1?'s':''})</span>
      <span style="font-size:10px;color:var(--vscode-descriptionForeground);flex:1">\${esc(timeStr(snap.timestamp))}</span>
      <span class="chevron" id="\${id}-ch">▶</span>
    </div>
    <div class="snap-body" id="\${id}">
      \${filesHtml||'<div style="color:var(--vscode-descriptionForeground);font-size:11px">No files tracked</div>'}
    </div>
  </div>\`;
}

function buildMsg(msg, idx) {
  const hasTool=msg.toolUses&&msg.toolUses.length>0;
  const hasResult=msg.toolResults&&msg.toolResults.length>0;
  const hasSnap=msg.fileHistorySnapshots&&msg.fileHistorySnapshots.length>0;
  const filterAttr=hasSnap?'snap':hasTool?'tool':hasResult?'result':msg.role;

  const toolsHtml=hasTool?msg.toolUses.map(buildTool).join(''):'';
  const resultsHtml=hasResult?msg.toolResults.map(buildResult).join(''):'';
  const snapsHtml=hasSnap?msg.fileHistorySnapshots.map(buildSnap).join(''):'';

  return \`<div class="msg" data-f="\${filterAttr}" data-i="\${idx}">
    <div class="msg-header">
      <span class="role-badge \${msg.role}">\${msg.role}</span>
      <span class="msg-time">\${esc(timeStr(msg.timestamp))}</span>
    </div>
    \${msg.content?\`<div class="md">\${md(msg.content)}</div>\`:''}
    \${toolsHtml}
    \${resultsHtml}
    \${snapsHtml}
  </div>\`;
}

function applyFilter() {
  document.querySelectorAll('.msg').forEach(el=>{
    const f=el.dataset.f;
    el.classList.toggle('hidden', currentFilter!=='all' && f!==currentFilter);
  });
}

document.querySelectorAll('.fbtn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter=btn.dataset.f;
    applyFilter();
  });
});

window.addEventListener('message',ev=>{
  const msg=ev.data;
  if(msg.type==='fileHistoryResult'){
    const fid=pending.get(msg.backupFileName);
    if(fid){
      const el=document.getElementById(fid);
      if(el){
        if(msg.error){
          el.innerHTML=\`<div style="color:var(--vscode-errorForeground);font-size:11px;padding:4px">\${esc(msg.error)}</div>\`;
        } else {
          const note=msg.truncated?\`<div style="color:#f59e0b;font-size:10px;margin-bottom:4px">⚠ Truncated (\${msg.originalBytes} bytes total)</div>\`:'';
          el.innerHTML=note+\`<pre>\${esc(msg.content||'')}</pre>\`;
        }
        loadedFiles.add(msg.backupFileName);
        pending.delete(msg.backupFileName);
      }
    }
  }
});

if(!MESSAGES.length){
  feed.innerHTML='<div class="empty-state">No messages in this session</div>';
} else {
  feed.innerHTML=MESSAGES.map((m,i)=>buildMsg(m,i)).join('');
  if(typeof hljs!=='undefined'){
    document.querySelectorAll('pre code').forEach(b=>hljs.highlightElement(b));
  }
}
</script>
</body>
</html>`;
}
