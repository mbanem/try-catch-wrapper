import * as vscode from 'vscode';

let inDevelopmentMode = false;
let rootUri: vscode.Uri | undefined;

let handlerOK = false;
let declareHandlerDtsOK = false;
let globalHandlerOK = false;

// Helper to safely read a file as a string using the VS Code cross-platform FS API
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
	try {
		const fileBuffer = Buffer.from(content, 'utf-8');
		await vscode.workspace.fs.writeFile(uri, fileBuffer);
		return true;
	} catch (err) {
		console.error(`Failed to write file to ${uri.toString()}`, err);
		return false;
	}
}

async function globalDefFound(subPath: string) {
	if (!rootUri) { return false; }

	const fileUri = vscode.Uri.joinPath(rootUri, subPath);
	try {
		const content = await readFileContent(fileUri);

		if (content === null) {
			return false;
		}

		if (subPath.endsWith('.html')) {
			const assignmentRegex = /<script>.*globalThis\.handleTryCatch\s*=\s*(\w+)/ms;
			return assignmentRegex.test(content);
		} else {
			return /.*globalThis\.handleTryCatch\s*=\s*handleTryCatch;/ms.test(content);
		}
	} catch (err: unknown) {
		console.error('Error in globalDefFound:', err);
	}
	return false;
}

async function searchForGlobalDef() {
	let found = false;
	const paths = ['src/routes/+layout.svelte', 'src/main.ts', 'src/hooks.client.ts', 'src/app.html'];
	for (const subPath of paths) {
		if (await globalDefFound(subPath)) {
			found = true;
			break;
		}
	}
	return found;
}

function hasGlobalHandleTryCatch(content: string): boolean {
	const hasImport = /import\s+type\s+\{\s*THandleTryCatch\s*\}\s+from\s+['"]\$lib\/utils\/handleTryCatch['"]/.test(content);
	const hasDeclareGlobal = /declare\s+global\s*\{/.test(content);
	return hasImport && hasDeclareGlobal;
}

async function ishandleTryCatchSet() {
	if (!rootUri) { return false; }

	const funcRex = /\s*export\s+function\s*handleTryCatch\s*\(err\:\s*unknown\, info\?\: string\)/s;
	const arrowRex = /\s*export\s+const\s+handleTryCatch\s*=\s*\(\s*err\:\s*unknown\s*,\s*info\?\:\s*string\s*\)\s*=>/s;

	const helpersUri = vscode.Uri.joinPath(rootUri, 'src/lib/utils/helpers.ts');
	const helpersContent = await readFileContent(helpersUri);

	if (helpersContent === null) {
		handlerOK = false;
	} else {
		const fr = funcRex.test(helpersContent);
		handlerOK = fr || arrowRex.test(helpersContent);
	}

	const appDtsUri = vscode.Uri.joinPath(rootUri, 'src/app.d.ts');
	const appDtsContent = await readFileContent(appDtsUri);

	if (appDtsContent === null) {
		declareHandlerDtsOK = false;
	} else {
		declareHandlerDtsOK = hasGlobalHandleTryCatch(appDtsContent);
	}

	globalHandlerOK = await searchForGlobalDef();
	return handlerOK && declareHandlerDtsOK && globalHandlerOK;
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
				return activeWorkspace.uri;
			}
		}
	}

	return folders[0].uri;
}

