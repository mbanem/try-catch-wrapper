import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';

interface TInspectionResult {
  handlerImplementationOK: boolean;
  globalDeclarationOK: boolean;
  handlerFilePath: string;
  handlerSrcFilePath: string;
  handlerExported: boolean;
}

let inDevelopmentMode = false;
let rootUri: vscode.Uri | undefined;

const found: TInspectionResult = {
  handlerImplementationOK: false,
  globalDeclarationOK: false,
  handlerFilePath: '',
  handlerSrcFilePath: '',
  handlerExported: false,
};

export const capitalizes = (str: string) => {
  if (!str) {
    return;
  }
  str = str.replace(/_/gm, ' ').trim();
  let s = (str[0] as string)?.toUpperCase() + str.slice(1);
  return s.replace(/\s+[a-z](?=[a-z]{2})/g, (char: string) => char.toUpperCase());
};

const channel = vscode.window.createOutputChannel('loadMainMarkup');
const channelShow = (msg: string | string[], show: boolean = false) => {
  channel.appendLine(Array.isArray(msg) ? msg.join('\n') : msg);
  if (show) {
    channel.show();
  }
};

// Helper to safely read a file as a string using the VS Code cross-platform File System API
async function readFileContent(uri: vscode.Uri): Promise<string | null> {
  try {
    const fileBuffer = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(fileBuffer).toString('utf-8');
  } catch {
    return null;
  }
}

// Helper to safely write/overwrite files cross-platform
async function writeFileContent(uri: vscode.Uri, content: string): Promise<boolean> {
  // channelShow(`writeFileContent into ${uri.fsPath}`, true);
  try {
    const fileBuffer = Buffer.from(content, 'utf-8');
    await vscode.workspace.fs.writeFile(uri, fileBuffer);
    return true;
  } catch (err) {
    console.error(`Failed to write file to ${uri.toString()}`, err);
    return false;
  }
}

// Automatically creates or updates support files inside WSL
async function setupSupportFiles(): Promise<void> {
  if (!rootUri) {
    channelShow('setupSupportFiles -- no rootUri', true);
    return;
  }

  // Setup src/lib/utils/helpers.ts
  if (!found.handlerImplementationOK) {
    const helpersUri = vscode.Uri.joinPath(rootUri, 'src/lib/utils/helpers.ts');
    const defaultHelpersContent = `
/* try/catch block sends error object and a function name, in
  which it is defined, to the handleTryCatch function, which
  outputs via console.log the function name and error message
  to reveal the function in which the error occured.
*/

export type THandleTryCatch = (err: unknown, info?: string) => void;
export const handleTryCatch = (err: unknown, info?: string) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(info, msg)
}
\n
`;
    let content = await readFileContent(helpersUri);
    if (content) {
      const updatedContent = defaultHelpersContent + content;
      if (!await writeFileContent(helpersUri, updatedContent)) {
        channelShow(`Failed to define handleTryCatch in ${helpersUri.fsPath}`, true);
      }
    } else {
      await writeFileContent(helpersUri, defaultHelpersContent);
    }
  }

}

// Looks backward through text block to determine what function scopes the selection
function extractFunctionName(document: vscode.TextDocument, selection: vscode.Selection): string {
  const startLine = selection.start.line;
  // Look up to 40 lines backward from selection start to locate parent function block signature
  const maxSearchLines = Math.max(0, startLine - 40);

  // Regular expressions parsing classic signatures or standard arrow syntax names
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

function findEnclosingFunction(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | undefined {
  let candidate: vscode.DocumentSymbol;
  for (const symbol of symbols) {
    if (!symbol.range.contains(position)) {
      continue;
    }

    // Search children first to find a nested function.
    const nested = findEnclosingFunction(
      symbol.children,
      position
    );

    if (nested) {
      return nested;
    }

    if (symbol.kind === vscode.SymbolKind.Function) {
      return symbol;
    }
    if (symbol.kind === vscode.SymbolKind.Constant) {
      candidate = symbol;
    }
  }
  const editor = vscode.window.activeTextEditor as vscode.TextEditor;

  return undefined;
}

async function getWorkspaceRootUri(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    if (inDevelopmentMode) {
      return vscode.Uri.file('/home/mili/test-apps/try-catch-wrapper');
    }
    return undefined;
  }

  if (folders.length > 1) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const activeWorkspace = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (activeWorkspace) {
        // channelShow(`workspace found ${JSON.stringify(activeWorkspace.uri)}`, true);
        return activeWorkspace.uri;
      }
    }
  }

  return folders[0].uri;
}

