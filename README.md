# try-catch-wrapper README

- Often we need try/catch blocks to render beside error messages some other valuable information.

> In my case I needed a function name added to the error message, so as snippets have no way of reading the document that live in -- a solution offered by the CA (an AI ChatGPT) is to make an extension, utilizing an existing snippet having a Timestop and a Placeholder as a template, to find out from vscode.executeDocumentSymbolProvider a function name that in its range holds caret

- So, in order to use it please install Try Cath Wrapper extension, open youe page having some functions, select the function code block to be wrapped in the Try/Catch, press Shift+Ctrl+P (Shift+Cmd+P) combination and type Try Catch Wrapper and press Enter. The block would be wrapped and the enclosing function name would appear inside the error messsage.
- NOTE As the catch rely on a utility

```ts
export const handleTryCatch = (err: unknown, info?: string) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(info, msg)
}
```

you can get it installed in the $lib/utils/helpers.ts file, created if not found, and it would be defined as a global in the app.d.ts, created if not found, so you do not need to use import on every page that have Try Catch Wrapper applied by appending -g on extension name, e.g. Try Catch Wrapper-g.
