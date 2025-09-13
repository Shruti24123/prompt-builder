"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = require("vscode");
const path = require("path");
const fs_1 = require("fs");
let tagDecoInline;
let tagDecoHide;
const WATCHERS = new Map();
const CACHE = new Map();
function activate(context) {
    createDecorations();
    const updateAll = () => vscode.window.visibleTextEditors
        .filter(e => e.document.languageId === 'plaintext')
        .forEach(e => void updateDecorations(e));
    const debounced = debounce(updateAll, 120);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('tagHighlighter'))
            return;
        disposeDecorations();
        createDecorations();
        debounced();
    }), vscode.window.onDidChangeActiveTextEditor(ed => ed && void updateDecorations(ed)), vscode.workspace.onDidChangeTextDocument(e => {
        const ed = vscode.window.activeTextEditor;
        if (ed && e.document === ed.document)
            debounced();
    }), vscode.workspace.onDidSaveTextDocument(() => debounced()), vscode.workspace.onDidCloseTextDocument(doc => {
        // Clean up watchers whose base folder was this doc (best-effort)
        // (We keep per-target watchers separately; they auto-clean via refcounts below.)
    }), vscode.commands.registerCommand('tagHighlighter.openSubstitutedPreview', () => openVirtualPreview()));
    updateAll();
}
function createDecorations() {
    const cfg = vscode.workspace.getConfiguration('tagHighlighter');
    // This shows the inline preview after the (hidden) tag
    tagDecoInline = vscode.window.createTextEditorDecorationType({
        after: {
            color: cfg.get('inlineColor') || '#888',
            margin: '0 0 0 6px',
            contentText: '' // set per range dynamically via renderOptions
        }
    });
    // This hides the tag text so the inline preview appears "in place"
    tagDecoHide = vscode.window.createTextEditorDecorationType({
        opacity: '0',
        letterSpacing: '-0.6ch' // visually compress hidden span so after-text feels inline
    });
}
function disposeDecorations() {
    tagDecoInline?.dispose();
    tagDecoHide?.dispose();
}
async function updateDecorations(editor) {
    if (!editor)
        return;
    const cfg = vscode.workspace.getConfiguration('tagHighlighter');
    const pattern = safeRegex(cfg.get('pattern') || '<<[A-Za-z0-9._\\-/:\\\\]+?>>');
    const sep = cfg.get('pathSeparator') || ':';
    const onlyExisting = cfg.get('onlyHighlightExistingPaths') ?? true;
    const showInline = cfg.get('showInline') ?? true;
    const showHover = cfg.get('showHover') ?? true;
    const maxBytes = Math.max(0, cfg.get('maxBytes') ?? 8192);
    const joiner = cfg.get('newlineJoiner') || ' ↩ ';
    const baseDir = path.dirname(editor.document.uri.fsPath);
    const text = editor.document.getText();
    const matches = [];
    let m;
    while ((m = pattern.exec(text)) !== null) {
        const full = m[0];
        const inner = full.slice(2, -2);
        const start = editor.document.positionAt(m.index);
        const end = editor.document.positionAt(m.index + full.length);
        const absPath = toAbsolute(baseDir, inner, sep);
        matches.push({ range: new vscode.Range(start, end), inner, absPath });
        if (m.index === pattern.lastIndex)
            pattern.lastIndex++;
    }
    // Resolve which ones exist + read contents
    const inlineDecos = [];
    const hideDecos = [];
    // maintain watchers for just the currently visible set
    const needed = new Set();
    await Promise.all(matches.map(async (it) => {
        const exists = await pathExists(it.absPath);
        if (onlyExisting && !exists)
            return;
        // Watch target so we live-update when that file changes
        if (exists) {
            needed.add(it.absPath);
            retainWatcher(it.absPath, () => {
                // clear cache & refresh editors when file changes
                CACHE.delete(it.absPath);
                const ed = vscode.window.activeTextEditor;
                if (ed)
                    void updateDecorations(ed);
            });
        }
        // Prepare hover and inline
        const text = exists ? await readFileTruncated(it.absPath, maxBytes) : '';
        const hover = showHover
            ? new vscode.MarkdownString(exists
                ? '```text\n' + text + '\n```'
                : '_Path not found_')
            : undefined;
        if (hover)
            hover.isTrusted = false;
        if (showInline) {
            const oneLine = text.replace(/\r?\n/g, joiner);
            inlineDecos.push({
                range: it.range,
                hoverMessage: hover,
                renderOptions: {
                    after: { contentText: exists ? oneLine : '(missing)' }
                }
            });
            hideDecos.push({ range: it.range, hoverMessage: hover });
        }
        else if (showHover) {
            // If only hover mode, still add an invisible decoration to attach hover
            inlineDecos.push({ range: it.range, hoverMessage: hover });
        }
    }));
    // Apply
    editor.setDecorations(tagDecoInline, inlineDecos);
    editor.setDecorations(tagDecoHide, hideDecos);
    // release watchers that are no longer needed
    for (const [p, info] of WATCHERS) {
        if (!needed.has(p))
            releaseWatcher(p);
    }
}
// --- Helpers -------------------------------------------------------
function safeRegex(src) {
    try {
        return new RegExp(src, 'g');
    }
    catch {
        return /<<[A-Za-z0-9._\-/:\\]+?>>/g;
    }
}
function toAbsolute(baseDir, tagInner, sep) {
    // split by config separator, then allow slashes inside segments too
    const parts = tagInner.split(sep).flatMap(p => p.split(/[\/\\]/)).filter(Boolean);
    return path.normalize(path.join(baseDir, ...parts));
}
async function pathExists(p) {
    try {
        const stat = await fs_1.promises.stat(p);
        return stat.isFile() || stat.isDirectory();
    }
    catch {
        return false;
    }
}
async function readFileTruncated(p, maxBytes) {
    // simple cache with mtime guard
    try {
        const st = await fs_1.promises.stat(p);
        const cached = CACHE.get(p);
        if (cached && cached.mtimeMs === st.mtimeMs)
            return cached.text;
        let buf = await fs_1.promises.readFile(p);
        if (maxBytes && buf.byteLength > maxBytes)
            buf = buf.subarray(0, maxBytes);
        const text = buf.toString('utf8');
        CACHE.set(p, { mtimeMs: st.mtimeMs, text });
        return text;
    }
    catch {
        return '';
    }
}
function debounce(fn, ms) {
    let t;
    return ((...args) => {
        if (t)
            clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    });
}
function retainWatcher(absPath, onAnyChange) {
    const existing = WATCHERS.get(absPath);
    if (existing) {
        existing.refs++;
        return;
    }
    const uri = vscode.Uri.file(absPath);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(absPath), path.basename(absPath)));
    const sub = () => onAnyChange();
    watcher.onDidChange(sub);
    watcher.onDidCreate(sub);
    watcher.onDidDelete(sub);
    WATCHERS.set(absPath, { watcher, refs: 1 });
}
function releaseWatcher(absPath) {
    const info = WATCHERS.get(absPath);
    if (!info)
        return;
    info.refs--;
    if (info.refs <= 0) {
        info.watcher.dispose();
        WATCHERS.delete(absPath);
        CACHE.delete(absPath);
    }
}
// ----- Virtual substituted preview (multi-line friendly) ------------
async function openVirtualPreview() {
    const ed = vscode.window.activeTextEditor;
    if (!ed)
        return;
    const cfg = vscode.workspace.getConfiguration('tagHighlighter');
    const pattern = safeRegex(cfg.get('pattern') || '<<[A-Za-z0-9._\\-/:\\\\]+?>>');
    const sep = cfg.get('pathSeparator') || ':';
    const maxBytes = Math.max(0, cfg.get('maxBytes') ?? 8192);
    const baseDir = path.dirname(ed.document.uri.fsPath);
    const srcText = ed.document.getText();
    // Build substituted text (best-effort)
    const chunks = [];
    let last = 0;
    let m;
    while ((m = pattern.exec(srcText)) !== null) {
        chunks.push(srcText.slice(last, m.index));
        const inner = m[0].slice(2, -2);
        const abs = toAbsolute(baseDir, inner, sep);
        const exists = await pathExists(abs);
        chunks.push(exists ? await readFileTruncated(abs, maxBytes) : `<<MISSING:${inner}>>`);
        last = m.index + m[0].length;
        if (m.index === pattern.lastIndex)
            pattern.lastIndex++;
    }
    chunks.push(srcText.slice(last));
    const substituted = chunks.join('');
    // Register a one-off content provider
    const scheme = 'tagview';
    const provider = {
        onDidChange: _onDidChange.event,
        provideTextDocumentContent: () => substituted
    };
    vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
    // Open a doc next to the source
    const vdoc = vscode.Uri.parse(`${scheme}://${encodeURIComponent(path.basename(ed.document.uri.fsPath))}?preview`);
    await vscode.window.showTextDocument(vdoc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}
const _onDidChange = new vscode.EventEmitter();
//# sourceMappingURL=extension.js.map