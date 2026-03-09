import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Session {
    source: 'claude' | 'codex';
    id: string;
    timestamp: number;
    display: string;
    project: string;
    locator: string;
    messageCount: number;
}

export interface ToolUse {
    name: string;
    command: string;
    payload: string;
    callId: string | null;
}

export interface ToolResult {
    toolUseId: string;
    content: string;
    isError: boolean;
}

export interface FileHistorySnapshot {
    messageId: string;
    timestamp: string | null;
    isSnapshotUpdate: boolean;
    trackedFileBackups: Record<string, string>;
}

export interface Message {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string | null;
    uuid: string | null;
    toolUses: ToolUse[];
    toolResults: ToolResult[];
    fileHistorySnapshots: FileHistorySnapshot[];
}

export interface FileHistoryResult {
    content?: string;
    truncated?: boolean;
    originalBytes?: number;
    error?: string;
}

function getClaudeConfigPath(): string {
    const homeDir = os.homedir();
    if (process.platform === 'win32') {
        return path.join(
            process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'),
            'claude',
        );
    }
    return path.join(homeDir, '.claude');
}

function getCodexConfigPath(): string {
    return path.join(os.homedir(), '.codex');
}

function safeJsonParse(line: string): unknown {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function extractTextContent(message: unknown): string {
    if (!message || typeof message !== 'object') return '';
    const msg = message as Record<string, unknown>;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter(
                (b): b is Record<string, unknown> =>
                    b !== null && typeof b === 'object' && b.type === 'text',
            )
            .map((b) => String(b.text || ''))
            .join('\n\n');
    }
    return '';
}

function extractCodexTextFromContentBlocks(content: unknown): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((b) => {
                if (!b || typeof b !== 'object') return '';
                const block = b as Record<string, unknown>;
                if (typeof block.text === 'string') return block.text;
                if (typeof block.content === 'string') return block.content;
                return '';
            })
            .filter(Boolean)
            .join('\n\n');
    }
    return '';
}

function tryExtractCwdFromEnvText(text: string): string | null {
    const m = text.match(/<cwd>([^<]+)<\/cwd>/);
    return m ? m[1] : null;
}

function isProbablyEnvironmentContextText(text: string): boolean {
    const t = text.trim();
    return t.startsWith('<environment_context>') || t.includes('<environment_context>');
}

function extractToolResultContent(content: unknown): string {
    if (typeof content === 'string') return truncateForUi(content);
    if (Array.isArray(content)) {
        return truncateForUi(
            content
                .filter(
                    (b): b is Record<string, unknown> =>
                        b !== null && typeof b === 'object' && b.type === 'text',
                )
                .map((b) => String(b.text || ''))
                .join('\n'),
        );
    }
    return '';
}