// check if some statement has THandleTryCatch returning boolean
function inspectHandlerType(
  sourceFile: ts.SourceFile
): boolean {

  return sourceFile.statements.some(statement =>
    ts.isTypeAliasDeclaration(statement) &&
    statement.name.text === 'THandleTryCatch'
  );
}

// return two booleans {found, exported} check if defined and exported as well
function inspectHandlerImplementation(
  sourceFile: ts.SourceFile
): { found: boolean; exported: boolean } {

  for (const statement of sourceFile.statements) {

    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'handleTryCatch' &&
      statement.body && statement.body.statements.length
    ) {
      const exported = statement.modifiers?.some(
        modifier => modifier.kind === ts.SyntaxKind.ExportKeyword
      ) ?? false;

      return { found: true, exported };
    }

    if (ts.isVariableStatement(statement)) {

      const exported = statement.modifiers?.some(
        modifier => modifier.kind === ts.SyntaxKind.ExportKeyword
      ) ?? false;

      for (const declaration of statement.declarationList.declarations) {

        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'handleTryCatch' &&
          declaration.initializer &&
          (
            ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer)
          )
        ) {
          return { found: true, exported };
        }
      }
    }
  }

  return { found: false, exported: false };
}

async function manageHookFiles(
  uri: vscode.Uri,
  content: string | null,
  CSType: string,
  correctPath: string
): Promise<void> {
  // Define the exact initialization template to append
  const initTemplate = `
//  ${CSType}-side global handleTryCatch definition
export const init: ${CSType}Init = () => {
  globalThis.handleTryCatch = handleTryCatch;
};`;

  let updatedContent = '';

  // File doesn't exist, create a brand new one
  if (content === null) {
    updatedContent = `import type { ${CSType}Init } from '@sveltejs/kit';
import { handleTryCatch } from '${correctPath}';
${initTemplate}
`;
  } else {
    // File exists, inspect and update it
    updatedContent = content;

    // Manage the @sveltejs/kit type import
    const importRegex = new RegExp(`import\\s+type\\s+\\{\\s*${CSType}Init\\s*\\}\\s+from\\s+['"]@sveltejs/kit['"];?`);
    if (!importRegex.test(updatedContent)) {
      // Prepend the type import if missing
      updatedContent = `import type { ${CSType}Init } from '@sveltejs/kit';\n` + updatedContent;
    }

    // Manage the handleTryCatch import and its path
    const handlerImportRegex = /import\s+\{\s*handleTryCatch\s*\}\s+from\s+['"]([^'"]+)['"];?/;
    const match = updatedContent.match(handlerImportRegex);

    if (match) {
      const currentPath = match[1];
      if (currentPath !== correctPath) {
        // Path is incorrect -> replace it with the correct one
        updatedContent = updatedContent.replace(
          handlerImportRegex,
          `import { handleTryCatch } from '${correctPath}';`
        );
      }
    } else {
      // Import is missing entirely -> prepend it
      updatedContent = `import { handleTryCatch } from '${correctPath}';\n` + updatedContent;
    }

    // Manage the global init assignment block
    // Checks if 'globalThis.handleTryCatch = handleTryCatch' is already present
    if (!updatedContent.includes('globalThis.handleTryCatch = handleTryCatch')) {
      // Append to the end of the file safely ensuring a trailing newline
      if (!updatedContent.endsWith('\n')) {
        updatedContent += '\n';
      }
      updatedContent += initTemplate + '\n';
    }
  }

  // Write the file back to the workspace via VS Code File System API
  await writeFileContent(uri, updatedContent);
}

