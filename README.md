# Tag Highlighter

Highlights custom tags like `<<name>>` in plaintext files.

## Features
- Scans `.txt` (plaintext) files and highlights tags using a regex.
- Customizable regex & colors via settings.

## Settings
- `tagHighlighter.pattern` (default: `<<[^<>]+?>>`)
- `tagHighlighter.borderColor` (default: `#FFB300`)
- `tagHighlighter.backgroundColor` (default: `#FFF3CD66`)

## Run / Debug
1. `npm install`
2. Press **F5** in VS Code to launch the Extension Development Host.
3. Open a `.txt` file and type `<<name>>` to see the highlight.

## Package
- `npm run compile`
- `npx vsce package` → installs as a `.vsix`