function truncateForUi(text: string, max = 12000): string {
    if (typeof text !== 'string') return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function parseStructuredPayload(value: unknown): Record<string, unknown> | null {
    if (!value) return null;
    if (typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const parsed = safeJsonParse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    }
    return null;
}

function findCommandLikeString(value: unknown, depth = 0): string | null {
    if (depth > 4 || value == null) return null;
    if (typeof value === 'string') return value.trim() || null;
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = findCommandLikeString(entry, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (typeof value !== 'object') return null;
    const obj = value as Record<string, unknown>;
    for (const key of ['cmd', 'command', 'shell_command', 'commandLine', 'script', 'patch', 'query']) {
        if (typeof obj[key] === 'string' && (obj[key] as string).trim()) {
            return (obj[key] as string).trim();
        }
    }
    for (const key of Object.keys(obj)) {
        const found = findCommandLikeString(obj[key], depth + 1);
        if (found) return found;
    }
    return null;
}

function stringifyPayloadForUi(payload: unknown): string {
    if (payload == null) return '';
    if (typeof payload === 'string') return truncateForUi(payload);
    try {
        return truncateForUi(JSON.stringify(payload, null, 2));
    } catch {
        return truncateForUi(String(payload));
    }
}

function normalizeToolUse(
    name: unknown,
    payloadSource: unknown,
    fallbackText = '',
    callId: string | null = null,
): ToolUse {
    const payload = parseStructuredPayload(payloadSource);
    const rawPayloadText = typeof payloadSource === 'string' ? payloadSource.trim() : '';
    const rawFallback = typeof fallbackText === 'string' ? fallbackText.trim() : '';

    const command =
        findCommandLikeString(payload) ||
        (rawPayloadText && !parseStructuredPayload(rawPayloadText) ? rawPayloadText : '') ||
        rawFallback;

    let payloadText = '';
    if (payload) {
        payloadText = stringifyPayloadForUi(payload);
    } else if (rawPayloadText && rawPayloadText !== command) {
        payloadText = truncateForUi(rawPayloadText);
    } else if (rawFallback && rawFallback !== command) {
        payloadText = truncateForUi(rawFallback);
    }

    return {
        name: typeof name === 'string' ? name : 'tool',
        command: truncateForUi(command || '', 4000),
        payload: payloadText,
        callId: callId || null,
    };
}

function unwrapCodexRecord(obj: unknown): {
    timestamp: string | null;
    rec: Record<string, unknown> | null;
} {
    if (!obj || typeof obj !== 'object') return { timestamp: null, rec: null };
    const o = obj as Record<string, unknown>;
    if (o.type === 'response_item' && o.payload && typeof o.payload === 'object') {
        return {
            timestamp: typeof o.timestamp === 'string' ? o.timestamp : null,
            rec: o.payload as Record<string, unknown>,
        };
    }
    return { timestamp: typeof o.timestamp === 'string' ? o.timestamp : null, rec: o };
}

function listFilesRecursive(baseDir: string, predicate: (p: string) => boolean): string[] {
    const results: string[] = [];
    if (!fs.existsSync(baseDir)) return results;
    const stack = [baseDir];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                stack.push(p);
            } else if (ent.isFile() && predicate(p)) {
                results.push(p);
            }
        }
    }
    return results;
}

