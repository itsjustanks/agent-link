// Paseo compiles index.ts twice. Before esbuild runs, it splices the entry's
// text: the client build DELETES every `import … from "./x.server"` statement
// outright (no stub, no undefined — the identifier is left with no binding) and
// deletes bare `plugin.handle(...)` statements; the server build deletes the
// surface registrations instead. So a `*.server` import may only be *referenced*
// from index.ts inside a statement the splice removes. Any other reference —
// a setTimeout, a cleanup call, a variable initialiser — compiles clean and then
// throws `ReferenceError: X is not defined` when the app evaluates the plugin,
// which drops the whole plugin from the catalog: no sidebar items, no surfaces.
//
// This registry is how server-only code reaches startup and shutdown without
// index.ts ever naming it. A *.server module registers at import time; index.ts
// calls run*() on a list it owns. In the client bundle the server imports are
// gone, so nothing ever registers and both calls are no-ops.

type Task = () => void;

const startTasks: Task[] = [];
const shutdownTasks: Task[] = [];

/** Run once the plugin is registered, off the startup path. Server modules only. */
export function onStart(task: Task): void {
  startTasks.push(task);
}

/** Run when the plugin is disabled or reloaded. Server modules only. */
export function onShutdown(task: Task): void {
  shutdownTasks.push(task);
}

function drain(tasks: Task[]): void {
  // Splice the list first: a task that throws must not strand the others, and a
  // second call (reload racing shutdown) must not run anything twice.
  for (const task of tasks.splice(0, tasks.length)) {
    try {
      task();
    } catch (error) {
      console.error("[agent-link] lifecycle task failed", error);
    }
  }
}

export function runStart(): void {
  // Start tasks are warm-ups by definition, so they must not sit on the
  // registration path. A tick is enough to get off it.
  if (startTasks.length === 0) return;
  setTimeout(() => drain(startTasks), 0);
}

export function runShutdown(): void {
  drain(shutdownTasks);
}
