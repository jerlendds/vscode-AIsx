import * as vscode from 'vscode';
import { getSessions } from './historyProvider';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aisx.sessions';
    private _view?: vscode.WebviewView;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(
            (msg: { type: string; sessionId?: string; locator?: string; source?: string }) => {
                if (msg.type === 'ready' || msg.type === 'refresh') {
                    this._loadSessions();
                } else if (msg.type === 'openSession' && msg.sessionId && msg.locator && msg.source) {
                    vscode.commands.executeCommand(
                        'aisx.openSession',
                        msg.sessionId,
                        msg.locator,
                        msg.source,
                    );
                }
            },
        );
    }

    public refresh() {
        this._loadSessions();
    }

    private _loadSessions() {
        if (!this._view) return;
        this._view.webview.postMessage({ type: 'loading' });
        try {
            const result = getSessions();
            this._view.webview.postMessage({
                type: 'sessions',
                sessions: result.sessions || [],
                error: result.error,
            });
        } catch (e) {
            this._view.webview.postMessage({ type: 'sessions', sessions: [], error: String(e) });
        }
    }

    private _getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<title>AI Session Xplorer</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);height:100vh;display:flex;flex-direction:column;overflow:hidden}
.toolbar{padding:8px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--vscode-sideBar-border,var(--vscode-widget-border,#333));flex-shrink:0}
.search-input{width:100%;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;font-size:12px;font-family:var(--vscode-font-family);outline:none}
.search-input:focus{border-color:var(--vscode-focusBorder)}
.search-input::placeholder{color:var(--vscode-input-placeholderForeground)}
.filter-row{display:flex;gap:4px}
.filter-btn{flex:1;padding:3px 4px;font-size:10px;font-family:var(--vscode-font-family);background:var(--vscode-button-secondaryBackground,var(--vscode-editor-background,#1e1e1e));color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));border:1px solid var(--vscode-widget-border,#555);border-radius:2px;cursor:pointer;text-transform:uppercase;letter-spacing:.05em}
.filter-btn:hover{background:var(--vscode-list-hoverBackground)}
.filter-btn.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-background)}
.session-list{flex:1;overflow-y:auto;overflow-x:hidden}
.session-list::-webkit-scrollbar{width:6px}
.session-list::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}
.session-list::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}
.session-item{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--vscode-list-inactiveSelectionBackground,transparent);display:flex;flex-direction:column;gap:3px}
.session-item:hover{background:var(--vscode-list-hoverBackground)}
.session-item:active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.session-meta{display:flex;align-items:center;gap:5px}
.badge{font-size:9px;font-weight:700;padding:1px 5px;border-radius:10px;text-transform:uppercase;letter-spacing:.05em;flex-shrink:0}
.badge.claude{background:#d97706;color:#fff}
.badge.codex{background:#0284c7;color:#fff}
.session-time{font-size:10px;color:var(--vscode-descriptionForeground);flex:1;text-align:right}
.session-count{font-size:9px;color:var(--vscode-descriptionForeground)}
.session-preview{font-size:11px;color:var(--vscode-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4}
.session-project{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.status{padding:16px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px}
.error-msg{color:var(--vscode-errorForeground);padding:12px;font-size:11px;word-break:break-word}
.empty{color:var(--vscode-descriptionForeground);padding:16px;text-align:center;font-size:11px}
</style>
</head>
<body>
<div class="toolbar">
  <input class="search-input" id="search" type="text" placeholder="Search sessions…" />
  <div class="filter-row">
    <button class="filter-btn active" data-filter="all">All</button>
    <button class="filter-btn" data-filter="claude">Claude</button>
    <button class="filter-btn" data-filter="codex">Codex</button>
  </div>
</div>
<div class="session-list" id="list"><div class="status">Loading…</div></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let all = [], filter = 'all', query = '';
const list = document.getElementById('list');
const search = document.getElementById('search');

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    render();
  });
});

search.addEventListener('input', () => { query = search.value.toLowerCase(); render(); });

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff/86400000) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function render() {
  let sessions = all;
  if (filter !== 'all') sessions = sessions.filter(s => s.source === filter);
  if (query) sessions = sessions.filter(s =>
    (s.display||'').toLowerCase().includes(query) ||
    (s.project||'').toLowerCase().includes(query) ||
    (s.id||'').toLowerCase().includes(query)
  );
  if (!sessions.length) { list.innerHTML = '<div class="empty">No sessions found</div>'; return; }
  list.innerHTML = sessions.map(s => \`
    <div class="session-item" data-id="\${esc(s.id)}" data-locator="\${esc(s.locator)}" data-source="\${esc(s.source)}">
      <div class="session-meta">
        <span class="badge \${esc(s.source)}">\${esc(s.source)}</span>
        <span class="session-count">\${s.messageCount||0} msgs</span>
        <span class="session-time">\${esc(timeAgo(s.timestamp))}</span>
      </div>
      <div class="session-preview">\${esc(s.display||'(no preview)')}</div>
      <div class="session-project">\${esc(s.project||'')}</div>
    </div>
  \`).join('');
  list.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => {
      vscode.postMessage({ type:'openSession', sessionId:el.dataset.id, locator:el.dataset.locator, source:el.dataset.source });
    });
  });
}

window.addEventListener('message', ev => {
  const msg = ev.data;
  if (msg.type === 'loading') { list.innerHTML = '<div class="status">Loading…</div>'; }
  else if (msg.type === 'sessions') {
    if (msg.error && !(msg.sessions && msg.sessions.length)) {
      list.innerHTML = '<div class="error-msg">' + esc(msg.error) + '</div>';
    } else { all = msg.sessions||[]; render(); }
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
    return t;
}