export function getSessions(): { sessions?: Session[]; error?: string } {
    try {
        const sessions: Session[] = [];

        // Claude Code sessions
        try {
            const configPath = getClaudeConfigPath();
            const projectsPath = path.join(configPath, 'projects');
            const sessionMap = new Map<string, Session>();

            if (fs.existsSync(projectsPath)) {
                for (const projectDir of fs.readdirSync(projectsPath)) {
                    const projectPath = path.join(projectsPath, projectDir);
                    try {
                        if (!fs.statSync(projectPath).isDirectory()) continue;
                    } catch {
                        continue;
                    }

                    const sessionFiles = fs
                        .readdirSync(projectPath)
                        .filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'));

                    for (const sessionFile of sessionFiles) {
                        const sessionPath = path.join(projectPath, sessionFile);
                        const sessionId = sessionFile.replace('.jsonl', '');
                        try {
                            const lines = fs
                                .readFileSync(sessionPath, 'utf-8')
                                .trim()
                                .split('\n')
                                .filter((l) => l.trim());
                            if (lines.length === 0) continue;

                            const messages = lines
                                .map((l) => safeJsonParse(l))
                                .filter(
                                    (m): m is Record<string, unknown> =>
                                        m !== null && typeof m === 'object',
                                );

                            const firstUser = messages.find(
                                (m) => m.type === 'user' && m.message,
                            );
                            if (!firstUser) continue;

                            const projectName = projectDir.replace(/-/g, '/').substring(1);
                            const content = extractTextContent(firstUser.message);

                            sessionMap.set(sessionId, {
                                source: 'claude',
                                id: sessionId,
                                timestamp:
                                    typeof firstUser.timestamp === 'string'
                                        ? new Date(firstUser.timestamp).getTime()
                                        : 0,
                                display: content.substring(0, 100),
                                project: projectName,
                                locator: projectDir,
                                messageCount: messages.filter(
                                    (m) => m.type === 'user' || m.type === 'assistant',
                                ).length,
                            });
                        } catch {
                            // skip
                        }
                    }
                }
            }
            sessions.push(...Array.from(sessionMap.values()));
        } catch {
            // skip claude errors
        }

        // Codex sessions
        try {
            const sessionsPath = path.join(getCodexConfigPath(), 'sessions');
            for (const sessionFilePath of listFilesRecursive(sessionsPath, (p) =>
                p.endsWith('.jsonl'),
            )) {
                try {
                    const relPath = path.relative(sessionsPath, sessionFilePath);
                    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) continue;

                    const lines = fs
                        .readFileSync(sessionFilePath, 'utf-8')
                        .trim()
                        .split('\n')
                        .filter(Boolean);
                    if (lines.length === 0) continue;

                    const firstObj = safeJsonParse(lines[0]) as Record<string, unknown> | null;
                    const firstPayload =
                        firstObj?.type === 'session_meta' &&
                        firstObj.payload &&
                        typeof firstObj.payload === 'object'
                            ? (firstObj.payload as Record<string, unknown>)
                            : null;

                    const sessionId =
                        (firstPayload && typeof firstPayload.id === 'string' && firstPayload.id) ||
                        (firstObj && typeof firstObj.id === 'string' && firstObj.id) ||
                        path.basename(sessionFilePath).replace(/\.jsonl$/, '');

                    let ts: number | null = null;
                    const firstTs =
                        (firstPayload &&
                            typeof firstPayload.timestamp === 'string' &&
                            firstPayload.timestamp) ||
                        (firstObj &&
                            typeof firstObj.timestamp === 'string' &&
                            firstObj.timestamp) ||
                        null;
                    if (firstTs) {
                        const t = new Date(firstTs).getTime();
                        if (!Number.isNaN(t)) ts = t;
                    }

                    let cwd: string | null = null;
                    let displayText = '';
                    let messageCount = 0;

                    for (const line of lines) {
                        const raw = safeJsonParse(line) as Record<string, unknown> | null;
                        if (!raw) continue;

                        if (!cwd && raw.type === 'session_meta') {
                            const p = raw.payload as Record<string, unknown> | null;
                            if (p && typeof p.cwd === 'string') cwd = p.cwd;
                        }

                        const { timestamp: wrapperTs, rec } = unwrapCodexRecord(raw);
                        if (!rec) continue;

                        if (rec.type === 'message' && (rec.role === 'user' || rec.role === 'assistant')) {
                            messageCount++;
                        }
                        if (!cwd && rec.type === 'message' && rec.role === 'user' && rec.content) {
                            const extracted = tryExtractCwdFromEnvText(
                                extractCodexTextFromContentBlocks(rec.content),
                            );
                            if (extracted) cwd = extracted;
                        }
                        if (!displayText && rec.type === 'message' && rec.role === 'user' && rec.content) {
                            const text = extractCodexTextFromContentBlocks(rec.content);
                            if (text.trim() && !isProbablyEnvironmentContextText(text)) {
                                displayText = text.trim();
                            }
                        }
                        if (!ts && rec.type === 'message' && rec.role === 'user' && rec.content) {
                            const tsStr =
                                (typeof wrapperTs === 'string' && wrapperTs) ||
                                (typeof rec.created_at === 'string' && rec.created_at) ||
                                (typeof rec.timestamp === 'string' && rec.timestamp) ||
                                null;
                            if (tsStr) {
                                const t = new Date(tsStr).getTime();
                                if (!Number.isNaN(t)) ts = t;
                            }
                        }
                    }

                    if (!displayText) {
                        const firstUser = lines
                            .map((l) => unwrapCodexRecord(safeJsonParse(l)).rec)
                            .find((r) => r && r.type === 'message' && r.role === 'user' && r.content);
                        if (firstUser) {
                            displayText = extractCodexTextFromContentBlocks(firstUser.content).trim();
                        }
                    }

                    const gitInfo = firstPayload?.git as Record<string, unknown> | null;
                    const project =
                        cwd ||
                        (gitInfo &&
                            (String(gitInfo.repository_url || '') || String(gitInfo.branch || ''))) ||
                        'Codex';

                    sessions.push({
                        source: 'codex',
                        id: String(sessionId),
                        timestamp: ts || 0,
                        display: (displayText || '').substring(0, 100),
                        project: String(project),
                        locator: relPath,
                        messageCount,
                    });
                } catch {
                    // skip
                }
            }
        } catch {
            // skip codex errors
        }

        sessions.sort(
            (a, b) =>
                (b.timestamp || 0) - (a.timestamp || 0) ||
                String(a.id).localeCompare(String(b.id)),
        );

        return { sessions };
    } catch (error) {
        return { error: String(error) };
    }
}

