import assert from "node:assert/strict";
import test from "node:test";

import { respostaSaudeDisponivel } from "./status.ts";

test("health de staging fica degradado sem derrubar banco e Festa", () => {
  assert.deepEqual(
    respostaSaudeDisponivel({ provider: "disabled", status: "unavailable" }),
    {
      ok: true,
      status: "degraded",
      components: { database: "ready", festa: "ready", otp: "unavailable" },
    },
  );
});

test("health permanece pronto quando WhatsApp está configurado", () => {
  assert.deepEqual(
    respostaSaudeDisponivel({ provider: "whatsapp_cloud", status: "ready" }),
    {
      ok: true,
      status: "ready",
      components: { database: "ready", festa: "ready", otp: "ready" },
    },
  );
});
