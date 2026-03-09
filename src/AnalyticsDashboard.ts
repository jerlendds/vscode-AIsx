import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import {
    getSessions,
    getSessionDetails,
    Session,
    Message,
    ToolUse,
    ToolResult,
} from './historyProvider';

// ─── Analytics Types ───────────────────────────────────────────────────────

export interface FieldDimension {
    key: string;
    label: string;
    description: string;
}

export interface SessionVector {
    sessionId: string;
    source: string;
    project: string;
    timestamp: number;
    // φ -- behavioral vector (each index corresponds to FIELD_DIMENSIONS)
    phi: number[];
    // ψ -- task state progression
    statesReached: string[];
    finalState: string;
    // ρπ -- intent / program
    intentSequence: string[]; // per-assistant-message: 'acting' | 'introspecting'
    programString: string; // run-length-encoded intent, e.g. "A→I→A→A→I"
    actingCount: number;
    introspectingCount: number;
    actThinkCycles: number;
    // outcome
    outcome: number; // 0–1 heuristic (0=failed, 1=success)
    errorRate: number;
    numErrors: number;
    numResults: number;
}

export interface FieldMetricsResult {
    center: number[];
    variance: number[];
    width: number;
    convergence: number;
    separation: number[];
    skew: number[];
    successK: number;
    failureK: number;
}

export interface HorizonMetrics {
    state: string;
    K: number;
    successK: number;
    width: number;
    convergence: number;
    drift: number;
}

export interface ProgramFamily {
    program: string;
    K: number;
    successK: number;
    avgWidth: number;
    successRate: number;
}

export interface AnalyticsPayload {
    vectors: SessionVector[];
    dimensions: FieldDimension[];
    field: FieldMetricsResult;
    horizons: HorizonMetrics[];
    programFamilies: ProgramFamily[];
    totalSessions: number;
    analyzedSessions: number;
    bySource: Record<string, number>;
    byProject: Array<{ project: string; count: number }>;
    timelineData: Array<{ date: string; count: number }>;
    pythonResult?: Record<string, unknown>;
    pythonError?: string;
    customDimensions?: Array<{ key: string; label: string; values: number[] }>;
}

// ─── Field Dimensions (φ) ──────────────────────────────────────────────────

const FIELD_DIMENSIONS: FieldDimension[] = [
    {
        key: 'num_tool_calls',
        label: 'Tool Calls',
        description: 'Total tool invocations across the session',
    },
    { key: 'num_reads', label: 'Reads', description: 'File read operations (Read, Glob, Grep)' },
    { key: 'num_edits', label: 'Edits', description: 'File edit/write operations (Edit, Write)' },
    { key: 'num_bash', label: 'Bash', description: 'Terminal / shell commands (Bash)' },
    { key: 'num_messages', label: 'Messages', description: 'Total messages in the session' },
    {
        key: 'exploration_ratio',
        label: 'Exploration Ratio',
        description: 'Reads ÷ total tool calls (0=all action, 1=all reading)',
    },
    {
        key: 'commit_speed',
        label: 'Commit Speed',
        description: 'Normalized position of first edit (0=committed early, 1=committed late)',
    },
    {
        key: 'direction_changes',
        label: 'Direction Changes',
        description: 'Read→write mode switches (hesitation signal)',
    },
    {
        key: 'verification_effort',
        label: 'Verification Effort',
        description: 'Bash calls ÷ total tool calls (how much the agent checked its work)',
    },
    {
        key: 'error_rate',
        label: 'Error Rate',
        description: 'Fraction of tool results that reported errors',
    },
];

// ─── Behavioral Measurement (φ) ────────────────────────────────────────────

function measureSession(
    messages: Message[],
    sessionId: string,
    source: string,
    project: string,
    timestamp: number,
): SessionVector {
    // Collect all tool uses and results
    const allToolUses: ToolUse[] = [];
    const allToolResults: ToolResult[] = [];
    const intentSequence: string[] = [];

    for (const msg of messages) {
        allToolUses.push(...msg.toolUses);
        allToolResults.push(...msg.toolResults);

        if (msg.role === 'assistant') {
            const hasTool = msg.toolUses.length > 0;
            const hasText = msg.content && msg.content.trim().length > 0;
            if (hasTool) {
                intentSequence.push('A'); // acting
            } else if (hasText) {
                intentSequence.push('I'); // introspecting
            }
        }
    }

    const n = allToolUses.length || 1;

    // φ dimensions
    const reads = allToolUses.filter((t) => ['Read', 'Glob', 'Grep'].includes(t.name)).length;
    const edits = allToolUses.filter((t) => ['Edit', 'Write', 'MultiEdit'].includes(t.name)).length;
    const bash = allToolUses.filter((t) => t.name === 'Bash').length;

    const explorationRatio = reads / n;

    let firstEditPos = allToolUses.length;
    for (let i = 0; i < allToolUses.length; i++) {
        if (['Edit', 'Write', 'MultiEdit'].includes(allToolUses[i].name)) {
            firstEditPos = i;
            break;
        }
    }
    const commitSpeed = firstEditPos / n;

    let directionChanges = 0;
    let lastType: string | null = null;
    for (const t of allToolUses) {
        const cur = ['Read', 'Glob', 'Grep'].includes(t.name)
            ? 'read'
            : ['Edit', 'Write', 'MultiEdit'].includes(t.name)
              ? 'write'
              : null;
        if (cur && lastType && cur !== lastType) directionChanges++;
        if (cur) lastType = cur;
    }

    const verificationEffort = bash / n;
    const numErrors = allToolResults.filter((r) => r.isError).length;
    const numResults = allToolResults.length;
    const errorRate = numResults > 0 ? numErrors / numResults : 0;

    // ψ state progression
    const statesReached = computeStates(allToolUses);

    // ρπ intent program
    const programString = runLengthEncode(intentSequence);
    const actingCount = intentSequence.filter((i) => i === 'A').length;
    const introspectingCount = intentSequence.filter((i) => i === 'I').length;
    const actThinkCycles = countCycles(intentSequence);

    // Heuristic outcome: 0=failure, 1=success
    // A session that runs many errors relative to total results is likely failing.
    const outcome = errorRate < 0.15 ? 1.0 : errorRate < 0.4 ? 0.5 : 0.0;

    const phi = [
        allToolUses.length, // num_tool_calls
        reads, // num_reads
        edits, // num_edits
        bash, // num_bash
        messages.length, // num_messages
        explorationRatio, // exploration_ratio
        commitSpeed, // commit_speed
        directionChanges, // direction_changes
        verificationEffort, // verification_effort
        errorRate, // error_rate
    ];

    return {
        sessionId,
        source,
        project,
        timestamp,
        phi,
        statesReached,
        finalState: statesReached[statesReached.length - 1] ?? 'start',
        intentSequence,
        programString,
        actingCount,
        introspectingCount,
        actThinkCycles,
        outcome,
        errorRate,
        numErrors,
        numResults,
    };
}

function computeStates(toolUses: ToolUse[]): string[] {
    const states: string[] = ['start'];
    let hasRead = false,
        hasEdit = false,
        hasBash = false;

    for (const t of toolUses) {
        if (['Read', 'Glob', 'Grep'].includes(t.name)) hasRead = true;
        if (['Edit', 'Write', 'MultiEdit'].includes(t.name)) hasEdit = true;
        if (t.name === 'Bash') hasBash = true;
    }

    if (hasRead && !states.includes('exploring')) states.push('exploring');
    if (hasEdit && !states.includes('editing')) states.push('editing');
    if (hasBash && hasEdit && !states.includes('verified')) states.push('verified');

    return states;
}

