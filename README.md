# Try Catch Wrapper

- Often we need try/catch blocks to render beside error messages some other valuable information.

> In my case I needed a function name added to the error message, and as snippets have no way of reading the document that it would act on -- a solution offered by the CA (an AI ChatGPT) is to make an extension, utilizing an existing snippet that has a Timestop and a Placeholder as a template, to find out from vscode.executeDocumentSymbolProvider a function name that in its range holds the caret at the moment

- So, in order to use it please install Try Catch Wrapper extension, open your page having some functions, select the function code block to be wrapped in the Try/Catch block, press Shift+Ctrl+P (Shift+Cmd+P) combination to open Command Palette and start typing Try Catch Wrapper and press Enter when it shows up.
- The extension would examine your app to see whether the handler function handleTryCatch is already installed and globally available, and if not, will ofer you to install it and make it globally available, so no need for imports in any page.
- The extension will then wrap the selected block of code sitting in the function in a try/catch block

```ts
  function myFunction(){
    try {
      <selected block of code>
    } catch (err:unknown) {
      handleTryCatch(err, 'myFunction');
    }
  }
```

The handleTryCatch Extension relys on the following settings to become globally awailable:

- app.d.ts -- to make TypeScript recognize it everywhere in the app

```ts
* app.d.ts
  import type { THandleTryCatch } from '$lib/utils/helpers';
  declare global {
  var handleTryCatch: THandleTryCatch;
   ...
  }
```

- lib/utils/helpers.ts (if defined elsewhere extension will find and use it )

  try/catch block sends error object and a function name, in
  which it resides, to the handleTryCatch function, which
  outputs via console.log the function name and error message
  to reveal the function in which the error occured.

```ts
export type THandleTryCatch = (err: any, info?: string) => void
export const handleTryCatch = (err: unknown, info?: string) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(info, msg)
}
```

the handler could be updated based on your needs.

- hooks.client.ts -- client-level (web-side) globally available

```ts
import type { ClientInit } from '@sveltejs/kit'
import { handleTryCatch } from '$lib/utils/helpers'

export const init: ClientInit = () => {
  globalThis.handleTryCatch = handleTryCatch
}
```

- hooks.server.ts -- server-level (SSR) globally available

```ts
import type { ServerInit } from '@sveltejs/kit'
import { handleTryCatch } from '$lib/utils/helpers'

export const init: ServerInit = () => {
  globalThis.handleTryCatch = handleTryCatch
}
```
