import * as vscode from 'vscode';
import * as path from 'path';

interface IAppState {
  handlerImplementationOK: boolean;
  globalDeclarationOK: boolean;
  handlerFilePath: string;
  makeGlobalLog: boolean;
  handlerExported: boolean;
  importUri: vscode.Uri | undefined;
  importHandlerDefined: boolean;  // to announce it is installed
  cancelApp: boolean; // could not continue as user app has problem
}

let rootUri: vscode.Uri | undefined;
let position: vscode.Position | undefined = undefined
let logLine = ''
let declareGlobal = ''
const setupGlobalLog = 'Yes, Setup Global log/err'

const initialState: IAppState = {
  handlerImplementationOK: false,
  globalDeclarationOK: false,
  handlerFilePath: '',
  makeGlobalLog: false,
  handlerExported: false,
  importUri: undefined,
  importHandlerDefined: false,
  cancelApp: false,
};
let state: IAppState = initialState

function importPath(currentEditorUri: vscode.Uri): string | undefined {
  if (!state.importUri) {
    return undefined;
  }
  // 1. Get the folder of the currently open file
  const currentDir = path.dirname(currentEditorUri.fsPath);

  // 2. Calculate the relative path directly to state.importUri (this keeps the filename!)
  let relativePath = path.relative(currentDir, state.importUri.fsPath);

  // 3. Convert Windows backslashes (\) to forward slashes (/)
  relativePath = relativePath.replace(/\\/g, '/');

  // 4. Strip the .ts / .js extension for valid JS/TS import syntax
  relativePath = relativePath.replace(/\.(ts|tsx|js|jsx)$/, '');

  // 5. Ensure same-folder imports start with './' (e.g., './index' instead of 'index')
  if (!relativePath.startsWith('.')) {
    relativePath = `./${relativePath}`;
  }

  return relativePath;
}

const handlerCode = `/*
  try/catch block sends error object and a function name, in
  which it is defined, to the handleTryCatch function, which
  outputs via console.log the function name and error message
  to reveal the function in which the error occurred.
*/

export const handleTryCatch = (err: unknown, info?: string) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(info, msg);
};
`
export const capitalizes = (str: string) => {
  if (!str) {
    return;
  }
  str = str.replace(/_/gm, ' ').trim();
  let s = (str[0] as string)?.toUpperCase() + str.slice(1);
  return s.replace(/\s+[a-z](?=[a-z]{2})/g, (char: string) => char.toUpperCase());
};

const channel = vscode.window.createOutputChannel('TryCatchWrapper');
const channelShow = (msg: string | string[], show: boolean = false) => {
  channel.appendLine(Array.isArray(msg) ? msg.join('\n') : msg);
  channel.show();
};

async function readFileContent(uri: vscode.Uri): Promise<string | null> {
  try {
    const fileBuffer = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(fileBuffer).toString('utf-8');
  } catch {
    return null;
  }
}

async function writeFileContent(uri: vscode.Uri, content: string): Promise<boolean> {
  try {
    const fileBuffer = Buffer.from(content, 'utf-8');
    await vscode.workspace.fs.writeFile(uri, fileBuffer);
    return true;
  } catch (err) {
    console.error(`Failed to write file to ${uri.toString()}`, err);
    return false;
  }
}

async function setupSupportFiles(): Promise<void> {
  if (state.importUri) {
    return
  }
  if (!rootUri) {
    return;
  }

  if (!state.handlerFilePath) {
    const helpersUri = vscode.Uri.joinPath(rootUri, 'src/lib/utils/helpers.ts');
    state.handlerFilePath = './lib/utils/helpers.ts'

    const defaultHelpersContent = handlerCode

    let content = await readFileContent(helpersUri);
    if (content) {
      const updatedContent = defaultHelpersContent + content;
      if (!await writeFileContent(helpersUri, updatedContent)) {
        channelShow(`Failed to define handleTryCatch in ${helpersUri.fsPath}`);
      }
    } else {
      await writeFileContent(helpersUri, defaultHelpersContent);
    }
  }
}