export function getSessionDetails(
    sessionId: string,
    locator: string,
    source: string,
): { messages?: Message[]; error?: string } {
    try {
        if (source === 'codex') {
            const sessionsBase = path.join(getCodexConfigPath(), 'sessions');
            if (!locator.trim()) return { error: 'Invalid Codex session locator' };

            const resolvedBase = path.resolve(sessionsBase);
            const resolvedPath = path.resolve(sessionsBase, locator);
            if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
                return { error: 'Invalid Codex session path' };
            }
            if (!fs.existsSync(resolvedPath)) return { error: 'Session file not found' };

            const lines = fs
                .readFileSync(resolvedPath, 'utf-8')
                .trim()
                .split('\n')
                .filter((l) => l.trim());
            const records = lines
                .map((l) => safeJsonParse(l))
                .filter(
                    (m): m is Record<string, unknown> => m !== null && typeof m === 'object',
                );

            let defaultTimestamp: string | null = null;
            for (const rec of records) {
                if (typeof rec.timestamp === 'string') {
                    defaultTimestamp = rec.timestamp;
                    break;
                }
                if (rec.type === 'session_meta' && rec.payload) {
                    const p = rec.payload as Record<string, unknown>;
                    if (typeof p.timestamp === 'string') {
                        defaultTimestamp = p.timestamp;
                        break;
                    }
                }
            }

            const formattedMessages: Message[] = [];
            let lastAssistantMsg: Message | null = null;

            for (const raw of records) {
                const { timestamp: wrapperTs, rec } = unwrapCodexRecord(raw);
                if (!rec) continue;

                if (rec.type === 'message' && (rec.role === 'user' || rec.role === 'assistant')) {
                    const msg: Message = {
                        role: rec.role as 'user' | 'assistant',
                        content: extractCodexTextFromContentBlocks(rec.content),
                        timestamp:
                            (typeof rec.timestamp === 'string' ? rec.timestamp : null) ||
                            (typeof rec.created_at === 'string' ? rec.created_at : null) ||
                            wrapperTs ||
                            defaultTimestamp ||
                            null,
                        uuid: typeof rec.id === 'string' ? rec.id : null,
                        toolUses: [],
                        toolResults: [],
                        fileHistorySnapshots: [],
                    };
                    formattedMessages.push(msg);
                    if (rec.role === 'assistant') lastAssistantMsg = msg;
                    continue;
                }

                if (rec.type === 'function_call' && typeof rec.name === 'string') {
                    if (!lastAssistantMsg) {
                        lastAssistantMsg = {
                            role: 'assistant',
                            content: '',
                            timestamp:
                                (typeof rec.timestamp === 'string' ? rec.timestamp : null) ||
                                wrapperTs ||
                                defaultTimestamp ||
                                null,
                            uuid:
                                (typeof rec.call_id === 'string' ? rec.call_id : null) ||
                                (typeof rec.id === 'string' ? rec.id : null),
                            toolUses: [],
                            toolResults: [],
                            fileHistorySnapshots: [],
                        };
                        formattedMessages.push(lastAssistantMsg);
                    }
                    const payloadSource =
                        rec.arguments ?? rec.input ?? rec.parameters ?? rec.args ?? rec.kwargs ?? null;
                    const fallbackText =
                        typeof rec.command === 'string'
                            ? rec.command
                            : typeof rec.arguments === 'string'
                              ? rec.arguments
                              : '';
                    lastAssistantMsg.toolUses.push(
                        normalizeToolUse(
                            rec.name,
                            payloadSource,
                            fallbackText,
                            (typeof rec.call_id === 'string' ? rec.call_id : null) ||
                                (typeof rec.id === 'string' ? rec.id : null),
                        ),
                    );
                }
            }

            const cleaned = formattedMessages.filter(
                (m) => (m.content && m.content.trim()) || m.toolUses.length > 0,
            );
            return { messages: cleaned.slice(2) };
        }

        // Claude
        const configPath = getClaudeConfigPath();
        const sessionPath = path.join(configPath, 'projects', locator, `${sessionId}.jsonl`);
        if (!fs.existsSync(sessionPath)) return { error: 'Session file not found' };

        const lines = fs
            .readFileSync(sessionPath, 'utf-8')
            .trim()
            .split('\n')
            .filter((l) => l.trim());
        const messages = lines
            .map((l) => safeJsonParse(l))
            .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object');

        const snapshotsByMsgId = new Map<string, FileHistorySnapshot[]>();
        for (const msg of messages) {
            if (msg.type === 'file-history-snapshot' && msg.messageId && msg.snapshot) {
                const snap = msg.snapshot as Record<string, unknown>;
                const snapshot: FileHistorySnapshot = {
                    messageId: String(msg.messageId),
                    timestamp: typeof snap.timestamp === 'string' ? snap.timestamp : null,
                    isSnapshotUpdate: !!msg.isSnapshotUpdate,
                    trackedFileBackups: (snap.trackedFileBackups as Record<string, string>) || {},
                };
                const key = String(msg.messageId);
                snapshotsByMsgId.set(key, [...(snapshotsByMsgId.get(key) || []), snapshot]);
            }
        }

        const formatted = messages
            .filter((m) => (m.type === 'user' || m.type === 'assistant') && m.message)
            .map((msg): Message | null => {
                const uuid = typeof msg.uuid === 'string' ? msg.uuid : null;
                const timestamp = typeof msg.timestamp === 'string' ? msg.timestamp : null;
                const fileHistorySnapshots = uuid ? snapshotsByMsgId.get(uuid) || [] : [];

                if (msg.type === 'user') {
                    const msgContent = (msg.message as Record<string, unknown>).content;
                    const toolResults = Array.isArray(msgContent)
                        ? msgContent
                              .filter(
                                  (b): b is Record<string, unknown> =>
                                      b !== null &&
                                      typeof b === 'object' &&
                                      b.type === 'tool_result',
                              )
                              .map((b) => ({
                                  toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
                                  content: extractToolResultContent(b.content),
                                  isError: b.is_error === true,
                              }))
                        : [];
                    return {
                        role: 'user',
                        content: extractTextContent(msg.message),
                        timestamp,
                        uuid,
                        toolUses: [],
                        toolResults,
                        fileHistorySnapshots,
                    };
                }
                if (msg.type === 'assistant') {
                    const msgContent = (msg.message as Record<string, unknown>).content;
                    const toolUses = Array.isArray(msgContent)
                        ? msgContent
                              .filter(
                                  (b): b is Record<string, unknown> =>
                                      b !== null &&
                                      typeof b === 'object' &&
                                      b.type === 'tool_use',
                              )
                              .map((b) =>
                                  normalizeToolUse(
                                      b.name,
                                      b.input ?? b.arguments ?? b.parameters ?? null,
                                      typeof b.input === 'string' ? b.input : '',
                                      typeof b.id === 'string' ? b.id : null,
                                  ),
                              )
                        : [];
                    return {
                        role: 'assistant',
                        content: extractTextContent(msg.message),
                        timestamp,
                        uuid,
                        toolUses,
                        toolResults: [],
                        fileHistorySnapshots,
                    };
                }
                return null;
            })
            .filter((m): m is Message => m !== null);

        return { messages: formatted };
    } catch (error) {
        return { error: String(error) };
    }
}