// Automatically creates or updates boilerplate files inside WSL
async function setupBoilerplateFiles(): Promise<void> {
	if (!rootUri) { return; }

	// 1. Setup src/lib/utils/helpers.ts
	const helpersUri = vscode.Uri.joinPath(rootUri, 'src/lib/utils/helpers.ts');
	if (!handlerOK) {
		const defaultHelpersContent = `export function handleTryCatch(err: unknown, info?: string) {\n\tconsole.error(\`[Error Context: \${info || 'Unknown'}]\`, err);\n\t// Add custom Svelte 5 / UI notification frameworks here if needed\n}\n\ntype THandleTryCatch = typeof handleTryCatch;\nexport type { THandleTryCatch };\n`;
		await writeFileContent(helpersUri, defaultHelpersContent);
		vscode.window.showInformationMessage('Created src/lib/utils/helpers.ts');
	}

	// 2. Setup src/app.d.ts
	const appDtsUri = vscode.Uri.joinPath(rootUri, 'src/app.d.ts');
	let appDtsContent = await readFileContent(appDtsUri) || '';
	if (!declareHandlerDtsOK) {
		const globalDeclaration = `\nimport type { THandleTryCatch } from '$lib/utils/helpers';\n\ndeclare global {\n\tvar handleTryCatch: THandleTryCatch;\n}\n`;
		appDtsContent += globalDeclaration;
		await writeFileContent(appDtsUri, appDtsContent);
		vscode.window.showInformationMessage('Updated src/app.d.ts with global types');
	}

	// 3. Register globalThis inside src/routes/+layout.svelte (or fallback hooks)
	if (!globalHandlerOK) {
		const layoutUri = vscode.Uri.joinPath(rootUri, 'src/routes/+layout.svelte');
		let layoutContent = await readFileContent(layoutUri) || '';

		const injectionCode = `<script lang="ts">\n\timport { handleTryCatch } from '$lib/utils/helpers';\n\tglobalThis.handleTryCatch = handleTryCatch;\n</script>\n\n`;

		// If layout file exists, prepend script block, otherwise create clean file
		layoutContent = injectionCode + layoutContent;
		await writeFileContent(layoutUri, layoutContent);
		vscode.window.showInformationMessage('Registered global handleTryCatch inside +layout.svelte');
	}
}

async function askUserConfirmation(): Promise<string | undefined> {
	rootUri = await getWorkspaceRootUri();
	if (!rootUri) { return 'No'; }

	await ishandleTryCatchSet();

	if (handlerOK && declareHandlerDtsOK && globalHandlerOK) {
		return 'Yes'; // Everything is already configured smoothly
	}

	const m1 = handlerOK ? '' : 'not';
	const m2 = declareHandlerDtsOK ? '' : 'no';
	const m3 = globalHandlerOK ? 'a' : 'no';

	const selection = await vscode.window.showInformationMessage(
		`We found structural components are missing:\n` +
		`- handler is ${m1} installed,\n` +
		`- app.d.ts contains ${m2} global declaration,\n` +
		`- global assignment is missing in ${m3} entry point.\n\n` +
		`Would you like this extension to automatically configure global handleTryCatch architecture?`,
		{ modal: true },
		'Yes',
		'No'
	);

	if (selection === 'Yes') {
		await setupBoilerplateFiles();
	}

	return selection;
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

async function wrapTryCatch(): Promise<void> {
	const activeEditor = vscode.window.activeTextEditor;
	if (!activeEditor) {
		vscode.window.showErrorMessage('No active code windows open.');
		return;
	}

	// 1. Ensure initialization checklist passes smoothly
	const confirmation = await askUserConfirmation();
	if (confirmation !== 'Yes') {
		return;
	}

	const document = activeEditor.document;
	const selection = activeEditor.selection;

	// Grab currently highlighted string context block
	const selectedText = document.getText(selection);
	if (!selectedText.trim()) {
		vscode.window.showWarningMessage('Please highlight a block of statements inside a function first.');
		return;
	}

	// 2. Introspect parent context blocks up-tree to name the error tracking zone
	const functionName = extractFunctionName(document, selection);

	// 3. Format dynamic replacement block with indented syntax adjustments
	const wrappedText = `try {\n\t${selectedText.replace(/\n/g, '\n\t')}\n} catch (err) {\n\thandleTryCatch(err, '${functionName}');\n}`;

	// 4. Safely execute edit buffer transaction tracking changes smoothly
	await activeEditor.edit(editBuilder => {
		editBuilder.replace(selection, wrappedText);
	});

	vscode.window.showInformationMessage(`Successfully wrapped text inside block tracking: ${functionName}`);
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('try-catch-wrapper.extension', wrapTryCatch);
	context.subscriptions.push(disposable);
}

export function deactivate() { }