function runLengthEncode(seq: string[]): string {
    if (!seq.length) return '';
    const parts: string[] = [];
    let cur = seq[0],
        count = 1;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === cur) {
            count++;
        } else {
            parts.push(count > 1 ? `${cur}×${count}` : cur);
            cur = seq[i];
            count = 1;
        }
    }
    parts.push(count > 1 ? `${cur}×${count}` : cur);
    return parts.join('→');
}

function countCycles(seq: string[]): number {
    let cycles = 0,
        inA = false;
    for (const s of seq) {
        if (s === 'A' && !inA) {
            cycles++;
            inA = true;
        } else if (s === 'I') inA = false;
    }
    return cycles;
}

// ─── Field Metrics ──────────────────────────────────────────────────────────

function computeFieldMetrics(vectors: SessionVector[]): FieldMetricsResult {
    const K = vectors.length;
    const d = FIELD_DIMENSIONS.length;

    if (K === 0) {
        return {
            center: [],
            variance: [],
            width: 0,
            convergence: 0,
            separation: [],
            skew: [],
            successK: 0,
            failureK: 0,
        };
    }

    const points = vectors.map((v) => v.phi);
    const outcomes = vectors.map((v) => v.outcome);

    const center: number[] = [];
    const variance: number[] = [];
    for (let j = 0; j < d; j++) {
        const col = points.map((p) => p[j]);
        const mean = col.reduce((a, b) => a + b, 0) / K;
        const vari = col.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(K - 1, 1);
        center.push(mean);
        variance.push(vari);
    }
    const width = variance.reduce((a, b) => a + b, 0);

    const outMean = outcomes.reduce((a, b) => a + b, 0) / K;
    const outStd = Math.sqrt(
        outcomes.reduce((a, b) => a + (b - outMean) ** 2, 0) / Math.max(K - 1, 1),
    );
    const convergence = outStd > 1e-9 ? outMean / outStd : outMean > 0.5 ? Infinity : 0;

    const successes = vectors.filter((v) => v.outcome >= 0.5);
    const failures = vectors.filter((v) => v.outcome < 0.5);

    const separation: number[] = [];
    for (let j = 0; j < d; j++) {
        const sucMean =
            successes.length > 0
                ? successes.reduce((a, v) => a + v.phi[j], 0) / successes.length
                : 0;
        const failMean =
            failures.length > 0 ? failures.reduce((a, v) => a + v.phi[j], 0) / failures.length : 0;
        separation.push(sucMean - failMean);
    }

    const skew: number[] = [];
    for (let j = 0; j < d; j++) {
        skew.push(
            pearsonCorrelation(
                outcomes,
                vectors.map((v) => v.phi[j]),
            ),
        );
    }

    return {
        center,
        variance,
        width,
        convergence,
        separation,
        skew,
        successK: successes.length,
        failureK: failures.length,
    };
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
    const n = xs.length;
    if (n < 2) return 0;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    const dx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
    const dy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
    return dx < 1e-9 || dy < 1e-9 ? 0 : num / (dx * dy);
}

function fieldWidth(vectors: SessionVector[]): number {
    if (vectors.length < 2) return 0;
    const d = FIELD_DIMENSIONS.length;
    let w = 0;
    for (let j = 0; j < d; j++) {
        const col = vectors.map((v) => v.phi[j]);
        const mean = col.reduce((a, b) => a + b, 0) / col.length;
        w += col.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(col.length - 1, 1);
    }
    return w;
}

function fieldConvergence(vectors: SessionVector[]): number {
    const K = vectors.length;
    if (K < 2) return 0;
    const outcomes = vectors.map((v) => v.outcome);
    const mean = outcomes.reduce((a, b) => a + b, 0) / K;
    const std = Math.sqrt(outcomes.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(K - 1, 1));
    return std < 1e-9 ? (mean > 0.5 ? 99 : 0) : mean / std;
}

// ─── Horizon Analysis (ψ) ──────────────────────────────────────────────────

const ALL_STATES = ['start', 'exploring', 'editing', 'verified'];

function computeHorizons(vectors: SessionVector[]): HorizonMetrics[] {
    return ALL_STATES.map((state) => {
        const horizon = vectors.filter((v) => v.statesReached.includes(state));
        const successes = horizon.filter((v) => v.outcome >= 0.5);
        const W_all = fieldWidth(horizon);
        const W_suc = fieldWidth(successes);
        return {
            state,
            K: horizon.length,
            successK: successes.length,
            width: W_all,
            convergence: fieldConvergence(horizon),
            drift: W_all - W_suc,
        };
    });
}

// ─── Program Families (ρπ) ─────────────────────────────────────────────────

function computeProgramFamilies(vectors: SessionVector[]): ProgramFamily[] {
    const familyMap = new Map<string, SessionVector[]>();
    for (const v of vectors) {
        const prog = v.programString || '(empty)';
        if (!familyMap.has(prog)) familyMap.set(prog, []);
        familyMap.get(prog)!.push(v);
    }
    return Array.from(familyMap.entries())
        .map(([program, fvecs]) => ({
            program,
            K: fvecs.length,
            successK: fvecs.filter((v) => v.outcome >= 0.5).length,
            avgWidth: fieldWidth(fvecs),
            successRate: fvecs.filter((v) => v.outcome >= 0.5).length / fvecs.length,
        }))
        .sort((a, b) => b.K - a.K)
        .slice(0, 10);
}

// ─── Python AFT Integration ─────────────────────────────────────────────────

async function runPythonAft(
    vectors: SessionVector[],
    venvPath: string,
): Promise<Record<string, unknown>> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisx-aft-'));
    const dataFile = path.join(tmpDir, 'sessions.json');
    const scriptFile = path.join(tmpDir, 'analyze.py');
    const outputFile = path.join(tmpDir, 'output.json');

    fs.writeFileSync(dataFile, JSON.stringify(vectors, null, 2));

    const pythonScript = `
import json, sys, os, traceback

data_file   = sys.argv[1]
output_file = sys.argv[2]

with open(data_file) as f:
    sessions = json.load(f)

output = {}

try:
    import numpy as np
    import agent_fields as aft

    # Build a field from the session vectors (phi already computed in TypeScript)
    class SessionField(aft.Field):
        def dimensions(self):
            return [
                aft.Dimension("num_tool_calls",      "Total tool invocations"),
                aft.Dimension("num_reads",            "File read operations"),
                aft.Dimension("num_edits",            "File edit operations"),
                aft.Dimension("num_bash",             "Terminal commands"),
                aft.Dimension("num_messages",         "Total messages"),
                aft.Dimension("exploration_ratio",    "Reads / total tool calls"),
                aft.Dimension("commit_speed",         "Normalised position of first edit"),
                aft.Dimension("direction_changes",    "Read-to-write switches"),
                aft.Dimension("verification_effort",  "Bash / total tool calls"),
                aft.Dimension("error_rate",           "Fraction of tool results with errors"),
            ]
        def measure(self, trajectory):
            return np.array(trajectory["phi"], dtype=float)

    field = SessionField()
    for s in sessions:
        field.add(s, outcome=s["outcome"])

    m = field.metrics()
    output["aft_available"]  = True
    output["width"]          = float(m.width())
    output["convergence"]    = float(m.convergence()) if m.convergence() != float("inf") else 1e9
    output["center"]         = [float(x) for x in m.center()]
    output["variance"]       = [float(x) for x in m.variance()]
    output["separation"]     = [float(x) for x in m.separation()]
    output["skew"]           = [float(m.skew(i)) for i in range(len(field.dimensions()))]
    output["K"]              = field.K
    output["success_K"]      = int(np.sum(field.outcomes >= 0.5))

except ImportError as e:
    output["aft_available"] = False
    output["import_error"]  = str(e)
except Exception as e:
    output["error"] = traceback.format_exc()

with open(output_file, "w") as f:
    json.dump(output, f)
`;

    fs.writeFileSync(scriptFile, pythonScript);

    const pythonBin =
        process.platform === 'win32'
            ? path.join(venvPath, 'Scripts', 'python.exe')
            : path.join(venvPath, 'bin', 'python');

    return new Promise((resolve) => {
        const proc = cp.execFile(
            pythonBin,
            [scriptFile, dataFile, outputFile],
            { timeout: 30000 },
            (err, _stdout, stderr) => {
                try {
                    if (fs.existsSync(outputFile)) {
                        const result = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
                        resolve(result);
                    } else {
                        resolve({ error: err?.message ?? stderr ?? 'No output produced' });
                    }
                } catch {
                    resolve({ error: err?.message ?? 'Failed to parse Python output' });
                } finally {
                    try {
                        fs.rmSync(tmpDir, { recursive: true });
                    } catch {}
                }
            },
        );
        proc.on('error', (e) => resolve({ error: e.message }));
    });
}