export function getFileHistoryFile(sessionId: string, backupFileName: string): FileHistoryResult {
    try {
        const baseDir = path.join(getClaudeConfigPath(), 'file-history');

        if (
            !sessionId ||
            !backupFileName ||
            sessionId.includes('/') ||
            sessionId.includes('\\') ||
            backupFileName.includes('/') ||
            backupFileName.includes('\\') ||
            sessionId.includes('..') ||
            backupFileName.includes('..')
        ) {
            return { error: 'Invalid file-history request' };
        }

        const resolvedBase = path.resolve(baseDir);
        const resolvedPath = path.resolve(baseDir, sessionId, backupFileName);
        if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
            return { error: 'Invalid file-history path' };
        }
        if (!fs.existsSync(resolvedPath)) return { error: 'Snapshot file not found' };

        const stat = fs.statSync(resolvedPath);
        if (!stat.isFile()) return { error: 'Snapshot path is not a file' };

        const maxBytes = 2 * 1024 * 1024;
        if (stat.size > maxBytes) {
            const fd = fs.openSync(resolvedPath, 'r');
            try {
                const buffer = Buffer.allocUnsafe(maxBytes);
                const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
                return {
                    content: buffer.slice(0, bytesRead).toString('utf-8'),
                    truncated: true,
                    originalBytes: stat.size,
                };
            } finally {
                fs.closeSync(fd);
            }
        }

        return { content: fs.readFileSync(resolvedPath, 'utf-8') };
    } catch (error) {
        return { error: String(error) };
    }
}
