"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs_1 = require("fs");
const PREVIEW_SCHEME = "prompt-builder-preview";
const TAG_REGEX = /<<\s*([^:>]+(?:\/[^:>]+)*)\s*:\s*([^>]+)\s*>>/g;
/**
 * Keys to identify a specific tag occurrence: documentUri + ":" + startOffset
 */
const makeKey = (docUri, startOffset) => `${docUri.toString()}:${startOffset}`;
/**
 * Tracks currently visible preview editors to synthesize "expanded" state for decorations.
 * We'll recompute this from visible editors when needed.
 */
const expandedKeys = new Set();
/**
 * Event emitter used to refresh document links & decorations when needed.
 */
const refreshEmitter = new vscode.EventEmitter();
function activate(context) {
    // Decorations
    const existingFileDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: "rgba(0, 255, 0, 0.10)",
        border: "1px solid rgba(0, 180, 0, 0.6)",
        borderRadius: "3px"
    });
    const expandedDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: "rgba(0, 122, 204, 0.08)",
        border: "1px dashed rgba(0, 122, 204, 0.6)",
        borderRadius: "3px"
    });
    // Register TextDocumentContentProvider for the preview scheme
    const provider = {
        async provideTextDocumentContent(uri) {
            // read target param from query (reliable with VS Code URIs)
            try {
                const params = new URLSearchParams(uri.query);
                const target = params.get("target") ?? "";
                if (!target)
                    return `Error: missing target parameter in URI.`;
                const buf = await fs_1.promises.readFile(target);
                return buf.toString();
            }
            catch (err) {
                return `Error reading referenced file: ${err?.message ?? String(err)}`;
            }
        }
    };
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, provider));
    // DocumentLinkProvider: creates clickable links over each tag that points to a command URI
    const linkProvider = {
        async provideDocumentLinks(document, _token) {
            if (document.languageId !== "plaintext" || !document.fileName.endsWith(".txt"))
                return [];
            const links = [];
            const text = document.getText();
            let match;
            while ((match = TAG_REGEX.exec(text))) {
                const fullMatch = match[0];
                const folderPart = match[1].trim();
                const filePart = match[2].trim();
                const matchIndex = match.index;
                const start = document.positionAt(matchIndex);
                const end = document.positionAt(matchIndex + fullMatch.length);
                const range = new vscode.Range(start, end);
                const docDir = path.dirname(document.uri.fsPath);
                const targetPath = path.join(docDir, folderPart, filePart);
                try {
                    await fs_1.promises.access(targetPath); // existence check
                    // create a command URI with encoded args: [docUriStr, startOffset, endOffset, targetPath]
                    const args = [document.uri.toString(), matchIndex, matchIndex + fullMatch.length, targetPath];
                    const encodedArgs = encodeURIComponent(JSON.stringify(args));
                    const commandUri = vscode.Uri.parse(`command:prompt-builder.openInlinePeek?${encodedArgs}`);
                    const link = new vscode.DocumentLink(range, commandUri);
                    // set tooltip so users know
                    link.tooltip = `Open referenced file: ${folderPart}/${filePart}`;
                    links.push(link);
                }
                catch {
                    // target missing -> no link
                }
            }
            return links;
        }
    };
    context.subscriptions.push(vscode.languages.registerDocumentLinkProvider({ language: "plaintext", scheme: "file" }, linkProvider));
    // Command that opens inline peek for a tag when user clicks the DocumentLink.
    // The command receives args encoded in the command URI query.
    const openCmd = vscode.commands.registerCommand("prompt-builder.openInlinePeek", async (...maybeArgs) => {
        // When command is invoked via a DocumentLink, the argument is provided as a single JSON array element
        // (encoded), so handle both cases:
        let args = [];
        if (maybeArgs.length === 1 && typeof maybeArgs[0] === "string") {
            try {
                args = JSON.parse(maybeArgs[0]);
            }
            catch {
                // fallback: if command invocation passed actual args array, use that
                try {
                    args = maybeArgs;
                }
                catch {
                    args = [];
                }
            }
        }
        else {
            args = maybeArgs;
        }
        if (!Array.isArray(args) || args.length < 4) {
            vscode.window.showErrorMessage("Invalid arguments for inline preview command.");
            return;
        }
        const [docUriStr, startOffset, endOffset, targetPath] = args;
        try {
            const docUri = vscode.Uri.parse(docUriStr);
            const key = makeKey(docUri, startOffset);
            // Build a virtual URI for the content provider
            const virtualUri = vscode.Uri.parse(`${PREVIEW_SCHEME}://preview/${encodeURIComponent(path.basename(targetPath))}?target=${encodeURIComponent(targetPath)}`);
            // Ensure the source document is visible, then get position inside it
            const doc = await vscode.workspace.openTextDocument(docUri);
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            const pos = doc.positionAt(startOffset);
            // Build a Location referencing the virtual document (start at 0:0 inside it)
            const loc = new vscode.Location(virtualUri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)));
            // Show inline peek with our virtual document under the tag position
            // The "peek" will display our virtual doc contents (provided by the content provider).
            await vscode.commands.executeCommand("editor.action.peekLocations", docUri, pos, [loc], "peek");
            // Mark expanded (we will reconcile expandedKeys from visible editors to be robust)
            expandedKeys.add(key);
            // Update decorations & links
            refreshAllOpenTextEditors();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to open inline preview: ${err?.message ?? String(err)}`);
        }
    });
    context.subscriptions.push(openCmd);
    // Listen to visible editors change to recompute which preview docs are visible,
    // then update expandedKeys accordingly so decorations properly show expanded state.
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(editors => {
        // Rebuild a set of keys present as previews in visible editors
        const presentPreviewKeys = new Set();
        for (const ed of editors) {
            const u = ed.document.uri;
            if (u.scheme === PREVIEW_SCHEME) {
                // our virtual uri uses the following form:
                // prompt-builder-preview://preview/<basename>?target=<absPath>
                // we can read query param 'target' and try to map back to keys by scanning open text documents
                const params = new URLSearchParams(u.query);
                const target = params.get("target");
                if (!target)
                    continue;
                // We need to find which tag (document + offset) caused this preview.
                // It's simpler to mark expandedKeys by scanning all open text documents for tags that point to this target,
                // and add keys for their start offsets. This is a best-effort approach.
                for (const doc of vscode.workspace.textDocuments) {
                    if (doc.uri.scheme !== "file" || !doc.fileName.endsWith(".txt"))
                        continue;
                    const text = doc.getText();
                    let match;
                    while ((match = TAG_REGEX.exec(text))) {
                        const folderPart = match[1].trim();
                        const filePart = match[2].trim();
                        const matchIndex = match.index;
                        const docDir = path.dirname(doc.uri.fsPath);
                        const candidate = path.join(docDir, folderPart, filePart);
                        if (path.resolve(candidate) === path.resolve(target)) {
                            presentPreviewKeys.add(makeKey(doc.uri, matchIndex));
                        }
                    }
                }
            }
        }
        // Replace expandedKeys with presentPreviewKeys
        expandedKeys.clear();
        for (const k of presentPreviewKeys)
            expandedKeys.add(k);
        // Refresh decorations & links
        refreshAllOpenTextEditors();
    }));
    // Also refresh when documents change, or when user explicitly triggers refreshEmitter
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(ev => {
        // On edits, links / decorations may change. Refresh for the affected document if visible.
        const active = vscode.window.activeTextEditor;
        if (active && active.document === ev.document) {
            refreshAllOpenTextEditors();
        }
    }));
    // Helper: refresh decorations & (document links provider via its event)
    function refreshAllOpenTextEditors() {
        // trigger DocumentLinkProvider refresh
        refreshEmitter.fire();
        // update decorations for all visible editors
        for (const ed of vscode.window.visibleTextEditors) {
            if (ed.document.languageId !== "plaintext" || !ed.document.fileName.endsWith(".txt")) {
                ed.setDecorations(existingFileDecoration, []);
                ed.setDecorations(expandedDecoration, []);
                continue;
            }
            const text = ed.document.getText();
            const fileDecos = [];
            const expDecos = [];
            let match;
            while ((match = TAG_REGEX.exec(text))) {
                const fullMatch = match[0];
                const folderPart = match[1].trim();
                const filePart = match[2].trim();
                const matchIndex = match.index;
                const start = ed.document.positionAt(matchIndex);
                const end = ed.document.positionAt(matchIndex + fullMatch.length);
                const range = new vscode.Range(start, end);
                const docDir = path.dirname(ed.document.uri.fsPath);
                const targetPath = path.join(docDir, folderPart, filePart);
                try {
                    // existence check
                    // (do not await inside loop for performance; use sync fs access via promises but allow catching)
                    // Here we use fs.access (async) but executed sequentially - it's OK for typical files. For huge docs, optimize later.
                    // To keep code simple we await here.
                    // If you want non-blocking, we can batch checks outside.
                    // Keep the current approach for correctness.
                }
                catch {
                    // placeholder
                }
                // Use fs.accessSync-like check via try/catch by reading stat asynchronously but awaited.
                // We'll actually perform an await access here to ensure link/decoration correctness.
            }
            // Because we didn't actually check existence above (to avoid multiple awaits inside the loop),
            // we will now re-run the loop synchronously but with awaits so presence is accurate.
            // (This keeps semantics correct; the visible editor count is small so cost is acceptable.)
            (async () => {
                const text2 = ed.document.getText();
                const fileDecos2 = [];
                const expDecos2 = [];
                let m;
                while ((m = TAG_REGEX.exec(text2))) {
                    const fullMatch = m[0];
                    const folderPart = m[1].trim();
                    const filePart = m[2].trim();
                    const matchIndex = m.index;
                    const start = ed.document.positionAt(matchIndex);
                    const end = ed.document.positionAt(matchIndex + fullMatch.length);
                    const range = new vscode.Range(start, end);
                    const docDir = path.dirname(ed.document.uri.fsPath);
                    const targetPath = path.join(docDir, folderPart, filePart);
                    try {
                        await fs_1.promises.access(targetPath);
                        fileDecos2.push({ range });
                        const key = makeKey(ed.document.uri, matchIndex);
                        if (expandedKeys.has(key)) {
                            expDecos2.push({ range });
                        }
                    }
                    catch {
                        // skip
                    }
                }
                ed.setDecorations(existingFileDecoration, fileDecos2);
                ed.setDecorations(expandedDecoration, expDecos2);
            })();
        }
    }
    // initial refresh
    refreshAllOpenTextEditors();
    // cleanup on deactivate
    context.subscriptions.push({
        dispose() {
            existingFileDecoration.dispose();
            expandedDecoration.dispose();
            refreshEmitter.dispose();
            expandedKeys.clear();
        }
    });
}
function deactivate() {
    // nothing required; disposables will be cleaned up
}
//# sourceMappingURL=extension.js.map