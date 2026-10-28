
import * as vscode from 'vscode';

/**
 * Finds the innermost conventional function declaration
 * containing the given position.
 *
 * Arrow functions and class methods are not treated as
 * function declarations.
 */
function findEnclosingFunction(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | undefined {
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
  }

  return undefined;
}

/**
 * Wraps the selected text in try-catch and inserts
 * the enclosing function name into an editable placeholder.
 */
async function wrapTryCatch(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return;
  }

  const position = editor.selection.active;

  const symbols =
    await vscode.commands.executeCommand<
      vscode.DocumentSymbol[] | undefined
    >(
      'vscode.executeDocumentSymbolProvider',
      editor.document.uri
    );

  const fn = findEnclosingFunction(
    symbols ?? [],
    position
  );

  if (!fn) {
    void vscode.window.showWarningMessage(
      'No enclosing function declaration was found.'
    );
    return;
  }

  const snippet = new vscode.SnippetString();

  snippet.appendText('try {\n\t');
  snippet.appendVariable('TM_SELECTED_TEXT', 'function name is missing');
  snippet.appendText('\n} catch (err: unknown) {\n\thandleTryCatch(err, \'');

  // The function name is the default value of an editable placeholder.
  snippet.appendPlaceholder(fn.name);

  snippet.appendText("');\n}");

  await editor.insertSnippet(snippet);
}