// set global handler in app root hooks.client/server.ts files
async function setHooksFiles() {
  // channelShow('setting hooks.client/server.ts files', true);

  // Use lowercase keys for the filenames to match SvelteKit standards
  for (const cs of ['client', 'server']) {
    // Point joinPath to the exact 'src/' subfolder location
    const uri = vscode.Uri.joinPath(rootUri as vscode.Uri, 'src', `hooks.${cs}.ts`);

    // Capitalize just the type token for the template ('Client' or 'Server')
    const CS = capitalizes(cs) as string;

    const content = await readFileContent(uri);
    await manageHookFiles(uri, content, CS, found.handlerFilePath);
  }
}

// inspect app.d.ts file for global declaration
function inspectGlobalDeclaration(
  sourceFile: ts.SourceFile
): boolean {

  function visit(node: ts.Node): boolean {

    if (
      ts.isModuleDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'global' &&
      node.body
    ) {
      let found = false;

      function inspectGlobalBody(child: ts.Node): void {

        if (
          ts.isVariableDeclaration(child) &&
          ts.isIdentifier(child.name) &&
          child.name.text === 'handleTryCatch'
        ) {
          found = true;
        }

        // recursive call to see if any could set found to true
        ts.forEachChild(child, inspectGlobalBody);
      }

      // and a final check
      inspectGlobalBody(node.body);

      if (found) {
        return true;
      }
    }

    let found = false;

    ts.forEachChild(node, child => {
      if (visit(child)) {
        found = true;
      }
    });

    return found;
  }

  return visit(sourceFile);
}
async function redeclareHandler(content: string) {
  let cleanContent = content
    .split('\n')
    .filter(line => !/(TH|h)andleTryCatch/.test(line))
    .join('\n');

  // declatarion
  const newDeclaration = `export type THandleTryCatch = (err: unknown, info?: string) => void;\ndeclare global {\n\tvar handleTryCatch: THandleTryCatch;`;
  return cleanContent.replace(/^\s*declare global\s*\{\s*$/m, newDeclaration);
}
async function manageAppDTsFile(uri: vscode.Uri) {
  const content = await readFileContent(uri);
  const newDeclare = `export type THandleTryCatch = typeof handleTryCatch;
declare global {
  var handleTryCatch: THandleTryCatch;
}
`;
  if (content) {
    await writeFileContent(uri, await redeclareHandler(content));
  } else {
    await writeFileContent(uri, newDeclare);
  }
}

// examine all the files from workspace creating their ASt for search
async function inspectWorkspace(
  root: vscode.Uri
): Promise<TInspectionResult> {

  // to check for handleTryCatch: THandleTryCatch defined anywhere in the 
  // workspace we collect all the files of the given type to build an AST.
  // The findFiles returns Thenable<vscode.Uri[]> so we await
  const files = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx}',
    '**/{node_modules,.svelte-kit,build,dist,coverage}/**'
  );

  // work on individual files
  for (const uri of files) {

    // Do not inspect files outside the selected workspace root.
    if (!uri.fsPath.startsWith(root.fsPath)) {
      continue;
    }

    // we need file content for AST and for other processing as well
    let content: string;

    try {
      // read the file content so we can build AST to examine their content
      // via VSCode instead of individulaly via RegExp for all the syntaxes
      const bytes = await vscode.workspace.fs.readFile(uri);
      content = Buffer.from(bytes).toString('utf8');
    } catch (error) {
      console.error(`Unable to read ${uri.fsPath}`, error);
      // ignore this file and continue
      continue;
    }

    // looks like an AST is created in order for VSCode to examine its
    // ts. functions and constants for array functions in the tree
    const sourceFile = ts.createSourceFile(
      uri.fsPath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    // check if THandleTryCathc type is defined in this source file
    // though it should be inside app.d.ts file ?
    if (inspectHandlerType(sourceFile)) { // returns boolean
      // its path could be used for import type in app.d.ts
      const rp = path.relative((rootUri as vscode.Uri).fsPath, uri.fsPath);
    }

    // maybe some of the examined functions already had implementation
    // and if not we continue checking incomming files
    if (!found.handlerImplementationOK) {
      // this will test if the function is exported, not only defined
      const handler = inspectHandlerImplementation(sourceFile);
      if (handler.found && handler.exported) {
        const rp = path.relative((rootUri as vscode.Uri).fsPath, uri.fsPath);
        found.handlerImplementationOK = true;
        found.handlerSrcFilePath = rp;

        // as handler file is found its relative path will be used for hooks.client/server
        // import { handleTryCatch } from `${found.handlerFilePath}`
        found.handlerFilePath = rp.replace(/\s*\/?src/, '.');
        found.handlerExported = handler.exported;
        if (!found.handlerExported) {
          vscode.window.showInformationMessage(`The handleTryCatch implementation is
  found at ${found.handlerSrcFilePath}
  but is not exported as should be.
  We will continue but please fix it.`,
            { modal: true },
            'OK'
          );
        }
        // there is enough information to handle hooks.client/server.ts files
        await setHooksFiles();
      }
    }

    if (
      !found.globalDeclarationOK &&
      uri.fsPath.endsWith('.d.ts')
    ) {
      // check if handleTryCatch is defined in *.d.ts
      found.globalDeclarationOK =
        inspectGlobalDeclaration(sourceFile);
      // *.d.ts should get new declaration as it is missing one
      // as the file could be global.d.ts or app.d.ts send its uri
      manageAppDTsFile(uri);
    }
  } // end of main 'for loop'
  return found;
}

