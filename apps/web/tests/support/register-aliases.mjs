// Import this first, then load app modules with dynamic `import()`: static
// imports are linked before this registration runs.
import { register } from "node:module";

register("./resolve-hooks.mjs", import.meta.url);
