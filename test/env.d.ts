import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../worker/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    // Types `exports` from "cloudflare:workers" as the worker's main module.
    interface GlobalProps {
      mainModule: typeof import("../worker/index");
    }
  }
}