// async function wrapSelectedBolck(editor: vscode.TextEditor) {
//   // channelShow('User refused setting global handler', true);
//   const position = editor.selection.active;

//   const symbols =
//     await vscode.commands.executeCommand<
//       vscode.DocumentSymbol[] | undefined
//     >(
//       'vscode.executeDocumentSymbolProvider',
//       editor.document.uri
//     );
//   // channelShow(`Symbols found ${(symbols as vscode.DocumentSymbol[]).length} symbols`, true);
//   const fn = findEnclosingFunction(
//     symbols ?? [],
//     position
//   );
//   let funcName = '';  // looks like both should be used findEnclosingFunction and extractFunctionName
//   if (fn) {
//     funcName = fn.name;
//   } else {
//     funcName = extractFunctionName(editor?.document, editor?.selection);
//   }

//   if (!funcName) {
//     channelShow('No enclosing function declaration was found.', true);
//     return;
//   }

//   const snippet = new vscode.SnippetString();

//   snippet.appendText('try {\n\t');
//   snippet.appendVariable('TM_SELECTED_TEXT', 'function name here');
//   snippet.appendText('\n} catch (err: unknown) {\n\thandleTryCatch(err, \'');

//   // The function name is the default value of an editable placeholder.
//   snippet.appendPlaceholder(funcName);

//   snippet.appendText("');\n}");

//   await editor.insertSnippet(snippet);

// }