// ─── Custom Scripts ─────────────────────────────────────────────────────────

interface CustomScript {
    filename: string;
    content: string;
}

function loadCustomScripts(scriptsDir: string): CustomScript[] {
    if (!scriptsDir || !fs.existsSync(scriptsDir)) return [];
    try {
        return fs
            .readdirSync(scriptsDir)
            .filter((f) => f.endsWith('.js'))
            .map((f) => ({
                filename: f,
                content: fs.readFileSync(path.join(scriptsDir, f), 'utf8'),
            }));
    } catch {
        return [];
    }
}

// ─── Analytics Computation ──────────────────────────────────────────────────

function computeTimeline(vectors: SessionVector[]): Array<{ date: string; count: number }> {
    const counts = new Map<string, number>();
    for (const v of vectors) {
        const d = new Date(v.timestamp).toISOString().slice(0, 10);
        counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return Array.from(counts.entries())
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-60); // last 60 days
}

// ─── AnalyticsDashboard Class ──────────────────────────────────────────────

export class AnalyticsDashboard {
    public static readonly viewType = 'aisx.analytics';
    private static _instance: AnalyticsDashboard | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _context: vscode.ExtensionContext;
    private readonly _disposables: vscode.Disposable[] = [];

    public static createOrShow(context: vscode.ExtensionContext) {
        if (AnalyticsDashboard._instance) {
            AnalyticsDashboard._instance._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            AnalyticsDashboard.viewType,
            'AIsx Analytics',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri],
            },
        );

        AnalyticsDashboard._instance = new AnalyticsDashboard(panel, context);
        panel.onDidDispose(() => {
            AnalyticsDashboard._instance = undefined;
        });
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._context = context;
        this._panel.webview.html = getDashboardHtml();

        this._panel.webview.onDidReceiveMessage(
            async (msg: {
                type: string;
                venvPath?: string;
                scriptsPath?: string;
                maxSessions?: number;
            }) => {
                if (msg.type === 'ready' || msg.type === 'refresh') {
                    await this._sendAnalytics();
                } else if (msg.type === 'saveSettings') {
                    const cfg = vscode.workspace.getConfiguration('aisx.analytics');
                    if (msg.venvPath !== undefined)
                        await cfg.update(
                            'pythonVenvPath',
                            msg.venvPath,
                            vscode.ConfigurationTarget.Global,
                        );
                    if (msg.scriptsPath !== undefined)
                        await cfg.update(
                            'customScriptsPath',
                            msg.scriptsPath,
                            vscode.ConfigurationTarget.Global,
                        );
                    if (msg.maxSessions !== undefined)
                        await cfg.update(
                            'maxSessions',
                            msg.maxSessions,
                            vscode.ConfigurationTarget.Global,
                        );
                    await this._sendAnalytics();
                } else if (msg.type === 'testPython') {
                    const result = await this._testPython(msg.venvPath ?? '');
                    this._panel.webview.postMessage({ type: 'pythonTestResult', ...result });
                }
            },
            null,
            this._disposables,
        );
    }

    private async _testPython(venvPath: string): Promise<{ ok: boolean; message: string }> {
        if (!venvPath) return { ok: false, message: 'No venv path provided' };
        const pythonBin =
            process.platform === 'win32'
                ? path.join(venvPath, 'Scripts', 'python.exe')
                : path.join(venvPath, 'bin', 'python');
        if (!fs.existsSync(pythonBin))
            return { ok: false, message: `Python not found at ${pythonBin}` };

        return new Promise((resolve) => {
            cp.execFile(
                pythonBin,
                ['-c', 'import agent_fields; print("agent_fields OK")'],
                { timeout: 10000 },
                (err, stdout, stderr) => {
                    if (err) resolve({ ok: false, message: stderr || err.message });
                    else resolve({ ok: true, message: stdout.trim() });
                },
            );
        });
    }

    private async _sendAnalytics() {
        this._panel.webview.postMessage({ type: 'loading' });

        const cfg = vscode.workspace.getConfiguration('aisx.analytics');
        const venvPath = (cfg.get<string>('pythonVenvPath') ?? '').trim();
        const scriptsPath = (cfg.get<string>('customScriptsPath') ?? '').trim();
        const maxSessions = cfg.get<number>('maxSessions') ?? 50;

        try {
            const { sessions = [] } = getSessions();
            const limited = sessions.slice(0, maxSessions);

            const vectors: SessionVector[] = [];
            for (const sess of limited) {
                try {
                    const detail = getSessionDetails(sess.id, sess.locator, sess.source);
                    if (!detail.error && detail.messages) {
                        vectors.push(
                            measureSession(
                                detail.messages,
                                sess.id,
                                sess.source,
                                sess.project,
                                sess.timestamp,
                            ),
                        );
                    }
                } catch {
                    // skip sessions that fail to load
                }
            }

            const bySource: Record<string, number> = {};
            for (const v of vectors) bySource[v.source] = (bySource[v.source] ?? 0) + 1;

            const projCounts = new Map<string, number>();
            for (const v of vectors)
                projCounts.set(v.project, (projCounts.get(v.project) ?? 0) + 1);
            const byProject = Array.from(projCounts.entries())
                .map(([project, count]) => ({ project, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 10);

            const payload: AnalyticsPayload = {
                vectors,
                dimensions: FIELD_DIMENSIONS,
                field: computeFieldMetrics(vectors),
                horizons: computeHorizons(vectors),
                programFamilies: computeProgramFamilies(vectors),
                totalSessions: sessions?.length ?? 0,
                analyzedSessions: vectors.length,
                bySource,
                byProject,
                timelineData: computeTimeline(vectors),
            };

            // Optional: Python AFT analysis
            if (venvPath && fs.existsSync(venvPath)) {
                try {
                    payload.pythonResult = await runPythonAft(vectors, venvPath);
                } catch (e) {
                    payload.pythonError = String(e);
                }
            }

            // Custom scripts -- load and send to webview for in-browser execution
            const scripts = loadCustomScripts(scriptsPath);

            const settings = { venvPath, scriptsPath, maxSessions };

            this._panel.webview.postMessage({ type: 'analyticsData', payload, scripts, settings });
        } catch (e) {
            this._panel.webview.postMessage({ type: 'analyticsError', error: String(e) });
        }
    }

    dispose() {
        this._disposables.forEach((d) => d.dispose());
    }
}

// ─── HTML ──────────────────────────────────────────────────────────────────

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
    return t;
}

function getDashboardHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'none';">
<title>AIsx Analytics</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --c-bg:var(--vscode-editor-background,#1e1e1e);
  --c-fg:var(--vscode-editor-foreground,#d4d4d4);
  --c-sidebar:var(--vscode-sideBar-background,#252526);
  --c-border:var(--vscode-widget-border,#333);
  --c-desc:var(--vscode-descriptionForeground,#888);
  --c-btn:var(--vscode-button-background,#0e639c);
  --c-btn-fg:var(--vscode-button-foreground,#fff);
  --c-btn-hover:var(--vscode-button-hoverBackground,#1177bb);
  --c-btn2:var(--vscode-button-secondaryBackground,#3a3d41);
  --c-btn2-fg:var(--vscode-button-secondaryForeground,#ccc);
  --c-input-bg:var(--vscode-input-background,#3c3c3c);
  --c-input-fg:var(--vscode-input-foreground,#cccccc);
  --c-input-border:var(--vscode-input-border,#3c3c3c);
  --c-focus:var(--vscode-focusBorder,#007fd4);
  --c-hover:var(--vscode-list-hoverBackground,#2a2d2e);
  --c-active:var(--vscode-list-activeSelectionBackground,#094771);
  --c-code:var(--vscode-textCodeBlock-background,#1e1e1e);
  --c-err:var(--vscode-errorForeground,#f48771);
  --c-warn:var(--vscode-editorWarning-foreground,#cca700);
  --c-ok:#22c55e;
  /* Chart palette -- using VSCode chart vars with fallbacks */
  --chart-blue:var(--vscode-charts-blue,#4fc3f7);
  --chart-green:var(--vscode-charts-green,#81c784);
  --chart-orange:var(--vscode-charts-orange,#ffb74d);
  --chart-red:var(--vscode-charts-red,#e57373);
  --chart-purple:var(--vscode-charts-purple,#ba68c8);
  --chart-yellow:var(--vscode-charts-yellow,#fff176);
}
body{font-family:var(--vscode-font-family,system-ui);font-size:13px;color:var(--c-fg);background:var(--c-bg);height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* ── Top bar ─────────────────────────────────────────────────────── */
.topbar{padding:8px 16px;border-bottom:1px solid var(--c-border);background:var(--c-sidebar);display:flex;align-items:center;gap:10px;flex-shrink:0}
.topbar-title{font-size:14px;font-weight:600;flex:1}
.topbar-subtitle{font-size:11px;color:var(--c-desc)}
.btn{padding:4px 12px;font-size:11px;font-family:var(--vscode-font-family);background:var(--c-btn);color:var(--c-btn-fg);border:none;border-radius:2px;cursor:pointer}
.btn:hover{background:var(--c-btn-hover)}
.btn.secondary{background:var(--c-btn2);color:var(--c-btn2-fg)}
.btn.secondary:hover{background:var(--c-hover)}
.btn.danger{background:#7f1d1d;color:#fca5a5}
.btn.small{padding:2px 8px;font-size:10px}

/* ── Tab nav ─────────────────────────────────────────────────────── */
.tab-nav{display:flex;border-bottom:1px solid var(--c-border);background:var(--c-sidebar);flex-shrink:0;overflow-x:auto}
.tab-nav::-webkit-scrollbar{height:3px}
.tab-nav::-webkit-scrollbar-thumb{background:var(--c-border)}
.tab{padding:8px 16px;font-size:11px;cursor:pointer;border-bottom:2px solid transparent;color:var(--c-desc);white-space:nowrap;user-select:none;text-transform:uppercase;letter-spacing:.06em}
.tab:hover{color:var(--c-fg);background:var(--c-hover)}
.tab.active{color:var(--c-fg);border-bottom-color:var(--c-btn);background:var(--c-bg)}

/* ── Content area ────────────────────────────────────────────────── */
.content{flex:1;overflow-y:auto;padding:20px 24px}
.content::-webkit-scrollbar{width:8px}
.content::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,#555);border-radius:4px}
.tab-pane{display:none}
.tab-pane.active{display:block}

/* ── Cards ──────────────────────────────────────────────────────── */
.card{background:var(--c-sidebar);border:1px solid var(--c-border);border-radius:4px;padding:16px;margin-bottom:16px}
.card-title{font-size:12px;font-weight:600;color:var(--c-desc);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
.card-subtitle{font-size:11px;color:var(--c-desc);margin-bottom:10px}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:var(--c-code);border:1px solid var(--c-border);border-radius:4px;padding:12px}
.kpi-value{font-size:24px;font-weight:700;line-height:1.2}
.kpi-label{font-size:10px;color:var(--c-desc);text-transform:uppercase;letter-spacing:.06em;margin-top:3px}
.kpi .kpi-note{font-size:10px;color:var(--c-desc);margin-top:4px}

/* ── Charts ─────────────────────────────────────────────────────── */
.chart-wrap{position:relative;height:220px;margin-bottom:4px}
.chart-wrap.tall{height:280px}
.chart-wrap.short{height:160px}

/* ── Tables ─────────────────────────────────────────────────────── */
table{width:100%;border-collapse:collapse;font-size:11px}
th{padding:5px 10px;border:1px solid var(--c-border);background:var(--c-code);color:var(--c-desc);text-transform:uppercase;letter-spacing:.05em;font-weight:600;text-align:left}
td{padding:5px 10px;border:1px solid var(--c-border)}
tr:hover td{background:var(--c-hover)}

/* ── Grid ───────────────────────────────────────────────────────── */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:700px){.grid2{grid-template-columns:1fr}}

/* ── Settings form ──────────────────────────────────────────────── */
.form-group{margin-bottom:14px}
.form-label{font-size:11px;color:var(--c-desc);margin-bottom:5px;display:block;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.form-input{width:100%;padding:5px 8px;background:var(--c-input-bg);color:var(--c-input-fg);border:1px solid var(--c-input-border);border-radius:2px;font-size:12px;font-family:var(--vscode-font-family);outline:none}
.form-input:focus{border-color:var(--c-focus)}
.form-desc{font-size:10px;color:var(--c-desc);margin-top:3px}
.form-actions{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
.test-result{font-size:11px;padding:4px 8px;border-radius:2px}
.test-result.ok{background:#14532d;color:#bbf7d0}
.test-result.fail{background:#7f1d1d;color:#fca5a5}

/* ── Interpretation chips ───────────────────────────────────────── */
.chip{display:inline-block;font-size:9px;padding:1px 6px;border-radius:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.chip.good{background:#14532d;color:#86efac}
.chip.bad{background:#7f1d1d;color:#fca5a5}
.chip.neutral{background:#1e3a5f;color:#93c5fd}
.chip.warning{background:#78350f;color:#fcd34d}

/* ── State badges ───────────────────────────────────────────────── */
.state-badge{display:inline-block;font-size:9px;padding:2px 7px;border-radius:10px;font-weight:700;letter-spacing:.04em;margin-right:4px}
.state-start{background:#1f2937;color:#9ca3af}
.state-exploring{background:#1e3a5f;color:#93c5fd}
.state-editing{background:#422006;color:#fdba74}
.state-verified{background:#14532d;color:#86efac}

/* ── Metric explanation panels ──────────────────────────────────── */
.explain{font-size:11px;color:var(--c-desc);background:var(--c-code);border-left:3px solid var(--c-btn);padding:8px 12px;border-radius:0 4px 4px 0;margin-bottom:12px}
.explain strong{color:var(--c-fg)}

/* ── Loading / error ────────────────────────────────────────────── */
.loading-overlay{display:flex;align-items:center;justify-content:center;height:200px;flex-direction:column;gap:12px}
.spinner{width:28px;height:28px;border:3px solid var(--c-border);border-top-color:var(--c-btn);border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.error-box{background:#7f1d1d22;border:1px solid #7f1d1d;color:var(--c-err);padding:12px;border-radius:4px;font-size:11px;word-break:break-word}

/* ── Section headers ────────────────────────────────────────────── */
.section-header{display:flex;align-items:center;gap:8px;margin:20px 0 12px}
.section-header h2{font-size:13px;font-weight:600}
.section-divider{flex:1;height:1px;background:var(--c-border)}

/* ── Python badge ───────────────────────────────────────────────── */
.python-badge{font-size:9px;padding:2px 7px;border-radius:10px;font-weight:700;background:#1a3a4a;color:#67e8f9;letter-spacing:.05em}
.custom-badge{font-size:9px;padding:2px 7px;border-radius:10px;font-weight:700;background:#2d1b4a;color:#d8b4fe;letter-spacing:.05em}
</style>
</head>
<body>

<div class="topbar">
  <span class="topbar-title">AIsx Analytics</span>
  <span class="topbar-subtitle" id="topbar-subtitle">Loading…</span>
  <button class="btn secondary small" id="btn-refresh">↻ Refresh</button>
</div>

<div class="tab-nav">
  <div class="tab active" data-tab="overview">Overview</div>
  <div class="tab" data-tab="field">Field Metrics φ</div>
  <div class="tab" data-tab="separation">Separation &amp; Skew</div>
  <div class="tab" data-tab="horizon">Horizons ψ</div>
  <div class="tab" data-tab="intent">Intent ρπ</div>
  <div class="tab" data-tab="custom">Custom Scripts</div>
  <div class="tab" data-tab="settings">Settings</div>
</div>

<div class="content">
  <!-- OVERVIEW -->
  <div class="tab-pane active" id="pane-overview">
    <div id="overview-loading" class="loading-overlay"><div class="spinner"></div><div style="color:var(--c-desc);font-size:12px">Computing behavioral analysis…</div></div>
    <div id="overview-content" style="display:none">
      <div class="kpi-row" id="kpi-row"></div>
      <div class="grid2">
        <div class="card"><div class="card-title">Sessions Over Time</div><div class="chart-wrap"><canvas id="chart-timeline"></canvas></div></div>
        <div class="card"><div class="card-title">Source Distribution</div><div class="chart-wrap short"><canvas id="chart-source"></canvas></div><div id="by-project-list" style="margin-top:12px"></div></div>
      </div>
      <div id="python-result-overview"></div>
    </div>
  </div>

  <!-- FIELD METRICS -->
  <div class="tab-pane" id="pane-field">
    <div class="explain">
      <strong>Field Width (W<sub>F</sub>)</strong> = Σ Var(φ<sub>j</sub>(τ)) -- total behavioral spread across all sessions.
      Near zero means every session did the same thing. Large means sessions varied. The per-dimension variance chart shows <em>where</em> the spread lives.
    </div>
    <div class="kpi-row" id="field-kpi-row"></div>
    <div class="card"><div class="card-title">Per-Dimension Variance</div><div class="chart-wrap tall"><canvas id="chart-variance"></canvas></div></div>
    <div class="card"><div class="card-title">Mean Behavior (Centroid)</div><div class="chart-wrap tall"><canvas id="chart-center"></canvas></div></div>
  </div>

  <!-- SEPARATION & SKEW -->
  <div class="tab-pane" id="pane-separation">
    <div class="explain">
      <strong>Separation (Δ<sub>F</sub>)</strong> = μ<sub>F+</sub> − μ<sub>F−</sub> -- centroid of successful sessions minus centroid of failed sessions per dimension.
      Positive means successful sessions scored higher on that dimension. Negative means they scored lower.
      <br><br>
      <strong>Skew (S<sub>F</sub>)</strong> = corr(y(τ), φ<sub>j</sub>(τ)) -- correlation between outcome and each dimension.
      Negative skew: more activity on this dimension correlates with <em>failure</em> (constrain). Positive: correlates with <em>success</em> (expand).
      <br><br>
      <strong>Outcome</strong> is a heuristic: sessions with &lt;15% error rate = success (1.0), &gt;40% = failure (0.0), else 0.5.
    </div>
    <div class="grid2">
      <div class="card"><div class="card-title">Separation Vector</div><div class="chart-wrap tall"><canvas id="chart-separation"></canvas></div></div>
      <div class="card"><div class="card-title">Skew (correlation with outcome)</div><div class="chart-wrap tall"><canvas id="chart-skew"></canvas></div></div>
    </div>
    <div class="card"><div class="card-title">Dimension Interpretation</div><div id="sep-table-wrap"></div></div>
  </div>

  <!-- HORIZONS -->
  <div class="tab-pane" id="pane-horizon">
    <div class="explain">
      <strong>Horizon H(s)</strong> = subset of sessions that passed through state s.
      States: <span class="state-badge state-start">start</span><span class="state-badge state-exploring">exploring</span><span class="state-badge state-editing">editing</span><span class="state-badge state-verified">verified</span>
      <br><br>
      <strong>Drift δ(s)</strong> = W(H(s)) − W(H⁺(s)) -- excess spread that failing sessions contribute at each state. Positive drift = failing sessions are diverging from the success corridor.
    </div>
    <div id="horizon-table-wrap" class="card" style="margin-bottom:16px"></div>
    <div class="grid2">
      <div class="card"><div class="card-title">Horizon Width by State</div><div class="chart-wrap"><canvas id="chart-horizon-width"></canvas></div></div>
      <div class="card"><div class="card-title">Horizon Convergence by State</div><div class="chart-wrap"><canvas id="chart-horizon-conv"></canvas></div></div>
    </div>
    <div class="card"><div class="card-title">Drift δ(s) by State</div><div class="chart-wrap short"><canvas id="chart-drift"></canvas></div></div>
  </div>

  <!-- INTENT / PROGRAMS -->
  <div class="tab-pane" id="pane-intent">
    <div class="explain">
      <strong>Intent (ρπ)</strong>: Each assistant message is labeled <em>acting</em> (A -- made tool calls) or <em>introspecting</em> (I -- reasoning without tool calls).
      The run-length-encoded sequence is the <strong>program string</strong>.
      <br><br>
      Sessions sharing the same program string form a <strong>program family</strong>.
      More distinct programs = more behavioral fragmentation. Fewer cycles = more decisive execution.
    </div>
    <div class="kpi-row" id="intent-kpi-row"></div>
    <div class="grid2">
      <div class="card"><div class="card-title">Act/Think Cycles Distribution</div><div class="chart-wrap short"><canvas id="chart-cycles"></canvas></div></div>
      <div class="card"><div class="card-title">Acting vs Introspecting Ratio</div><div class="chart-wrap short"><canvas id="chart-act-ratio"></canvas></div></div>
    </div>
    <div class="card"><div class="card-title">Program Families</div><div id="program-table-wrap"></div></div>
  </div>

  <!-- CUSTOM SCRIPTS -->
  <div class="tab-pane" id="pane-custom">
    <div class="explain">
      Custom measurement scripts add new <strong>φ dimensions</strong> to the behavioral space.
      Place <code>.js</code> files in the configured scripts directory. Each file should export a
      <code>measure(session)</code> function returning a number and a <code>label</code> string.
      <br><br>
      <strong>API:</strong> <code>measure(session)</code> receives a session object with
      <code>{ sessionId, source, project, timestamp, phi, statesReached, intentSequence, outcome, errorRate }</code>.
    </div>
    <div id="custom-scripts-content">
      <div class="card">
        <div class="card-title">Loaded Scripts</div>
        <div id="scripts-list"></div>
      </div>
      <div id="custom-dims-charts"></div>
    </div>
  </div>

  <!-- SETTINGS -->
  <div class="tab-pane" id="pane-settings">
    <div class="card">
      <div class="card-title">Python AFT Integration</div>
      <div class="explain" style="margin-bottom:14px">
        Set a Python virtual environment with <code>agent_fields</code> installed to enable deep AFT analysis.
        Run <code>pip install git+https://github.com/technoyoda/aft.git</code> in your venv.
        The extension will execute Python-side field metrics and merge them with the JavaScript analysis.
      </div>
      <div class="form-group">
        <label class="form-label">Python Virtual Environment Path</label>
        <input class="form-input" id="setting-venv" type="text" placeholder="e.g. /home/user/myenv or C:\\Users\\user\\myenv">
        <div class="form-desc">Path to the venv root directory (contains bin/python or Scripts/python.exe)</div>
      </div>
      <div class="form-actions">
        <button class="btn small" id="btn-test-python">Test Connection</button>
        <div id="python-test-result" style="display:none"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Custom Measurement Scripts</div>
      <div class="form-group">
        <label class="form-label">Scripts Directory</label>
        <input class="form-input" id="setting-scripts" type="text" placeholder="e.g. /home/user/.aisx/scripts">
        <div class="form-desc">Directory containing <code>.js</code> files that export <code>measure(session)</code> and <code>label</code></div>
      </div>
      <div id="scripts-template" class="card" style="background:var(--c-code);margin-top:8px">
        <div class="card-title">Script Template</div>
        <pre style="font-family:var(--vscode-editor-font-family,monospace);font-size:11px;white-space:pre-wrap;color:var(--c-fg)">// my_dimension.js -- place in your scripts directory
// session: { phi, statesReached, intentSequence, outcome, errorRate, source, ... }

exports.label = 'My Metric';
exports.description = 'What this dimension measures';

exports.measure = function(session) {
  // Return a single number -- your custom behavioral dimension
  // Example: ratio of acting to total intent steps
  const total = session.intentSequence.length || 1;
  const acting = session.intentSequence.filter(x => x === 'A').length;
  return acting / total;
};</pre>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Analysis Settings</div>
      <div class="form-group">
        <label class="form-label">Max Sessions to Analyze</label>
        <input class="form-input" id="setting-max" type="number" min="5" max="500" step="5" value="50">
        <div class="form-desc">Most recent N sessions will be analyzed. Higher values are slower but more representative.</div>
      </div>
    </div>
    <div class="form-actions" style="margin-top:8px">
      <button class="btn" id="btn-save-settings">Save &amp; Recompute</button>
    </div>
  </div>
</div>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<script nonce="${nonce}">
// ═══════════════════════════════════════════════════════════════════════════
// Dashboard JS -- receives analyticsData from extension and renders charts
// ═══════════════════════════════════════════════════════════════════════════

const vscode = acquireVsCodeApi();
let state = {};
const charts = {};

// ── Theme helper ──────────────────────────────────────────────────────────
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function themeColors() {
  return {
    blue:   cssVar('--chart-blue')   || '#4fc3f7',
    green:  cssVar('--chart-green')  || '#81c784',
    orange: cssVar('--chart-orange') || '#ffb74d',
    red:    cssVar('--chart-red')    || '#e57373',
    purple: cssVar('--chart-purple') || '#ba68c8',
    yellow: cssVar('--chart-yellow') || '#fff176',
    fg:     cssVar('--c-fg')         || '#d4d4d4',
    desc:   cssVar('--c-desc')       || '#888',
    border: cssVar('--c-border')     || '#333',
    bg:     cssVar('--c-bg')         || '#1e1e1e',
    sidebar:cssVar('--c-sidebar')    || '#252526',
  };
}

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: { enabled: true }
  }
};

function baseBarOptions(extra = {}) {
  const t = themeColors();
  return {
    ...CHART_DEFAULTS,
    scales: {
      x: {
        ticks: { color: t.desc, font: { size: 10 } },
        grid:  { color: t.border + '44' }
      },
      y: {
        ticks: { color: t.desc, font: { size: 10 } },
        grid:  { color: t.border + '44' }
      }
    },
    ...extra
  };
}

function makeChart(id, type, data, options) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (charts[id]) { charts[id].destroy(); }
  charts[id] = new Chart(el, { type, data, options: options || CHART_DEFAULTS });
  return charts[id];
}

// ── Tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const pane = document.getElementById('pane-' + tab.dataset.tab);
    if (pane) pane.classList.add('active');
  });
});

// ── Utility ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtNum(n, decimals = 2) {
  if (!isFinite(n) || n === null || n === undefined) return '∞';
  return Number(n).toFixed(decimals);
}

function interpretSep(v) {
  if (Math.abs(v) < 0.05) return '<span class="chip neutral">neutral</span>';
  if (v > 0) return '<span class="chip good">success+</span>';
  return '<span class="chip bad">success−</span>';
}

function interpretSkew(v) {
  if (Math.abs(v) < 0.1) return '<span class="chip neutral">no signal</span>';
  if (v > 0) return '<span class="chip warning">expensive success</span>';
  return '<span class="chip good">cheap success</span>';
}

function stateBadge(s) {
  return \`<span class="state-badge state-\${s}">\${s}</span>\`;
}

// ── Render functions ──────────────────────────────────────────────────────

function renderOverview(payload) {
  document.getElementById('overview-loading').style.display = 'none';
  document.getElementById('overview-content').style.display = 'block';

  const { vectors, field, bySource, byProject, timelineData, totalSessions, analyzedSessions } = payload;
  const t = themeColors();

  const successK = vectors.filter(v => v.outcome >= 0.5).length;

  // KPIs
  document.getElementById('kpi-row').innerHTML = [
    { label: 'Total Sessions', value: totalSessions, note: analyzedSessions + ' analyzed' },
    { label: 'Success Rate',   value: (analyzedSessions ? (successK/analyzedSessions*100).toFixed(0) : 0) + '%', note: successK + ' success / ' + (analyzedSessions - successK) + ' fail' },
    { label: 'Field Width',    value: fmtNum(field.width), note: 'behavioral spread' },
    { label: 'Convergence',    value: fmtNum(field.convergence), note: 'E[y]/σ[y]' },
    { label: 'Tool Calls avg', value: fmtNum(field.center[0], 1), note: 'per session' },
    { label: 'Avg Messages',   value: fmtNum(field.center[4], 1), note: 'per session' },
  ].map(k => \`<div class="kpi"><div class="kpi-value">\${esc(String(k.value))}</div><div class="kpi-label">\${esc(k.label)}</div><div class="kpi-note">\${esc(k.note)}</div></div>\`).join('');

  // Timeline chart
  if (timelineData.length) {
    makeChart('chart-timeline', 'bar', {
      labels: timelineData.map(d => d.date),
      datasets: [{ data: timelineData.map(d => d.count), backgroundColor: t.blue + 'bb', borderColor: t.blue, borderWidth: 1 }]
    }, baseBarOptions());
  }

  // Source pie
  const srcLabels = Object.keys(bySource);
  const srcColors = [t.orange, t.blue, t.purple, t.green];
  makeChart('chart-source', 'doughnut', {
    labels: srcLabels,
    datasets: [{ data: srcLabels.map(k => bySource[k]), backgroundColor: srcColors.slice(0, srcLabels.length), borderColor: t.bg, borderWidth: 2 }]
  }, { ...CHART_DEFAULTS, plugins: { legend: { display: true, position: 'right', labels: { color: t.fg, font: { size: 10 } } } } });

  // Projects list
  const projHtml = byProject.slice(0,8).map(p =>
    \`<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px;border-bottom:1px solid \${esc(t.border)}44">
       <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="\${esc(p.project)}">\${esc(p.project||'(unknown)')}</span>
       <span style="color:\${esc(t.desc)};flex-shrink:0;margin-left:8px">\${p.count}</span>
     </div>\`
  ).join('');
  document.getElementById('by-project-list').innerHTML = \`<div style="font-size:10px;color:var(--c-desc);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Top Projects</div>\` + projHtml;

  // Python result summary
  if (payload.pythonResult && payload.pythonResult.aft_available) {
    const pr = payload.pythonResult;
    document.getElementById('python-result-overview').innerHTML = \`
      <div class="card">
        <div class="card-title">Python AFT Results <span class="python-badge">AFT</span></div>
        <div class="kpi-row">
          <div class="kpi"><div class="kpi-value">\${fmtNum(pr.width)}</div><div class="kpi-label">Width (Python)</div></div>
          <div class="kpi"><div class="kpi-value">\${fmtNum(pr.convergence === 1e9 ? Infinity : pr.convergence)}</div><div class="kpi-label">Convergence (Python)</div></div>
          <div class="kpi"><div class="kpi-value">\${pr.K}</div><div class="kpi-label">K sessions</div></div>
          <div class="kpi"><div class="kpi-value">\${pr.success_K}</div><div class="kpi-label">Successes</div></div>
        </div>
      </div>\`;
  } else if (payload.pythonError) {
    document.getElementById('python-result-overview').innerHTML = \`<div class="error-box">Python AFT error: \${esc(payload.pythonError)}</div>\`;
  }
}

function renderField(payload) {
  const { field, dimensions } = payload;
  const t = themeColors();
  const labels = dimensions.map(d => d.label);

  document.getElementById('field-kpi-row').innerHTML = [
    { label: 'Width W_F', value: fmtNum(field.width), note: 'total behavioral spread' },
    { label: 'Convergence', value: fmtNum(field.convergence), note: 'E[y] / σ[y]' },
    { label: 'Successes', value: field.successK, note: 'outcome ≥ 0.5' },
    { label: 'Failures', value: field.failureK, note: 'outcome < 0.5' },
    { label: 'Dimensions', value: dimensions.length, note: 'behavioral axes' },
  ].map(k => \`<div class="kpi"><div class="kpi-value">\${esc(String(k.value))}</div><div class="kpi-label">\${esc(k.label)}</div><div class="kpi-note">\${esc(k.note)}</div></div>\`).join('');

  // Variance bar chart
  makeChart('chart-variance', 'bar', {
    labels,
    datasets: [{ label: 'Variance', data: field.variance, backgroundColor: field.variance.map(v => v > 0.5 ? t.orange + 'cc' : t.blue + 'cc'), borderColor: field.variance.map(v => v > 0.5 ? t.orange : t.blue), borderWidth: 1 }]
  }, baseBarOptions({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + ctx.raw.toFixed(4) + ' (variance)' } } } }));

  // Center bar chart
  makeChart('chart-center', 'bar', {
    labels,
    datasets: [{ label: 'Mean', data: field.center, backgroundColor: t.blue + 'bb', borderColor: t.blue, borderWidth: 1 }]
  }, baseBarOptions());
}

function renderSeparation(payload) {
  const { field, dimensions } = payload;
  const t = themeColors();
  const labels = dimensions.map(d => d.label);

  // Separation chart -- diverging bars
  makeChart('chart-separation', 'bar', {
    labels,
    datasets: [{
      label: 'Separation',
      data: field.separation,
      backgroundColor: field.separation.map(v => v > 0.05 ? t.green + 'bb' : v < -0.05 ? t.red + 'bb' : t.desc + '55'),
      borderColor: field.separation.map(v => v > 0.05 ? t.green : v < -0.05 ? t.red : t.desc),
      borderWidth: 1,
    }]
  }, baseBarOptions({
    scales: {
      x: { ticks: { color: t.desc, font: { size: 10 } }, grid: { color: t.border + '44' } },
      y: { ticks: { color: t.desc, font: { size: 10 } }, grid: { color: t.border + '44', drawOnChartArea: true }, position: 'left', beginAtZero: false }
    }
  }));

  // Skew chart
  makeChart('chart-skew', 'bar', {
    labels,
    datasets: [{
      label: 'Skew',
      data: field.skew,
      backgroundColor: field.skew.map(v => v > 0.1 ? t.orange + 'bb' : v < -0.1 ? t.green + 'bb' : t.desc + '55'),
      borderColor: field.skew.map(v => v > 0.1 ? t.orange : v < -0.1 ? t.green : t.desc),
      borderWidth: 1,
    }]
  }, baseBarOptions());

  // Interpretation table
  const rows = dimensions.map((d, i) => \`
    <tr>
      <td style="font-weight:600">\${esc(d.label)}</td>
      <td>\${fmtNum(field.separation[i], 4)}</td>
      <td>\${interpretSep(field.separation[i])}</td>
      <td>\${fmtNum(field.skew[i], 4)}</td>
      <td>\${interpretSkew(field.skew[i])}</td>
      <td style="color:var(--c-desc);font-size:10px">\${esc(d.description)}</td>
    </tr>\`).join('');
  document.getElementById('sep-table-wrap').innerHTML = \`
    <table>
      <thead><tr><th>Dimension</th><th>Separation</th><th>Sep. Signal</th><th>Skew</th><th>Skew Signal</th><th>Description</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
}

function renderHorizons(payload) {
  const { horizons } = payload;
  const t = themeColors();
  const stateLabels = horizons.map(h => h.state);

  // Table
  const rows = horizons.map(h => \`
    <tr>
      <td>\${stateBadge(h.state)}</td>
      <td>\${h.K}</td>
      <td>\${h.successK}</td>
      <td>\${fmtNum(h.width, 4)}</td>
      <td>\${fmtNum(h.convergence, 4)}</td>
      <td style="color:\${h.drift > 2 ? esc(t.red) : h.drift > 0.5 ? esc(t.orange) : esc(t.fg)}">\${fmtNum(h.drift, 4)}</td>
    </tr>\`).join('');
  document.getElementById('horizon-table-wrap').innerHTML = \`
    <div class="card-title">Horizon Chain</div>
    <table>
      <thead><tr><th>State</th><th>K</th><th>K+</th><th>Width</th><th>Convergence</th><th>Drift δ</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;

  // Width chart
  makeChart('chart-horizon-width', 'line', {
    labels: stateLabels,
    datasets: [{ label: 'Width', data: horizons.map(h => h.width), borderColor: t.blue, backgroundColor: t.blue + '33', fill: true, tension: 0.3, pointBackgroundColor: t.blue }]
  }, baseBarOptions());

  // Convergence chart
  const convData = horizons.map(h => Math.min(h.convergence, 10));
  makeChart('chart-horizon-conv', 'line', {
    labels: stateLabels,
    datasets: [{ label: 'Convergence', data: convData, borderColor: t.green, backgroundColor: t.green + '33', fill: true, tension: 0.3, pointBackgroundColor: t.green }]
  }, baseBarOptions());

  // Drift chart
  makeChart('chart-drift', 'bar', {
    labels: stateLabels,
    datasets: [{
      label: 'Drift',
      data: horizons.map(h => h.drift),
      backgroundColor: horizons.map(h => h.drift > 2 ? t.red + 'bb' : h.drift > 0.5 ? t.orange + 'bb' : t.blue + 'bb'),
      borderColor: horizons.map(h => h.drift > 2 ? t.red : h.drift > 0.5 ? t.orange : t.blue),
      borderWidth: 1,
    }]
  }, baseBarOptions());
}

function renderIntent(payload) {
  const { vectors, programFamilies } = payload;
  const t = themeColors();

  const avgCycles = vectors.length ? (vectors.reduce((a,v) => a+v.actThinkCycles, 0)/vectors.length) : 0;
  const avgActRatio = vectors.length ? (vectors.reduce((a,v) => {
    const total = v.actingCount + v.introspectingCount || 1;
    return a + v.actingCount/total;
  }, 0)/vectors.length) : 0;

  document.getElementById('intent-kpi-row').innerHTML = [
    { label: 'Distinct Programs', value: programFamilies.length, note: 'unique act/think patterns' },
    { label: 'Avg A/I Cycles', value: fmtNum(avgCycles, 1), note: 'acting→introspecting switches' },
    { label: 'Avg Acting Ratio', value: (avgActRatio*100).toFixed(0) + '%', note: 'of assistant messages' },
  ].map(k => \`<div class="kpi"><div class="kpi-value">\${esc(String(k.value))}</div><div class="kpi-label">\${esc(k.label)}</div><div class="kpi-note">\${esc(k.note)}</div></div>\`).join('');

  // Cycles histogram
  const cycleBuckets = {};
  vectors.forEach(v => { const b = v.actThinkCycles; cycleBuckets[b] = (cycleBuckets[b]||0) + 1; });
  const cycleLabels = Object.keys(cycleBuckets).sort((a,b) => +a - +b);
  makeChart('chart-cycles', 'bar', {
    labels: cycleLabels,
    datasets: [{ data: cycleLabels.map(k => cycleBuckets[k]), backgroundColor: t.purple + 'bb', borderColor: t.purple, borderWidth: 1 }]
  }, baseBarOptions({ scales: { x: { ticks: { color: t.desc, font: { size: 10 } }, grid: { color: t.border + '44' }, title: { display: true, text: 'Cycles', color: t.desc, font: { size: 9 } } }, y: { ticks: { color: t.desc, font: { size: 10 } }, grid: { color: t.border + '44' } } } }));

  // Acting ratio histogram
  const ratioBuckets = Array(10).fill(0);
  vectors.forEach(v => {
    const total = v.actingCount + v.introspectingCount || 1;
    const idx = Math.min(9, Math.floor(v.actingCount/total * 10));
    ratioBuckets[idx]++;
  });
  makeChart('chart-act-ratio', 'bar', {
    labels: ratioBuckets.map((_,i) => (i*10) + '–' + ((i+1)*10) + '%'),
    datasets: [{ data: ratioBuckets, backgroundColor: t.orange + 'bb', borderColor: t.orange, borderWidth: 1 }]
  }, baseBarOptions());

  // Program families table
  const rows = programFamilies.map((f, i) =>
    \`<tr>
      <td style="font-family:var(--vscode-editor-font-family,monospace);font-size:10px;color:var(--c-desc);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${esc(f.program)}">\${esc(f.program)}</td>
      <td>\${f.K}</td>
      <td>\${f.successK} / \${f.K}</td>
      <td>\${(f.successRate*100).toFixed(0)}%</td>
      <td>\${fmtNum(f.avgWidth, 4)}</td>
    </tr>\`
  ).join('');
  document.getElementById('program-table-wrap').innerHTML = \`
    <table>
      <thead><tr><th>Program String</th><th>Sessions</th><th>Success</th><th>Rate</th><th>Width</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
}

function renderCustomScripts(payload, scripts) {
  const { vectors } = payload;
  const t = themeColors();

  if (!scripts || !scripts.length) {
    document.getElementById('scripts-list').innerHTML = \`<div style="color:var(--c-desc);font-size:11px;padding:8px 0">No scripts found. Configure a scripts directory in Settings and add .js files.</div>\`;
    return;
  }

  document.getElementById('scripts-list').innerHTML = scripts.map(s => \`
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--c-border)">
      <span class="custom-badge">JS</span>
      <span style="font-size:11px;font-family:var(--vscode-editor-font-family,monospace)">\${esc(s.filename)}</span>
    </div>\`).join('');

  const chartsEl = document.getElementById('custom-dims-charts');
  chartsEl.innerHTML = '';

  scripts.forEach(script => {
    try {
      const mod = {};
      const fn = new Function('exports', 'session', script.content + '\\nreturn exports;');
      const exports_obj = {};
      // Evaluate the script for its exports
      const evalFn = new Function('exports', script.content);
      evalFn(exports_obj);

      if (typeof exports_obj.measure !== 'function') return;

      const values = vectors.map(v => {
        try { return exports_obj.measure(v); } catch { return 0; }
      });

      const label = exports_obj.label || script.filename;
      const canvasId = 'custom-chart-' + script.filename.replace(/[^a-z0-9]/gi, '_');

      const wrap = document.createElement('div');
      wrap.className = 'card';
      wrap.innerHTML = \`<div class="card-title">\${esc(label)} <span class="custom-badge">custom</span></div>
        <div class="chart-wrap short"><canvas id="\${esc(canvasId)}"></canvas></div>\`;
      chartsEl.appendChild(wrap);

      const mean = values.reduce((a,b) => a+b, 0) / (values.length||1);
      const buckets = {};
      values.forEach(v => { const k = v.toFixed(2); buckets[k] = (buckets[k]||0)+1; });
      const bLabels = Object.keys(buckets).sort((a,b) => +a - +b).slice(0, 20);

      setTimeout(() => {
        makeChart(canvasId, 'bar', {
          labels: bLabels,
          datasets: [{ data: bLabels.map(k => buckets[k]), backgroundColor: t.purple + 'bb', borderColor: t.purple, borderWidth: 1 }]
        }, baseBarOptions());
      }, 50);

    } catch(e) {
      const wrap = document.createElement('div');
      wrap.className = 'error-box';
      wrap.textContent = script.filename + ': ' + String(e);
      document.getElementById('custom-dims-charts').appendChild(wrap);
    }
  });
}

function renderSettings(settings) {
  if (settings) {
    const venvEl = document.getElementById('setting-venv');
    const scriptsEl = document.getElementById('setting-scripts');
    const maxEl = document.getElementById('setting-max');
    if (venvEl)    venvEl.value   = settings.venvPath    || '';
    if (scriptsEl) scriptsEl.value = settings.scriptsPath || '';
    if (maxEl)     maxEl.value    = settings.maxSessions  || 50;
  }
}

// ── Main render ───────────────────────────────────────────────────────────

function renderAll(payload, scripts, settings) {
  state = { payload, scripts, settings };
  const { totalSessions, analyzedSessions } = payload;
  document.getElementById('topbar-subtitle').textContent = analyzedSessions + ' sessions analyzed of ' + totalSessions + ' total';

  renderOverview(payload);
  renderField(payload);
  renderSeparation(payload);
  renderHorizons(payload);
  renderIntent(payload);
  renderCustomScripts(payload, scripts);
  renderSettings(settings);
}

// ── Message handler ───────────────────────────────────────────────────────

window.addEventListener('message', ev => {
  const msg = ev.data;
  if (msg.type === 'loading') {
    document.getElementById('overview-loading').style.display = 'flex';
    document.getElementById('overview-content').style.display = 'none';
    document.getElementById('topbar-subtitle').textContent = 'Loading…';
  } else if (msg.type === 'analyticsData') {
    renderAll(msg.payload, msg.scripts || [], msg.settings || {});
  } else if (msg.type === 'analyticsError') {
    document.getElementById('overview-loading').innerHTML = \`<div class="error-box">\${esc(msg.error)}</div>\`;
  } else if (msg.type === 'pythonTestResult') {
    const el = document.getElementById('python-test-result');
    el.style.display = 'block';
    el.className = 'test-result ' + (msg.ok ? 'ok' : 'fail');
    el.textContent = msg.message;
  }
});

// ── Controls ──────────────────────────────────────────────────────────────

document.getElementById('btn-refresh').addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});

document.getElementById('btn-save-settings').addEventListener('click', () => {
  vscode.postMessage({
    type: 'saveSettings',
    venvPath:    document.getElementById('setting-venv').value.trim(),
    scriptsPath: document.getElementById('setting-scripts').value.trim(),
    maxSessions: parseInt(document.getElementById('setting-max').value, 10) || 50,
  });
});

document.getElementById('btn-test-python').addEventListener('click', () => {
  const venvPath = document.getElementById('setting-venv').value.trim();
  vscode.postMessage({ type: 'testPython', venvPath });
  document.getElementById('python-test-result').style.display = 'none';
});

// ── Bootstrap ─────────────────────────────────────────────────────────────
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