function extractFunctionName(document: vscode.TextDocument, selection: vscode.Selection): string {

  const startLine = selection.start.line;
  const maxSearchLines = Math.max(0, startLine - 40);

  const namedFuncRegex = /(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/;
  const arrowFuncRegex = /(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([\s\S]*?\)\s*=>/;
  const svelteMethodRegex = /([a-zA-Z0-9_$]+)\s*\([\s\S]*?\)\s*\{/;

  for (let i = startLine; i >= maxSearchLines; i--) {
    const lineText = document.lineAt(i).text;

    let match = namedFuncRegex.exec(lineText);
    if (match && match[1]) {
      return match[1];
    }

    match = arrowFuncRegex.exec(lineText);
    if (match && match[1]) {
      return match[1];
    }

    match = svelteMethodRegex.exec(lineText);
    if (match && match[1]) {
      return match[1];
    }
  }
  return 'anonymous context';
}

// position is acquired at the very beginning and kept 
// as global until a new execution starts to avoid
// changing position meanwhile
function findEnclosingFunction(
  symbols: vscode.DocumentSymbol[]
): vscode.DocumentSymbol | undefined {
  let candidate: vscode.DocumentSymbol | undefined;
  for (const symbol of symbols) {
    if (!symbol.range.contains(position!)) {
      continue;
    }

    const nested = findEnclosingFunction(symbol.children);
    if (nested) {
      return nested;
    }

    if (symbol.kind === vscode.SymbolKind.Function || symbol.kind === vscode.SymbolKind.Method) {
      return symbol;
    }
    if (symbol.kind === vscode.SymbolKind.Variable || symbol.kind === vscode.SymbolKind.Constant) {
      candidate = symbol;
    }
  }
  return candidate;
}

// the essential call
async function getWorkspaceRootUri(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  if (folders.length > 1) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const activeWorkspace = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (activeWorkspace) {
        return activeWorkspace.uri;
      }
    }
  }

  return folders[0].uri;
}


// More resilient regex supporting type annotations and spacing
function hasHandlerImplementation(content: string): { found: boolean; exported: boolean } {
  const hasHandlerDef = /(?:function\s+handleTryCatch|const\s+handleTryCatch\s*[:=]|let\s+handleTryCatch\s*[:=])/.test(content);
  const isExported = /export\s+(?:function\s+handleTryCatch|const\s+handleTryCatch|const\s+\w+\s*:\s*THandleTryCatch)/.test(content) ||
    /export\s*\{\s*handleTryCatch\s*\}/.test(content);

  return { found: hasHandlerDef, exported: isExported };
}
function inspectGlobalDeclaration(content: string): boolean {
  return content.includes('var handleTryCatch') || content.includes('handleTryCatch:');
}

// creating new or updating the existing including updating
// import path when handler is moved accross the files
async function manageHookFiles(
  uri: vscode.Uri,
  content: string | null,
  CSType: string,
  correctPath: string
): Promise<void> {

  const initTemplate = `
//  ${CSType}-side global handleTryCatch definition
export const init: ${CSType}Init = () => {
  globalThis.handleTryCatch = handleTryCatch;
};`;

  let updatedContent = content || '';

  const importRegex = new RegExp(`import\\s+type\\s+\\{\\s*${CSType}Init\\s*\\}\\s+from\\s+['"]@sveltejs/kit['"];?`);

  // if import Client/ServerInit from @sveltejs/kit is missing prepend a new one
  if (!importRegex.test(updatedContent)) {
    updatedContent = `import type { ${CSType}Init } from '@sveltejs/kit';\n` + updatedContent;
  }

  const handlerImportRegex = /import\s+\{\s*handleTryCatch\s*\}\s+from\s+['"]([^'"]+)['"];?/;
  const match = updatedContent.match(handlerImportRegex);

  // if import handler has a different path update it
  if (match) {  // match succeeded now see if paths are different
    if (match[1] !== correctPath) {
      updatedContent = updatedContent.replace(match[1], correctPath);
    }
  } else {  // match did not succeed, so it is missing and we add a new one
    updatedContent = `import { handleTryCatch } from '${correctPath}';\n` + updatedContent;
  }

  if (!updatedContent.includes('globalThis.handleTryCatch = handleTryCatch')) {
    if (!updatedContent.endsWith('\n')) {
      updatedContent += '\n';
    }
    updatedContent += initTemplate + '\n';
  }

  await writeFileContent(uri, updatedContent);
}

async function setHooksFiles() {

  for (const cs of ['client', 'server']) {
    const uri = vscode.Uri.joinPath(rootUri as vscode.Uri, 'src', `hooks.${cs}.ts`);
    const CS = capitalizes(cs) as string;
    const content = await readFileContent(uri);
    await manageHookFiles(uri, content, CS, state.handlerFilePath);
  }
}

// declare global { has different var items
async function redeclareHandler(content: string): Promise<string> {
  //  channelShow(`redeclareHandler`)
  const cleanContent = content
    .split('\n')
    .filter(line => !/(TH|h)andleTryCatch/.test(line))
    .join('\n');

  const newDeclaration = `export type THandleTryCatch = (err: unknown, info?: string) => void;\ndeclare global {\n\tvar handleTryCatch: THandleTryCatch;`;
  if (/declare global\s*\{/.test(cleanContent)) {
    return cleanContent.replace(/declare global\s*\{/, newDeclaration);
  }
  return cleanContent + '\n' + newDeclaration;
}

// 
async function manageAppDTsFile(uri: vscode.Uri) {
  const content = await readFileContent(uri);
  const newDeclare = `export type THandleTryCatch = typeof handleTryCatch;
declare global {
  var handleTryCatch: THandleTryCatch;
`;
  if (content) {
    await writeFileContent(uri, await redeclareHandler(content));
  } else {
    await writeFileContent(uri, newDeclare);
  }
}


async function inspectWorkspace(root: vscode.Uri): Promise<IAppState> {
  const files = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx}',
    '**/{node_modules,.svelte-kit,build,dist,coverage}/**'
  );

  let foundHandlerPath = '';
  let foundExported = false;

  for (const uri of files) {
    if (!uri.fsPath.startsWith(root.fsPath)) {
      continue;
    }

    const content = await readFileContent(uri);
    if (!content) {
      continue;
    }

    // Check for global declaration in .d.ts files
    if (!state.globalDeclarationOK && uri.fsPath.endsWith('.d.ts')) {
      state.globalDeclarationOK = inspectGlobalDeclaration(content);
      await manageAppDTsFile(uri);
    }

    // Scan for handler implementation across files
    const handler = hasHandlerImplementation(content);
    if (handler.found) {
      const rp = path.relative(root.fsPath, uri.fsPath);
      const relativePath = rp.replace(/\s*\/?src/, '.');

      if (handler.exported) {
        foundHandlerPath = relativePath;
        foundExported = true;
        break;
      } else if (!foundHandlerPath) {
        foundHandlerPath = relativePath;
        foundExported = false;
      }
    }
  }

  if (foundHandlerPath) {
    state.handlerImplementationOK = true;
    state.handlerFilePath = foundHandlerPath;
    state.handlerExported = foundExported;

    if (!state.handlerExported) {
      vscode.window.showInformationMessage(
        `The handleTryCatch implementation is at ${state.handlerFilePath} but is not exported. Please export it.`,
        { modal: true },
        'OK'
      );
      state.cancelApp = true;
      return state;
    }
  } else {
    // If helper is not found anywhere, set up default one
    await setupSupportFiles();
  }

  await setHooksFiles();
  return state;
}

// Helper to normalize any URI (WSL remote or local file) for reliable comparison
function isSameFile(uriA: vscode.Uri | undefined, uriB: vscode.Uri | undefined): boolean {
  if (!uriA || !uriB) {
    return false;
  }
  // Comparing .path (always forward slashes) avoids Windows vs WSL scheme mismatches
  return uriA.path.toLowerCase() === uriB.path.toLowerCase();
}

// Pass the validated `editor` directly into this function instead of re-fetching activeTextEditor
async function applyHandlerToEditor(editor: vscode.TextEditor): Promise<void> {
  try {
    const currentUri = editor.document.uri;
    const impPath = importPath(currentUri);

    if (isSameFile(state.importUri, currentUri) && !state.importHandlerDefined) {
      // 1. Initial file: prepend the full handleTryCatch definition
      const inserted = await editor.edit((editBuilder) => {
        editBuilder.insert(new vscode.Position(0, 0), handlerCode);
      });

      if (inserted) {
        await editor.document.save();
        state.importHandlerDefined = true
      } else {
        channelShow('Failed to insert handler code.');
      }
    } else if (impPath) {
      // 2. Other files: prepend ONLY the import statement using editor.edit (never writeFileContent!)
      const importStatement = `import { handleTryCatch } from '${impPath}';\n`;

      // Optional: Prevent duplicate imports if the user runs the command twice on the same file
      if (!editor.document.getText().includes(importStatement.trim())) {
        const inserted = await editor.edit((editBuilder) => {
          editBuilder.insert(new vscode.Position(0, 0), importStatement);
        });

        if (inserted) {
          await editor.document.save();
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    channelShow(`wrapSelectedBlock err: ${msg}`, true);
  }
}
async function wrapSelectedBlock(editor: vscode.TextEditor): Promise<void> {
  applyHandlerToEditor(editor)

  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
    'vscode.executeDocumentSymbolProvider',
    editor.document.uri
  );

  const enclosingSymbol = findEnclosingFunction(symbols ?? []);
  let funcName = enclosingSymbol ? enclosingSymbol.name : '';

  if (!funcName) {
    funcName = extractFunctionName(editor.document, editor.selection);
  }

  if (!funcName) {
    channelShow('No enclosing function declaration was found.', true);
    return;
  }

  const firstLineText = editor.document.lineAt(editor.selection.start.line).text;
  const matchIndentation = firstLineText.match(/^\s*/);
  const baseIndent = '';  //matchIndentation ? matchIndentation[0] : '';
  const bodyIndent = baseIndent + (editor.options.insertSpaces ? ' '.repeat(editor.options.tabSize as number) : '\t');

  const selectedText = editor.document.getText(editor.selection);
  const lines = selectedText.split(/\r?\n/);
  const indentedBody = lines
    .map((line, index) => (index === 0 && line.startsWith(baseIndent) ? line.slice(baseIndent.length) : line))
    .map(line => bodyIndent + line)
    .join('\n');

  const snippet = new vscode.SnippetString();
  snippet.appendText(`${baseIndent}try {
${indentedBody}
${baseIndent}} catch (err: unknown) {
`);
  snippet.appendText(`${bodyIndent}handleTryCatch(err, '`);
  snippet.appendPlaceholder(funcName);
  snippet.appendText(`');${baseIndent}
}; `
  );

  await editor.insertSnippet(snippet, editor.selection);
}


async function varGlobalsFouund(rootUri: vscode.Uri): Promise<vscode.Uri | boolean> {
  for (const p of ['src/app.d.ts', 'src/global.d.ts', 'srx/routes/+layout.svelte']) {
    const varsPath = vscode.Uri.joinPath(rootUri, p)
    if (await readFileContent(varsPath)) {
      return varsPath
    }
  }
  return false
}

async function findHandler(root: vscode.Uri) {
  const files = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx}'
  );
  for (const uri of files) {
    if (!uri.fsPath.startsWith(root.fsPath)) {
      continue;
    }
    const content = await readFileContent(uri);
    if (!content) {
      continue;
    }

    const found = /(?:function\s+handleTryCatch|const\s+handleTryCatch\s*[:=]|let\s+handleTryCatch\s*[:=])/.test(content);
    const exported = /export\s+(?:function\s+handleTryCatch|const\s+handleTryCatch|const\s+\w+\s*:\s*THandleTryCatch)/.test(content) ||
      /export\s*\{\s*handleTryCatch\s*\}/.test(content);
    if (found && exported) {
      state.importUri = uri
      return true
    }
  }
  return false
}

async function wrapTryCatch(): Promise<void> {

  rootUri = await getWorkspaceRootUri();
  if (!rootUri) {
    channelShow(
      'Unable to locate workspace root folder.\nPlease use File -> Save Workspace As... to navigate to it and bind to your application root folder.',
      true
    );
    return;
  }

  // if user launch extension many times in the same app
  // the extension hold the previous state like state.handlerFilePath
  // so such states should be initialized here every time
  const savedImportUri = state.importUri;
  Object.assign(state, initialState);
  state.importUri = savedImportUri;
  const editor = vscode.window.activeTextEditor;
  let validationMessage = '';

  if (!editor) {
    validationMessage = 'No active code windows open.';
  } else if (!['typescript', 'javascript', 'svelte'].includes(editor.document.languageId)) {
    validationMessage = 'Supported file types: TypeScript, JavaScript, and Svelte.';
  } else if (editor.document.languageId !== 'svelte' && !state.importUri) {
    // Only ask on the VERY FIRST non-Svelte execution when importUri is not set yet
    const answer = await vscode.window.showInformationMessage(
      `This is not a Svelte app, but the extension can define:\nexport function handleTryCatch(err: unknown, info?: string) { ... }\nin this page and import it into other pages from here.`,
      { modal: true },
      'OK'
    );

    if (answer === 'OK') {
      // try to find handleTryCatch implementation and put it into state.importUri
      if (!await findHandler(rootUri)) {
        state.importUri = editor.document.uri;
      }
    } else {
      // User clicked Cancel or pressed Esc
      return;
    }
  }

  if (validationMessage) {
    vscode.window.showErrorMessage(validationMessage, { modal: true }, 'OK');
    return;
  }

  // @ts-expect-error though above is test if (!editor) { with return before this statement
  // take position early as cursor could move before searching for enclosing function
  position = editor.selection.active as vscode.Position;

  if (!state.importUri) {
    // is there any app.d.ts, global.d.ts or /routes/+layout.svelte
    // where declare global { exists to held var handleTryCatch, log and err
    const varsPath = await varGlobalsFouund(rootUri)
    if (!varsPath) {
      // this question must be asked somewhere so ask here
      const answer = await vscode.window.showInformationMessage(
        'Should setup global log/err (console.log/error) for this project?',
        { modal: true },
        setupGlobalLog,
      )// based on the answer prepare globals for log and err or left an empty string
      logLine = (answer !== setupGlobalLog) ? '' :
        `var log: typeof console.log
var err: typeof console.error; `
      declareGlobal = `export type THandleTryCatch = typeof handleTryCatch
declare global {
  ${logLine}
  var handleTryCatch: THandleTryCatch
  `;

      const appdtsUri = vscode.Uri.joinPath(rootUri, 'src', 'app.d.ts')
      state.makeGlobalLog = false;  // it is just done
      // NOTE declareGlobal has no closing curly bracket
      await writeFileContent(appdtsUri, declareGlobal + '}')
    }

    // search for export const/func handleTryCatch implementatioin
    await inspectWorkspace(rootUri);
  }
  await wrapSelectedBlock(editor as vscode.TextEditor);
}

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('try-catch-wrapper.extension', wrapTryCatch);
  context.subscriptions.push(disposable);
}

export function deactivate(): void { }