async function wrapSelectedBlock(editor: vscode.TextEditor): Promise<void> {
  const position = editor.selection.active;

  // Retrieve document symbols via the official VS Code built-in provider
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
    'vscode.executeDocumentSymbolProvider',
    editor.document.uri
  );

  // 1. Resolve the parent function name using AST first, falling back to manual regex lookup
  const enclosingSymbol = findEnclosingFunction(symbols ?? [], position);
  let funcName = enclosingSymbol ? enclosingSymbol.name : '';

  if (!funcName) {
    funcName = extractFunctionName(editor.document, editor.selection);
  }

  if (!funcName) {
    channelShow('No enclosing function declaration was found.', true);
    return;
  }

  // 2. Identify the base line indentation of the selection start
  const firstLineText = editor.document.lineAt(editor.selection.start.line).text;
  const matchIndentation = firstLineText.match(/^\s*/);
  const baseIndent = matchIndentation ? matchIndentation[0] : '';
  const bodyIndent = baseIndent + (editor.options.insertSpaces ? ' '.repeat(editor.options.tabSize as number) : '\t');

  // 3. Process the selected text line by line to maintain robust indentation
  const selectedText = editor.document.getText(editor.selection);
  const lines = selectedText.split(/\r?\n/);
  const indentedBody = lines
    .map((line, index) => (index === 0 && line.startsWith(baseIndent) ? line.slice(baseIndent.length) : line))
    .map(line => bodyIndent + line)
    .join('\n');

  // 4. Construct the custom SnippetString cleanly
  const snippet = new vscode.SnippetString();
  snippet.appendText(`${baseIndent}try {\n`);
  snippet.appendText(`${indentedBody}\n`);
  snippet.appendText(`${baseIndent}} catch (err: unknown) {\n`);
  snippet.appendText(`${bodyIndent}handleTryCatch(err, '`);

  // The function name is an editable placeholder, making it easy to rename via Tab
  snippet.appendPlaceholder(funcName);

  snippet.appendText(`');\n${baseIndent}}\n`);

  // Replace the user's selection with the formatted snippet block
  await editor.insertSnippet(snippet, editor.selection);
}
// initial call after registering extension

// async function wrapTryCatch(): Promise<void> {
//   const editor = vscode.window.activeTextEditor;
//   let msg = '';
//   // there must be active code with part of function body selected to wrap it in try/catch
//   if (!editor) {
//     msg = 'No active code windows open.';
//   } else if (!['typescript', 'javascript', 'svelte'].includes(editor.document.languageId)) {
//     msg = 'Supported typescript, javascript and Svelte';
//   } else if (!editor.selections.some(selection => !selection.isEmpty)) {
//     msg = 'There should be some code selected...';
//   }
//   if (msg) {
//     vscode.window.showErrorMessage(msg, { modal: true }, 'OK');
//     return;
//   }

//   // in order to examine files for definitions get rootUri first
//   rootUri = await getWorkspaceRootUri();
//   if (!rootUri) {
//     channelShow('Unable to get workspace root folder\nfrom the menu select File->Save Workspace As...\nand navigate to the app root and save it', true);
//     return;
//   }

//   await inspectWorkspace(rootUri);

//   await wrapSelectedBolck(editor as vscode.TextEditor);
// }
// export function activate(context: vscode.ExtensionContext) {
//   const disposable = vscode.commands.registerCommand('try-catch-wrapper.extension', wrapTryCatch);
//   context.subscriptions.push(disposable);
// }

// export function deactivate() { }
// Entry gate for execution triggers
async function wrapTryCatch(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let validationMessage = '';

  // 1. Ensure a clear code frame and file type match are active
  if (!editor) {
    validationMessage = 'No active code windows open.';
  } else if (!['typescript', 'javascript', 'svelte', 'typescriptreact', 'javascriptreact'].includes(editor.document.languageId)) {
    validationMessage = 'Supported file types: TypeScript, JavaScript, and Svelte.';
  } else if (!editor.selections.some(selection => !selection.isEmpty)) {
    validationMessage = 'Please select a code block to wrap inside a try/catch container.';
  }

  if (validationMessage) {
    // Note: Modal set to true always appends a standard 'Cancel' button natively
    vscode.window.showErrorMessage(validationMessage, { modal: true }, 'OK');
    return;
  }

  // 2. Retrieve and validate the target workspace root folder
  rootUri = await getWorkspaceRootUri();
  if (!rootUri) {
    channelShow(
      'Unable to locate workspace root folder.\nPlease use File -> Save Workspace As... to navigate and bind your application root folder.',
      true
    );
    return;
  }

  // 3. Audit structural configuration scripts (hooks, app.d.ts, implementation checks)
  await inspectWorkspace(rootUri);

  // 4. Execute final code conversion transformations
  await wrapSelectedBlock(editor as vscode.TextEditor);
}

// Extension Activation Lifecycle Hook
export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('try-catch-wrapper.extension', wrapTryCatch);
  context.subscriptions.push(disposable);
}

// Extension Deactivation Lifecycle Hook
export function deactivate(): void { }